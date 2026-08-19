use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use kube::core::{ApiResource, DynamicObject, GroupVersionKind};
use kube::{api::ListParams, Api, Client};
use serde::Serialize;

use crate::format_age;

#[derive(Serialize, Clone)]
pub struct DeployReport {
    pub window: String,
    pub namespaces: Vec<String>,
    pub items: Vec<DeployedRow>,
    pub degraded_collectors: Vec<String>,
}

/// A workload that did not exist in this cluster before the window began.
#[derive(Serialize, Clone)]
pub struct DeployedRow {
    pub namespace: String,
    pub name: String,
    pub kind: String,
    /// When the object was created in the cluster.
    pub deployed_at: String,
    pub age: String,
    pub images: Vec<String>,
    /// What "running" means for this kind, in its own terms: replicas for a Deployment,
    /// a schedule for a CronJob, completions for a Job.
    pub detail: String,
    pub health: String,
    pub reason: String,
    /// The tool that created it, when it says so.
    pub managed_by: Option<String>,
}

/// How far back to look. "Today" is anchored to the operator's own midnight rather than
/// to a rolling 24 hours, because that is what the word means in a standup.
pub fn cutoff_for(window: &str, now: chrono::DateTime<chrono::Local>) -> chrono::DateTime<chrono::Utc> {
    use chrono::TimeZone;
    let local = match window {
        "yesterday" => now - chrono::Duration::days(1),
        "7d" => now - chrono::Duration::days(7),
        "30d" => now - chrono::Duration::days(30),
        // "today" and anything unrecognised: since local midnight.
        _ => chrono::Local
            .from_local_datetime(&now.date_naive().and_hms_opt(0, 0, 0).unwrap())
            .single()
            .unwrap_or(now),
    };
    local.with_timezone(&chrono::Utc)
}

/// "yesterday" means the day before today, not the last 48 hours, so it needs an upper
/// bound as well. Every other window runs up to now.
pub fn ceiling_for(window: &str, now: chrono::DateTime<chrono::Local>) -> Option<chrono::DateTime<chrono::Utc>> {
    if window != "yesterday" {
        return None;
    }
    Some(cutoff_for("today", now))
}

fn workflow_resource() -> ApiResource {
    ApiResource::from_gvk(&GroupVersionKind::gvk("argoproj.io", "v1alpha1", "Workflow"))
}

fn images_of(spec: Option<&k8s_openapi::api::core::v1::PodSpec>) -> Vec<String> {
    spec.map(|spec| {
        spec.init_containers
            .iter()
            .flatten()
            .chain(spec.containers.iter())
            .filter_map(|container| container.image.clone())
            .collect()
    })
    .unwrap_or_default()
}

/// Names the tool that created the object, which on most clusters answers "who put this
/// here" without anyone having to ask in chat.
fn managed_by(metadata: &kube::core::ObjectMeta) -> Option<String> {
    let labels = metadata.labels.as_ref();
    if let Some(value) = labels.and_then(|map| map.get("app.kubernetes.io/managed-by")) {
        return Some(value.clone());
    }
    if metadata.annotations.as_ref().is_some_and(|map| map.contains_key("meta.helm.sh/release-name")) {
        return Some("Helm".to_string());
    }
    if labels.is_some_and(|map| map.contains_key("argocd.argoproj.io/instance")) {
        return Some("Argo CD".to_string());
    }
    if labels.is_some_and(|map| map.contains_key("kustomize.toolkit.fluxcd.io/name")) {
        return Some("Flux".to_string());
    }
    None
}

/// A workload deployed today that is not running is the single most useful line in this
/// report, so readiness is judged rather than just counted.
fn health_of(ready: i32, desired: i32) -> (&'static str, String) {
    if desired == 0 {
        return ("warning", "Scaled to zero — deployed but not running.".to_string());
    }
    if ready == 0 {
        return ("critical", format!("None of {desired} replicas are ready."));
    }
    if ready < desired {
        return ("warning", format!("{ready} of {desired} replicas ready."));
    }
    ("good", format!("All {desired} replicas ready."))
}

fn within(
    metadata: &kube::core::ObjectMeta,
    cutoff: chrono::DateTime<chrono::Utc>,
    ceiling: Option<chrono::DateTime<chrono::Utc>>,
) -> Option<chrono::DateTime<chrono::Utc>> {
    let created = metadata.creation_timestamp.as_ref()?.0;
    if created < cutoff {
        return None;
    }
    if ceiling.is_some_and(|limit| created >= limit) {
        return None;
    }
    Some(created)
}

