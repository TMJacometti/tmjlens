use k8s_openapi::api::{
    admissionregistration::v1::{MutatingWebhookConfiguration, ValidatingWebhookConfiguration},
    autoscaling::v2::HorizontalPodAutoscaler,
    coordination::v1::Lease,
    core::v1::{ConfigMap, LimitRange, Pod, ResourceQuota, Secret, Service},
    node::v1::RuntimeClass,
    policy::v1::PodDisruptionBudget,
    scheduling::v1::PriorityClass,
};
use kube::{api::ListParams, Api, Client};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::format_age;

/// How many consumers to name before summarising. A ConfigMap mounted by every pod in
/// the namespace should not push the table off the screen.
const CONSUMER_LIMIT: usize = 6;

#[derive(Serialize, Clone)]
pub struct ConfigurationOverview {
    pub namespace: String,
    pub config_maps: Vec<ConfigMapInfo>,
    pub secrets: Vec<SecretInfo>,
    pub quotas: Vec<QuotaInfo>,
    pub limit_ranges: Vec<LimitRangeInfo>,
    pub autoscalers: Vec<AutoscalerInfo>,
    pub disruption_budgets: Vec<DisruptionBudgetInfo>,
    pub leases: Vec<LeaseInfo>,
    pub priority_classes: Vec<PriorityClassInfo>,
    pub runtime_classes: Vec<RuntimeClassInfo>,
    pub webhooks: Vec<WebhookInfo>,
    pub findings: Vec<ConfigFinding>,
    pub degraded_collectors: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct KeyInfo {
    pub key: String,
    pub bytes: usize,
    /// Binary keys cannot be shown or edited as text.
    pub binary: bool,
}

#[derive(Serialize, Clone)]
pub struct ConfigMapInfo {
    pub name: String,
    pub keys: Vec<KeyInfo>,
    pub total_bytes: usize,
    pub immutable: bool,
    pub used_by: Vec<String>,
    pub used_by_total: usize,
    pub managed_by: Option<String>,
    pub age: String,
}

/// A Secret, described without ever carrying a value.
///
/// Key names and sizes are listed; the values are not part of this payload at all, so
/// nothing sensitive sits in the frontend's memory just because a list was opened. A
/// value crosses into the UI only when the operator asks for that one key.
#[derive(Serialize, Clone)]
pub struct SecretInfo {
    pub name: String,
    pub secret_type: String,
    pub keys: Vec<KeyInfo>,
    pub total_bytes: usize,
    pub immutable: bool,
    pub used_by: Vec<String>,
    pub used_by_total: usize,
    pub managed_by: Option<String>,
    /// What this Secret is for, when its type says so.
    pub purpose: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct QuotaEntry {
    pub resource: String,
    pub used: String,
    pub hard: String,
    /// None when either side cannot be parsed, rather than a misleading zero.
    pub percent: Option<f64>,
    pub health: String,
}

#[derive(Serialize, Clone)]
pub struct QuotaInfo {
    pub name: String,
    pub scopes: Vec<String>,
    pub entries: Vec<QuotaEntry>,
    pub health: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct LimitRangeItemInfo {
    pub item_type: String,
    pub resource: String,
    pub min: Option<String>,
    pub max: Option<String>,
    pub default_limit: Option<String>,
    pub default_request: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct LimitRangeInfo {
    pub name: String,
    pub items: Vec<LimitRangeItemInfo>,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct AutoscalerInfo {
    pub name: String,
    pub target: String,
    pub min_replicas: i32,
    pub max_replicas: i32,
    pub current_replicas: i32,
    pub desired_replicas: i32,
    pub metrics: Vec<String>,
    pub health: String,
    pub reason: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct DisruptionBudgetInfo {
    pub name: String,
    pub requirement: String,
    pub current_healthy: i32,
    pub desired_healthy: i32,
    pub disruptions_allowed: i32,
    pub expected_pods: i32,
    pub health: String,
    pub reason: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct LeaseInfo {
    pub name: String,
    pub holder: Option<String>,
    pub renewed: Option<String>,
    pub duration_seconds: Option<i32>,
    pub health: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct PriorityClassInfo {
    pub name: String,
    pub value: i32,
    pub global_default: bool,
    pub preemption: String,
    pub description: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct RuntimeClassInfo {
    pub name: String,
    pub handler: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct WebhookInfo {
    pub configuration: String,
    /// "Mutating" or "Validating".
    pub kind: String,
    pub webhook: String,
    pub failure_policy: String,
    pub timeout_seconds: Option<i32>,
    pub rules: Vec<String>,
    /// Set when the webhook points at a Service in this cluster.
    pub service: Option<String>,
    pub service_exists: Option<bool>,
    pub health: String,
    pub reason: String,
}

#[derive(Serialize, Clone)]
pub struct ConfigFinding {
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub targets: Vec<String>,
}

// ---------------------------------------------------------------- quantities

/// Parses a Kubernetes quantity into a plain number, so quota usage can be shown as a
/// proportion rather than as two opaque strings side by side.
///
/// Returns None for anything it does not recognise. A quota bar drawn from a guess is
/// worse than no bar: it would read as measured.
pub fn parse_quantity(raw: &str) -> Option<f64> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }

    let split = text
        .find(|character: char| !character.is_ascii_digit() && character != '.' && character != '-' && character != '+')
        .unwrap_or(text.len());
    let (number, suffix) = text.split_at(split);
    let value: f64 = number.parse().ok()?;

    let multiplier = match suffix.trim() {
        "" => 1.0,
        // Binary suffixes.
        "Ki" => 1024.0,
        "Mi" => 1024f64.powi(2),
        "Gi" => 1024f64.powi(3),
        "Ti" => 1024f64.powi(4),
        "Pi" => 1024f64.powi(5),
        "Ei" => 1024f64.powi(6),
        // Decimal suffixes.
        "n" => 1e-9,
        "u" => 1e-6,
        "m" => 1e-3,
        "k" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        "P" => 1e15,
        "E" => 1e18,
        // Exponent form, as the API server sometimes writes it.
        other if other.starts_with('e') || other.starts_with('E') => {
            let exponent: i32 = other[1..].parse().ok()?;
            10f64.powi(exponent)
        }
        _ => return None,
    };

    Some(value * multiplier)
}

fn quota_health(percent: Option<f64>) -> &'static str {
    match percent {
        Some(value) if value >= 100.0 => "critical",
        Some(value) if value >= 90.0 => "serious",
        Some(value) if value >= 75.0 => "warning",
        Some(_) => "good",
        // Unparsed is not healthy; it is unknown, and says so.
        None => "unknown",
    }
}

// ---------------------------------------------------------------- consumers

#[derive(Default)]
struct Consumers {
    config_maps: HashMap<String, BTreeSet<String>>,
    secrets: HashMap<String, BTreeSet<String>>,
}

impl Consumers {
    fn add_config_map(&mut self, name: &str, pod: &str) {
        self.config_maps.entry(name.to_string()).or_default().insert(pod.to_string());
    }

    fn add_secret(&mut self, name: &str, pod: &str) {
        self.secrets.entry(name.to_string()).or_default().insert(pod.to_string());
    }
}

/// Walks every place a pod can name a ConfigMap or Secret.
///
/// Missing one of these would report a Secret that is in use as unused, which is the
/// one wrong answer that gets something deleted.
fn collect_consumers(pods: &[Pod]) -> Consumers {
    let mut found = Consumers::default();

    for pod in pods {
        let pod_name = pod.metadata.name.clone().unwrap_or_default();
        let Some(spec) = &pod.spec else { continue };

        for reference in spec.image_pull_secrets.iter().flatten() {
            found.add_secret(&reference.name, &pod_name);
        }

        for volume in spec.volumes.iter().flatten() {
            if let Some(source) = &volume.config_map {
                found.add_config_map(&source.name, &pod_name);
            }
            if let Some(source) = &volume.secret {
                if let Some(name) = &source.secret_name {
                    found.add_secret(name, &pod_name);
                }
            }
            // A projected volume nests the same references one level down.
            for source in volume.projected.iter().flat_map(|projected| projected.sources.iter().flatten()) {
                if let Some(inner) = &source.config_map {
                    found.add_config_map(&inner.name, &pod_name);
                }
                if let Some(inner) = &source.secret {
                    found.add_secret(&inner.name, &pod_name);
                }
            }
        }

        // Init and ephemeral containers reference them just as ordinary ones do.
        let containers = spec
            .containers
            .iter()
            .chain(spec.init_containers.iter().flatten());

        for container in containers {
            for source in container.env_from.iter().flatten() {
                if let Some(reference) = &source.config_map_ref {
                    found.add_config_map(&reference.name, &pod_name);
                }
                if let Some(reference) = &source.secret_ref {
                    found.add_secret(&reference.name, &pod_name);
                }
            }

            for variable in container.env.iter().flatten() {
                let Some(from) = &variable.value_from else { continue };
                if let Some(reference) = &from.config_map_key_ref {
                    found.add_config_map(&reference.name, &pod_name);
                }
                if let Some(reference) = &from.secret_key_ref {
                    found.add_secret(&reference.name, &pod_name);
                }
            }
        }
    }

    found
}

fn trim_consumers(all: Option<&BTreeSet<String>>) -> (Vec<String>, usize) {
    let entries: Vec<String> = all.map(|set| set.iter().cloned().collect()).unwrap_or_default();
    let total = entries.len();
    (entries.into_iter().take(CONSUMER_LIMIT).collect(), total)
}

/// Names the tool that owns an object, so an operator knows an edit here will be
/// reverted on the next sync.
fn managed_by(labels: Option<&BTreeMap<String, String>>, annotations: Option<&BTreeMap<String, String>>) -> Option<String> {
    let labels = labels?;
    if labels.get("app.kubernetes.io/managed-by").map(String::as_str) == Some("Helm")
        || annotations.is_some_and(|map| map.contains_key("meta.helm.sh/release-name"))
    {
        return Some("Helm".to_string());
    }
    if labels.contains_key("argocd.argoproj.io/instance") {
        return Some("Argo CD".to_string());
    }
    if labels.get("kustomize.toolkit.fluxcd.io/name").is_some() {
        return Some("Flux".to_string());
    }
    None
}

/// What a Secret is for, read from its type rather than guessed from its name.
pub fn secret_purpose(secret_type: &str) -> &'static str {
    match secret_type {
        "kubernetes.io/service-account-token" => "Service account token, issued by Kubernetes",
        "kubernetes.io/dockerconfigjson" | "kubernetes.io/dockercfg" => "Registry pull credentials",
        "kubernetes.io/tls" => "TLS certificate and private key",
        "kubernetes.io/basic-auth" => "Username and password",
        "kubernetes.io/ssh-auth" => "SSH private key",
        "bootstrap.kubernetes.io/token" => "Cluster bootstrap token",
        "helm.sh/release.v1" => "Helm release history, written by Helm",
        _ => "Application data",
    }
}

// ---------------------------------------------------------------- collectors

fn config_map_info(item: ConfigMap, consumers: &Consumers) -> ConfigMapInfo {
    let mut keys: Vec<KeyInfo> = item
        .data
        .iter()
        .flatten()
        .map(|(key, value)| KeyInfo { key: key.clone(), bytes: value.len(), binary: false })
        .chain(item.binary_data.iter().flatten().map(|(key, value)| KeyInfo {
            key: key.clone(),
            bytes: value.0.len(),
            binary: true,
        }))
        .collect();
    keys.sort_by(|left, right| left.key.cmp(&right.key));

    let name = item.metadata.name.clone().unwrap_or_default();
    let (used_by, used_by_total) = trim_consumers(consumers.config_maps.get(&name));

    ConfigMapInfo {
        total_bytes: keys.iter().map(|entry| entry.bytes).sum(),
        immutable: item.immutable.unwrap_or(false),
        managed_by: managed_by(item.metadata.labels.as_ref(), item.metadata.annotations.as_ref()),
        age: item.metadata.creation_timestamp.as_ref().map(|stamp| format_age(stamp.0)).unwrap_or_default(),
        keys,
        used_by,
        used_by_total,
        name,
    }
}

fn secret_info(item: Secret, consumers: &Consumers) -> SecretInfo {
    let mut keys: Vec<KeyInfo> = item
        .data
        .iter()
        .flatten()
        .map(|(key, value)| KeyInfo {
            key: key.clone(),
            bytes: value.0.len(),
            // Decided when the value is asked for, not guessed from the key name.
            binary: false,
        })
        .collect();
    keys.sort_by(|left, right| left.key.cmp(&right.key));

    let secret_type = item.type_.clone().unwrap_or_else(|| "Opaque".to_string());
    let name = item.metadata.name.clone().unwrap_or_default();
    let (used_by, used_by_total) = trim_consumers(consumers.secrets.get(&name));

    SecretInfo {
        total_bytes: keys.iter().map(|entry| entry.bytes).sum(),
        immutable: item.immutable.unwrap_or(false),
        managed_by: managed_by(item.metadata.labels.as_ref(), item.metadata.annotations.as_ref()),
        age: item.metadata.creation_timestamp.as_ref().map(|stamp| format_age(stamp.0)).unwrap_or_default(),
        purpose: secret_purpose(&secret_type).to_string(),
        keys,
        used_by,
        used_by_total,
        secret_type,
        name,
    }
}

fn quota_info(item: ResourceQuota) -> QuotaInfo {
    let status = item.status.unwrap_or_default();
    let hard = status.hard.clone().or_else(|| item.spec.as_ref().and_then(|spec| spec.hard.clone())).unwrap_or_default();
    let used = status.used.unwrap_or_default();

    let mut entries: Vec<QuotaEntry> = hard
        .iter()
        .map(|(resource, limit)| {
            let consumed = used.get(resource).map(|value| value.0.clone()).unwrap_or_else(|| "0".to_string());
            let percent = match (parse_quantity(&consumed), parse_quantity(&limit.0)) {
                (Some(_), Some(total)) if total == 0.0 => None,
                (Some(current), Some(total)) => Some(current / total * 100.0),
                _ => None,
            };
            QuotaEntry {
                resource: resource.clone(),
                used: consumed,
                hard: limit.0.clone(),
                health: quota_health(percent).to_string(),
                percent,
            }
        })
        .collect();
    entries.sort_by(|left, right| {
        right.percent.unwrap_or(-1.0).total_cmp(&left.percent.unwrap_or(-1.0))
    });

    let health = entries
        .iter()
        .map(|entry| entry.health.as_str())
        .max_by_key(|health| severity_rank(health))
        .unwrap_or("good")
        .to_string();

    QuotaInfo {
        scopes: item.spec.and_then(|spec| spec.scopes).unwrap_or_default(),
        age: item.metadata.creation_timestamp.as_ref().map(|stamp| format_age(stamp.0)).unwrap_or_default(),
        name: item.metadata.name.unwrap_or_default(),
        entries,
        health,
    }
}

pub fn severity_rank(severity: &str) -> u8 {
    match severity {
        "critical" => 4,
        "serious" => 3,
        "warning" => 2,
        "unknown" => 1,
        _ => 0,
    }
}

fn limit_range_info(item: LimitRange) -> LimitRangeInfo {
    let mut rows = Vec::new();
    for entry in item.spec.iter().flat_map(|spec| spec.limits.iter()) {
        let mut resources: BTreeSet<String> = BTreeSet::new();
        for map in [&entry.min, &entry.max, &entry.default, &entry.default_request] {
            for key in map.iter().flat_map(|inner| inner.keys()) {
                resources.insert(key.clone());
            }
        }
        for resource in resources {
            let read = |map: &Option<BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>| {
                map.as_ref().and_then(|inner| inner.get(&resource)).map(|value| value.0.clone())
            };
            rows.push(LimitRangeItemInfo {
                item_type: entry.type_.clone(),
                min: read(&entry.min),
                max: read(&entry.max),
                default_limit: read(&entry.default),
                default_request: read(&entry.default_request),
                resource,
            });
        }
    }

    LimitRangeInfo {
        items: rows,
        age: item.metadata.creation_timestamp.as_ref().map(|stamp| format_age(stamp.0)).unwrap_or_default(),
        name: item.metadata.name.unwrap_or_default(),
    }
}

fn autoscaler_info(item: HorizontalPodAutoscaler) -> AutoscalerInfo {
    let spec = item.spec.unwrap_or_default();
    let status = item.status.unwrap_or_default();
    let min_replicas = spec.min_replicas.unwrap_or(1);
    let max_replicas = spec.max_replicas;
    let current_replicas = status.current_replicas.unwrap_or(0);
    let desired_replicas = status.desired_replicas;

    let metrics = spec
        .metrics
        .iter()
        .flatten()
        .map(describe_metric)
        .collect::<Vec<String>>();

    let able_to_scale = status
        .conditions
        .iter()
        .flatten()
        .find(|condition| condition.type_ == "ScalingActive");

    // Pinned at the ceiling is the state worth surfacing: the autoscaler has run out of
    // room, so load above this point is absorbed by latency instead of by replicas.
    let (health, reason) = if able_to_scale.is_some_and(|condition| condition.status == "False") {
        (
            "serious",
            able_to_scale
                .and_then(|condition| condition.message.clone())
                .unwrap_or_else(|| "The autoscaler cannot read its metrics.".to_string()),
        )
    } else if current_replicas >= max_replicas && max_replicas > 0 {
        ("warning", format!("At its ceiling of {max_replicas}; it cannot scale further."))
    } else if current_replicas != desired_replicas {
        ("warning", format!("Scaling from {current_replicas} to {desired_replicas}."))
    } else {
        ("good", format!("Between {min_replicas} and {max_replicas} replicas."))
    };

    AutoscalerInfo {
        target: format!("{}/{}", spec.scale_target_ref.kind, spec.scale_target_ref.name),
        age: item.metadata.creation_timestamp.as_ref().map(|stamp| format_age(stamp.0)).unwrap_or_default(),
        name: item.metadata.name.unwrap_or_default(),
        health: health.to_string(),
        reason,
        min_replicas,
        max_replicas,
        current_replicas,
        desired_replicas,
        metrics,
    }
}

fn describe_metric(metric: &k8s_openapi::api::autoscaling::v2::MetricSpec) -> String {
    let target = |target: &k8s_openapi::api::autoscaling::v2::MetricTarget| {
        if let Some(percent) = target.average_utilization {
            format!("{percent}%")
        } else if let Some(value) = &target.average_value {
            value.0.clone()
        } else if let Some(value) = &target.value {
            value.0.clone()
        } else {
            "unset".to_string()
        }
    };

    match metric.type_.as_str() {
        "Resource" => metric
            .resource
            .as_ref()
            .map(|entry| format!("{} at {}", entry.name, target(&entry.target)))
            .unwrap_or_else(|| "resource".to_string()),
        "Pods" => metric
            .pods
            .as_ref()
            .map(|entry| format!("{} per pod at {}", entry.metric.name, target(&entry.target)))
            .unwrap_or_else(|| "pods".to_string()),
        "External" => metric
            .external
            .as_ref()
            .map(|entry| format!("external {} at {}", entry.metric.name, target(&entry.target)))
            .unwrap_or_else(|| "external".to_string()),
        other => other.to_string(),
    }
}

/// A budget states its requirement either as a count or as a percentage of the
/// selected pods, and both need rendering as written.
fn int_or_string(value: &k8s_openapi::apimachinery::pkg::util::intstr::IntOrString) -> String {
    use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
    match value {
        IntOrString::Int(number) => number.to_string(),
        IntOrString::String(text) => text.clone(),
    }
}

fn disruption_budget_info(item: PodDisruptionBudget) -> DisruptionBudgetInfo {
    let spec = item.spec.unwrap_or_default();
    let status = item.status.unwrap_or_default();

    let requirement = match (&spec.min_available, &spec.max_unavailable) {
        (Some(value), _) => format!("at least {} available", int_or_string(value)),
        (_, Some(value)) => format!("at most {} unavailable", int_or_string(value)),
        _ => "no requirement set".to_string(),
    };

    // A budget allowing zero disruptions is what makes `kubectl drain` hang forever.
    // The app offers drain on the Nodes screen, so this is worth stating outright.
    let (health, reason) = if status.disruptions_allowed == 0 {
        (
            "serious",
            format!(
                "No pod may be evicted right now, so draining a node running these pods will block. \
                 {} of {} pods are healthy.",
                status.current_healthy, status.desired_healthy
            ),
        )
    } else if status.current_healthy < status.desired_healthy {
        (
            "warning",
            format!("{} of {} pods healthy.", status.current_healthy, status.desired_healthy),
        )
    } else {
        ("good", format!("{} eviction(s) allowed.", status.disruptions_allowed))
    };

    DisruptionBudgetInfo {
        age: item.metadata.creation_timestamp.as_ref().map(|stamp| format_age(stamp.0)).unwrap_or_default(),
        name: item.metadata.name.unwrap_or_default(),
        current_healthy: status.current_healthy,
        desired_healthy: status.desired_healthy,
        disruptions_allowed: status.disruptions_allowed,
        expected_pods: status.expected_pods,
        health: health.to_string(),
        requirement,
        reason,
    }
}

fn lease_info(item: Lease) -> LeaseInfo {
    let spec = item.spec.unwrap_or_default();
    let renewed = spec.renew_time.as_ref().map(|time| time.0.to_rfc3339());
    let duration = spec.lease_duration_seconds;

    // A lease whose renewal is older than several times its own duration is stale: the
    // holder stopped renewing without releasing it.
    let health = match (&spec.renew_time, duration) {
        (Some(time), Some(seconds)) => {
            let elapsed = (chrono::Utc::now() - time.0).num_seconds();
            if elapsed > i64::from(seconds) * 3 { "warning" } else { "good" }
        }
        _ => "good",
    };

    LeaseInfo {
        holder: spec.holder_identity,
        duration_seconds: duration,
        age: item.metadata.creation_timestamp.as_ref().map(|stamp| format_age(stamp.0)).unwrap_or_default(),
        name: item.metadata.name.unwrap_or_default(),
        health: health.to_string(),
        renewed,
    }
}

fn priority_class_info(item: PriorityClass) -> PriorityClassInfo {
    PriorityClassInfo {
        value: item.value,
        global_default: item.global_default.unwrap_or(false),
        preemption: item.preemption_policy.unwrap_or_else(|| "PreemptLowerPriority".to_string()),
        description: item.description.unwrap_or_default(),
        age: item.metadata.creation_timestamp.as_ref().map(|stamp| format_age(stamp.0)).unwrap_or_default(),
        name: item.metadata.name.unwrap_or_default(),
    }
}

fn runtime_class_info(item: RuntimeClass) -> RuntimeClassInfo {
    RuntimeClassInfo {
        handler: item.handler,
        age: item.metadata.creation_timestamp.as_ref().map(|stamp| format_age(stamp.0)).unwrap_or_default(),
        name: item.metadata.name.unwrap_or_default(),
    }
}

/// Judges one webhook against the services that exist in the cluster.
///
/// The failure this catches is specific and severe: a webhook with `failurePolicy:
/// Fail` whose backing Service has been deleted rejects every matching API write,
/// which can make a namespace — or the whole cluster — unwritable. Listing webhooks
/// without checking the target names the object but not the outage.
fn webhook_row(
    configuration: &str,
    kind: &str,
    webhook: &str,
    failure_policy: Option<String>,
    timeout_seconds: Option<i32>,
    service: Option<(String, String)>,
    rules: Vec<String>,
    known_services: &BTreeSet<String>,
) -> WebhookInfo {
    let failure_policy = failure_policy.unwrap_or_else(|| "Fail".to_string());
    let service_key = service.as_ref().map(|(namespace, name)| format!("{namespace}/{name}"));
    let exists = service_key.as_ref().map(|key| known_services.contains(key));

    let (health, reason) = match (exists, failure_policy.as_str()) {
        (Some(false), "Fail") => (
            "critical",
            format!(
                "Its service {} does not exist, and the policy is Fail — every matching API write is \
                 rejected until this is fixed.",
                service_key.clone().unwrap_or_default()
            ),
        ),
        (Some(false), _) => (
            "warning",
            format!(
                "Its service {} does not exist. The policy is Ignore, so writes still succeed, but this \
                 webhook does nothing.",
                service_key.clone().unwrap_or_default()
            ),
        ),
        (_, "Fail") => (
            "good",
            "Rejects matching writes if it cannot be reached.".to_string(),
        ),
        _ => ("good", "Matching writes proceed if it cannot be reached.".to_string()),
    };

    WebhookInfo {
        configuration: configuration.to_string(),
        kind: kind.to_string(),
        webhook: webhook.to_string(),
        service: service_key,
        service_exists: exists,
        health: health.to_string(),
        reason,
        failure_policy,
        timeout_seconds,
        rules,
    }
}

fn describe_rules(rules: &[k8s_openapi::api::admissionregistration::v1::RuleWithOperations]) -> Vec<String> {
    rules
        .iter()
        .map(|rule| {
            let operations = rule.operations.clone().unwrap_or_default().join(",");
            let resources = rule.resources.clone().unwrap_or_default().join(",");
            format!("{operations} {resources}")
        })
        .collect()
}

// ---------------------------------------------------------------- findings

fn build_findings(overview: &ConfigurationOverview) -> Vec<ConfigFinding> {
    let mut findings = Vec::new();

    let blocking: Vec<String> = overview
        .disruption_budgets
        .iter()
        .filter(|budget| budget.disruptions_allowed == 0)
        .map(|budget| budget.name.clone())
        .collect();
    if !blocking.is_empty() {
        findings.push(ConfigFinding {
            severity: "serious".to_string(),
            title: "A disruption budget allows no evictions".to_string(),
            detail: "Draining a node that runs these pods will block until the budget is satisfied. \
                     This is the usual reason a node drain never finishes."
                .to_string(),
            targets: blocking,
        });
    }

    let broken: Vec<String> = overview
        .webhooks
        .iter()
        .filter(|hook| hook.health == "critical")
        .map(|hook| format!("{} · {}", hook.configuration, hook.webhook))
        .collect();
    if !broken.is_empty() {
        findings.push(ConfigFinding {
            severity: "critical".to_string(),
            title: "An admission webhook points at a service that does not exist".to_string(),
            detail: "Its failure policy is Fail, so the API server rejects every write that matches its \
                     rules. Deleting the webhook configuration, or restoring the service, unblocks it."
                .to_string(),
            targets: broken,
        });
    }

    let exhausted: Vec<String> = overview
        .quotas
        .iter()
        .flat_map(|quota| {
            quota
                .entries
                .iter()
                .filter(|entry| entry.health == "critical" || entry.health == "serious")
                .map(move |entry| format!("{} · {} at {}", quota.name, entry.resource, entry.used))
        })
        .collect();
    if !exhausted.is_empty() {
        findings.push(ConfigFinding {
            severity: "serious".to_string(),
            title: "A resource quota is nearly or fully consumed".to_string(),
            detail: "New pods in this namespace will be rejected once the hard limit is reached."
                .to_string(),
            targets: exhausted,
        });
    }

    let pinned: Vec<String> = overview
        .autoscalers
        .iter()
        .filter(|hpa| hpa.current_replicas >= hpa.max_replicas && hpa.max_replicas > 0)
        .map(|hpa| format!("{} at {} replicas", hpa.name, hpa.current_replicas))
        .collect();
    if !pinned.is_empty() {
        findings.push(ConfigFinding {
            severity: "warning".to_string(),
            title: "An autoscaler is at its ceiling".to_string(),
            detail: "It has no room left to scale, so additional load is absorbed as latency rather \
                     than as replicas."
                .to_string(),
            targets: pinned,
        });
    }

    // Unreferenced is reported as an observation, never as an instruction to delete:
    // plenty of legitimate Secrets are read by something other than a running pod.
    let orphan_secrets: Vec<String> = overview
        .secrets
        .iter()
        .filter(|secret| {
            secret.used_by_total == 0
                && secret.secret_type != "kubernetes.io/service-account-token"
                && secret.secret_type != "helm.sh/release.v1"
        })
        .map(|secret| secret.name.clone())
        .collect();
    let orphan_maps: Vec<String> = overview
        .config_maps
        .iter()
        .filter(|entry| entry.used_by_total == 0 && entry.name != "kube-root-ca.crt")
        .map(|entry| entry.name.clone())
        .collect();

    if !orphan_secrets.is_empty() || !orphan_maps.is_empty() {
        let mut targets = orphan_maps;
        targets.extend(orphan_secrets);
        findings.push(ConfigFinding {
            severity: "warning".to_string(),
            title: "Not referenced by any running pod".to_string(),
            detail: "No pod in this namespace mounts these or reads them as environment variables. \
                     They may still be read by a controller, a Job that is not running, or something \
                     outside the namespace — check before deleting."
                .to_string(),
            targets,
        });
    }

    findings
}

// ---------------------------------------------------------------- entry point

/// Reads everything the Configuration screen shows.
///
/// The namespaced collectors are required; the cluster-scoped ones are not. An
/// identity that may read its own namespace but not cluster objects gets the screen
/// with those tables reported as unavailable, rather than an error page.
pub async fn overview(client: Client, namespace: &str) -> Result<ConfigurationOverview, String> {
    let params = ListParams::default();
    let mut degraded = Vec::new();

    let config_maps: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
    let secrets: Api<Secret> = Api::namespaced(client.clone(), namespace);
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let quotas: Api<ResourceQuota> = Api::namespaced(client.clone(), namespace);
    let limits: Api<LimitRange> = Api::namespaced(client.clone(), namespace);
    let autoscalers: Api<HorizontalPodAutoscaler> = Api::namespaced(client.clone(), namespace);
    let budgets: Api<PodDisruptionBudget> = Api::namespaced(client.clone(), namespace);
    let leases: Api<Lease> = Api::namespaced(client.clone(), namespace);

    let (map_list, secret_list, pod_list, quota_list, limit_list, hpa_list, pdb_list, lease_list) = tokio::join!(
        config_maps.list(&params),
        secrets.list(&params),
        pods.list(&params),
        quotas.list(&params),
        limits.list(&params),
        autoscalers.list(&params),
        budgets.list(&params),
        leases.list(&params),
    );

    let pod_items = match pod_list {
        Ok(list) => list.items,
        Err(error) => {
            // Without pods there is no consumer map, and "used by" would read as
            // "nothing uses this" for everything. Say so rather than imply it.
            degraded.push(format!(
                "Pods could not be listed, so nothing on this screen can show what uses it ({error})."
            ));
            Vec::new()
        }
    };
    let consumers = collect_consumers(&pod_items);
    let pods_known = !pod_items.is_empty() || degraded.is_empty();

    let mut collect = |label: &str, error: kube::Error| {
        degraded.push(format!("{label} could not be listed ({error})."));
    };

    let config_map_rows = match map_list {
        Ok(list) => list.items.into_iter().map(|item| config_map_info(item, &consumers)).collect(),
        Err(error) => {
            collect("Config maps", error);
            Vec::new()
        }
    };
    let secret_rows = match secret_list {
        Ok(list) => list.items.into_iter().map(|item| secret_info(item, &consumers)).collect(),
        Err(error) => {
            collect("Secrets", error);
            Vec::new()
        }
    };
    let quota_rows = match quota_list {
        Ok(list) => list.items.into_iter().map(quota_info).collect(),
        Err(error) => {
            collect("Resource quotas", error);
            Vec::new()
        }
    };
    let limit_rows = match limit_list {
        Ok(list) => list.items.into_iter().map(limit_range_info).collect(),
        Err(error) => {
            collect("Limit ranges", error);
            Vec::new()
        }
    };
    let hpa_rows = match hpa_list {
        Ok(list) => list.items.into_iter().map(autoscaler_info).collect(),
        Err(error) => {
            collect("Horizontal pod autoscalers", error);
            Vec::new()
        }
    };
    let pdb_rows = match pdb_list {
        Ok(list) => list.items.into_iter().map(disruption_budget_info).collect(),
        Err(error) => {
            collect("Pod disruption budgets", error);
            Vec::new()
        }
    };
    let lease_rows = match lease_list {
        Ok(list) => list.items.into_iter().map(lease_info).collect(),
        Err(error) => {
            collect("Leases", error);
            Vec::new()
        }
    };

    let (priority_classes, runtime_classes, webhooks) = cluster_scoped(client, &mut degraded).await;

    let mut overview = ConfigurationOverview {
        namespace: namespace.to_string(),
        config_maps: config_map_rows,
        secrets: secret_rows,
        quotas: quota_rows,
        limit_ranges: limit_rows,
        autoscalers: hpa_rows,
        disruption_budgets: pdb_rows,
        leases: lease_rows,
        priority_classes,
        runtime_classes,
        webhooks,
        findings: Vec::new(),
        degraded_collectors: degraded,
    };

    overview.findings = build_findings(&overview);
    // An "unused" finding drawn from a pod list that failed to load would be wrong.
    if !pods_known {
        overview.findings.retain(|finding| finding.title != "Not referenced by any running pod");
    }

    Ok(overview)
}

async fn cluster_scoped(
    client: Client,
    degraded: &mut Vec<String>,
) -> (Vec<PriorityClassInfo>, Vec<RuntimeClassInfo>, Vec<WebhookInfo>) {
    let priorities: Api<PriorityClass> = Api::all(client.clone());
    let runtimes: Api<RuntimeClass> = Api::all(client.clone());
    let mutating: Api<MutatingWebhookConfiguration> = Api::all(client.clone());
    let validating: Api<ValidatingWebhookConfiguration> = Api::all(client.clone());
    let services: Api<Service> = Api::all(client);
    let params = ListParams::default();

    let (priority_list, runtime_list, mutating_list, validating_list, service_list) = tokio::join!(
        priorities.list(&params),
        runtimes.list(&params),
        mutating.list(&params),
        validating.list(&params),
        services.list(&params),
    );

    let priority_rows = match priority_list {
        Ok(list) => {
            let mut rows: Vec<PriorityClassInfo> = list.items.into_iter().map(priority_class_info).collect();
            rows.sort_by(|left, right| right.value.cmp(&left.value));
            rows
        }
        Err(error) => {
            degraded.push(format!("Priority classes could not be listed ({error})."));
            Vec::new()
        }
    };

    let runtime_rows = match runtime_list {
        Ok(list) => list.items.into_iter().map(runtime_class_info).collect(),
        Err(error) => {
            degraded.push(format!("Runtime classes could not be listed ({error})."));
            Vec::new()
        }
    };

    // Without the service list, a webhook's target cannot be checked. It is reported as
    // unknown rather than assumed present.
    let known_services: Option<BTreeSet<String>> = match service_list {
        Ok(list) => Some(
            list.items
                .into_iter()
                .filter_map(|service| {
                    Some(format!(
                        "{}/{}",
                        service.metadata.namespace?,
                        service.metadata.name?
                    ))
                })
                .collect(),
        ),
        Err(_) => None,
    };
    let lookup = known_services.clone().unwrap_or_default();

    let mut webhooks = Vec::new();

    match mutating_list {
        Ok(list) => {
            for configuration in list.items {
                let name = configuration.metadata.name.clone().unwrap_or_default();
                for hook in configuration.webhooks.into_iter().flatten() {
                    let service = hook
                        .client_config
                        .service
                        .as_ref()
                        .map(|reference| (reference.namespace.clone(), reference.name.clone()));
                    webhooks.push(webhook_row(
                        &name,
                        "Mutating",
                        &hook.name,
                        hook.failure_policy,
                        hook.timeout_seconds,
                        service,
                        describe_rules(&hook.rules.unwrap_or_default()),
                        &lookup,
                    ));
                }
            }
        }
        Err(error) => degraded.push(format!("Mutating webhook configurations could not be listed ({error}).")),
    }

    match validating_list {
        Ok(list) => {
            for configuration in list.items {
                let name = configuration.metadata.name.clone().unwrap_or_default();
                for hook in configuration.webhooks.into_iter().flatten() {
                    let service = hook
                        .client_config
                        .service
                        .as_ref()
                        .map(|reference| (reference.namespace.clone(), reference.name.clone()));
                    webhooks.push(webhook_row(
                        &name,
                        "Validating",
                        &hook.name,
                        hook.failure_policy,
                        hook.timeout_seconds,
                        service,
                        describe_rules(&hook.rules.unwrap_or_default()),
                        &lookup,
                    ));
                }
            }
        }
        Err(error) => degraded.push(format!("Validating webhook configurations could not be listed ({error}).")),
    }

    if known_services.is_none() && !webhooks.is_empty() {
        degraded.push(
            "Services could not be listed, so no webhook target could be checked for existence.".to_string(),
        );
        for hook in &mut webhooks {
            hook.service_exists = None;
            hook.health = "unknown".to_string();
            hook.reason = "Its target could not be checked.".to_string();
        }
    }

    webhooks.sort_by_key(|hook| std::cmp::Reverse(severity_rank(&hook.health)));

    (priority_rows, runtime_rows, webhooks)
}

// ---------------------------------------------------------------- values

#[derive(Serialize, Clone)]
pub struct RevealedValue {
    pub key: String,
    /// None when the bytes are not valid UTF-8, in which case there is nothing safe to
    /// show as text and nothing that could be edited as text either.
    pub value: Option<String>,
    pub bytes: usize,
    pub binary: bool,
}

/// Decodes one key of a Secret.
///
/// Deliberately one key per call. The list payload carries no values at all, so a
/// secret's contents are never sitting in the frontend because a table was opened —
/// only the key the operator explicitly asked to see. Each call is an ordinary `get`
/// against the API server, so it lands in the cluster's audit log like any other read.
pub async fn reveal_secret_key(
    client: Client,
    namespace: &str,
    name: &str,
    key: &str,
) -> Result<RevealedValue, String> {
    let api: Api<Secret> = Api::namespaced(client, namespace);
    let secret = api
        .get(name)
        .await
        .map_err(|error| crate::errors::humanize(&error.to_string()))?;

    let raw = secret
        .data
        .as_ref()
        .and_then(|map| map.get(key))
        .ok_or_else(|| format!("Secret {name} has no key {key}."))?;

    let bytes = raw.0.len();
    match String::from_utf8(raw.0.clone()) {
        Ok(text) => Ok(RevealedValue { key: key.to_string(), value: Some(text), bytes, binary: false }),
        Err(_) => Ok(RevealedValue { key: key.to_string(), value: None, bytes, binary: true }),
    }
}

/// Decodes one key of a ConfigMap. Kept alongside the Secret path so both edit flows
/// behave identically from the operator's side.
pub async fn read_config_map_key(
    client: Client,
    namespace: &str,
    name: &str,
    key: &str,
) -> Result<RevealedValue, String> {
    let api: Api<ConfigMap> = Api::namespaced(client, namespace);
    let map = api
        .get(name)
        .await
        .map_err(|error| crate::errors::humanize(&error.to_string()))?;

    if let Some(text) = map.data.as_ref().and_then(|data| data.get(key)) {
        return Ok(RevealedValue {
            key: key.to_string(),
            bytes: text.len(),
            value: Some(text.clone()),
            binary: false,
        });
    }

    let binary = map
        .binary_data
        .as_ref()
        .and_then(|data| data.get(key))
        .ok_or_else(|| format!("Config map {name} has no key {key}."))?;

    Ok(RevealedValue { key: key.to_string(), value: None, bytes: binary.0.len(), binary: true })
}

/// Writes one key of a Secret, taking the value in plain text.
///
/// The operator edits what the value means; the base64 that Kubernetes stores is this
/// function's problem. Hand-editing `data` in YAML is where secrets get corrupted — a
/// stray newline in the encoding produces a value that looks right and is not.
///
/// A merge patch touching a single key is used rather than a whole-object write, so a
/// concurrent change to a different key in the same Secret is not silently reverted.
pub async fn write_secret_key(
    client: Client,
    namespace: &str,
    name: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
    let patch = serde_json::json!({ "data": { key: encoded } });

    let api: Api<Secret> = Api::namespaced(client, namespace);
    api.patch(name, &crate::merge_patch_params(), &kube::api::Patch::Merge(&patch))
        .await
        .map_err(|error| crate::errors::humanize(&error.to_string()))?;
    Ok(())
}

pub async fn write_config_map_key(
    client: Client,
    namespace: &str,
    name: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let patch = serde_json::json!({ "data": { key: value } });
    let api: Api<ConfigMap> = Api::namespaced(client, namespace);
    api.patch(name, &crate::merge_patch_params(), &kube::api::Patch::Merge(&patch))
        .await
        .map_err(|error| crate::errors::humanize(&error.to_string()))?;
    Ok(())
}

/// Removes one key. A merge patch with an explicit null is how a key is deleted
/// without rewriting the rest of the object.
pub async fn delete_key(
    client: Client,
    namespace: &str,
    kind: &str,
    name: &str,
    key: &str,
) -> Result<(), String> {
    let patch = serde_json::json!({ "data": { key: serde_json::Value::Null } });
    let params = crate::merge_patch_params();
    let patch = kube::api::Patch::Merge(&patch);

    match kind {
        "Secret" => {
            let api: Api<Secret> = Api::namespaced(client, namespace);
            api.patch(name, &params, &patch).await.map_err(|error| crate::errors::humanize(&error.to_string()))?;
        }
        "ConfigMap" => {
            let api: Api<ConfigMap> = Api::namespaced(client, namespace);
            api.patch(name, &params, &patch).await.map_err(|error| crate::errors::humanize(&error.to_string()))?;
        }
        other => return Err(format!("{other} is not a kind this screen edits.")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantities_parse_in_both_binary_and_decimal_form() {
        assert_eq!(parse_quantity("1"), Some(1.0));
        assert_eq!(parse_quantity("500m"), Some(0.5));
        assert_eq!(parse_quantity("2Gi"), Some(2.0 * 1024.0 * 1024.0 * 1024.0));
        assert_eq!(parse_quantity("1G"), Some(1e9));
        assert_eq!(parse_quantity("1024Ki"), Some(1024.0 * 1024.0));
        assert_eq!(parse_quantity("1e3"), Some(1000.0));
    }

    #[test]
    fn an_unrecognised_quantity_is_unknown_rather_than_zero() {
        // A quota bar drawn from a guess would read as measured.
        assert_eq!(parse_quantity("lots"), None);
        assert_eq!(parse_quantity(""), None);
        assert_eq!(parse_quantity("12Zz"), None);
    }

    #[test]
    fn quota_health_escalates_with_consumption() {
        assert_eq!(quota_health(Some(10.0)), "good");
        assert_eq!(quota_health(Some(80.0)), "warning");
        assert_eq!(quota_health(Some(95.0)), "serious");
        assert_eq!(quota_health(Some(100.0)), "critical");
        // Unmeasured is its own state, never "good".
        assert_eq!(quota_health(None), "unknown");
    }

    #[test]
    fn a_secret_purpose_comes_from_its_type_not_its_name() {
        assert_eq!(secret_purpose("kubernetes.io/tls"), "TLS certificate and private key");
        assert_eq!(secret_purpose("kubernetes.io/dockerconfigjson"), "Registry pull credentials");
        assert_eq!(secret_purpose("Opaque"), "Application data");
        assert_eq!(secret_purpose("something.new/v1"), "Application data");
    }

    #[test]
    fn a_webhook_with_a_missing_service_and_a_fail_policy_is_critical() {
        let known = BTreeSet::new();
        let hook = webhook_row(
            "policy-controller",
            "Validating",
            "validate.example.com",
            Some("Fail".to_string()),
            Some(10),
            Some(("gatekeeper".to_string(), "gatekeeper-webhook".to_string())),
            vec![],
            &known,
        );
        assert_eq!(hook.health, "critical");
        assert!(hook.reason.contains("rejected"));
        assert_eq!(hook.service_exists, Some(false));
    }

    #[test]
    fn the_same_webhook_set_to_ignore_is_only_a_warning() {
        // Writes still succeed; the webhook simply does nothing.
        let known = BTreeSet::new();
        let hook = webhook_row(
            "policy-controller",
            "Validating",
            "validate.example.com",
            Some("Ignore".to_string()),
            Some(10),
            Some(("gatekeeper".to_string(), "gatekeeper-webhook".to_string())),
            vec![],
            &known,
        );
        assert_eq!(hook.health, "warning");
        assert!(hook.reason.contains("does nothing"));
    }

    #[test]
    fn a_webhook_whose_service_exists_is_healthy() {
        let mut known = BTreeSet::new();
        known.insert("gatekeeper/gatekeeper-webhook".to_string());
        let hook = webhook_row(
            "policy-controller",
            "Validating",
            "validate.example.com",
            Some("Fail".to_string()),
            Some(10),
            Some(("gatekeeper".to_string(), "gatekeeper-webhook".to_string())),
            vec![],
            &known,
        );
        assert_eq!(hook.health, "good");
        assert_eq!(hook.service_exists, Some(true));
    }

    #[test]
    fn a_webhook_reached_by_url_has_no_service_to_check() {
        let known = BTreeSet::new();
        let hook = webhook_row("external", "Mutating", "hook.example.com", None, None, None, vec![], &known);
        assert_eq!(hook.service_exists, None);
        assert_eq!(hook.health, "good");
    }

    #[test]
    fn severity_rank_orders_unknown_above_healthy_but_below_a_real_problem() {
        assert!(severity_rank("unknown") > severity_rank("good"));
        assert!(severity_rank("warning") > severity_rank("unknown"));
        assert!(severity_rank("critical") > severity_rank("serious"));
    }

    #[test]
    fn managed_by_names_the_tool_that_will_revert_an_edit() {
        let mut helm = BTreeMap::new();
        helm.insert("app.kubernetes.io/managed-by".to_string(), "Helm".to_string());
        assert_eq!(managed_by(Some(&helm), None), Some("Helm".to_string()));

        let mut argo = BTreeMap::new();
        argo.insert("argocd.argoproj.io/instance".to_string(), "checkout".to_string());
        assert_eq!(managed_by(Some(&argo), None), Some("Argo CD".to_string()));

        assert_eq!(managed_by(Some(&BTreeMap::new()), None), None);
        assert_eq!(managed_by(None, None), None);
    }
}
