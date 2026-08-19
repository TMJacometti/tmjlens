use k8s_openapi::api::{
    apps::v1::{Deployment, ReplicaSet},
    core::v1::{Event, Pod},
};
use kube::{api::ListParams, Api, Client, ResourceExt};
use serde::Serialize;

use crate::format_age;

#[derive(Serialize, Clone)]
pub struct ContainerSpec {
    pub name: String,
    pub image: String,
    pub kind: String,
}

#[derive(Serialize, Clone)]
pub struct WorkloadEvent {
    pub reason: String,
    pub message: String,
    pub kind: String,
    pub name: String,
    pub severity: String,
    pub count: i32,
    pub timestamp: Option<String>,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct WorkloadCondition {
    pub kind: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub healthy: bool,
}

#[derive(Serialize, Clone)]
pub struct DeploymentDetail {
    pub name: String,
    pub namespace: String,
    pub replicas_desired: i32,
    pub replicas_ready: i32,
    pub replicas_updated: i32,
    pub replicas_available: i32,
    pub strategy: String,
    pub image_summary: String,
    pub selector: Vec<String>,
    pub containers: Vec<ContainerSpec>,
    pub pods: Vec<String>,
    pub conditions: Vec<WorkloadCondition>,
    pub events: Vec<WorkloadEvent>,
}

/// Fetches the object exactly as the API server holds it and renders it as YAML.
///
/// Deliberately raw. Round-tripping through the typed struct would silently drop any
/// field this build of k8s-openapi does not know about — alpha fields, or anything a
/// mutating webhook or CRD controller added — and an export that quietly loses data
/// is worse than no export. Server-owned fields (status, managedFields,
/// resourceVersion) are kept: this is a faithful snapshot, and whoever re-applies it
/// knows what to strip.
pub async fn export_raw(client: Client, path: &str) -> Result<String, String> {
    let request = http::Request::get(path)
        .body(Vec::new())
        .map_err(|error| error.to_string())?;
    let value = client
        .request::<serde_json::Value>(request)
        .await
        .map_err(|error| error.to_string())?;
    serde_yaml::to_string(&value).map_err(|error| error.to_string())
}

pub fn deployment_path(namespace: &str, name: &str) -> String {
    format!("/apis/apps/v1/namespaces/{namespace}/deployments/{name}")
}

/// Warnings are ranked so the reason a rollout is stuck sorts above routine noise.
fn event_severity(event_type: Option<&str>, reason: &str) -> String {
    if event_type == Some("Warning") {
        let critical = ["Failed", "BackOff", "Unhealthy", "Evicted", "OOM"];
        if critical.iter().any(|value| reason.contains(value)) {
            return "critical".to_string();
        }
        return "serious".to_string();
    }
    "good".to_string()
}

fn summarise_images(containers: &[ContainerSpec]) -> String {
    let images: Vec<&str> = containers
        .iter()
        .filter(|container| container.kind == "container")
        .map(|container| container.image.as_str())
        .collect();
    match images.len() {
        0 => "no containers".to_string(),
        1 => images[0].to_string(),
        count => format!("{} and {} more", images[0], count - 1),
    }
}

/// Collects everything needed to explain a Deployment, walking Deployment → ReplicaSet → Pod.
///
/// A Deployment's own events say almost nothing — usually just ScalingReplicaSet. The
/// reason a rollout is stuck lives one or two levels down: FailedCreate on the
/// ReplicaSet when a quota or policy rejects the pod, FailedScheduling or
/// ImagePullBackOff on the pods themselves. Matching on owner UID rather than name
/// avoids picking up a different object that happens to share a prefix.
pub async fn deployment_detail(client: Client, namespace: &str, name: &str) -> Result<DeploymentDetail, String> {
    let deployments: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    let deployment = deployments.get(name).await.map_err(|error| error.to_string())?;
    let deployment_uid = deployment.uid().unwrap_or_default();

    let spec = deployment.spec.clone();
    let selector: Vec<String> = spec
        .as_ref()
        .and_then(|spec| spec.selector.match_labels.clone())
        .map(|labels| labels.iter().map(|(key, value)| format!("{key}={value}")).collect())
        .unwrap_or_default();

    let containers: Vec<ContainerSpec> = spec
        .as_ref()
        .and_then(|spec| spec.template.spec.as_ref())
        .map(|template| {
            template
                .init_containers
                .iter()
                .flatten()
                .map(|container| ContainerSpec {
                    name: container.name.clone(),
                    image: container.image.clone().unwrap_or_else(|| "unknown".to_string()),
                    kind: "init".to_string(),
                })
                .chain(template.containers.iter().map(|container| ContainerSpec {
                    name: container.name.clone(),
                    image: container.image.clone().unwrap_or_else(|| "unknown".to_string()),
                    kind: "container".to_string(),
                }))
                .collect()
        })
        .unwrap_or_default();

    let replica_sets: Api<ReplicaSet> = Api::namespaced(client.clone(), namespace);
    let replica_set_uids: Vec<String> = replica_sets
        .list(&ListParams::default())
        .await
        .map(|list| {
            list.items
                .into_iter()
                .filter(|item| item.owner_references().iter().any(|owner| owner.uid == deployment_uid))
                .filter_map(|item| item.uid())
                .collect()
        })
        .unwrap_or_default();

    let pods_api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let params = if selector.is_empty() {
        ListParams::default()
    } else {
        ListParams::default().labels(&selector.join(","))
    };
    let pods = pods_api.list(&params).await.map(|list| list.items).unwrap_or_default();
    let pod_uids: Vec<String> = pods.iter().filter_map(|pod| pod.uid()).collect();
    let pod_names: Vec<String> = pods.iter().filter_map(|pod| pod.metadata.name.clone()).collect();

    let owned: std::collections::HashSet<String> = std::iter::once(deployment_uid)
        .chain(replica_set_uids)
        .chain(pod_uids)
        .collect();

    let events_api: Api<Event> = Api::namespaced(client, namespace);
    let mut events: Vec<WorkloadEvent> = events_api
        .list(&ListParams::default())
        .await
        .map(|list| {
            list.items
                .into_iter()
                .filter(|event| event.involved_object.uid.as_ref().is_some_and(|uid| owned.contains(uid)))
                .map(|event| {
                    let reason = event.reason.clone().unwrap_or_else(|| "Unknown".to_string());
                    let kind = event.involved_object.kind.clone().unwrap_or_else(|| "Unknown".to_string());
                    let timestamp = event
                        .last_timestamp
                        .clone()
                        .map(|time| time.0)
                        .or_else(|| event.event_time.clone().map(|time| time.0));
                    WorkloadEvent {
                        severity: event_severity(event.type_.as_deref(), &reason),
                        age: timestamp.map(format_age).unwrap_or_else(|| "n/a".to_string()),
                        timestamp: timestamp.map(|time| time.to_rfc3339()),
                        message: event.message.clone().unwrap_or_else(|| "No details".to_string()),
                        name: event.involved_object.name.clone().unwrap_or_default(),
                        count: event.count.unwrap_or(1),
                        reason,
                        kind,
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    events.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    events.truncate(60);

    let status = deployment.status.clone();
    let conditions = status
        .as_ref()
        .and_then(|status| status.conditions.clone())
        .map(|conditions| {
            conditions
                .into_iter()
                .map(|condition| WorkloadCondition {
                    healthy: condition.status == "True",
                    kind: condition.type_,
                    status: condition.status,
                    reason: condition.reason,
                    message: condition.message,
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(DeploymentDetail {
        name: name.to_string(),
        namespace: namespace.to_string(),
        replicas_desired: spec.as_ref().and_then(|spec| spec.replicas).unwrap_or(1),
        replicas_ready: status.as_ref().and_then(|status| status.ready_replicas).unwrap_or(0),
        replicas_updated: status.as_ref().and_then(|status| status.updated_replicas).unwrap_or(0),
        replicas_available: status.as_ref().and_then(|status| status.available_replicas).unwrap_or(0),
        strategy: spec
            .as_ref()
            .and_then(|spec| spec.strategy.as_ref())
            .and_then(|strategy| strategy.type_.clone())
            .unwrap_or_else(|| "RollingUpdate".to_string()),
        image_summary: summarise_images(&containers),
        selector,
        containers,
        pods: pod_names,
        conditions,
        events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container(name: &str, image: &str, kind: &str) -> ContainerSpec {
        ContainerSpec { name: name.into(), image: image.into(), kind: kind.into() }
    }

    #[test]
    fn ranks_event_severity_from_type_and_reason() {
        assert_eq!(event_severity(Some("Warning"), "FailedScheduling"), "critical");
        assert_eq!(event_severity(Some("Warning"), "BackOff"), "critical");
        assert_eq!(event_severity(Some("Warning"), "OOMKilling"), "critical");
        assert_eq!(event_severity(Some("Warning"), "SomethingElse"), "serious");
        assert_eq!(event_severity(Some("Normal"), "ScalingReplicaSet"), "good");
        assert_eq!(event_severity(None, "Created"), "good");
    }

    #[test]
    fn summarises_images_without_counting_init_containers() {
        assert_eq!(summarise_images(&[]), "no containers");
        assert_eq!(summarise_images(&[container("api", "registry/api:1.2", "container")]), "registry/api:1.2");
        // An init container is not part of what the workload runs steady-state.
        assert_eq!(
            summarise_images(&[container("wait", "busybox", "init"), container("api", "registry/api:1.2", "container")]),
            "registry/api:1.2"
        );
        assert_eq!(
            summarise_images(&[
                container("api", "registry/api:1.2", "container"),
                container("sidecar", "envoy:1.29", "container"),
            ]),
            "registry/api:1.2 and 1 more"
        );
    }

    #[test]
    fn builds_the_namespaced_deployment_path() {
        assert_eq!(
            deployment_path("payments", "checkout-api"),
            "/apis/apps/v1/namespaces/payments/deployments/checkout-api"
        );
    }
}