fn row(
    metadata: &kube::core::ObjectMeta,
    kind: &str,
    created: chrono::DateTime<chrono::Utc>,
    images: Vec<String>,
    ready: i32,
    desired: i32,
) -> DeployedRow {
    let (health, reason) = health_of(ready, desired);
    DeployedRow {
        namespace: metadata.namespace.clone().unwrap_or_default(),
        name: metadata.name.clone().unwrap_or_default(),
        kind: kind.to_string(),
        deployed_at: created.to_rfc3339(),
        age: format_age(created),
        managed_by: managed_by(metadata),
        detail: format!("{ready}/{desired} ready"),
        health: health.to_string(),
        images,
        reason,
    }
}

/// A row for a kind that has no replicas to count.
fn plain_row(
    metadata: &kube::core::ObjectMeta,
    kind: &str,
    created: chrono::DateTime<chrono::Utc>,
    images: Vec<String>,
    detail: String,
    health: &str,
    reason: String,
) -> DeployedRow {
    DeployedRow {
        namespace: metadata.namespace.clone().unwrap_or_default(),
        name: metadata.name.clone().unwrap_or_default(),
        kind: kind.to_string(),
        deployed_at: created.to_rfc3339(),
        age: format_age(created),
        managed_by: managed_by(metadata),
        health: health.to_string(),
        images,
        detail,
        reason,
    }
}

/// A Job created by a CronJob is that schedule firing, not something anyone deployed.
/// Counting those would bury the report under every nightly run.
fn spawned_by_cron(metadata: &kube::core::ObjectMeta) -> bool {
    metadata
        .owner_references
        .iter()
        .flatten()
        .any(|reference| reference.kind == "CronJob")
}

