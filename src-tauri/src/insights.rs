//! The report catalogue.
//!
//! Every report answers a different question, but they all produce the same shape:
//! ordered columns, rows of cells, a severity per row and a sentence saying what the
//! whole thing amounts to. One shape means one table component, one CSV path and one
//! set of sorting rules, instead of six of each drifting apart.

use k8s_openapi::api::{
    apps::v1::{Deployment, ReplicaSet, StatefulSet},
    batch::v1::Job,
    core::v1::{ConfigMap, Node, PersistentVolume, PersistentVolumeClaim, Pod, Secret},
    networking::v1::NetworkPolicy,
    policy::v1::PodDisruptionBudget,
};
use kube::{api::ListParams, Api, Client};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::configuration::parse_quantity;
use crate::format_age;

#[derive(Serialize, Clone)]
pub struct ReportColumn {
    pub key: String,
    pub header: String,
    /// Rendered in a monospace cell. Names, images and sizes read better that way.
    pub mono: bool,
}

#[derive(Serialize, Clone)]
pub struct ReportRow {
    /// Stable identity for the row, used as a React key and for de-duplication.
    pub key: String,
    pub cells: BTreeMap<String, String>,
    pub severity: String,
}

#[derive(Serialize, Clone)]
pub struct ReportResult {
    pub id: String,
    pub title: String,
    /// One sentence saying what the report amounts to. Read before the table.
    pub summary: String,
    pub columns: Vec<ReportColumn>,
    pub rows: Vec<ReportRow>,
    pub degraded_collectors: Vec<String>,
}

fn column(key: &str, header: &str, mono: bool) -> ReportColumn {
    ReportColumn { key: key.to_string(), header: header.to_string(), mono }
}

/// Builds a row from pairs, so each report reads as a table of its own values rather
/// than as map plumbing.
fn row(key: String, severity: &str, cells: &[(&str, String)]) -> ReportRow {
    ReportRow {
        key,
        severity: severity.to_string(),
        cells: cells.iter().map(|(name, value)| (name.to_string(), value.clone())).collect(),
    }
}

pub fn severity_rank(severity: &str) -> u8 {
    match severity {
        "critical" => 4,
        "serious" => 3,
        "warning" => 2,
        _ => 0,
    }
}

/// Worst first, then by the row key, so a report opens on what matters and is stable
/// between runs.
fn sort_rows(rows: &mut [ReportRow]) {
    rows.sort_by(|left, right| {
        severity_rank(&right.severity)
            .cmp(&severity_rank(&left.severity))
            .then_with(|| left.key.cmp(&right.key))
    });
}

// ---------------------------------------------------------------- shared reads

/// The pods of the chosen namespaces, read once and shared by every report that needs
/// to know what is actually running.
async fn pods_in(client: &Client, namespaces: &[String], degraded: &mut Vec<String>) -> Vec<Pod> {
    let mut all = Vec::new();
    for namespace in namespaces {
        let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
        match api.list(&ListParams::default()).await {
            Ok(list) => all.extend(list.items),
            Err(error) => degraded.push(format!("Pods in {namespace} could not be listed ({error}).")),
        }
    }
    all
}

fn pod_containers(pod: &Pod) -> Vec<&k8s_openapi::api::core::v1::Container> {
    pod.spec
        .iter()
        .flat_map(|spec| spec.init_containers.iter().flatten().chain(spec.containers.iter()))
        .collect()
}

/// The controller a pod belongs to, walked one level up. A pod owned by a ReplicaSet is
/// reported under its Deployment's name, which is what anyone reading recognises.
fn owner_label(pod: &Pod) -> String {
    let reference = pod.metadata.owner_references.iter().flatten().next();
    match reference {
        Some(owner) if owner.kind == "ReplicaSet" => {
            // A ReplicaSet is named <deployment>-<hash>; trimming the hash names the
            // Deployment without another API call.
            let name = &owner.name;
            match name.rfind('-') {
                Some(index) => format!("Deployment/{}", &name[..index]),
                None => format!("ReplicaSet/{name}"),
            }
        }
        Some(owner) => format!("{}/{}", owner.kind, owner.name),
        None => "bare pod".to_string(),
    }
}

// ---------------------------------------------------------------- 1. idle cost

