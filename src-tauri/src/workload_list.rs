use k8s_openapi::api::{
    apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet},
    batch::v1::{CronJob, Job},
};
use kube::{api::ListParams, Api, Client};
use serde::Serialize;

use crate::format_age;

/// One row shape for every controller kind.
///
/// The kinds differ in what "ready" means — a DaemonSet targets one pod per eligible
/// node, a Job targets a completion count, a CronJob has no replicas at all — so each
/// adapter resolves its own numbers and says in words what they mean. The UI then has
/// a single table instead of six.
#[derive(Serialize, Clone)]
pub struct WorkloadRow {
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub ready: i32,
    pub desired: i32,
    /// What the two numbers count for this kind: replicas, nodes, completions.
    pub unit: String,
    pub detail: String,
    pub health: String,
    pub suspended: bool,
    pub images: Vec<String>,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct WorkloadInventory {
    pub rows: Vec<WorkloadRow>,
    pub degraded_collectors: Vec<String>,
}

fn health_for(ready: i32, desired: i32, suspended: bool) -> &'static str {
    if suspended {
        return "warning";
    }
    if desired == 0 {
        return "good";
    }
    if ready == 0 {
        return "critical";
    }
    if ready < desired {
        return "serious";
    }
    "good"
}

fn images_of(spec: Option<&k8s_openapi::api::core::v1::PodSpec>) -> Vec<String> {
    spec.map(|spec| spec.containers.iter().filter_map(|container| container.image.clone()).collect())
        .unwrap_or_default()
}

fn age_of(meta: &kube::core::ObjectMeta) -> String {
    meta.creation_timestamp
        .as_ref()
        .map(|stamp| format_age(stamp.0))
        .unwrap_or_else(|| "n/a".to_string())
}