/// Reads the workloads that first appeared in the cluster inside the window.
///
/// Deliberately driven by an explicit namespace list rather than sweeping the cluster:
/// the caller chooses what to look at, and nothing is read until it does.
pub async fn deployed(
    client: Client,
    namespaces: Vec<String>,
    window: &str,
) -> Result<DeployReport, String> {
    let now = chrono::Local::now();
    let cutoff = cutoff_for(window, now);
    let ceiling = ceiling_for(window, now);
    let params = ListParams::default();
    let mut items = Vec::new();
    let mut degraded = Vec::new();

    for namespace in &namespaces {
        let deployments: Api<Deployment> = Api::namespaced(client.clone(), namespace);
        let stateful_sets: Api<StatefulSet> = Api::namespaced(client.clone(), namespace);
        let daemon_sets: Api<DaemonSet> = Api::namespaced(client.clone(), namespace);

        let cron_jobs: Api<CronJob> = Api::namespaced(client.clone(), namespace);
        let jobs: Api<Job> = Api::namespaced(client.clone(), namespace);
        let workflows: Api<DynamicObject> =
            Api::namespaced_with(client.clone(), namespace, &workflow_resource());

        let (deployment_list, stateful_list, daemon_list, cron_list, job_list, workflow_list) = tokio::join!(
            deployments.list(&params),
            stateful_sets.list(&params),
            daemon_sets.list(&params),
            cron_jobs.list(&params),
            jobs.list(&params),
            workflows.list(&params),
        );

        match deployment_list {
            Ok(list) => {
                for item in list.items {
                    let Some(created) = within(&item.metadata, cutoff, ceiling) else { continue };
                    let status = item.status.clone().unwrap_or_default();
                    items.push(row(
                        &item.metadata,
                        "Deployment",
                        created,
                        images_of(item.spec.as_ref().and_then(|spec| spec.template.spec.as_ref())),
                        status.ready_replicas.unwrap_or(0),
                        item.spec.as_ref().and_then(|spec| spec.replicas).unwrap_or(1),
                    ));
                }
            }
            Err(error) => degraded.push(format!("Deployments in {namespace} could not be listed ({error}).")),
        }

        match stateful_list {
            Ok(list) => {
                for item in list.items {
                    let Some(created) = within(&item.metadata, cutoff, ceiling) else { continue };
                    let status = item.status.clone().unwrap_or_default();
                    items.push(row(
                        &item.metadata,
                        "StatefulSet",
                        created,
                        images_of(item.spec.as_ref().and_then(|spec| spec.template.spec.as_ref())),
                        status.ready_replicas.unwrap_or(0),
                        item.spec.as_ref().and_then(|spec| spec.replicas).unwrap_or(1),
                    ));
                }
            }
            Err(error) => degraded.push(format!("Stateful sets in {namespace} could not be listed ({error}).")),
        }

        match daemon_list {
            Ok(list) => {
                for item in list.items {
                    let Some(created) = within(&item.metadata, cutoff, ceiling) else { continue };
                    let status = item.status.clone().unwrap_or_default();
                    items.push(row(
                        &item.metadata,
                        "DaemonSet",
                        created,
                        images_of(item.spec.as_ref().and_then(|spec| spec.template.spec.as_ref())),
                        status.number_ready,
                        status.desired_number_scheduled,
                    ));
                }
            }
            Err(error) => degraded.push(format!("Daemon sets in {namespace} could not be listed ({error}).")),
        }

        match cron_list {
            Ok(list) => {
                for item in list.items {
                    let Some(created) = within(&item.metadata, cutoff, ceiling) else { continue };
                    let spec = item.spec.clone().unwrap_or_default();
                    let suspended = spec.suspend.unwrap_or(false);
                    let (health, reason) = if suspended {
                        ("warning", "Suspended - it will not run on its schedule.".to_string())
                    } else {
                        ("good", format!("Runs on schedule {}.", spec.schedule))
                    };
                    let detail = if suspended {
                        format!("{} - suspended", spec.schedule)
                    } else {
                        spec.schedule.clone()
                    };
                    items.push(plain_row(
                        &item.metadata,
                        "CronJob",
                        created,
                        images_of(spec.job_template.spec.as_ref().and_then(|job| job.template.spec.as_ref())),
                        detail,
                        health,
                        reason,
                    ));
                }
            }
            Err(error) => degraded.push(format!("Cron jobs in {namespace} could not be listed ({error}).")),
        }

        match job_list {
            Ok(list) => {
                for item in list.items {
                    // A scheduled run is not a deployment.
                    if spawned_by_cron(&item.metadata) {
                        continue;
                    }
                    let Some(created) = within(&item.metadata, cutoff, ceiling) else { continue };
                    let status = item.status.clone().unwrap_or_default();
                    let succeeded = status.succeeded.unwrap_or(0);
                    let failed = status.failed.unwrap_or(0);
                    let wanted = item.spec.as_ref().and_then(|spec| spec.completions).unwrap_or(1);
                    let (health, reason) = if failed > 0 {
                        ("critical", format!("{failed} attempt(s) failed."))
                    } else if succeeded >= wanted {
                        ("good", "Completed.".to_string())
                    } else {
                        ("warning", format!("{succeeded} of {wanted} completions so far."))
                    };
                    items.push(plain_row(
                        &item.metadata,
                        "Job",
                        created,
                        images_of(item.spec.as_ref().and_then(|spec| spec.template.spec.as_ref())),
                        format!("{succeeded}/{wanted} complete"),
                        health,
                        reason,
                    ));
                }
            }
            Err(error) => degraded.push(format!("Jobs in {namespace} could not be listed ({error}).")),
        }

        // Argo Workflows are a custom resource. A cluster without Argo returns 404 here,
        // which is not a degraded read - it means Argo is not installed.
        if let Ok(list) = workflow_list {
            for item in list.items {
                let Some(created) = within(&item.metadata, cutoff, ceiling) else { continue };
                let phase = item
                    .data
                    .pointer("/status/phase")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Unknown")
                    .to_string();
                let health = match phase.as_str() {
                    "Succeeded" => "good",
                    "Running" | "Pending" => "warning",
                    "Failed" | "Error" => "critical",
                    _ => "warning",
                };
                items.push(plain_row(
                    &item.metadata,
                    "Workflow",
                    created,
                    Vec::new(),
                    phase.clone(),
                    health,
                    format!("Argo workflow, phase {phase}."),
                ));
            }
        }
    }

    // Most recent first: a report is read from the top for what just landed.
    items.sort_by(|left, right| right.deployed_at.cmp(&left.deployed_at));

    Ok(DeployReport {
        window: window.to_string(),
        namespaces,
        items,
        degraded_collectors: degraded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn local(year: i32, month: u32, day: u32, hour: u32) -> chrono::DateTime<chrono::Local> {
        chrono::Local.with_ymd_and_hms(year, month, day, hour, 0, 0).single().unwrap()
    }

    #[test]
    fn today_means_since_local_midnight_not_a_rolling_day() {
        // Something deployed at 09:00 must still be in the report at 23:00, and
        // something from last night must not appear in it at all.
        let now = local(2026, 8, 19, 23);
        let cutoff = cutoff_for("today", now);
        assert!(local(2026, 8, 19, 9).with_timezone(&chrono::Utc) >= cutoff);
        assert!(local(2026, 8, 18, 22).with_timezone(&chrono::Utc) < cutoff);
    }

    #[test]
    fn yesterday_is_a_day_not_the_last_forty_eight_hours() {
        let now = local(2026, 8, 19, 15);
        let cutoff = cutoff_for("yesterday", now);
        let ceiling = ceiling_for("yesterday", now).expect("yesterday is bounded");

        let during_yesterday = local(2026, 8, 18, 20).with_timezone(&chrono::Utc);
        let this_morning = local(2026, 8, 19, 9).with_timezone(&chrono::Utc);
        assert!(during_yesterday >= cutoff && during_yesterday < ceiling);
        assert!(this_morning >= ceiling, "today must not appear under yesterday");
    }

    #[test]
    fn the_open_ended_windows_have_no_ceiling() {
        let now = local(2026, 8, 19, 12);
        assert!(ceiling_for("today", now).is_none());
        assert!(ceiling_for("7d", now).is_none());
    }

    #[test]
    fn the_wider_windows_look_back_from_now() {
        let now = local(2026, 8, 19, 12);
        assert!(cutoff_for("30d", now) < cutoff_for("7d", now));
        assert!(cutoff_for("7d", now) < cutoff_for("today", now));
    }

    #[test]
    fn an_unknown_window_falls_back_to_today_rather_than_everything() {
        let now = local(2026, 8, 19, 12);
        assert_eq!(cutoff_for("nonsense", now), cutoff_for("today", now));
    }

    #[test]
    fn a_workload_deployed_today_that_is_not_running_is_the_headline() {
        assert_eq!(health_of(0, 3).0, "critical");
        assert_eq!(health_of(1, 3).0, "warning");
        assert_eq!(health_of(3, 3).0, "good");
    }

    #[test]
    fn scaled_to_zero_is_not_reported_as_a_failure() {
        // Nothing is broken; it was deployed and deliberately runs no replicas.
        let (health, reason) = health_of(0, 0);
        assert_eq!(health, "warning");
        assert!(reason.contains("Scaled to zero"));
    }

    fn owner(kind: &str) -> kube::core::ObjectMeta {
        let mut metadata = kube::core::ObjectMeta::default();
        metadata.owner_references = Some(vec![
            k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference {
                kind: kind.to_string(),
                name: "parent".to_string(),
                uid: "abc".to_string(),
                api_version: "v1".to_string(),
                ..Default::default()
            },
        ]);
        metadata
    }

    #[test]
    fn a_job_that_a_cronjob_spawned_is_not_a_deployment() {
        // Otherwise every nightly run would fill the report.
        assert!(spawned_by_cron(&owner("CronJob")));
    }

    #[test]
    fn a_job_someone_created_themselves_is_counted() {
        assert!(!spawned_by_cron(&kube::core::ObjectMeta::default()));
        assert!(!spawned_by_cron(&owner("Workflow")));
    }

    #[test]
    fn the_creating_tool_is_named_from_labels_or_annotations() {
        let mut metadata = kube::core::ObjectMeta::default();
        let mut labels = std::collections::BTreeMap::new();
        labels.insert("app.kubernetes.io/managed-by".to_string(), "Helm".to_string());
        metadata.labels = Some(labels);
        assert_eq!(managed_by(&metadata), Some("Helm".to_string()));

        let mut argo = kube::core::ObjectMeta::default();
        let mut argo_labels = std::collections::BTreeMap::new();
        argo_labels.insert("argocd.argoproj.io/instance".to_string(), "checkout".to_string());
        argo.labels = Some(argo_labels);
        assert_eq!(managed_by(&argo), Some("Argo CD".to_string()));

        assert_eq!(managed_by(&kube::core::ObjectMeta::default()), None);
    }
}