/// Everything that is provisioned, billed, and doing nothing.
///
/// The individual signals already exist on the Storage and Configuration screens; the
/// point of gathering them here is that idle capacity is a number someone outside the
/// team asks for, and it is not visible while it is spread across five tables.
async fn idle_cost(client: Client, namespaces: Vec<String>) -> ReportResult {
    let params = ListParams::default();
    let mut degraded = Vec::new();
    let mut rows = Vec::new();
    let mut idle_bytes = 0f64;

    let pods = pods_in(&client, &namespaces, &mut degraded).await;

    // Which claims, config maps and secrets any running pod actually uses.
    let mut used_claims = BTreeSet::new();
    let mut used_maps = BTreeSet::new();
    let mut used_secrets = BTreeSet::new();
    for pod in &pods {
        let namespace = pod.metadata.namespace.clone().unwrap_or_default();
        let Some(spec) = &pod.spec else { continue };
        for reference in spec.image_pull_secrets.iter().flatten() {
            used_secrets.insert(format!("{namespace}/{}", reference.name));
        }
        for volume in spec.volumes.iter().flatten() {
            if let Some(claim) = &volume.persistent_volume_claim {
                used_claims.insert(format!("{namespace}/{}", claim.claim_name));
            }
            if let Some(source) = &volume.config_map {
                used_maps.insert(format!("{namespace}/{}", source.name));
            }
            if let Some(source) = &volume.secret {
                if let Some(name) = &source.secret_name {
                    used_secrets.insert(format!("{namespace}/{name}"));
                }
            }
            for source in volume.projected.iter().flat_map(|p| p.sources.iter().flatten()) {
                if let Some(inner) = &source.config_map {
                    used_maps.insert(format!("{namespace}/{}", inner.name));
                }
                if let Some(inner) = &source.secret {
                    used_secrets.insert(format!("{namespace}/{}", inner.name));
                }
            }
        }
        for container in pod_containers(pod) {
            for source in container.env_from.iter().flatten() {
                if let Some(reference) = &source.config_map_ref {
                    used_maps.insert(format!("{namespace}/{}", reference.name));
                }
                if let Some(reference) = &source.secret_ref {
                    used_secrets.insert(format!("{namespace}/{}", reference.name));
                }
            }
            for variable in container.env.iter().flatten() {
                let Some(from) = &variable.value_from else { continue };
                if let Some(reference) = &from.config_map_key_ref {
                    used_maps.insert(format!("{namespace}/{}", reference.name));
                }
                if let Some(reference) = &from.secret_key_ref {
                    used_secrets.insert(format!("{namespace}/{}", reference.name));
                }
            }
        }
    }

    for namespace in &namespaces {
        let claims: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), namespace);
        let maps: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
        let secrets: Api<Secret> = Api::namespaced(client.clone(), namespace);
        let deployments: Api<Deployment> = Api::namespaced(client.clone(), namespace);
        let jobs: Api<Job> = Api::namespaced(client.clone(), namespace);

        let (claim_list, map_list, secret_list, deployment_list, job_list) = tokio::join!(
            claims.list(&params),
            maps.list(&params),
            secrets.list(&params),
            deployments.list(&params),
            jobs.list(&params),
        );

        if let Ok(list) = claim_list {
            for claim in list.items {
                let name = claim.metadata.name.clone().unwrap_or_default();
                let key = format!("{namespace}/{name}");
                if used_claims.contains(&key) {
                    continue;
                }
                let phase = claim.status.as_ref().and_then(|s| s.phase.clone()).unwrap_or_default();
                if phase != "Bound" {
                    continue;
                }
                let size = claim
                    .status
                    .as_ref()
                    .and_then(|status| status.capacity.as_ref())
                    .and_then(|capacity| capacity.get("storage"))
                    .map(|value| value.0.clone())
                    .unwrap_or_default();
                idle_bytes += parse_quantity(&size).unwrap_or(0.0);
                rows.push(row(
                    key,
                    "serious",
                    &[
                        ("namespace", namespace.clone()),
                        ("kind", "PersistentVolumeClaim".into()),
                        ("name", name),
                        ("amount", size),
                        ("why", "Bound to a volume that no running pod mounts.".into()),
                        ("age", claim.metadata.creation_timestamp.as_ref().map(|s| format_age(s.0)).unwrap_or_default()),
                    ],
                ));
            }
        } else if let Err(error) = claim_list {
            degraded.push(format!("Volume claims in {namespace} could not be listed ({error})."));
        }

        if let Ok(list) = map_list {
            for item in list.items {
                let name = item.metadata.name.clone().unwrap_or_default();
                if name == "kube-root-ca.crt" {
                    continue;
                }
                let key = format!("{namespace}/{name}");
                if used_maps.contains(&key) {
                    continue;
                }
                let bytes: usize = item.data.iter().flatten().map(|(_, value)| value.len()).sum();
                rows.push(row(
                    key,
                    "warning",
                    &[
                        ("namespace", namespace.clone()),
                        ("kind", "ConfigMap".into()),
                        ("name", name),
                        ("amount", format!("{bytes} B")),
                        ("why", "No running pod reads it. It may still be read by something else.".into()),
                        ("age", item.metadata.creation_timestamp.as_ref().map(|s| format_age(s.0)).unwrap_or_default()),
                    ],
                ));
            }
        }

        if let Ok(list) = secret_list {
            for item in list.items {
                let secret_type = item.type_.clone().unwrap_or_default();
                // Service account tokens and Helm history are read by the control plane
                // and by Helm, never by a pod; calling them idle would be wrong.
                if secret_type == "kubernetes.io/service-account-token" || secret_type == "helm.sh/release.v1" {
                    continue;
                }
                let name = item.metadata.name.clone().unwrap_or_default();
                let key = format!("{namespace}/{name}");
                if used_secrets.contains(&key) {
                    continue;
                }
                rows.push(row(
                    key,
                    "warning",
                    &[
                        ("namespace", namespace.clone()),
                        ("kind", "Secret".into()),
                        ("name", name),
                        ("amount", format!("{} keys", item.data.iter().flatten().count())),
                        ("why", "No running pod reads it. It may still be read by something else.".into()),
                        ("age", item.metadata.creation_timestamp.as_ref().map(|s| format_age(s.0)).unwrap_or_default()),
                    ],
                ));
            }
        }

        if let Ok(list) = deployment_list {
            for item in list.items {
                if item.spec.as_ref().and_then(|spec| spec.replicas) != Some(0) {
                    continue;
                }
                let name = item.metadata.name.clone().unwrap_or_default();
                rows.push(row(
                    format!("{namespace}/deploy/{name}"),
                    "warning",
                    &[
                        ("namespace", namespace.clone()),
                        ("kind", "Deployment".into()),
                        ("name", name),
                        ("amount", "0 replicas".into()),
                        ("why", "Scaled to zero. Its config, claims and secrets are still held.".into()),
                        ("age", item.metadata.creation_timestamp.as_ref().map(|s| format_age(s.0)).unwrap_or_default()),
                    ],
                ));
            }
        }

        if let Ok(list) = job_list {
            for item in list.items {
                let finished = item.status.as_ref().and_then(|status| status.completion_time.clone());
                let Some(finished) = finished else { continue };
                let days = (chrono::Utc::now() - finished.0).num_days();
                // A Job that finished a week ago is holding pods and their logs for
                // nothing; ttlSecondsAfterFinished exists precisely to avoid this.
                if days < 7 {
                    continue;
                }
                let name = item.metadata.name.clone().unwrap_or_default();
                rows.push(row(
                    format!("{namespace}/job/{name}"),
                    "warning",
                    &[
                        ("namespace", namespace.clone()),
                        ("kind", "Job".into()),
                        ("name", name),
                        ("amount", format!("{days} days old")),
                        ("why", "Completed long ago and never cleaned up. Set ttlSecondsAfterFinished.".into()),
                        ("age", format_age(finished.0)),
                    ],
                ));
            }
        }
    }

    // Released volumes are cluster-scoped, and the most expensive item on the list.
    let volumes: Api<PersistentVolume> = Api::all(client);
    match volumes.list(&params).await {
        Ok(list) => {
            for volume in list.items {
                let spec = volume.spec.clone().unwrap_or_default();
                let phase = volume.status.as_ref().and_then(|s| s.phase.clone()).unwrap_or_default();
                let reclaim = spec.persistent_volume_reclaim_policy.unwrap_or_default();
                if phase != "Released" || reclaim != "Retain" {
                    continue;
                }
                // Only volumes whose claim was in a chosen namespace, so the report
                // stays scoped to what was asked for.
                let claim_namespace = spec.claim_ref.as_ref().and_then(|r| r.namespace.clone()).unwrap_or_default();
                if !namespaces.contains(&claim_namespace) {
                    continue;
                }
                let size = spec
                    .capacity
                    .as_ref()
                    .and_then(|capacity| capacity.get("storage"))
                    .map(|value| value.0.clone())
                    .unwrap_or_default();
                idle_bytes += parse_quantity(&size).unwrap_or(0.0);
                let name = volume.metadata.name.clone().unwrap_or_default();
                rows.push(row(
                    format!("pv/{name}"),
                    "critical",
                    &[
                        ("namespace", claim_namespace),
                        ("kind", "PersistentVolume".into()),
                        ("name", name),
                        ("amount", size),
                        ("why", "Released with Retain: never reused, and billed until deleted by hand.".into()),
                        ("age", volume.metadata.creation_timestamp.as_ref().map(|s| format_age(s.0)).unwrap_or_default()),
                    ],
                ));
            }
        }
        Err(error) => degraded.push(format!("Persistent volumes could not be listed ({error}).")),
    }

    sort_rows(&mut rows);
    let summary = if rows.is_empty() {
        "Nothing idle was found in the selected namespaces.".to_string()
    } else {
        format!(
            "{} idle item(s), holding {} of storage that is provisioned and billed.",
            rows.len(),
            format_bytes(idle_bytes)
        )
    };

    ReportResult {
        id: "idle-cost".into(),
        title: "Idle cost".into(),
        summary,
        columns: vec![
            column("namespace", "Namespace", true),
            column("kind", "Kind", false),
            column("name", "Name", true),
            column("amount", "Amount", true),
            column("why", "Why it is idle", false),
            column("age", "Age", false),
        ],
        rows,
        degraded_collectors: degraded,
    }
}

