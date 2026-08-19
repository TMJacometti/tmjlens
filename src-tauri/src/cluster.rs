use k8s_openapi::api::{
    apps::v1::{DaemonSet, Deployment, StatefulSet},
    core::v1::{Event, Node, Pod},
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use kube::{api::ListParams, Api, Client};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

use crate::format_age;

const WARNING_EVENT_LIMIT: u32 = 500;
const PROBLEM_POD_LIMIT: usize = 40;
const TOP_LIST_LIMIT: usize = 12;
const REQUEST_PRESSURE_THRESHOLD: f64 = 85.0;
const USAGE_PRESSURE_THRESHOLD: f64 = 85.0;

#[derive(Serialize, Clone)]
pub struct ClusterOverview {
    pub context: String,
    pub generated_at: String,
    pub control_plane: ControlPlane,
    pub health: HealthSummary,
    pub capacity: CapacitySummary,
    pub nodes: Vec<NodeInfo>,
    pub pods: PodSummary,
    pub workloads: WorkloadSummary,
    pub distribution: Distribution,
    pub events: EventSummary,
    pub findings: Vec<Finding>,
    pub degraded_collectors: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ControlPlane {
    /// Machine-readable provider key: eks, aks, gke, or generic.
    pub provider: String,
    /// Display name for the distribution, e.g. "Amazon EKS" or "Kubernetes".
    pub distribution: String,
    pub endpoint: String,
    pub kubernetes_version: String,
    pub control_plane_minor: Option<u32>,
    pub cluster_name: Option<String>,
    pub region: Option<String>,
    /// AWS account, Azure subscription, or GCP project, depending on the provider.
    pub account_id: Option<String>,
    pub account_label: Option<String>,
    pub provider_status: Option<String>,
    /// Provider-specific control plane build, e.g. the EKS platform version.
    pub provider_version: Option<String>,
    pub oidc_issuer: Option<String>,
    pub metrics_available: bool,
}

#[derive(Serialize, Clone)]
pub struct HealthSummary {
    pub score: u32,
    pub grade: String,
    pub headline: String,
    pub signals: Vec<HealthSignal>,
}

#[derive(Serialize, Clone)]
pub struct HealthSignal {
    pub name: String,
    pub score: u32,
    pub weight: f64,
    pub detail: String,
    pub severity: String,
}

#[derive(Serialize, Clone)]
pub struct CapacitySummary {
    pub cpu: ResourceAxis,
    pub memory: ResourceAxis,
    pub pod_slots: PodSlots,
}

/// CPU is carried in millicores and memory in bytes. Formatting belongs to the UI.
#[derive(Serialize, Clone)]
pub struct ResourceAxis {
    pub allocatable: f64,
    pub requested: f64,
    pub limits: f64,
    pub used: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct PodSlots {
    pub used: usize,
    pub allocatable: i64,
}

#[derive(Serialize, Clone)]
pub struct NodeInfo {
    pub name: String,
    pub ready: bool,
    pub health: String,
    pub roles: Vec<String>,
    pub kubelet_version: String,
    pub kubelet_minor: Option<u32>,
    pub instance_type: String,
    pub capacity_type: String,
    pub node_pool: Option<String>,
    pub zone: String,
    pub architecture: String,
    pub os_image: String,
    pub container_runtime: String,
    pub age: String,
    pub cpu_allocatable_milli: f64,
    pub cpu_requested_milli: f64,
    pub cpu_limit_milli: f64,
    pub cpu_used_milli: Option<f64>,
    pub memory_allocatable_bytes: f64,
    pub memory_requested_bytes: f64,
    pub memory_limit_bytes: f64,
    pub memory_used_bytes: Option<f64>,
    pub pod_count: usize,
    pub pod_capacity: i64,
    pub conditions: Vec<NodeCondition>,
    pub taints: Vec<NodeTaint>,
    pub pressure_reasons: Vec<String>,
    pub pressure: bool,
    pub unschedulable: bool,
    pub pods: Vec<NodePodInfo>,
}

#[derive(Serialize, Clone)]
pub struct NodeCondition {
    pub kind: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub healthy: bool,
}

#[derive(Serialize, Clone)]
pub struct NodeTaint {
    pub key: String,
    pub value: Option<String>,
    pub effect: String,
    /// `key=value:Effect`, the form kubectl prints and tolerations are written against.
    pub label: String,
}

#[derive(Serialize, Clone)]
pub struct NodePodInfo {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub restarts: i32,
    pub cpu_requested_milli: f64,
    pub memory_requested_bytes: f64,
}

#[derive(Serialize, Clone)]
pub struct PodSummary {
    pub total: usize,
    pub running: usize,
    pub ready: usize,
    pub pending: usize,
    pub failed: usize,
    pub succeeded: usize,
    pub unknown: usize,
    pub total_restarts: i32,
    pub by_phase: Vec<Bucket>,
    pub by_namespace: Vec<Bucket>,
    pub problems: Vec<ProblemPod>,
    pub top_restarts: Vec<ProblemPod>,
    pub top_cpu: Vec<PodUsage>,
}

#[derive(Serialize, Clone)]
pub struct PodUsage {
    pub name: String,
    pub namespace: String,
    pub cpu_used_milli: f64,
    pub cpu_requested_milli: f64,
}

#[derive(Serialize, Clone)]
pub struct ProblemPod {
    pub name: String,
    pub namespace: String,
    pub node: Option<String>,
    pub phase: String,
    pub reason: String,
    pub message: Option<String>,
    pub restarts: i32,
    pub age: String,
    pub severity: String,
}

#[derive(Serialize, Clone)]
pub struct WorkloadSummary {
    pub deployments: WorkloadBucket,
    pub statefulsets: WorkloadBucket,
    pub daemonsets: WorkloadBucket,
    pub degraded: Vec<DegradedWorkload>,
}

#[derive(Serialize, Clone)]
pub struct WorkloadBucket {
    pub total: usize,
    pub degraded: usize,
}

#[derive(Serialize, Clone)]
pub struct DegradedWorkload {
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub ready: i32,
    pub desired: i32,
}

#[derive(Serialize, Clone)]
pub struct Distribution {
    pub zones: Vec<ZoneBucket>,
    pub instance_types: Vec<Bucket>,
    pub capacity_types: Vec<Bucket>,
    pub node_pools: Vec<Bucket>,
    /// Nodes carrying each distinct taint, so the fleet's taints are visible
    /// without opening every node.
    pub taints: Vec<Bucket>,
    pub kubelet_versions: Vec<Bucket>,
}

#[derive(Serialize, Clone)]
pub struct ZoneBucket {
    pub zone: String,
    pub nodes: usize,
    pub ready_nodes: usize,
    pub pods: usize,
    pub cpu_allocatable_milli: f64,
    pub memory_allocatable_bytes: f64,
}

#[derive(Serialize, Clone)]
pub struct Bucket {
    pub label: String,
    pub value: usize,
}

#[derive(Serialize, Clone)]
pub struct EventSummary {
    pub warning_count: usize,
    pub truncated: bool,
    pub by_reason: Vec<Bucket>,
    pub recent: Vec<WarningEvent>,
}

#[derive(Serialize, Clone)]
pub struct WarningEvent {
    pub reason: String,
    pub message: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub count: i32,
    pub timestamp: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct Finding {
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub count: usize,
    pub targets: Vec<String>,
    pub hint: String,
}

pub fn parse_cpu_milli(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let (number, multiplier) = if let Some(number) = value.strip_suffix('n') {
        (number, 1e-6)
    } else if let Some(number) = value.strip_suffix('u') {
        (number, 1e-3)
    } else if let Some(number) = value.strip_suffix('m') {
        (number, 1.0)
    } else {
        (value, 1000.0)
    };
    number.trim().parse::<f64>().ok().map(|number| number * multiplier)
}

pub fn parse_memory_bytes(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    const BINARY: [(&str, f64); 6] = [
        ("Ki", 1024.0),
        ("Mi", 1_048_576.0),
        ("Gi", 1_073_741_824.0),
        ("Ti", 1_099_511_627_776.0),
        ("Pi", 1.125_899_906_842_624e15),
        ("Ei", 1.152_921_504_606_847e18),
    ];
    const DECIMAL: [(&str, f64); 6] = [
        ("k", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
        ("P", 1e15),
        ("E", 1e18),
    ];

    for (suffix, multiplier) in BINARY {
        if let Some(number) = value.strip_suffix(suffix) {
            return number.trim().parse::<f64>().ok().map(|number| number * multiplier);
        }
    }
    for (suffix, multiplier) in DECIMAL {
        if let Some(number) = value.strip_suffix(suffix) {
            return number.trim().parse::<f64>().ok().map(|number| number * multiplier);
        }
    }
    value.parse::<f64>().ok()
}

/// `1.30.4-eks-a1b2c3` and `v1.30.4` both resolve to minor 30.
pub fn parse_minor(version: &str) -> Option<u32> {
    let mut parts = version.trim_start_matches('v').split('.');
    parts.next()?;
    let minor = parts.next()?;
    minor
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

fn quantity(map: Option<&BTreeMap<String, Quantity>>, key: &str) -> Option<String> {
    map?.get(key).map(|value| value.0.clone())
}

/// Effective pod requests follow the Kubernetes rule: regular containers sum,
/// and each init container must fit on its own, so the larger of the two wins.
fn pod_resources(pod: &Pod) -> (f64, f64, f64, f64) {
    let Some(spec) = pod.spec.as_ref() else {
        return (0.0, 0.0, 0.0, 0.0);
    };

    let mut cpu_requests = 0.0;
    let mut memory_requests = 0.0;
    let mut cpu_limits = 0.0;
    let mut memory_limits = 0.0;

    for container in &spec.containers {
        let Some(resources) = container.resources.as_ref() else { continue };
        cpu_requests += quantity(resources.requests.as_ref(), "cpu").and_then(|value| parse_cpu_milli(&value)).unwrap_or(0.0);
        memory_requests += quantity(resources.requests.as_ref(), "memory").and_then(|value| parse_memory_bytes(&value)).unwrap_or(0.0);
        cpu_limits += quantity(resources.limits.as_ref(), "cpu").and_then(|value| parse_cpu_milli(&value)).unwrap_or(0.0);
        memory_limits += quantity(resources.limits.as_ref(), "memory").and_then(|value| parse_memory_bytes(&value)).unwrap_or(0.0);
    }

    for container in spec.init_containers.iter().flatten() {
        let Some(resources) = container.resources.as_ref() else { continue };
        let sidecar = container.restart_policy.as_deref() == Some("Always");
        let cpu = quantity(resources.requests.as_ref(), "cpu").and_then(|value| parse_cpu_milli(&value)).unwrap_or(0.0);
        let memory = quantity(resources.requests.as_ref(), "memory").and_then(|value| parse_memory_bytes(&value)).unwrap_or(0.0);
        let cpu_limit = quantity(resources.limits.as_ref(), "cpu").and_then(|value| parse_cpu_milli(&value)).unwrap_or(0.0);
        let memory_limit = quantity(resources.limits.as_ref(), "memory").and_then(|value| parse_memory_bytes(&value)).unwrap_or(0.0);

        if sidecar {
            cpu_requests += cpu;
            memory_requests += memory;
            cpu_limits += cpu_limit;
            memory_limits += memory_limit;
        } else {
            cpu_requests = cpu_requests.max(cpu);
            memory_requests = memory_requests.max(memory);
            cpu_limits = cpu_limits.max(cpu_limit);
            memory_limits = memory_limits.max(memory_limit);
        }
    }

    (cpu_requests, memory_requests, cpu_limits, memory_limits)
}

fn pod_phase(pod: &Pod) -> String {
    pod.status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Unknown".to_string())
}

fn pod_restarts(pod: &Pod) -> i32 {
    pod.status
        .as_ref()
        .and_then(|status| status.container_statuses.as_ref())
        .map(|statuses| statuses.iter().map(|status| status.restart_count).sum())
        .unwrap_or(0)
}

fn pod_is_ready(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|status| status.conditions.as_ref())
        .map(|conditions| {
            conditions
                .iter()
                .any(|condition| condition.type_ == "Ready" && condition.status == "True")
        })
        .unwrap_or(false)
}

/// The first blocking container state, which is what an operator actually needs to see.
fn pod_problem_reason(pod: &Pod) -> Option<(String, Option<String>)> {
    let status = pod.status.as_ref()?;
    let statuses = status
        .container_statuses
        .iter()
        .flatten()
        .chain(status.init_container_statuses.iter().flatten());

    for container in statuses {
        if let Some(waiting) = container.state.as_ref().and_then(|state| state.waiting.as_ref()) {
            let reason = waiting.reason.clone().unwrap_or_else(|| "Waiting".to_string());
            if reason != "ContainerCreating" && reason != "PodInitializing" {
                return Some((reason, waiting.message.clone()));
            }
        }
        if let Some(terminated) = container.state.as_ref().and_then(|state| state.terminated.as_ref()) {
            if terminated.exit_code != 0 {
                let reason = terminated.reason.clone().unwrap_or_else(|| "Terminated".to_string());
                return Some((format!("{reason} (exit {})", terminated.exit_code), terminated.message.clone()));
            }
        }
    }

    if let Some(reason) = status.reason.as_ref() {
        return Some((reason.clone(), status.message.clone()));
    }
    None
}

fn reason_severity(reason: &str, restarts: i32) -> String {
    let critical = [
        "CrashLoopBackOff",
        "ImagePullBackOff",
        "ErrImagePull",
        "CreateContainerConfigError",
        "CreateContainerError",
        "InvalidImageName",
        "OOMKilled",
        "Evicted",
    ];
    if critical.iter().any(|value| reason.contains(value)) {
        return "critical".to_string();
    }
    if reason.contains("Unschedulable") || reason.contains("FailedMount") || reason.contains("FailedScheduling") {
        return "serious".to_string();
    }
    if restarts >= 5 {
        return "serious".to_string();
    }
    "warning".to_string()
}

fn ranked_buckets(counts: HashMap<String, usize>, limit: usize) -> Vec<Bucket> {
    let mut buckets: Vec<Bucket> = counts
        .into_iter()
        .map(|(label, value)| Bucket { label, value })
        .collect();
    buckets.sort_by(|left, right| right.value.cmp(&left.value).then_with(|| left.label.cmp(&right.label)));

    if buckets.len() <= limit {
        return buckets;
    }
    let tail: usize = buckets[limit..].iter().map(|bucket| bucket.value).sum();
    buckets.truncate(limit);
    buckets.push(Bucket { label: "Other".to_string(), value: tail });
    buckets
}

fn metrics_index(metrics: Option<&serde_json::Value>, resource: &str) -> HashMap<String, f64> {
    let mut index = HashMap::new();
    let Some(items) = metrics.and_then(|value| value.get("items")).and_then(|value| value.as_array()) else {
        return index;
    };

    for item in items {
        let Some(name) = item.pointer("/metadata/name").and_then(|value| value.as_str()) else { continue };
        let raw = item
            .pointer(&format!("/usage/{resource}"))
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .or_else(|| {
                // Pod metrics carry usage per container, so they need summing.
                let containers = item.get("containers")?.as_array()?;
                let total: f64 = containers
                    .iter()
                    .filter_map(|container| container.pointer(&format!("/usage/{resource}"))?.as_str())
                    .filter_map(|value| if resource == "cpu" { parse_cpu_milli(value) } else { parse_memory_bytes(value) })
                    .sum();
                Some(if resource == "cpu" { format!("{total}m") } else { format!("{total}") })
            });
        let Some(raw) = raw else { continue };
        let parsed = if resource == "cpu" { parse_cpu_milli(&raw) } else { parse_memory_bytes(&raw) };
        if let Some(parsed) = parsed {
            let key = match item.pointer("/metadata/namespace").and_then(|value| value.as_str()) {
                Some(namespace) => format!("{namespace}/{name}"),
                None => name.to_string(),
            };
            index.insert(key, parsed);
        }
    }
    index
}

/// Managed-Kubernetes providers differ only in how they label nodes. Everything
/// downstream of this module works from the normalised values these helpers return.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Eks,
    Aks,
    Gke,
    Generic,
}

impl Provider {
    pub fn key(self) -> &'static str {
        match self {
            Provider::Eks => "eks",
            Provider::Aks => "aks",
            Provider::Gke => "gke",
            Provider::Generic => "generic",
        }
    }

    pub fn distribution(self) -> &'static str {
        match self {
            Provider::Eks => "Amazon EKS",
            Provider::Aks => "Azure AKS",
            Provider::Gke => "Google GKE",
            Provider::Generic => "Kubernetes",
        }
    }

    /// What the provider calls the identity that owns the cluster.
    pub fn account_label(self) -> Option<&'static str> {
        match self {
            Provider::Eks => Some("Account"),
            Provider::Aks => Some("Subscription"),
            Provider::Gke => Some("Project"),
            Provider::Generic => None,
        }
    }
}

/// `spec.providerID` is the most reliable signal because the cloud controller
/// manager sets it; labels and the endpoint host are the fallbacks.
pub fn detect_provider(provider_ids: &[String], label_keys: &[String], endpoint: &str) -> Provider {
    for id in provider_ids {
        if id.starts_with("aws://") {
            return Provider::Eks;
        }
        if id.starts_with("azure://") {
            return Provider::Aks;
        }
        if id.starts_with("gce://") {
            return Provider::Gke;
        }
    }

    if label_keys.iter().any(|key| key.starts_with("eks.amazonaws.com/")) {
        return Provider::Eks;
    }
    if label_keys.iter().any(|key| key.starts_with("kubernetes.azure.com/")) {
        return Provider::Aks;
    }
    if label_keys.iter().any(|key| key.starts_with("cloud.google.com/gke-")) {
        return Provider::Gke;
    }

    if endpoint.contains(".eks.amazonaws.com") {
        return Provider::Eks;
    }
    if endpoint.contains(".azmk8s.io") {
        return Provider::Aks;
    }

    Provider::Generic
}

/// NoExecute evicts pods that are already running, so it leads; PreferNoSchedule is
/// only a hint, so it trails. Within an effect the order is the node's own.
fn effect_rank(effect: &str) -> u8 {
    match effect {
        "NoExecute" => 0,
        "NoSchedule" => 1,
        "PreferNoSchedule" => 2,
        _ => 3,
    }
}

pub fn taint_label(key: &str, value: Option<&str>, effect: &str) -> String {
    match value.filter(|value| !value.is_empty()) {
        Some(value) => format!("{key}={value}:{effect}"),
        None => format!("{key}:{effect}"),
    }
}

pub fn node_pool_of(labels: &std::collections::BTreeMap<String, String>) -> Option<String> {
    [
        "eks.amazonaws.com/nodegroup",
        "alpha.eksctl.io/nodegroup-name",
        "karpenter.sh/nodepool",
        "kubernetes.azure.com/agentpool",
        "agentpool",
        "cloud.google.com/gke-nodepool",
    ]
    .iter()
    .find_map(|key| labels.get(*key).cloned())
}

/// Normalised to SPOT / ON_DEMAND / UNKNOWN. On AKS and GKE the absence of a spot
/// marker means a regular node, so a known provider never reports UNKNOWN.
pub fn capacity_type_of(labels: &std::collections::BTreeMap<String, String>, provider: Provider) -> String {
    if let Some(value) = labels.get("eks.amazonaws.com/capacityType") {
        return value.to_uppercase();
    }
    if let Some(value) = labels.get("karpenter.sh/capacity-type") {
        return value.replace('-', "_").to_uppercase();
    }
    let spot = labels.get("kubernetes.azure.com/scalesetpriority").map(String::as_str) == Some("spot")
        || labels.get("cloud.google.com/gke-spot").map(String::as_str) == Some("true")
        || labels.get("cloud.google.com/gke-preemptible").map(String::as_str) == Some("true");
    if spot {
        return "SPOT".to_string();
    }
    if provider == Provider::Generic {
        "UNKNOWN".to_string()
    } else {
        "ON_DEMAND".to_string()
    }
}

pub fn parse_cluster_arn(context: &str) -> Option<(String, String, String)> {
    let rest = context.strip_prefix("arn:aws:eks:")?;
    let mut parts = rest.split(':');
    let region = parts.next()?.to_string();
    let account = parts.next()?.to_string();
    let cluster = parts.next()?.strip_prefix("cluster/")?.to_string();
    Some((region, account, cluster))
}

pub async fn collect(context: &str, endpoint: String, client: Client) -> Result<ClusterOverview, String> {
    let mut degraded_collectors = Vec::new();

    let nodes_api: Api<Node> = Api::all(client.clone());
    let pods_api: Api<Pod> = Api::all(client.clone());
    let deployments_api: Api<Deployment> = Api::all(client.clone());
    let statefulsets_api: Api<StatefulSet> = Api::all(client.clone());
    let daemonsets_api: Api<DaemonSet> = Api::all(client.clone());
    let events_api: Api<Event> = Api::all(client.clone());

    let params = ListParams::default();
    let warning_params = ListParams::default().fields("type=Warning").limit(WARNING_EVENT_LIMIT);
    let node_metrics_request = http::Request::get("/apis/metrics.k8s.io/v1beta1/nodes")
        .body(Vec::new())
        .map_err(|error| error.to_string())?;
    let pod_metrics_request = http::Request::get("/apis/metrics.k8s.io/v1beta1/pods")
        .body(Vec::new())
        .map_err(|error| error.to_string())?;

    let (version, nodes, pods, deployments, statefulsets, daemonsets, events, node_metrics, pod_metrics) = tokio::join!(
        client.apiserver_version(),
        nodes_api.list(&params),
        pods_api.list(&params),
        deployments_api.list(&params),
        statefulsets_api.list(&params),
        daemonsets_api.list(&params),
        events_api.list(&warning_params),
        client.request::<serde_json::Value>(node_metrics_request),
        client.request::<serde_json::Value>(pod_metrics_request),
    );

    let nodes = match nodes {
        Ok(list) => list.items,
        Err(error) => return Err(format!("Unable to list Nodes: {error}")),
    };
    let pods = pods.map(|list| list.items).unwrap_or_else(|error| {
        degraded_collectors.push(format!("Pods could not be listed cluster-wide ({error}). Capacity and pod health are incomplete."));
        Vec::new()
    });
    let node_metrics = node_metrics.ok();
    let pod_metrics = pod_metrics.ok();
    if node_metrics.is_none() {
        degraded_collectors.push("metrics-server is unavailable, so live CPU/memory usage is not shown. Requests and limits are still exact.".to_string());
    }

    let node_cpu_usage = metrics_index(node_metrics.as_ref(), "cpu");
    let node_memory_usage = metrics_index(node_metrics.as_ref(), "memory");
    let pod_cpu_usage = metrics_index(pod_metrics.as_ref(), "cpu");

    let control_plane_version = version
        .as_ref()
        .map(|value| value.git_version.clone())
        .unwrap_or_else(|_| "unknown".to_string());
    let control_plane_minor = parse_minor(&control_plane_version);

    let mut requests_by_node: HashMap<String, (f64, f64, f64, f64)> = HashMap::new();
    let mut pods_by_node: HashMap<String, Vec<NodePodInfo>> = HashMap::new();
    let mut namespace_counts: HashMap<String, usize> = HashMap::new();
    let mut phase_counts: HashMap<String, usize> = HashMap::new();
    let mut problems: Vec<ProblemPod> = Vec::new();
    let mut restart_ranking: Vec<ProblemPod> = Vec::new();
    let mut cpu_usage_ranking: Vec<PodUsage> = Vec::new();
    let (mut running, mut ready_pods, mut pending, mut failed, mut succeeded, mut unknown, mut total_restarts) =
        (0usize, 0usize, 0usize, 0usize, 0usize, 0usize, 0i32);

    for pod in &pods {
        let Some(name) = pod.metadata.name.clone() else { continue };
        let namespace = pod.metadata.namespace.clone().unwrap_or_else(|| "default".to_string());
        let phase = pod_phase(pod);
        let restarts = pod_restarts(pod);
        let node_name = pod.spec.as_ref().and_then(|spec| spec.node_name.clone());
        let age = pod
            .metadata
            .creation_timestamp
            .as_ref()
            .map(|timestamp| format_age(timestamp.0))
            .unwrap_or_else(|| "n/a".to_string());

        total_restarts += restarts;
        *namespace_counts.entry(namespace.clone()).or_default() += 1;
        *phase_counts.entry(phase.clone()).or_default() += 1;
        match phase.as_str() {
            "Running" => running += 1,
            "Pending" => pending += 1,
            "Failed" => failed += 1,
            "Succeeded" => succeeded += 1,
            _ => unknown += 1,
        }
        if pod_is_ready(pod) {
            ready_pods += 1;
        }

        let terminal = phase == "Succeeded" || phase == "Failed";
        let (cpu_requests, memory_requests, cpu_limits, memory_limits) = pod_resources(pod);

        if let Some(used) = pod_cpu_usage.get(&format!("{namespace}/{name}")) {
            cpu_usage_ranking.push(PodUsage {
                name: name.clone(),
                namespace: namespace.clone(),
                cpu_used_milli: *used,
                cpu_requested_milli: cpu_requests,
            });
        }

        if let Some(node_name) = node_name.as_ref() {
            if !terminal {
                let entry = requests_by_node.entry(node_name.clone()).or_insert((0.0, 0.0, 0.0, 0.0));
                entry.0 += cpu_requests;
                entry.1 += memory_requests;
                entry.2 += cpu_limits;
                entry.3 += memory_limits;
            }
            pods_by_node.entry(node_name.clone()).or_default().push(NodePodInfo {
                name: name.clone(),
                namespace: namespace.clone(),
                status: phase.clone(),
                restarts,
                cpu_requested_milli: cpu_requests,
                memory_requested_bytes: memory_requests,
            });
        }

        if let Some((reason, message)) = pod_problem_reason(pod) {
            problems.push(ProblemPod {
                severity: reason_severity(&reason, restarts),
                name: name.clone(),
                namespace: namespace.clone(),
                node: node_name.clone(),
                phase: phase.clone(),
                reason,
                message,
                restarts,
                age: age.clone(),
            });
        } else if phase == "Pending" {
            problems.push(ProblemPod {
                severity: "serious".to_string(),
                name: name.clone(),
                namespace: namespace.clone(),
                node: node_name.clone(),
                phase: phase.clone(),
                reason: "Pending".to_string(),
                message: Some("The pod has not been scheduled or its containers have not started.".to_string()),
                restarts,
                age: age.clone(),
            });
        }

        if restarts > 0 {
            restart_ranking.push(ProblemPod {
                severity: if restarts >= 10 { "critical".to_string() } else if restarts >= 5 { "serious".to_string() } else { "warning".to_string() },
                name,
                namespace,
                node: node_name,
                phase,
                reason: "Restarts".to_string(),
                message: None,
                restarts,
                age,
            });
        }
    }

    let severity_rank = |severity: &str| match severity {
        "critical" => 0,
        "serious" => 1,
        "warning" => 2,
        _ => 3,
    };
    problems.sort_by(|left, right| {
        severity_rank(&left.severity)
            .cmp(&severity_rank(&right.severity))
            .then_with(|| right.restarts.cmp(&left.restarts))
            .then_with(|| left.name.cmp(&right.name))
    });
    problems.truncate(PROBLEM_POD_LIMIT);
    restart_ranking.sort_by(|left, right| right.restarts.cmp(&left.restarts));
    restart_ranking.truncate(TOP_LIST_LIMIT);
    cpu_usage_ranking.sort_by(|left, right| {
        right
            .cpu_used_milli
            .partial_cmp(&left.cpu_used_milli)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    cpu_usage_ranking.truncate(TOP_LIST_LIMIT);

    // The provider has to be known before nodes are normalised, because label
    // meaning depends on it — so this pre-pass reads only what the detector needs.
    let provider_ids: Vec<String> = nodes
        .iter()
        .filter_map(|node| node.spec.as_ref().and_then(|spec| spec.provider_id.clone()))
        .collect();
    let label_keys: Vec<String> = nodes
        .iter()
        .filter_map(|node| node.metadata.labels.as_ref())
        .flat_map(|labels| labels.keys().cloned())
        .collect();
    let provider = detect_provider(&provider_ids, &label_keys, &endpoint);
    let region = nodes.iter().find_map(|node| {
        node.metadata
            .labels
            .as_ref()?
            .get("topology.kubernetes.io/region")
            .or_else(|| node.metadata.labels.as_ref()?.get("failure-domain.beta.kubernetes.io/region"))
            .cloned()
    });

    let mut node_infos: Vec<NodeInfo> = Vec::with_capacity(nodes.len());
    let mut zone_index: BTreeMap<String, ZoneBucket> = BTreeMap::new();
    let mut instance_counts: HashMap<String, usize> = HashMap::new();
    let mut capacity_type_counts: HashMap<String, usize> = HashMap::new();
    let mut node_pool_counts: HashMap<String, usize> = HashMap::new();
    let mut taint_counts: HashMap<String, usize> = HashMap::new();
    let mut kubelet_counts: HashMap<String, usize> = HashMap::new();

    for node in nodes {
        let Some(name) = node.metadata.name.clone() else { continue };
        let labels = node.metadata.labels.clone().unwrap_or_default();
        let status = node.status.as_ref();

        let conditions: Vec<NodeCondition> = status
            .and_then(|status| status.conditions.as_ref())
            .map(|conditions| {
                conditions
                    .iter()
                    .map(|condition| {
                        let healthy = if condition.type_ == "Ready" {
                            condition.status == "True"
                        } else {
                            condition.status == "False"
                        };
                        NodeCondition {
                            kind: condition.type_.clone(),
                            status: condition.status.clone(),
                            reason: condition.reason.clone(),
                            message: condition.message.clone(),
                            healthy,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        let ready = conditions.iter().any(|condition| condition.kind == "Ready" && condition.status == "True");
        let pressure_reasons: Vec<String> = conditions
            .iter()
            .filter(|condition| condition.kind != "Ready" && !condition.healthy)
            .map(|condition| condition.kind.clone())
            .collect();
        let unschedulable = node.spec.as_ref().and_then(|spec| spec.unschedulable).unwrap_or(false);

        let allocatable = status.and_then(|status| status.allocatable.as_ref());
        let cpu_allocatable_milli = quantity(allocatable, "cpu").and_then(|value| parse_cpu_milli(&value)).unwrap_or(0.0);
        let memory_allocatable_bytes = quantity(allocatable, "memory").and_then(|value| parse_memory_bytes(&value)).unwrap_or(0.0);
        let pod_capacity = quantity(allocatable, "pods").and_then(|value| value.parse::<i64>().ok()).unwrap_or(0);

        let (cpu_requested_milli, memory_requested_bytes, cpu_limit_milli, memory_limit_bytes) =
            requests_by_node.get(&name).copied().unwrap_or((0.0, 0.0, 0.0, 0.0));
        let hosted_pods = pods_by_node.remove(&name).unwrap_or_default();
        let pod_count = hosted_pods.len();

        let zone = labels
            .get("topology.kubernetes.io/zone")
            .or_else(|| labels.get("failure-domain.beta.kubernetes.io/zone"))
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        let instance_type = labels
            .get("node.kubernetes.io/instance-type")
            .or_else(|| labels.get("beta.kubernetes.io/instance-type"))
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        let capacity_type = capacity_type_of(&labels, provider);
        let node_pool = node_pool_of(&labels);

        let mut node_taints: Vec<NodeTaint> = node
            .spec
            .as_ref()
            .and_then(|spec| spec.taints.as_ref())
            .map(|taints| {
                taints
                    .iter()
                    .map(|taint| NodeTaint {
                        label: taint_label(&taint.key, taint.value.as_deref(), &taint.effect),
                        key: taint.key.clone(),
                        value: taint.value.clone(),
                        effect: taint.effect.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        node_taints.sort_by_key(|taint| effect_rank(&taint.effect));
        for taint in &node_taints {
            *taint_counts.entry(taint.label.clone()).or_default() += 1;
        }
        let node_system = status.and_then(|status| status.node_info.as_ref());
        let kubelet_version = node_system.map(|info| info.kubelet_version.clone()).unwrap_or_else(|| "unknown".to_string());

        let roles: Vec<String> = labels
            .iter()
            .filter_map(|(key, value)| {
                key.strip_prefix("node-role.kubernetes.io/")
                    .map(|role| if role.is_empty() { value.clone() } else { role.to_string() })
            })
            .chain(labels.get("kubernetes.io/role").cloned())
            .collect();

        let health = if !ready {
            "critical"
        } else if !pressure_reasons.is_empty() {
            "serious"
        } else if unschedulable {
            "warning"
        } else {
            let request_pressure = percent(cpu_requested_milli, cpu_allocatable_milli)
                .max(percent(memory_requested_bytes, memory_allocatable_bytes));
            if request_pressure >= REQUEST_PRESSURE_THRESHOLD { "warning" } else { "good" }
        };

        let zone_entry = zone_index.entry(zone.clone()).or_insert_with(|| ZoneBucket {
            zone: zone.clone(),
            nodes: 0,
            ready_nodes: 0,
            pods: 0,
            cpu_allocatable_milli: 0.0,
            memory_allocatable_bytes: 0.0,
        });
        zone_entry.nodes += 1;
        zone_entry.ready_nodes += usize::from(ready);
        zone_entry.pods += pod_count;
        zone_entry.cpu_allocatable_milli += cpu_allocatable_milli;
        zone_entry.memory_allocatable_bytes += memory_allocatable_bytes;

        *instance_counts.entry(instance_type.clone()).or_default() += 1;
        *capacity_type_counts.entry(capacity_type.clone()).or_default() += 1;
        *kubelet_counts.entry(kubelet_version.clone()).or_default() += 1;
        if let Some(node_pool) = node_pool.as_ref() {
            *node_pool_counts.entry(node_pool.clone()).or_default() += 1;
        }

        node_infos.push(NodeInfo {
            kubelet_minor: parse_minor(&kubelet_version),
            name,
            ready,
            health: health.to_string(),
            roles: if roles.is_empty() { vec!["worker".to_string()] } else { roles },
            kubelet_version,
            instance_type,
            capacity_type,
            node_pool,
            zone,
            architecture: node_system.map(|info| info.architecture.clone()).unwrap_or_else(|| "unknown".to_string()),
            os_image: node_system.map(|info| info.os_image.clone()).unwrap_or_else(|| "unknown".to_string()),
            container_runtime: node_system.map(|info| info.container_runtime_version.clone()).unwrap_or_else(|| "unknown".to_string()),
            age: node.metadata.creation_timestamp.as_ref().map(|timestamp| format_age(timestamp.0)).unwrap_or_else(|| "n/a".to_string()),
            cpu_allocatable_milli,
            cpu_requested_milli,
            cpu_limit_milli,
            cpu_used_milli: None,
            memory_allocatable_bytes,
            memory_requested_bytes,
            memory_limit_bytes,
            memory_used_bytes: None,
            pod_count,
            pod_capacity,
            conditions,
            taints: node_taints,
            pressure: !pressure_reasons.is_empty(),
            pressure_reasons,
            unschedulable,
            pods: hosted_pods,
        });
    }

    for node in &mut node_infos {
        node.cpu_used_milli = node_cpu_usage.get(&node.name).copied();
        node.memory_used_bytes = node_memory_usage.get(&node.name).copied();
        node.pods.sort_by(|left, right| {
            right
                .cpu_requested_milli
                .partial_cmp(&left.cpu_requested_milli)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.name.cmp(&right.name))
        });
    }
    node_infos.sort_by(|left, right| {
        severity_rank(&left.health)
            .cmp(&severity_rank(&right.health))
            .then_with(|| left.name.cmp(&right.name))
    });

    let capacity = CapacitySummary {
        cpu: ResourceAxis {
            allocatable: node_infos.iter().map(|node| node.cpu_allocatable_milli).sum(),
            requested: node_infos.iter().map(|node| node.cpu_requested_milli).sum(),
            limits: node_infos.iter().map(|node| node.cpu_limit_milli).sum(),
            used: node_metrics.is_some().then(|| node_infos.iter().filter_map(|node| node.cpu_used_milli).sum()),
        },
        memory: ResourceAxis {
            allocatable: node_infos.iter().map(|node| node.memory_allocatable_bytes).sum(),
            requested: node_infos.iter().map(|node| node.memory_requested_bytes).sum(),
            limits: node_infos.iter().map(|node| node.memory_limit_bytes).sum(),
            used: node_metrics.is_some().then(|| node_infos.iter().filter_map(|node| node.memory_used_bytes).sum()),
        },
        pod_slots: PodSlots {
            used: node_infos.iter().map(|node| node.pod_count).sum(),
            allocatable: node_infos.iter().map(|node| node.pod_capacity).sum(),
        },
    };

    let workloads = summarize_workloads(deployments, statefulsets, daemonsets, &mut degraded_collectors);
    let events = summarize_events(events, &mut degraded_collectors);

    let pod_summary = PodSummary {
        total: pods.len(),
        running,
        ready: ready_pods,
        pending,
        failed,
        succeeded,
        unknown,
        total_restarts,
        by_phase: ranked_buckets(phase_counts, 6),
        by_namespace: ranked_buckets(namespace_counts, TOP_LIST_LIMIT),
        problems,
        top_restarts: restart_ranking,
        top_cpu: cpu_usage_ranking,
    };

    let distribution = Distribution {
        zones: zone_index.into_values().collect(),
        instance_types: ranked_buckets(instance_counts, 8),
        capacity_types: ranked_buckets(capacity_type_counts, 4),
        node_pools: ranked_buckets(node_pool_counts, 8),
        taints: ranked_buckets(taint_counts, 10),
        kubelet_versions: ranked_buckets(kubelet_counts, 6),
    };

    let arn = parse_cluster_arn(context);

    let health = score_health(&node_infos, &pod_summary, &capacity, &workloads, control_plane_minor);
    let findings = build_findings(&node_infos, &pod_summary, &capacity, &workloads, &events, control_plane_minor, &distribution);

    Ok(ClusterOverview {
        context: context.to_string(),
        generated_at: chrono::Utc::now().to_rfc3339(),
        control_plane: ControlPlane {
            provider: provider.key().to_string(),
            distribution: provider.distribution().to_string(),
            endpoint,
            kubernetes_version: control_plane_version,
            control_plane_minor,
            cluster_name: arn.as_ref().map(|value| value.2.clone()),
            region: arn.as_ref().map(|value| value.0.clone()).or(region),
            account_id: arn.as_ref().map(|value| value.1.clone()),
            account_label: provider.account_label().map(str::to_string),
            provider_status: None,
            provider_version: None,
            oidc_issuer: None,
            metrics_available: node_metrics.is_some(),
        },
        health,
        capacity,
        nodes: node_infos,
        pods: pod_summary,
        workloads,
        distribution,
        events,
        findings,
        degraded_collectors,
    })
}

fn percent(part: f64, whole: f64) -> f64 {
    if whole <= 0.0 {
        0.0
    } else {
        (part / whole) * 100.0
    }
}

fn summarize_workloads(
    deployments: Result<kube::core::ObjectList<Deployment>, kube::Error>,
    statefulsets: Result<kube::core::ObjectList<StatefulSet>, kube::Error>,
    daemonsets: Result<kube::core::ObjectList<DaemonSet>, kube::Error>,
    degraded_collectors: &mut Vec<String>,
) -> WorkloadSummary {
    let mut degraded = Vec::new();

    let deployment_bucket = match deployments {
        Ok(list) => {
            let total = list.items.len();
            let mut count = 0;
            for item in list.items {
                let desired = item.spec.as_ref().and_then(|spec| spec.replicas).unwrap_or(1);
                let ready = item.status.as_ref().and_then(|status| status.ready_replicas).unwrap_or(0);
                if ready < desired {
                    count += 1;
                    degraded.push(DegradedWorkload {
                        kind: "Deployment".to_string(),
                        namespace: item.metadata.namespace.unwrap_or_default(),
                        name: item.metadata.name.unwrap_or_default(),
                        ready,
                        desired,
                    });
                }
            }
            WorkloadBucket { total, degraded: count }
        }
        Err(error) => {
            degraded_collectors.push(format!("Deployments could not be listed ({error})."));
            WorkloadBucket { total: 0, degraded: 0 }
        }
    };

    let statefulset_bucket = match statefulsets {
        Ok(list) => {
            let total = list.items.len();
            let mut count = 0;
            for item in list.items {
                let desired = item.spec.as_ref().and_then(|spec| spec.replicas).unwrap_or(1);
                let ready = item.status.as_ref().and_then(|status| status.ready_replicas).unwrap_or(0);
                if ready < desired {
                    count += 1;
                    degraded.push(DegradedWorkload {
                        kind: "StatefulSet".to_string(),
                        namespace: item.metadata.namespace.unwrap_or_default(),
                        name: item.metadata.name.unwrap_or_default(),
                        ready,
                        desired,
                    });
                }
            }
            WorkloadBucket { total, degraded: count }
        }
        Err(error) => {
            degraded_collectors.push(format!("StatefulSets could not be listed ({error})."));
            WorkloadBucket { total: 0, degraded: 0 }
        }
    };

    let daemonset_bucket = match daemonsets {
        Ok(list) => {
            let total = list.items.len();
            let mut count = 0;
            for item in list.items {
                let desired = item.status.as_ref().map(|status| status.desired_number_scheduled).unwrap_or(0);
                let ready = item.status.as_ref().map(|status| status.number_ready).unwrap_or(0);
                if ready < desired {
                    count += 1;
                    degraded.push(DegradedWorkload {
                        kind: "DaemonSet".to_string(),
                        namespace: item.metadata.namespace.unwrap_or_default(),
                        name: item.metadata.name.unwrap_or_default(),
                        ready,
                        desired,
                    });
                }
            }
            WorkloadBucket { total, degraded: count }
        }
        Err(error) => {
            degraded_collectors.push(format!("DaemonSets could not be listed ({error})."));
            WorkloadBucket { total: 0, degraded: 0 }
        }
    };

    degraded.sort_by(|left, right| (left.ready - left.desired).cmp(&(right.ready - right.desired)));
    degraded.truncate(TOP_LIST_LIMIT);

    WorkloadSummary {
        deployments: deployment_bucket,
        statefulsets: statefulset_bucket,
        daemonsets: daemonset_bucket,
        degraded,
    }
}

fn summarize_events(
    events: Result<kube::core::ObjectList<Event>, kube::Error>,
    degraded_collectors: &mut Vec<String>,
) -> EventSummary {
    let list = match events {
        Ok(list) => list,
        Err(error) => {
            degraded_collectors.push(format!("Warning events could not be listed ({error})."));
            return EventSummary { warning_count: 0, truncated: false, by_reason: Vec::new(), recent: Vec::new() };
        }
    };

    let truncated = list.items.len() >= WARNING_EVENT_LIMIT as usize;
    let mut reason_counts: HashMap<String, usize> = HashMap::new();
    let mut recent: Vec<WarningEvent> = Vec::new();

    for event in list.items {
        let reason = event.reason.clone().unwrap_or_else(|| "Unknown".to_string());
        let count = event.count.unwrap_or(1);
        *reason_counts.entry(reason.clone()).or_default() += count.max(1) as usize;
        recent.push(WarningEvent {
            reason,
            message: event.message.unwrap_or_else(|| "No details".to_string()),
            kind: event.involved_object.kind.unwrap_or_else(|| "Unknown".to_string()),
            name: event.involved_object.name.unwrap_or_else(|| "unknown".to_string()),
            namespace: event.metadata.namespace,
            count,
            timestamp: event
                .last_timestamp
                .map(|value| value.0.to_rfc3339())
                .or_else(|| event.event_time.map(|value| value.0.to_rfc3339())),
        });
    }

    recent.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    let warning_count = reason_counts.values().sum();
    recent.truncate(25);

    EventSummary {
        warning_count,
        truncated,
        by_reason: ranked_buckets(reason_counts, 8),
        recent,
    }
}

fn score_health(
    nodes: &[NodeInfo],
    pods: &PodSummary,
    capacity: &CapacitySummary,
    workloads: &WorkloadSummary,
    control_plane_minor: Option<u32>,
) -> HealthSummary {
    fn signal(name: &str, score: f64, weight: f64, detail: String) -> HealthSignal {
        let score = score.clamp(0.0, 1.0);
        HealthSignal {
            name: name.to_string(),
            score: (score * 100.0).round() as u32,
            weight,
            detail,
            severity: severity_for(score * 100.0),
        }
    }

    let mut signals: Vec<HealthSignal> = Vec::new();
    let mut push = |name: &str, score: f64, weight: f64, detail: String| signals.push(signal(name, score, weight, detail));

    if !nodes.is_empty() {
        let ready = nodes.iter().filter(|node| node.ready).count();
        push(
            "Node readiness",
            ready as f64 / nodes.len() as f64,
            25.0,
            format!("{ready} of {} nodes report Ready", nodes.len()),
        );

        let impacted = nodes.iter().filter(|node| node.pressure || node.unschedulable).count();
        push(
            "Node conditions",
            1.0 - (impacted as f64 / nodes.len() as f64),
            10.0,
            if impacted == 0 {
                "No node reports pressure or is cordoned".to_string()
            } else {
                format!("{impacted} node(s) under pressure or cordoned")
            },
        );

        if let Some(control_plane_minor) = control_plane_minor {
            let skewed = nodes
                .iter()
                .filter(|node| node.kubelet_minor.is_some_and(|minor| minor != control_plane_minor))
                .count();
            push(
                "Version alignment",
                1.0 - (skewed as f64 / nodes.len() as f64),
                5.0,
                if skewed == 0 {
                    format!("All kubelets match control plane 1.{control_plane_minor}")
                } else {
                    format!("{skewed} node(s) run a kubelet minor other than 1.{control_plane_minor}")
                },
            );
        }
    }

    if pods.total > 0 {
        let schedulable = (pods.total - pods.succeeded).max(1);
        push(
            "Pod readiness",
            pods.ready as f64 / schedulable as f64,
            25.0,
            format!("{} of {schedulable} non-completed pods are Ready", pods.ready),
        );

        let crashing = pods.problems.iter().filter(|pod| pod.severity == "critical").count();
        push(
            "Container stability",
            1.0 - (crashing as f64 / schedulable as f64 * 4.0),
            15.0,
            if crashing == 0 {
                format!("No pod is crash-looping or failing to pull ({} restarts total)", pods.total_restarts)
            } else {
                format!("{crashing} pod(s) in a crash or image-pull state")
            },
        );
    }

    let request_pressure = percent(capacity.cpu.requested, capacity.cpu.allocatable)
        .max(percent(capacity.memory.requested, capacity.memory.allocatable));
    if capacity.cpu.allocatable > 0.0 {
        push(
            "Scheduling headroom",
            ((100.0 - request_pressure) / 25.0).min(1.0),
            15.0,
            format!("{request_pressure:.0}% of allocatable capacity is already requested"),
        );
    }

    let workload_total = workloads.deployments.total + workloads.statefulsets.total + workloads.daemonsets.total;
    if workload_total > 0 {
        let degraded = workloads.deployments.degraded + workloads.statefulsets.degraded + workloads.daemonsets.degraded;
        push(
            "Workload availability",
            1.0 - (degraded as f64 / workload_total as f64),
            5.0,
            if degraded == 0 {
                format!("All {workload_total} workload controllers are at their desired replica count")
            } else {
                format!("{degraded} of {workload_total} controllers are below desired replicas")
            },
        );
    }

    let total_weight: f64 = signals.iter().map(|signal| signal.weight).sum();
    let score = if total_weight <= 0.0 {
        0
    } else {
        (signals.iter().map(|signal| signal.score as f64 * signal.weight).sum::<f64>() / total_weight).round() as u32
    };

    let (grade, headline) = match score {
        90..=100 => ("Healthy", "The cluster is operating within normal parameters."),
        75..=89 => ("Attention", "The cluster is serving traffic but has signals worth reviewing."),
        50..=74 => ("Degraded", "Multiple subsystems are impaired. Investigate the findings below."),
        _ => ("Critical", "Core cluster health signals are failing."),
    };

    HealthSummary {
        score,
        grade: grade.to_string(),
        headline: headline.to_string(),
        signals,
    }
}

fn severity_for(score: f64) -> String {
    match score {
        value if value >= 90.0 => "good".to_string(),
        value if value >= 75.0 => "warning".to_string(),
        value if value >= 50.0 => "serious".to_string(),
        _ => "critical".to_string(),
    }
}

fn build_findings(
    nodes: &[NodeInfo],
    pods: &PodSummary,
    capacity: &CapacitySummary,
    workloads: &WorkloadSummary,
    events: &EventSummary,
    control_plane_minor: Option<u32>,
    distribution: &Distribution,
) -> Vec<Finding> {
    let mut findings = Vec::new();

    let not_ready: Vec<String> = nodes.iter().filter(|node| !node.ready).map(|node| node.name.clone()).collect();
    if !not_ready.is_empty() {
        findings.push(Finding {
            severity: "critical".to_string(),
            title: "Nodes are not Ready".to_string(),
            detail: "The kubelet on these nodes is not reporting Ready, so their pods may already be evicted or stuck.".to_string(),
            count: not_ready.len(),
            targets: not_ready.into_iter().take(TOP_LIST_LIMIT).collect(),
            hint: "Check kubelet and CNI health on the node, then the underlying EC2 instance status checks.".to_string(),
        });
    }

    let pressured: Vec<String> = nodes
        .iter()
        .filter(|node| node.pressure)
        .map(|node| format!("{} ({})", node.name, node.pressure_reasons.join(", ")))
        .collect();
    if !pressured.is_empty() {
        findings.push(Finding {
            severity: "serious".to_string(),
            title: "Nodes report resource pressure".to_string(),
            detail: "Memory, disk, or PID pressure causes the kubelet to evict pods and refuse new ones.".to_string(),
            count: pressured.len(),
            targets: pressured.into_iter().take(TOP_LIST_LIMIT).collect(),
            hint: "Free disk on the node, raise requests so the scheduler packs less densely, or scale the node group out.".to_string(),
        });
    }

    let cordoned: Vec<String> = nodes.iter().filter(|node| node.unschedulable).map(|node| node.name.clone()).collect();
    if !cordoned.is_empty() {
        findings.push(Finding {
            severity: "warning".to_string(),
            title: "Nodes are cordoned".to_string(),
            detail: "Cordoned nodes still run their pods but accept no new ones, which shrinks effective capacity.".to_string(),
            count: cordoned.len(),
            targets: cordoned.into_iter().take(TOP_LIST_LIMIT).collect(),
            hint: "Uncordon once maintenance is finished, or drain and replace the node.".to_string(),
        });
    }

    let critical_pods: Vec<&ProblemPod> = pods.problems.iter().filter(|pod| pod.severity == "critical").collect();
    if !critical_pods.is_empty() {
        findings.push(Finding {
            severity: "critical".to_string(),
            title: "Pods are crash-looping or cannot start".to_string(),
            detail: "These containers never reached a running state. The reason column is the container's own status, not an inference.".to_string(),
            count: critical_pods.len(),
            targets: critical_pods
                .iter()
                .take(TOP_LIST_LIMIT)
                .map(|pod| format!("{}/{} — {}", pod.namespace, pod.name, pod.reason))
                .collect(),
            hint: "Read the container logs with --previous, then verify the image tag, the mounted config, and the probe thresholds.".to_string(),
        });
    }

    let pending: Vec<&ProblemPod> = pods.problems.iter().filter(|pod| pod.phase == "Pending").collect();
    if !pending.is_empty() {
        findings.push(Finding {
            severity: "serious".to_string(),
            title: "Pods are stuck in Pending".to_string(),
            detail: "A pending pod has not been placed on a node. The usual causes are insufficient capacity, taints, or an unbound volume.".to_string(),
            count: pending.len(),
            targets: pending
                .iter()
                .take(TOP_LIST_LIMIT)
                .map(|pod| format!("{}/{}", pod.namespace, pod.name))
                .collect(),
            hint: "Check the pod's FailedScheduling event for the exact predicate that failed.".to_string(),
        });
    }

    let cpu_request_pressure = percent(capacity.cpu.requested, capacity.cpu.allocatable);
    let memory_request_pressure = percent(capacity.memory.requested, capacity.memory.allocatable);
    if cpu_request_pressure >= REQUEST_PRESSURE_THRESHOLD || memory_request_pressure >= REQUEST_PRESSURE_THRESHOLD {
        findings.push(Finding {
            severity: if cpu_request_pressure >= 95.0 || memory_request_pressure >= 95.0 { "serious".to_string() } else { "warning".to_string() },
            title: "Scheduling headroom is low".to_string(),
            detail: format!(
                "{cpu_request_pressure:.0}% of allocatable CPU and {memory_request_pressure:.0}% of allocatable memory are already reserved by requests."
            ),
            count: 1,
            targets: Vec::new(),
            hint: "Requests reserve capacity whether or not it is used. Right-size requests before adding nodes.".to_string(),
        });
    }

    if let Some(used) = capacity.cpu.used {
        let usage_pressure = percent(used, capacity.cpu.allocatable);
        if usage_pressure >= USAGE_PRESSURE_THRESHOLD {
            findings.push(Finding {
                severity: "warning".to_string(),
                title: "Live CPU utilisation is high".to_string(),
                detail: format!("Nodes are consuming {usage_pressure:.0}% of allocatable CPU right now."),
                count: 1,
                targets: Vec::new(),
                hint: "Confirm whether this is steady state or a spike before scaling.".to_string(),
            });
        }
    }

    if !workloads.degraded.is_empty() {
        findings.push(Finding {
            severity: "serious".to_string(),
            title: "Workloads are below desired replicas".to_string(),
            detail: "These controllers have fewer ready replicas than requested, so they are running with reduced redundancy.".to_string(),
            count: workloads.degraded.len(),
            targets: workloads
                .degraded
                .iter()
                .take(TOP_LIST_LIMIT)
                .map(|workload| format!("{} {}/{} — {}/{}", workload.kind, workload.namespace, workload.name, workload.ready, workload.desired))
                .collect(),
            hint: "Inspect the newest ReplicaSet's events, then the pod-level reason.".to_string(),
        });
    }

    if let Some(control_plane_minor) = control_plane_minor {
        let skewed: Vec<String> = nodes
            .iter()
            .filter(|node| node.kubelet_minor.is_some_and(|minor| minor != control_plane_minor))
            .map(|node| format!("{} ({})", node.name, node.kubelet_version))
            .collect();
        if !skewed.is_empty() {
            findings.push(Finding {
                severity: "warning".to_string(),
                title: "Kubelet version skew".to_string(),
                detail: format!("Some nodes do not run kubelet 1.{control_plane_minor}. Kubernetes supports only a bounded skew below the control plane."),
                count: skewed.len(),
                targets: skewed.into_iter().take(TOP_LIST_LIMIT).collect(),
                hint: "Roll the node group to the AMI matching the control plane minor version.".to_string(),
            });
        }
    }

    let ready_zones = distribution.zones.iter().filter(|zone| zone.ready_nodes > 0).count();
    if ready_zones == 1 && nodes.len() > 1 {
        findings.push(Finding {
            severity: "warning".to_string(),
            title: "All ready nodes are in one Availability Zone".to_string(),
            detail: "A single-AZ node fleet loses the whole data plane if that AZ degrades.".to_string(),
            count: 1,
            targets: distribution.zones.iter().map(|zone| format!("{} — {} node(s)", zone.zone, zone.nodes)).collect(),
            hint: "Spread the node group across at least two Availability Zones.".to_string(),
        });
    }

    if let Some(spot) = distribution.capacity_types.iter().find(|bucket| bucket.label == "SPOT") {
        let total: usize = distribution.capacity_types.iter().map(|bucket| bucket.value).sum();
        if total > 0 && percent(spot.value as f64, total as f64) >= 80.0 {
            findings.push(Finding {
                severity: "warning".to_string(),
                title: "The fleet is almost entirely Spot".to_string(),
                detail: format!("{} of {total} nodes are Spot capacity, so a reclaim wave can remove most of the data plane at once.", spot.value),
                count: spot.value,
                targets: Vec::new(),
                hint: "Keep an on-demand baseline for workloads that cannot tolerate a two-minute eviction notice.".to_string(),
            });
        }
    }

    if events.warning_count > 0 {
        if let Some(top) = events.by_reason.first() {
            findings.push(Finding {
                severity: "warning".to_string(),
                title: "Warning events are being emitted".to_string(),
                detail: format!("{} warning event(s) across the cluster. The most frequent reason is {}.", events.warning_count, top.label),
                count: events.warning_count,
                targets: events.by_reason.iter().take(6).map(|bucket| format!("{} × {}", bucket.value, bucket.label)).collect(),
                hint: "Events expire after roughly an hour, so a high count means the problem is current.".to_string(),
            });
        }
    }

    if findings.is_empty() {
        findings.push(Finding {
            severity: "good".to_string(),
            title: "No health signal is currently failing".to_string(),
            detail: "Every collected signal — node readiness, node conditions, pod readiness, container stability, headroom, and workload availability — is within its threshold.".to_string(),
            count: 0,
            targets: Vec::new(),
            hint: "This reflects the data the current identity is allowed to read.".to_string(),
        });
    }

    let severity_rank = |severity: &str| match severity {
        "critical" => 0,
        "serious" => 1,
        "warning" => 2,
        _ => 3,
    };
    findings.sort_by_key(|finding| severity_rank(&finding.severity));
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cpu_quantities() {
        assert_eq!(parse_cpu_milli("100m"), Some(100.0));
        assert_eq!(parse_cpu_milli("2"), Some(2000.0));
        assert_eq!(parse_cpu_milli("0.5"), Some(500.0));
        assert_eq!(parse_cpu_milli("1500000n"), Some(1.5));
        assert_eq!(parse_cpu_milli(""), None);
    }

    #[test]
    fn parses_memory_quantities() {
        assert_eq!(parse_memory_bytes("128Mi"), Some(134_217_728.0));
        assert_eq!(parse_memory_bytes("1Gi"), Some(1_073_741_824.0));
        assert_eq!(parse_memory_bytes("1000k"), Some(1_000_000.0));
        assert_eq!(parse_memory_bytes("2048"), Some(2048.0));
    }

    #[test]
    fn parses_minor_from_eks_and_upstream_versions() {
        assert_eq!(parse_minor("v1.30.4-eks-a1b2c3"), Some(30));
        assert_eq!(parse_minor("1.29.8"), Some(29));
        assert_eq!(parse_minor("garbage"), None);
    }

    #[test]
    fn parses_eks_cluster_arn() {
        let parsed = parse_cluster_arn("arn:aws:eks:sa-east-1:123456789012:cluster/prod-shark");
        assert_eq!(parsed, Some(("sa-east-1".to_string(), "123456789012".to_string(), "prod-shark".to_string())));
        assert_eq!(parse_cluster_arn("minikube"), None);
    }

    fn labels(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect()
    }

    #[test]
    fn detects_provider_from_provider_id_before_labels() {
        assert_eq!(
            detect_provider(&["azure:///subscriptions/abc/vm/0".to_string()], &["eks.amazonaws.com/nodegroup".to_string()], "")
                .key(),
            "aks"
        );
        assert_eq!(detect_provider(&["aws:///sa-east-1a/i-0abc".to_string()], &[], "").key(), "eks");
        assert_eq!(detect_provider(&["gce://project/zone/node".to_string()], &[], "").key(), "gke");
    }

    #[test]
    fn falls_back_to_labels_then_endpoint_then_generic() {
        assert_eq!(detect_provider(&[], &["kubernetes.azure.com/agentpool".to_string()], "").key(), "aks");
        assert_eq!(detect_provider(&[], &["cloud.google.com/gke-nodepool".to_string()], "").key(), "gke");
        assert_eq!(detect_provider(&[], &[], "https://x.hcp.eastus.azmk8s.io:443").key(), "aks");
        assert_eq!(detect_provider(&[], &[], "https://127.0.0.1:6443").key(), "generic");
    }

    #[test]
    fn normalises_capacity_type_across_providers() {
        assert_eq!(capacity_type_of(&labels(&[("eks.amazonaws.com/capacityType", "SPOT")]), Provider::Eks), "SPOT");
        assert_eq!(capacity_type_of(&labels(&[("karpenter.sh/capacity-type", "on-demand")]), Provider::Eks), "ON_DEMAND");
        assert_eq!(capacity_type_of(&labels(&[("kubernetes.azure.com/scalesetpriority", "spot")]), Provider::Aks), "SPOT");
        assert_eq!(capacity_type_of(&labels(&[("cloud.google.com/gke-spot", "true")]), Provider::Gke), "SPOT");
        // A managed provider with no spot marker is a regular node, not an unknown.
        assert_eq!(capacity_type_of(&labels(&[("agentpool", "system")]), Provider::Aks), "ON_DEMAND");
        assert_eq!(capacity_type_of(&labels(&[]), Provider::Generic), "UNKNOWN");
    }

    #[test]
    fn formats_taints_the_way_tolerations_are_written() {
        assert_eq!(taint_label("dedicated", Some("gpu"), "NoSchedule"), "dedicated=gpu:NoSchedule");
        assert_eq!(taint_label("node.kubernetes.io/unreachable", None, "NoExecute"), "node.kubernetes.io/unreachable:NoExecute");
        // An empty value is not the same as `key=:Effect`.
        assert_eq!(taint_label("spot", Some(""), "NoSchedule"), "spot:NoSchedule");
    }

    #[test]
    fn orders_taints_by_how_disruptive_the_effect_is() {
        let mut effects = ["PreferNoSchedule", "NoSchedule", "NoExecute"];
        effects.sort_by_key(|effect| effect_rank(effect));
        assert_eq!(effects, ["NoExecute", "NoSchedule", "PreferNoSchedule"]);
    }

    #[test]
    fn reads_the_node_pool_label_of_each_provider() {
        assert_eq!(node_pool_of(&labels(&[("eks.amazonaws.com/nodegroup", "ng-a")])), Some("ng-a".to_string()));
        assert_eq!(node_pool_of(&labels(&[("kubernetes.azure.com/agentpool", "userpool")])), Some("userpool".to_string()));
        assert_eq!(node_pool_of(&labels(&[("cloud.google.com/gke-nodepool", "default-pool")])), Some("default-pool".to_string()));
        assert_eq!(node_pool_of(&labels(&[("unrelated", "x")])), None);
    }

    #[test]
    fn folds_the_tail_of_a_ranked_distribution_into_other() {
        let counts = HashMap::from([
            ("a".to_string(), 10),
            ("b".to_string(), 5),
            ("c".to_string(), 3),
            ("d".to_string(), 2),
        ]);
        let buckets = ranked_buckets(counts, 2);
        assert_eq!(buckets.len(), 3);
        assert_eq!(buckets[0].label, "a");
        assert_eq!(buckets[2].label, "Other");
        assert_eq!(buckets[2].value, 5);
    }
}
