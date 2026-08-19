use k8s_openapi::api::{
    apps::v1::{Deployment, ReplicaSet},
    core::v1::{ConfigMap, PersistentVolumeClaim, Pod, Secret, Service},
    networking::v1::Ingress,
};
use kube::{api::ListParams, Api, Client, ResourceExt};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};

/// The relation graph for one workload.
///
/// Bounded on purpose: it walks from an Ingress down to the pods and out to the config
/// a pod mounts, and stops. An unbounded graph of a namespace is a picture nobody can
/// read, and the question being answered is always about one workload.
#[derive(Serialize, Clone)]
pub struct RelationGraph {
    pub root: String,
    pub namespace: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub degraded_collectors: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub name: String,
    /// Which column the node belongs in: 0 is ingress, rising toward the pods.
    pub tier: u8,
    pub health: String,
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    /// Why the two are connected, in words: "routes to", "selects", "mounts".
    pub relation: String,
    /// Set when the link is declared but does not resolve — the useful part.
    pub broken: Option<String>,
}

fn id_of(kind: &str, name: &str) -> String {
    format!("{kind}/{name}")
}

fn matches_selector(labels: &std::collections::BTreeMap<String, String>, selector: &std::collections::BTreeMap<String, String>) -> bool {
    // An empty selector matches nothing here: a Service without one is wired by hand.
    !selector.is_empty() && selector.iter().all(|(key, value)| labels.get(key) == Some(value))
}

fn pod_health(pod: &Pod) -> (&'static str, String) {
    let phase = pod
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Unknown".into());
    let statuses = pod.status.as_ref().and_then(|status| status.container_statuses.as_ref());
    let ready = statuses.map(|list| list.iter().filter(|c| c.ready).count()).unwrap_or(0);
    let total = statuses.map(Vec::len).unwrap_or(0);

    let waiting = statuses.and_then(|list| {
        list.iter()
            .find_map(|c| c.state.as_ref()?.waiting.as_ref()?.reason.clone())
            .filter(|reason| reason != "ContainerCreating" && reason != "PodInitializing")
    });

    if let Some(reason) = waiting {
        return ("critical", reason);
    }
    match phase.as_str() {
        "Succeeded" => ("good", format!("{phase}")),
        "Failed" | "Unknown" => ("critical", phase),
        "Running" if total > 0 && ready < total => ("serious", format!("{ready}/{total} ready")),
        "Running" => ("good", format!("{ready}/{total} ready")),
        _ => ("warning", phase),
    }
}