pub fn format_bytes(bytes: f64) -> String {
    // Written out rather than computed, because a const cannot call powi.
    const UNITS: [(f64, &str); 5] = [
        (1_125_899_906_842_624.0, "Pi"),
        (1_099_511_627_776.0, "Ti"),
        (1_073_741_824.0, "Gi"),
        (1_048_576.0, "Mi"),
        (1024.0, "Ki"),
    ];
    for (size, suffix) in UNITS {
        if bytes >= size {
            let value = bytes / size;
            return if value >= 10.0 {
                format!("{value:.0}{suffix}")
            } else {
                format!("{value:.1}{suffix}")
            };
        }
    }
    format!("{bytes:.0}B")
}

// ---------------------------------------------------------------- 2. upgrade readiness

/// What will go wrong when nodes are drained, which is what a cluster upgrade is.
///
/// Every item here is something that turns a routine rolling upgrade into an outage or
/// a stuck drain, and every one of them is knowable beforehand.
async fn upgrade_readiness(client: Client, namespaces: Vec<String>) -> ReportResult {
    let params = ListParams::default();
    let mut degraded = Vec::new();
    let mut rows = Vec::new();

    let pods = pods_in(&client, &namespaces, &mut degraded).await;

    // A pod with no controller is not recreated when its node goes away. It simply
    // stops existing, and nothing reports that it was ever meant to be running.
    for pod in &pods {
        if pod.metadata.owner_references.iter().flatten().next().is_some() {
            continue;
        }
        let name = pod.metadata.name.clone().unwrap_or_default();
        let namespace = pod.metadata.namespace.clone().unwrap_or_default();
        rows.push(row(
            format!("{namespace}/bare/{name}"),
            "critical",
            &[
                ("namespace", namespace),
                ("kind", "Pod".into()),
                ("name", name),
                ("risk", "No controller".into()),
                ("effect", "Draining its node deletes it permanently. Nothing will recreate it.".into()),
            ],
        ));
    }

    // A pod using a local or hostPath volume is pinned to one node and cannot move.
    for pod in &pods {
        let namespace = pod.metadata.namespace.clone().unwrap_or_default();
        let name = pod.metadata.name.clone().unwrap_or_default();
        let pinned = pod
            .spec
            .iter()
            .flat_map(|spec| spec.volumes.iter().flatten())
            .any(|volume| volume.host_path.is_some());
        if pinned {
            rows.push(row(
                format!("{namespace}/hostpath/{name}"),
                "serious",
                &[
                    ("namespace", namespace),
                    ("kind", "Pod".into()),
                    ("name", name),
                    ("risk", "hostPath volume".into()),
                    ("effect", "Bound to one node's filesystem. Rescheduling elsewhere loses the data.".into()),
                ],
            ));
        }
    }

    for namespace in &namespaces {
        let deployments: Api<Deployment> = Api::namespaced(client.clone(), namespace);
        let stateful: Api<StatefulSet> = Api::namespaced(client.clone(), namespace);
        let budgets: Api<PodDisruptionBudget> = Api::namespaced(client.clone(), namespace);

        let (deployment_list, stateful_list, budget_list) =
            tokio::join!(deployments.list(&params), stateful.list(&params), budgets.list(&params));

        let budgets_present = budget_list.as_ref().map(|list| !list.items.is_empty()).unwrap_or(false);

        if let Ok(list) = budget_list {
            for budget in list.items {
                let status = budget.status.clone().unwrap_or_default();
                if status.disruptions_allowed > 0 {
                    continue;
                }
                let name = budget.metadata.name.clone().unwrap_or_default();
                rows.push(row(
                    format!("{namespace}/pdb/{name}"),
                    "critical",
                    &[
                        ("namespace", namespace.clone()),
                        ("kind", "PodDisruptionBudget".into()),
                        ("name", name),
                        ("risk", "Allows no eviction".into()),
                        (
                            "effect",
                            format!(
                                "A drain of any node running these pods blocks until the budget is met. \
                                 {} of {} healthy.",
                                status.current_healthy, status.desired_healthy
                            ),
                        ),
                    ],
                ));
            }
        }

        if let Ok(list) = deployment_list {
            for item in list.items {
                let replicas = item.spec.as_ref().and_then(|spec| spec.replicas).unwrap_or(1);
                let name = item.metadata.name.clone().unwrap_or_default();
                if replicas == 1 {
                    rows.push(row(
                        format!("{namespace}/single/{name}"),
                        "serious",
                        &[
                            ("namespace", namespace.clone()),
                            ("kind", "Deployment".into()),
                            ("name", name.clone()),
                            ("risk", "Single replica".into()),
                            ("effect", "Its only pod is evicted during the drain, so the service is down until it restarts elsewhere.".into()),
                        ],
                    ));
                }
                if !budgets_present && replicas > 1 {
                    rows.push(row(
                        format!("{namespace}/nopdb/{name}"),
                        "warning",
                        &[
                            ("namespace", namespace.clone()),
                            ("kind", "Deployment".into()),
                            ("name", name),
                            ("risk", "No disruption budget".into()),
                            ("effect", "Nothing stops every replica being evicted at once.".into()),
                        ],
                    ));
                }
            }
        }

        if let Ok(list) = stateful_list {
            for item in list.items {
                if item.spec.as_ref().and_then(|spec| spec.replicas).unwrap_or(1) != 1 {
                    continue;
                }
                let name = item.metadata.name.clone().unwrap_or_default();
                rows.push(row(
                    format!("{namespace}/single-sts/{name}"),
                    "serious",
                    &[
                        ("namespace", namespace.clone()),
                        ("kind", "StatefulSet".into()),
                        ("name", name),
                        ("risk", "Single replica".into()),
                        ("effect", "Stateful and unreplicated: the drain takes it offline with no standby.".into()),
                    ],
                ));
            }
        }
    }

    // Nodes already unschedulable mean the cluster has less room than it looks.
    let nodes: Api<Node> = Api::all(client);
    match nodes.list(&params).await {
        Ok(list) => {
            for node in list.items {
                let name = node.metadata.name.clone().unwrap_or_default();
                let spec = node.spec.clone().unwrap_or_default();
                let ready = node
                    .status
                    .as_ref()
                    .and_then(|status| status.conditions.as_ref())
                    .map(|conditions| {
                        conditions.iter().any(|c| c.type_ == "Ready" && c.status == "True")
                    })
                    .unwrap_or(false);

                if !ready {
                    rows.push(row(
                        format!("node/{name}"),
                        "critical",
                        &[
                            ("namespace", "cluster".into()),
                            ("kind", "Node".into()),
                            ("name", name.clone()),
                            ("risk", "Not ready".into()),
                            ("effect", "This node cannot take evicted pods, so there is less room for the upgrade than the node count suggests.".into()),
                        ],
                    ));
                } else if spec.unschedulable.unwrap_or(false) {
                    rows.push(row(
                        format!("node/{name}"),
                        "warning",
                        &[
                            ("namespace", "cluster".into()),
                            ("kind", "Node".into()),
                            ("name", name),
                            ("risk", "Cordoned".into()),
                            ("effect", "Already unschedulable. Evicted pods cannot land here.".into()),
                        ],
                    ));
                }
            }
        }
        Err(error) => degraded.push(format!("Nodes could not be listed ({error}).")),
    }

    sort_rows(&mut rows);
    let blockers = rows.iter().filter(|entry| entry.severity == "critical").count();
    let summary = if rows.is_empty() {
        "Nothing found that would block or disrupt a rolling node drain.".to_string()
    } else if blockers > 0 {
        format!("{} item(s) to handle before upgrading, {blockers} of which will block a drain outright.", rows.len())
    } else {
        format!("{} item(s) that will cause disruption during a rolling upgrade.", rows.len())
    };

    ReportResult {
        id: "upgrade-readiness".into(),
        title: "Upgrade readiness".into(),
        summary,
        columns: vec![
            column("namespace", "Namespace", true),
            column("kind", "Kind", false),
            column("name", "Name", true),
            column("risk", "Risk", false),
            column("effect", "What happens on drain", false),
        ],
        rows,
        degraded_collectors: degraded,
    }
}