pub async fn collect(client: Client, namespace: &str) -> Result<WorkloadInventory, String> {
    let params = ListParams::default();
    let deployments: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    let statefulsets: Api<StatefulSet> = Api::namespaced(client.clone(), namespace);
    let daemonsets: Api<DaemonSet> = Api::namespaced(client.clone(), namespace);
    let jobs: Api<Job> = Api::namespaced(client.clone(), namespace);
    let cronjobs: Api<CronJob> = Api::namespaced(client.clone(), namespace);
    let replicasets: Api<ReplicaSet> = Api::namespaced(client, namespace);

    let (deployments, statefulsets, daemonsets, jobs, cronjobs, replicasets) = tokio::join!(
        deployments.list(&params),
        statefulsets.list(&params),
        daemonsets.list(&params),
        jobs.list(&params),
        cronjobs.list(&params),
        replicasets.list(&params),
    );

    let mut rows = Vec::new();
    let mut degraded_collectors = Vec::new();
    let mut note = |kind: &str, error: kube::Error, degraded: &mut Vec<String>| {
        degraded.push(format!("{kind} could not be listed ({error})."));
    };

    match deployments {
        Ok(list) => rows.extend(list.items.into_iter().map(|item| {
            let desired = item.spec.as_ref().and_then(|spec| spec.replicas).unwrap_or(1);
            let ready = item.status.as_ref().and_then(|status| status.ready_replicas).unwrap_or(0);
            WorkloadRow {
                kind: "Deployment".into(),
                images: images_of(item.spec.as_ref().and_then(|spec| spec.template.spec.as_ref())),
                detail: format!("{ready} of {desired} replicas ready"),
                health: health_for(ready, desired, false).into(),
                unit: "replicas".into(),
                suspended: false,
                age: age_of(&item.metadata),
                namespace: item.metadata.namespace.unwrap_or_default(),
                name: item.metadata.name.unwrap_or_default(),
                ready,
                desired,
            }
        })),
        Err(error) => note("Deployments", error, &mut degraded_collectors),
    }

    match statefulsets {
        Ok(list) => rows.extend(list.items.into_iter().map(|item| {
            let desired = item.spec.as_ref().and_then(|spec| spec.replicas).unwrap_or(1);
            let ready = item.status.as_ref().and_then(|status| status.ready_replicas).unwrap_or(0);
            WorkloadRow {
                kind: "StatefulSet".into(),
                images: images_of(item.spec.as_ref().and_then(|spec| spec.template.spec.as_ref())),
                detail: format!("{ready} of {desired} replicas ready, in order"),
                health: health_for(ready, desired, false).into(),
                unit: "replicas".into(),
                suspended: false,
                age: age_of(&item.metadata),
                namespace: item.metadata.namespace.unwrap_or_default(),
                name: item.metadata.name.unwrap_or_default(),
                ready,
                desired,
            }
        })),
        Err(error) => note("StatefulSets", error, &mut degraded_collectors),
    }

    match daemonsets {
        Ok(list) => rows.extend(list.items.into_iter().map(|item| {
            // A DaemonSet's target is the number of nodes it is meant to run on, which
            // the scheduler computes — not a replica count anyone set.
            let desired = item.status.as_ref().map(|status| status.desired_number_scheduled).unwrap_or(0);
            let ready = item.status.as_ref().map(|status| status.number_ready).unwrap_or(0);
            let misscheduled = item.status.as_ref().map(|status| status.number_misscheduled).unwrap_or(0);
            WorkloadRow {
                kind: "DaemonSet".into(),
                images: images_of(item.spec.as_ref().and_then(|spec| spec.template.spec.as_ref())),
                detail: if misscheduled > 0 {
                    format!("{ready} of {desired} eligible nodes ready, {misscheduled} misscheduled")
                } else {
                    format!("{ready} of {desired} eligible nodes ready")
                },
                health: health_for(ready, desired, false).into(),
                unit: "nodes".into(),
                suspended: false,
                age: age_of(&item.metadata),
                namespace: item.metadata.namespace.unwrap_or_default(),
                name: item.metadata.name.unwrap_or_default(),
                ready,
                desired,
            }
        })),
        Err(error) => note("DaemonSets", error, &mut degraded_collectors),
    }

    match jobs {
        Ok(list) => rows.extend(list.items.into_iter().map(|item| {
            let spec = item.spec.clone().unwrap_or_default();
            let status = item.status.clone().unwrap_or_default();
            let desired = spec.completions.unwrap_or(1);
            let succeeded = status.succeeded.unwrap_or(0);
            let failed = status.failed.unwrap_or(0);
            let suspended = spec.suspend.unwrap_or(false);

            // A finished Job is not a degraded one: success is the terminal state.
            let health = if suspended {
                "warning"
            } else if failed > 0 && succeeded < desired {
                "critical"
            } else if succeeded >= desired {
                "good"
            } else {
                "serious"
            };

            WorkloadRow {
                kind: "Job".into(),
                images: images_of(spec.template.spec.as_ref()),
                detail: if failed > 0 {
                    format!("{succeeded} of {desired} completions, {failed} failed attempt(s)")
                } else if succeeded >= desired {
                    format!("completed {succeeded} of {desired}")
                } else {
                    format!("{succeeded} of {desired} completions")
                },
                health: health.into(),
                unit: "completions".into(),
                suspended,
                age: age_of(&item.metadata),
                namespace: item.metadata.namespace.unwrap_or_default(),
                name: item.metadata.name.unwrap_or_default(),
                ready: succeeded,
                desired,
            }
        })),
        Err(error) => note("Jobs", error, &mut degraded_collectors),
    }

    match cronjobs {
        Ok(list) => rows.extend(list.items.into_iter().map(|item| {
            let spec = item.spec.clone().unwrap_or_default();
            let status = item.status.clone().unwrap_or_default();
            let active = status.active.map(|entries| entries.len()).unwrap_or(0) as i32;
            let suspended = spec.suspend.unwrap_or(false);
            let last = status
                .last_schedule_time
                .map(|stamp| format!("last run {} ago", format_age(stamp.0)))
                .unwrap_or_else(|| "never run".to_string());

            WorkloadRow {
                kind: "CronJob".into(),
                images: images_of(spec.job_template.spec.as_ref().and_then(|job| job.template.spec.as_ref())),
                detail: if suspended {
                    format!("suspended · {} · {last}", spec.schedule)
                } else {
                    format!("{} · {last}", spec.schedule)
                },
                // A CronJob is healthy when idle; active runs are not a target to meet.
                health: if suspended { "warning".into() } else { "good".to_string() },
                unit: "active runs".into(),
                suspended,
                age: age_of(&item.metadata),
                namespace: item.metadata.namespace.unwrap_or_default(),
                name: item.metadata.name.unwrap_or_default(),
                ready: active,
                desired: active,
            }
        })),
        Err(error) => note("CronJobs", error, &mut degraded_collectors),
    }

    match replicasets {
        Ok(list) => rows.extend(
            list.items
                .into_iter()
                // A ReplicaSet owned by a Deployment is an implementation detail of it;
                // listing every historical revision would bury the workloads themselves.
                .filter(|item| item.metadata.owner_references.as_ref().map(Vec::is_empty).unwrap_or(true))
                .map(|item| {
                    let desired = item.spec.as_ref().and_then(|spec| spec.replicas).unwrap_or(1);
                    let ready = item.status.as_ref().and_then(|status| status.ready_replicas).unwrap_or(0);
                    WorkloadRow {
                        kind: "ReplicaSet".into(),
                        images: images_of(
                            item.spec.as_ref().and_then(|spec| spec.template.as_ref()).and_then(|t| t.spec.as_ref()),
                        ),
                        detail: format!("{ready} of {desired} replicas ready, unmanaged"),
                        health: health_for(ready, desired, false).into(),
                        unit: "replicas".into(),
                        suspended: false,
                        age: age_of(&item.metadata),
                        namespace: item.metadata.namespace.unwrap_or_default(),
                        name: item.metadata.name.unwrap_or_default(),
                        ready,
                        desired,
                    }
                }),
        ),
        Err(error) => note("ReplicaSets", error, &mut degraded_collectors),
    }

    let rank = |health: &str| match health {
        "critical" => 0,
        "serious" => 1,
        "warning" => 2,
        _ => 3,
    };
    rows.sort_by(|left, right| {
        rank(&left.health)
            .cmp(&rank(&right.health))
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(WorkloadInventory { rows, degraded_collectors })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_health_from_ready_against_desired() {
        assert_eq!(health_for(3, 3, false), "good");
        assert_eq!(health_for(1, 3, false), "serious");
        assert_eq!(health_for(0, 3, false), "critical");
        // Scaled to zero on purpose is not a fault.
        assert_eq!(health_for(0, 0, false), "good");
        // Suspension is deliberate, and outranks the replica numbers.
        assert_eq!(health_for(0, 3, true), "warning");
        assert_eq!(health_for(3, 3, true), "warning");
    }
}