/// Builds the graph around a Deployment.
pub async fn for_deployment(client: Client, namespace: &str, name: &str) -> Result<RelationGraph, String> {
    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut degraded: Vec<String> = Vec::new();
    let params = ListParams::default();

    let deployments: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    let deployment = deployments.get(name).await.map_err(|error| error.to_string())?;
    let deployment_uid = deployment.uid().unwrap_or_default();
    let deployment_id = id_of("Deployment", name);

    let desired = deployment.spec.as_ref().and_then(|spec| spec.replicas).unwrap_or(1);
    let ready = deployment.status.as_ref().and_then(|status| status.ready_replicas).unwrap_or(0);
    nodes.push(GraphNode {
        id: deployment_id.clone(),
        kind: "Deployment".into(),
        name: name.to_string(),
        tier: 2,
        health: if ready >= desired { "good" } else if ready == 0 { "critical" } else { "serious" }.into(),
        detail: format!("{ready}/{desired} ready"),
    });

    let selector = deployment
        .spec
        .as_ref()
        .and_then(|spec| spec.selector.match_labels.clone())
        .unwrap_or_default();

    // Pods, via the Deployment's own selector.
    let pods_api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pod_params = if selector.is_empty() {
        params.clone()
    } else {
        ListParams::default().labels(
            &selector.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(","),
        )
    };
    let pods = pods_api.list(&pod_params).await.map(|list| list.items).unwrap_or_else(|error| {
        degraded.push(format!("Pods could not be listed ({error})."));
        Vec::new()
    });

    // ReplicaSets sit between, and naming them is what explains a stuck rollout.
    let replicasets: Api<ReplicaSet> = Api::namespaced(client.clone(), namespace);
    if let Ok(list) = replicasets.list(&params).await {
        for item in list.items {
            if !item.owner_references().iter().any(|owner| owner.uid == deployment_uid) {
                continue;
            }
            let rs_desired = item.spec.as_ref().and_then(|spec| spec.replicas).unwrap_or(0);
            let rs_ready = item.status.as_ref().and_then(|status| status.ready_replicas).unwrap_or(0);
            // A scaled-down old revision is history, not a participant.
            if rs_desired == 0 && rs_ready == 0 {
                continue;
            }
            let rs_name = item.name_any();
            let rs_id = id_of("ReplicaSet", &rs_name);
            nodes.push(GraphNode {
                id: rs_id.clone(),
                kind: "ReplicaSet".into(),
                name: rs_name,
                tier: 3,
                health: if rs_ready >= rs_desired { "good" } else if rs_ready == 0 { "critical" } else { "serious" }.into(),
                detail: format!("{rs_ready}/{rs_desired} ready"),
            });
            edges.push(GraphEdge { from: deployment_id.clone(), to: rs_id, relation: "owns".into(), broken: None });
        }
    }

    let owning_rs: HashMap<String, String> = nodes
        .iter()
        .filter(|node| node.kind == "ReplicaSet")
        .map(|node| (node.name.clone(), node.id.clone()))
        .collect();

    let mut mounted_configmaps: BTreeSet<String> = BTreeSet::new();
    let mut mounted_secrets: BTreeSet<String> = BTreeSet::new();
    let mut mounted_claims: BTreeSet<String> = BTreeSet::new();

    for pod in &pods {
        let pod_name = pod.name_any();
        let pod_id = id_of("Pod", &pod_name);
        let (health, detail) = pod_health(pod);
        nodes.push(GraphNode {
            id: pod_id.clone(),
            kind: "Pod".into(),
            name: pod_name,
            tier: 4,
            health: health.into(),
            detail,
        });

        // Attach the pod to the ReplicaSet that owns it when there is one.
        let parent = pod
            .owner_references()
            .iter()
            .find_map(|owner| owning_rs.get(&owner.name).cloned())
            .unwrap_or_else(|| deployment_id.clone());
        edges.push(GraphEdge { from: parent, to: pod_id.clone(), relation: "runs".into(), broken: None });

        if let Some(spec) = pod.spec.as_ref() {
            for volume in spec.volumes.iter().flatten() {
                if let Some(source) = volume.config_map.as_ref().map(|entry| entry.name.clone()) {
                    mounted_configmaps.insert(source);
                }
                if let Some(source) = volume.secret.as_ref().and_then(|entry| entry.secret_name.clone()) {
                    mounted_secrets.insert(source);
                }
                if let Some(source) = volume.persistent_volume_claim.as_ref() {
                    mounted_claims.insert(source.claim_name.clone());
                }
            }
            for container in &spec.containers {
                for source in container.env_from.iter().flatten() {
                    if let Some(name) = source.config_map_ref.as_ref().map(|entry| entry.name.clone()) {
                        mounted_configmaps.insert(name);
                    }
                    if let Some(name) = source.secret_ref.as_ref().map(|entry| entry.name.clone()) {
                        mounted_secrets.insert(name);
                    }
                }
            }
        }
    }

    // Services that select these pods, and the Ingresses that route to them.
    let services_api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let services = services_api.list(&params).await.map(|list| list.items).unwrap_or_else(|error| {
        degraded.push(format!("Services could not be listed ({error})."));
        Vec::new()
    });

    let mut service_ids: HashMap<String, String> = HashMap::new();
    for service in &services {
        let service_selector = service
            .spec
            .as_ref()
            .and_then(|spec| spec.selector.clone())
            .unwrap_or_default();
        let selected: Vec<&Pod> = pods
            .iter()
            .filter(|pod| matches_selector(&pod.labels().clone(), &service_selector))
            .collect();
        if selected.is_empty() {
            continue;
        }

        let service_name = service.name_any();
        let service_id = id_of("Service", &service_name);
        let ready_backing = selected.iter().filter(|pod| pod_health(pod).0 == "good").count();
        nodes.push(GraphNode {
            id: service_id.clone(),
            kind: "Service".into(),
            name: service_name.clone(),
            tier: 1,
            health: if ready_backing == 0 { "critical" } else { "good" }.into(),
            detail: format!("{ready_backing} of {} pods ready", selected.len()),
        });
        service_ids.insert(service_name, service_id.clone());

        for pod in selected {
            edges.push(GraphEdge {
                from: service_id.clone(),
                to: id_of("Pod", &pod.name_any()),
                relation: "selects".into(),
                broken: (pod_health(pod).0 != "good").then(|| "endpoint not ready".to_string()),
            });
        }
    }

    let ingresses: Api<Ingress> = Api::namespaced(client.clone(), namespace);
    if let Ok(list) = ingresses.list(&params).await {
        for ingress in list.items {
            let ingress_name = ingress.name_any();
            let ingress_id = id_of("Ingress", &ingress_name);
            let mut linked = false;

            for rule in ingress.spec.as_ref().and_then(|spec| spec.rules.clone()).unwrap_or_default() {
                let host = rule.host.clone().unwrap_or_else(|| "*".into());
                for path in rule.http.map(|http| http.paths).unwrap_or_default() {
                    let Some(backend) = path.backend.service.as_ref() else { continue };
                    let Some(service_id) = service_ids.get(&backend.name) else { continue };
                    if !linked {
                        nodes.push(GraphNode {
                            id: ingress_id.clone(),
                            kind: "Ingress".into(),
                            name: ingress_name.clone(),
                            tier: 0,
                            health: "good".into(),
                            detail: ingress
                                .status
                                .as_ref()
                                .and_then(|status| status.load_balancer.as_ref())
                                .and_then(|lb| lb.ingress.as_ref())
                                .and_then(|entries| entries.first())
                                .and_then(|entry| entry.ip.clone().or_else(|| entry.hostname.clone()))
                                .unwrap_or_else(|| "no address".into()),
                        });
                        linked = true;
                    }
                    edges.push(GraphEdge {
                        from: ingress_id.clone(),
                        to: service_id.clone(),
                        relation: format!("routes {host}{}", path.path.unwrap_or_else(|| "/".into())),
                        broken: None,
                    });
                }
            }
        }
    }

    // Config the pods depend on. A missing one is exactly why a pod will not start.
    let configmaps: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
    let existing_configmaps: BTreeSet<String> = configmaps
        .list(&params)
        .await
        .map(|list| list.items.iter().map(|item| item.name_any()).collect())
        .unwrap_or_default();
    let secrets: Api<Secret> = Api::namespaced(client.clone(), namespace);
    let existing_secrets: BTreeSet<String> = secrets
        .list(&params)
        .await
        .map(|list| list.items.iter().map(|item| item.name_any()).collect())
        .unwrap_or_default();
    let claims: Api<PersistentVolumeClaim> = Api::namespaced(client, namespace);
    let claim_status: HashMap<String, String> = claims
        .list(&params)
        .await
        .map(|list| {
            list.items
                .iter()
                .map(|item| {
                    (
                        item.name_any(),
                        item.status
                            .as_ref()
                            .and_then(|status| status.phase.clone())
                            .unwrap_or_else(|| "Unknown".into()),
                    )
                })
                .collect()
        })
        .unwrap_or_default();

    let mut attach_dependency = |kind: &str, name: &str, present: bool, detail: String, health: &str| {
        let node_id = id_of(kind, name);
        nodes.push(GraphNode {
            id: node_id.clone(),
            kind: kind.into(),
            name: name.into(),
            tier: 5,
            health: health.into(),
            detail,
        });
        edges.push(GraphEdge {
            from: deployment_id.clone(),
            to: node_id,
            relation: "mounts".into(),
            broken: (!present).then(|| format!("{kind} {name} does not exist in this namespace")),
        });
    };

    for name in mounted_configmaps {
        let present = existing_configmaps.contains(&name);
        attach_dependency(
            "ConfigMap",
            &name,
            present,
            if present { "present".into() } else { "missing".into() },
            if present { "good" } else { "critical" },
        );
    }
    for name in mounted_secrets {
        let present = existing_secrets.contains(&name);
        // Presence and name only — never the contents.
        attach_dependency(
            "Secret",
            &name,
            present,
            if present { "present, values hidden".into() } else { "missing".into() },
            if present { "good" } else { "critical" },
        );
    }
    for name in mounted_claims {
        let phase = claim_status.get(&name).cloned();
        let bound = phase.as_deref() == Some("Bound");
        attach_dependency(
            "PersistentVolumeClaim",
            &name,
            phase.is_some(),
            phase.clone().unwrap_or_else(|| "missing".into()),
            if bound { "good" } else { "critical" },
        );
    }

    Ok(RelationGraph {
        root: deployment_id,
        namespace: namespace.to_string(),
        nodes,
        edges,
        degraded_collectors: degraded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn a_selector_matches_only_when_every_label_agrees() {
        let labels = map(&[("app", "checkout"), ("tier", "backend"), ("extra", "x")]);
        assert!(matches_selector(&labels, &map(&[("app", "checkout")])));
        assert!(matches_selector(&labels, &map(&[("app", "checkout"), ("tier", "backend")])));
        assert!(!matches_selector(&labels, &map(&[("app", "checkout"), ("tier", "frontend")])));
        assert!(!matches_selector(&labels, &map(&[("missing", "value")])));
    }

    #[test]
    fn an_empty_selector_selects_nothing() {
        // A Service with no selector has hand-managed endpoints; claiming it selects
        // every pod in the namespace would draw a graph that is simply false.
        assert!(!matches_selector(&map(&[("app", "checkout")]), &BTreeMap::new()));
    }

    #[test]
    fn ids_are_unique_per_kind_and_name() {
        assert_eq!(id_of("Pod", "checkout"), "Pod/checkout");
        assert_ne!(id_of("Pod", "checkout"), id_of("Service", "checkout"));
    }
}