// ---------------------------------------------------------------- 3. security posture

/// What is running with more privilege than it needs.
///
/// Each finding names the container rather than only the workload, because that is the
/// level at which the setting lives and at which it has to be fixed.
async fn security_posture(client: Client, namespaces: Vec<String>) -> ReportResult {
    let params = ListParams::default();
    let mut degraded = Vec::new();
    let mut rows = Vec::new();

    let pods = pods_in(&client, &namespaces, &mut degraded).await;

    for pod in &pods {
        let namespace = pod.metadata.namespace.clone().unwrap_or_default();
        let workload = owner_label(pod);
        let Some(spec) = &pod.spec else { continue };

        let mut pod_level = |risk: &str, severity: &str, detail: &str| {
            rows.push(row(
                format!("{namespace}/{workload}/{risk}"),
                severity,
                &[
                    ("namespace", namespace.clone()),
                    ("workload", workload.clone()),
                    ("container", "—".into()),
                    ("risk", risk.to_string()),
                    ("detail", detail.to_string()),
                ],
            ));
        };

        if spec.host_network.unwrap_or(false) {
            pod_level("hostNetwork", "critical", "Shares the node's network stack, so it can reach anything the node can and bypasses NetworkPolicy.");
        }
        if spec.host_pid.unwrap_or(false) {
            pod_level("hostPID", "critical", "Sees and can signal every process on the node.");
        }
        if spec.host_ipc.unwrap_or(false) {
            pod_level("hostIPC", "serious", "Shares the node's IPC namespace with every other process on it.");
        }
        if spec.automount_service_account_token.unwrap_or(true) {
            pod_level(
                "Mounts its API token",
                "warning",
                "The service account token is mounted whether or not it is used. Set automountServiceAccountToken: false unless it calls the API.",
            );
        }
        for volume in spec.volumes.iter().flatten() {
            if let Some(path) = &volume.host_path {
                rows.push(row(
                    format!("{namespace}/{workload}/hostPath/{}", path.path),
                    "critical",
                    &[
                        ("namespace", namespace.clone()),
                        ("workload", workload.clone()),
                        ("container", "—".into()),
                        ("risk", "hostPath volume".into()),
                        ("detail", format!("Mounts {} from the node's filesystem.", path.path)),
                    ],
                ));
            }
        }

        for container in pod_containers(pod) {
            let name = container.name.clone();
            let mut flag = |risk: &str, severity: &str, detail: String| {
                rows.push(row(
                    format!("{namespace}/{workload}/{name}/{risk}"),
                    severity,
                    &[
                        ("namespace", namespace.clone()),
                        ("workload", workload.clone()),
                        ("container", name.clone()),
                        ("risk", risk.to_string()),
                        ("detail", detail),
                    ],
                ));
            };

            let security = container.security_context.as_ref();
            if security.and_then(|context| context.privileged).unwrap_or(false) {
                flag("Privileged", "critical", "Effectively root on the node, with every capability.".into());
            }
            if security.and_then(|context| context.allow_privilege_escalation).unwrap_or(true) {
                flag(
                    "Privilege escalation allowed",
                    "warning",
                    "allowPrivilegeEscalation is not set to false, so a process inside can gain more privilege than its parent.".into(),
                );
            }
            if security.and_then(|context| context.run_as_non_root).is_none()
                && spec.security_context.as_ref().and_then(|context| context.run_as_non_root).is_none()
            {
                flag(
                    "May run as root",
                    "serious",
                    "Neither the pod nor the container sets runAsNonRoot, so the image's user is whatever it chose.".into(),
                );
            }
            if let Some(added) = security.and_then(|context| context.capabilities.as_ref()).and_then(|c| c.add.as_ref()) {
                if !added.is_empty() {
                    flag(
                        "Extra capabilities",
                        "serious",
                        format!("Adds {}.", added.join(", ")),
                    );
                }
            }
            if let Some(image) = &container.image {
                if image.ends_with(":latest") || !image.contains(':') {
                    flag(
                        "Unpinned image",
                        "serious",
                        format!("{image} is not pinned to a version, so what runs after a restart is not what runs now."),
                    );
                }
            }
        }
    }

    // A namespace with no NetworkPolicy at all allows every pod to reach every other.
    for namespace in &namespaces {
        let policies: Api<NetworkPolicy> = Api::namespaced(client.clone(), namespace);
        match policies.list(&params).await {
            Ok(list) if list.items.is_empty() => rows.push(row(
                format!("{namespace}/no-netpol"),
                "serious",
                &[
                    ("namespace", namespace.clone()),
                    ("workload", "—".into()),
                    ("container", "—".into()),
                    ("risk", "No network policy".into()),
                    ("detail", "Nothing restricts traffic in or out of this namespace; every pod can reach every other.".into()),
                ],
            )),
            Ok(_) => {}
            Err(error) => degraded.push(format!("Network policies in {namespace} could not be listed ({error}).")),
        }
    }

    sort_rows(&mut rows);
    let critical = rows.iter().filter(|entry| entry.severity == "critical").count();
    let summary = if rows.is_empty() {
        "Nothing in the selected namespaces runs with more privilege than it needs.".to_string()
    } else {
        format!("{} finding(s), {critical} of them serious enough to be a way onto the node.", rows.len())
    };

    ReportResult {
        id: "security-posture".into(),
        title: "Security posture".into(),
        summary,
        columns: vec![
            column("namespace", "Namespace", true),
            column("workload", "Workload", true),
            column("container", "Container", true),
            column("risk", "Risk", false),
            column("detail", "Detail", false),
        ],
        rows,
        degraded_collectors: degraded,
    }
}

// ---------------------------------------------------------------- 4. image hygiene

/// Every distinct image running, and where.
///
/// The question this exists for is asked under time pressure: a CVE lands against a
/// version and someone needs to know every place it is running, right now.
async fn image_hygiene(client: Client, namespaces: Vec<String>) -> ReportResult {
    let mut degraded = Vec::new();
    let pods = pods_in(&client, &namespaces, &mut degraded).await;

    struct Usage {
        workloads: BTreeSet<String>,
        namespaces: BTreeSet<String>,
        pull_policies: BTreeSet<String>,
        pods: usize,
    }
    let mut by_image: HashMap<String, Usage> = HashMap::new();

    for pod in &pods {
        let namespace = pod.metadata.namespace.clone().unwrap_or_default();
        let workload = owner_label(pod);
        for container in pod_containers(pod) {
            let Some(image) = &container.image else { continue };
            let entry = by_image.entry(image.clone()).or_insert_with(|| Usage {
                workloads: BTreeSet::new(),
                namespaces: BTreeSet::new(),
                pull_policies: BTreeSet::new(),
                pods: 0,
            });
            entry.workloads.insert(workload.clone());
            entry.namespaces.insert(namespace.clone());
            entry.pods += 1;
            if let Some(policy) = &container.image_pull_policy {
                entry.pull_policies.insert(policy.clone());
            }
        }
    }

    let mut rows: Vec<ReportRow> = by_image
        .into_iter()
        .map(|(image, usage)| {
            let (registry, rest) = split_registry(&image);
            let (repository, tag) = match rest.rsplit_once(':') {
                Some((repository, tag)) => (repository.to_string(), tag.to_string()),
                None => (rest.clone(), "latest (implied)".to_string()),
            };

            let (severity, note) = if tag.starts_with("latest") {
                (
                    "serious",
                    "Not pinned. What runs after the next restart is not necessarily what runs now.",
                )
            } else if registry == "docker.io" || registry.is_empty() {
                (
                    "warning",
                    "Pulled from Docker Hub, which rate-limits and is outside your control.",
                )
            } else {
                ("good", "Pinned to a version.")
            };

            row(
                image.clone(),
                severity,
                &[
                    ("registry", if registry.is_empty() { "docker.io".into() } else { registry }),
                    ("repository", repository),
                    ("tag", tag),
                    ("namespaces", usage.namespaces.iter().cloned().collect::<Vec<_>>().join(", ")),
                    ("workloads", usage.workloads.iter().cloned().collect::<Vec<_>>().join(", ")),
                    ("pods", usage.pods.to_string()),
                    ("pull", usage.pull_policies.iter().cloned().collect::<Vec<_>>().join(", ")),
                    ("note", note.to_string()),
                ],
            )
        })
        .collect();

    sort_rows(&mut rows);
    let unpinned = rows.iter().filter(|entry| entry.severity == "serious").count();
    let summary = if rows.is_empty() {
        "No running container was found in the selected namespaces.".to_string()
    } else {
        format!(
            "{} distinct image(s) running{}.",
            rows.len(),
            if unpinned > 0 { format!(", {unpinned} not pinned to a version") } else { String::new() }
        )
    };

    ReportResult {
        id: "image-hygiene".into(),
        title: "Image hygiene".into(),
        summary,
        columns: vec![
            column("registry", "Registry", true),
            column("repository", "Repository", true),
            column("tag", "Tag", true),
            column("namespaces", "Namespaces", true),
            column("workloads", "Workloads", true),
            column("pods", "Pods", false),
            column("pull", "Pull policy", false),
            column("note", "Note", false),
        ],
        rows,
        degraded_collectors: degraded,
    }
}

/// Splits a registry host from the rest of an image reference.
///
/// The rule Docker itself uses: the first segment is a registry only if it looks like a
/// host — it contains a dot or a colon, or it is exactly `localhost`. Otherwise
/// `library/nginx` would read as a registry called `library`.
pub fn split_registry(image: &str) -> (String, String) {
    match image.split_once('/') {
        Some((head, tail)) if head.contains('.') || head.contains(':') || head == "localhost" => {
            (head.to_string(), tail.to_string())
        }
        _ => (String::new(), image.to_string()),
    }
}

// ---------------------------------------------------------------- 5. change trail

/// What changed version, as opposed to what was created.
///
/// Kubernetes records each rollout of a Deployment as a new ReplicaSet, so comparing
/// the newest against the one before it says exactly which image replaced which. This
/// is the report read after an incident.
async fn change_trail(client: Client, namespaces: Vec<String>, window: &str) -> ReportResult {
    let cutoff = crate::reports::cutoff_for(window, chrono::Local::now());
    let ceiling = crate::reports::ceiling_for(window, chrono::Local::now());
    let params = ListParams::default();
    let mut degraded = Vec::new();
    let mut rows = Vec::new();

    for namespace in &namespaces {
        let deployments: Api<Deployment> = Api::namespaced(client.clone(), namespace);
        let replica_sets: Api<ReplicaSet> = Api::namespaced(client.clone(), namespace);
        let (deployment_list, replica_list) = tokio::join!(deployments.list(&params), replica_sets.list(&params));

        let sets = match replica_list {
            Ok(list) => list.items,
            Err(error) => {
                degraded.push(format!("Replica sets in {namespace} could not be listed ({error})."));
                continue;
            }
        };

        let Ok(list) = deployment_list else {
            degraded.push(format!("Deployments in {namespace} could not be listed."));
            continue;
        };

        for deployment in list.items {
            let Some(uid) = deployment.metadata.uid.clone() else { continue };
            let mut owned: Vec<&ReplicaSet> = sets
                .iter()
                .filter(|set| {
                    set.metadata
                        .owner_references
                        .iter()
                        .flatten()
                        .any(|reference| reference.uid == uid)
                })
                .collect();
            if owned.is_empty() {
                continue;
            }
            owned.sort_by_key(|set| std::cmp::Reverse(revision_of(set)));

            let current = owned[0];
            let Some(created) = current.metadata.creation_timestamp.as_ref().map(|stamp| stamp.0) else { continue };
            if created < cutoff || ceiling.is_some_and(|limit| created >= limit) {
                continue;
            }

            let current_images = replica_images(current);
            let previous_images = owned.get(1).map(|set| replica_images(set)).unwrap_or_default();
            let changes = describe_changes(&previous_images, &current_images);

            let name = deployment.metadata.name.clone().unwrap_or_default();
            rows.push(row(
                format!("{namespace}/{name}/{created}"),
                if owned.len() == 1 { "good" } else { "warning" },
                &[
                    ("namespace", namespace.clone()),
                    ("workload", name),
                    ("revision", revision_of(current).map(|value| value.to_string()).unwrap_or_default()),
                    ("changed", if changes.is_empty() { "first rollout".into() } else { changes.join("; ") }),
                    ("at", created.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string()),
                ],
            ));
        }
    }

    rows.sort_by(|left, right| right.cells.get("at").cmp(&left.cells.get("at")));
    let summary = if rows.is_empty() {
        "Nothing changed version in the selected namespaces.".to_string()
    } else {
        format!("{} rollout(s) in the selected namespaces.", rows.len())
    };

    ReportResult {
        id: "change-trail".into(),
        title: "Change trail".into(),
        summary,
        columns: vec![
            column("namespace", "Namespace", true),
            column("workload", "Workload", true),
            column("revision", "Revision", false),
            column("changed", "What changed", true),
            column("at", "At", false),
        ],
        rows,
        degraded_collectors: degraded,
    }
}

fn revision_of(set: &ReplicaSet) -> Option<i64> {
    set.metadata
        .annotations
        .as_ref()?
        .get("deployment.kubernetes.io/revision")?
        .parse()
        .ok()
}

fn replica_images(set: &ReplicaSet) -> Vec<String> {
    set.spec
        .as_ref()
        .and_then(|spec| spec.template.as_ref())
        .and_then(|template| template.spec.as_ref())
        .map(|spec| {
            spec.containers
                .iter()
                .filter_map(|container| container.image.as_ref().map(|image| format!("{}={image}", container.name)))
                .collect()
        })
        .unwrap_or_default()
}

/// Names what a revision changed relative to the one before it. Almost every rollout is
/// an image bump, and naming both tags turns "something was deployed" into "this
/// version replaced that one".
pub fn describe_changes(previous: &[String], current: &[String]) -> Vec<String> {
    let parse = |entries: &[String]| -> BTreeMap<String, String> {
        entries
            .iter()
            .filter_map(|entry| entry.split_once('=').map(|(name, image)| (name.to_string(), image.to_string())))
            .collect()
    };
    // Nothing to compare against: a brand-new workload has not changed, and listing
    // every container as "added" would be noise rather than history.
    if previous.is_empty() {
        return Vec::new();
    }

    let before = parse(previous);
    let after = parse(current);
    let mut changes = Vec::new();

    for (container, image) in &after {
        match before.get(container) {
            Some(old) if old != image => changes.push(format!(
                "{container}: {} → {}",
                tail_of(old),
                tail_of(image)
            )),
            Some(_) => {}
            None => changes.push(format!("{container}: added")),
        }
    }
    for container in before.keys() {
        if !after.contains_key(container) {
            changes.push(format!("{container}: removed"));
        }
    }
    changes.sort();

    if changes.is_empty() {
        changes.push("no image change — configuration or a restart".to_string());
    }
    changes
}

fn tail_of(image: &str) -> String {
    match image.rsplit_once('/') {
        Some((_, tail)) => tail.to_string(),
        None => image.to_string(),
    }
}

/// Which reports exist, what each needs, and what each is for. Returned to the UI so the
/// catalogue is defined once rather than in two places that drift.
#[derive(Serialize, Clone)]
pub struct ReportKind {
    pub id: String,
    pub title: String,
    pub purpose: String,
    /// Every report accepts a namespace filter; none requires one. Left empty, a report
    /// covers the whole cluster, which is how most of these questions are actually asked.
    pub filters_namespaces: bool,
    pub needs_window: bool,
}

pub fn catalogue() -> Vec<ReportKind> {
    vec![
        ReportKind {
            id: "deployed".into(),
            title: "What was deployed".into(),
            purpose: "Workloads that did not exist in the cluster before the window began.".into(),
            filters_namespaces: true,
            needs_window: true,
        },
        ReportKind {
            id: "change-trail".into(),
            title: "Change trail".into(),
            purpose: "What changed version, with the image it replaced. The report to open after an incident.".into(),
            filters_namespaces: true,
            needs_window: true,
        },
        ReportKind {
            id: "idle-cost".into(),
            title: "Idle cost".into(),
            purpose: "Storage, config and workloads that are provisioned, billed, and doing nothing.".into(),
            filters_namespaces: true,
            needs_window: false,
        },
        ReportKind {
            id: "upgrade-readiness".into(),
            title: "Upgrade readiness".into(),
            purpose: "What will block or disrupt a rolling node drain, before you start one.".into(),
            filters_namespaces: true,
            needs_window: false,
        },
        ReportKind {
            id: "security-posture".into(),
            title: "Security posture".into(),
            purpose: "What runs with more privilege than it needs, per container.".into(),
            filters_namespaces: true,
            needs_window: false,
        },
        ReportKind {
            id: "image-hygiene".into(),
            title: "Image hygiene".into(),
            purpose: "Every distinct image running and where, so a CVE can be traced in one pass.".into(),
            filters_namespaces: true,
            needs_window: false,
        },
    ]
}

/// The deploy report, expressed in the shared shape.
///
/// It keeps its own collector in `reports`, because the windowing logic there is tested
/// on its own terms; this only reshapes the result so every report renders and exports
/// through one path.
async fn deployed(client: Client, namespaces: Vec<String>, window: &str) -> Result<ReportResult, String> {
    let report = crate::reports::deployed(client, namespaces, window).await?;
    let total = report.items.len();
    let broken = report.items.iter().filter(|item| item.health == "critical").count();

    let rows = report
        .items
        .into_iter()
        .map(|item| {
            row(
                format!("{}/{}/{}", item.namespace, item.kind, item.name),
                &item.health,
                &[
                    ("namespace", item.namespace),
                    ("name", item.name),
                    ("kind", item.kind),
                    ("detail", item.detail),
                    ("reason", item.reason),
                    ("images", item.images.join(", ")),
                    ("by", item.managed_by.unwrap_or_else(|| "by hand".to_string())),
                    (
                        "at",
                        chrono::DateTime::parse_from_rfc3339(&item.deployed_at)
                            .map(|stamp| stamp.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
                            .unwrap_or(item.deployed_at),
                    ),
                ],
            )
        })
        .collect();

    let summary = if total == 0 {
        "Nothing was deployed in the selected namespaces.".to_string()
    } else if broken > 0 {
        format!("{total} workload(s) deployed, {broken} of them not running.")
    } else {
        format!("{total} workload(s) deployed, all running.")
    };

    Ok(ReportResult {
        id: "deployed".into(),
        title: "What was deployed".into(),
        summary,
        columns: vec![
            column("namespace", "Namespace", true),
            column("name", "Workload", true),
            column("kind", "Kind", false),
            column("detail", "Detail", true),
            column("reason", "State", false),
            column("images", "Images", true),
            column("by", "Deployed by", false),
            column("at", "At", false),
        ],
        rows,
        degraded_collectors: report.degraded_collectors,
    })
}

/// An empty filter means the whole cluster, so the caller does not have to enumerate
/// namespaces to ask a cluster-wide question.
async fn resolve_namespaces(client: &Client, chosen: Vec<String>) -> Result<Vec<String>, String> {
    if !chosen.is_empty() {
        return Ok(chosen);
    }
    let api: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client.clone());
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|error| crate::errors::humanize(&error.to_string()))?;
    Ok(list.items.into_iter().filter_map(|item| item.metadata.name).collect())
}

pub async fn run(
    client: Client,
    report: &str,
    namespaces: Vec<String>,
    window: &str,
) -> Result<ReportResult, String> {
    let namespaces = resolve_namespaces(&client, namespaces).await?;
    match report {
        "deployed" => deployed(client, namespaces, window).await,
        "idle-cost" => Ok(idle_cost(client, namespaces).await),
        "upgrade-readiness" => Ok(upgrade_readiness(client, namespaces).await),
        "security-posture" => Ok(security_posture(client, namespaces).await),
        "image-hygiene" => Ok(image_hygiene(client, namespaces).await),
        "change-trail" => Ok(change_trail(client, namespaces, window).await),
        other => Err(format!("{other} is not a report this app knows how to build.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registry_is_only_split_off_when_it_looks_like_a_host() {
        assert_eq!(split_registry("registry.example.com/acme/api:1.0"), ("registry.example.com".into(), "acme/api:1.0".into()));
        assert_eq!(split_registry("localhost:5000/api:1.0"), ("localhost:5000".into(), "api:1.0".into()));
        // Otherwise `library/nginx` would read as a registry called `library`.
        assert_eq!(split_registry("library/nginx:1.25"), ("".into(), "library/nginx:1.25".into()));
        assert_eq!(split_registry("nginx:1.25"), ("".into(), "nginx:1.25".into()));
    }

    #[test]
    fn an_image_bump_names_both_tags() {
        let changes = describe_changes(
            &["api=registry.example.com/acme/checkout:1.4.2".into()],
            &["api=registry.example.com/acme/checkout:1.4.3".into()],
        );
        assert_eq!(changes, vec!["api: checkout:1.4.2 → checkout:1.4.3"]);
    }

    #[test]
    fn a_rollout_with_no_image_change_says_what_it_was_not() {
        // A restart also creates a revision; claiming an image change would be wrong,
        // and saying nothing would look like a bug.
        let changes = describe_changes(&["api=acme/a:1".into()], &["api=acme/a:1".into()]);
        assert_eq!(changes, vec!["no image change — configuration or a restart"]);
    }

    #[test]
    fn a_first_rollout_claims_no_diff() {
        assert!(describe_changes(&[], &["api=acme/a:1".into()]).is_empty());
    }

    #[test]
    fn added_and_removed_containers_are_both_named() {
        let changes = describe_changes(
            &["api=acme/a:1".into(), "sidecar=acme/envoy:1".into()],
            &["api=acme/a:1".into(), "metrics=acme/m:1".into()],
        );
        assert!(changes.contains(&"metrics: added".to_string()));
        assert!(changes.contains(&"sidecar: removed".to_string()));
    }

    #[test]
    fn rows_are_ordered_worst_first_then_stably() {
        let mut rows = vec![
            row("b".into(), "warning", &[]),
            row("a".into(), "critical", &[]),
            row("c".into(), "critical", &[]),
            row("d".into(), "good", &[]),
        ];
        sort_rows(&mut rows);
        assert_eq!(
            rows.iter().map(|entry| entry.key.as_str()).collect::<Vec<_>>(),
            vec!["a", "c", "b", "d"]
        );
    }

    #[test]
    fn a_pod_owned_by_a_replicaset_is_reported_under_its_deployment() {
        let mut pod = Pod::default();
        pod.metadata.owner_references = Some(vec![k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference {
            kind: "ReplicaSet".into(),
            name: "checkout-api-7d9f8b6c4d".into(),
            uid: "x".into(),
            api_version: "apps/v1".into(),
            ..Default::default()
        }]);
        assert_eq!(owner_label(&pod), "Deployment/checkout-api");
    }

    #[test]
    fn a_pod_with_no_controller_is_named_as_such() {
        // This is the finding, not a formatting fallback: nothing recreates it.
        assert_eq!(owner_label(&Pod::default()), "bare pod");
    }

    #[test]
    fn a_pod_owned_directly_keeps_its_owner_kind() {
        let mut pod = Pod::default();
        pod.metadata.owner_references = Some(vec![k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference {
            kind: "StatefulSet".into(),
            name: "postgres".into(),
            uid: "x".into(),
            api_version: "apps/v1".into(),
            ..Default::default()
        }]);
        assert_eq!(owner_label(&pod), "StatefulSet/postgres");
    }

    #[test]
    fn byte_sizes_scale_to_a_readable_unit() {
        assert_eq!(format_bytes(1024.0 * 1024.0 * 1024.0 * 100.0), "100Gi");
        assert_eq!(format_bytes(1024f64.powi(4) * 2.0), "2.0Ti");
        assert_eq!(format_bytes(0.0), "0B");
    }

        #[test]
    fn every_catalogue_entry_declares_what_it_needs() {
        let entries = catalogue();
        assert!(entries.iter().any(|entry| entry.id == "change-trail" && entry.needs_window));
        // No report requires a namespace: an empty filter means the whole cluster.
        assert!(entries.iter().all(|entry| entry.filters_namespaces));
    }
}
