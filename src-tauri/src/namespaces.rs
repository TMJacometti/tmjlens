use k8s_openapi::api::core::v1::{Namespace, Pod, ResourceQuota};
use kube::{api::ListParams, Api, Client};
use serde::Serialize;
use std::collections::HashMap;

use crate::format_age;

#[derive(Serialize, Clone)]
pub struct NamespaceOverview {
    pub items: Vec<NamespaceInfo>,
    pub degraded_collectors: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct NamespaceInfo {
    pub name: String,
    pub phase: String,
    pub health: String,
    pub reason: String,
    pub pods: usize,
    pub pods_not_running: usize,
    pub has_quota: bool,
    pub labels: Vec<String>,
    /// What is holding a Terminating namespace open, when anything is.
    pub finalizers: Vec<String>,
    pub age: String,
}

/// Labels worth showing on the row. Everything else is noise in a table.
const INTERESTING_LABEL_PREFIXES: [&str; 3] = [
    "kubernetes.io/metadata.name",
    "pod-security.kubernetes.io/",
    "app.kubernetes.io/",
];

fn interesting_labels(namespace: &Namespace) -> Vec<String> {
    namespace
        .metadata
        .labels
        .iter()
        .flatten()
        // The name label is on every namespace and repeats the name column.
        .filter(|(key, _)| {
            key.as_str() != "kubernetes.io/metadata.name"
                && INTERESTING_LABEL_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
        })
        .map(|(key, value)| format!("{key}={value}"))
        .collect()
}

/// The namespace controller's condition messages list their subjects after a
/// colon: "Some resources are remaining: datadogagents.datadoghq.com has 1
/// resource instances, ...". The first word of each comma part is the token —
/// a resource type or a finalizer name — and the counts are noise.
pub fn first_words_after_colon(message: &str) -> Vec<String> {
    message
        .split_once(':')
        .map(|(_, rest)| rest)
        .unwrap_or("")
        .split(',')
        .filter_map(|part| part.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

/// What a Terminating namespace is actually waiting on, read from its
/// deletion conditions. The namespace's own finalizer list misses the common
/// case: a resource INSIDE it carrying a finalizer whose operator is gone —
/// the Datadog pattern — which only the conditions report.
pub fn blockers_from_conditions(
    conditions: &[k8s_openapi::api::core::v1::NamespaceCondition],
) -> Vec<String> {
    let mut blockers = Vec::new();
    for condition in conditions {
        if condition.status != "True" {
            continue;
        }
        let message = condition.message.as_deref().unwrap_or("");
        match condition.type_.as_str() {
            "NamespaceFinalizersRemaining" => blockers.extend(
                first_words_after_colon(message)
                    .into_iter()
                    .map(|finalizer| format!("{finalizer} (on a resource inside)")),
            ),
            "NamespaceContentRemaining" => blockers.extend(
                first_words_after_colon(message)
                    .into_iter()
                    .map(|resource| format!("{resource} still inside")),
            ),
            "NamespaceDeletionDiscoveryFailure"
            | "NamespaceDeletionContentFailure"
            | "NamespaceDeletionGroupVersionParsingFailure" => {
                blockers.push(if message.is_empty() { condition.type_.clone() } else { message.to_string() });
            }
            _ => {}
        }
    }
    blockers.dedup();
    blockers
}

/// A namespace stuck Terminating is the one namespace problem people actually hit, and
/// the reason is always a finalizer that nothing is clearing. Naming it turns a hung
/// delete into something actionable.
fn health_of(phase: &str, finalizers: &[String], age: &str) -> (&'static str, String) {
    if phase != "Terminating" {
        return ("good", "Active.".to_string());
    }
    if finalizers.is_empty() {
        return (
            "warning",
            "Deleting. Nothing is holding it open, so it should disappear shortly.".to_string(),
        );
    }
    (
        "serious",
        format!(
            "Deleting for {age}, held open by {}. The controller behind that finalizer has to \
             clear it — usually an API service or an operator that is no longer running.",
            finalizers.join(", ")
        ),
    )
}

/// Reads every namespace, with what is inside each one.
///
/// Pod counts come from a single cluster-wide list rather than one request per
/// namespace, which on a cluster with a hundred namespaces is the difference between
/// one round trip and a hundred.
pub async fn overview(client: Client) -> Result<NamespaceOverview, String> {
    let params = ListParams::default();
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let pods: Api<Pod> = Api::all(client.clone());
    let quotas: Api<ResourceQuota> = Api::all(client);

    let (namespace_list, pod_list, quota_list) =
        tokio::join!(namespaces.list(&params), pods.list(&params), quotas.list(&params));

    let mut degraded = Vec::new();

    let namespace_items = namespace_list
        .map_err(|error| crate::errors::humanize(&error.to_string()))?
        .items;

    let mut pod_counts: HashMap<String, (usize, usize)> = HashMap::new();
    match pod_list {
        Ok(list) => {
            for pod in list.items {
                let Some(namespace) = pod.metadata.namespace else { continue };
                let phase = pod.status.and_then(|status| status.phase).unwrap_or_default();
                let entry = pod_counts.entry(namespace).or_insert((0, 0));
                entry.0 += 1;
                if phase != "Running" && phase != "Succeeded" {
                    entry.1 += 1;
                }
            }
        }
        Err(error) => degraded.push(format!(
            "Pods could not be listed, so no namespace can show what it holds ({error})."
        )),
    }

    let quota_namespaces: Vec<String> = match quota_list {
        Ok(list) => list.items.into_iter().filter_map(|quota| quota.metadata.namespace).collect(),
        Err(error) => {
            degraded.push(format!("Resource quotas could not be listed ({error})."));
            Vec::new()
        }
    };

    let mut items: Vec<NamespaceInfo> = namespace_items
        .into_iter()
        .map(|namespace| {
            let name = namespace.metadata.name.clone().unwrap_or_default();
            let phase = namespace
                .status
                .as_ref()
                .and_then(|status| status.phase.clone())
                .unwrap_or_else(|| "Active".to_string());
            let age = namespace
                .metadata
                .creation_timestamp
                .as_ref()
                .map(|stamp| format_age(stamp.0))
                .unwrap_or_default();

            // Namespaces carry finalizers in the spec, not only in metadata.
            let mut finalizers: Vec<String> = namespace
                .spec
                .as_ref()
                .and_then(|spec| spec.finalizers.clone())
                .unwrap_or_default();
            finalizers.extend(namespace.metadata.finalizers.clone().unwrap_or_default());
            // "kubernetes" is on every namespace and means nothing is wrong.
            finalizers.retain(|entry| entry != "kubernetes");
            // The real blockers usually live INSIDE the namespace and only
            // the deletion conditions name them.
            if let Some(conditions) = namespace.status.as_ref().and_then(|status| status.conditions.as_ref()) {
                finalizers.extend(blockers_from_conditions(conditions));
            }

            let (health, reason) = health_of(&phase, &finalizers, &age);
            let (pods, pods_not_running) = pod_counts.get(&name).copied().unwrap_or((0, 0));

            NamespaceInfo {
                has_quota: quota_namespaces.iter().any(|entry| entry == &name),
                labels: interesting_labels(&namespace),
                health: health.to_string(),
                pods_not_running,
                finalizers,
                reason,
                phase,
                pods,
                age,
                name,
            }
        })
        .collect();

    // Anything not Active first, then alphabetical: the table is scanned for problems.
    items.sort_by(|left, right| {
        let rank = |entry: &NamespaceInfo| if entry.phase == "Active" { 1 } else { 0 };
        rank(left).cmp(&rank(right)).then_with(|| left.name.cmp(&right.name))
    });

    Ok(NamespaceOverview { items, degraded_collectors: degraded })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn condition(kind: &str, status: &str, message: &str) -> k8s_openapi::api::core::v1::NamespaceCondition {
        k8s_openapi::api::core::v1::NamespaceCondition {
            type_: kind.to_string(),
            status: status.to_string(),
            message: Some(message.to_string()),
            reason: None,
            last_transition_time: None,
        }
    }

    #[test]
    fn the_datadog_pattern_is_read_from_the_deletion_conditions() {
        // Verbatim from a real cluster: a DatadogAgent CR inside the namespace
        // carries a finalizer whose operator was uninstalled 233 days ago.
        let conditions = vec![
            condition("NamespaceDeletionDiscoveryFailure", "False", "All resources successfully discovered"),
            condition("NamespaceContentRemaining", "True", "Some resources are remaining: datadogagents.datadoghq.com has 1 resource instances"),
            condition("NamespaceFinalizersRemaining", "True", "Some content in the namespace has finalizers remaining: finalizer.agent.datadoghq.com in 1 resource instances"),
        ];
        let blockers = blockers_from_conditions(&conditions);
        assert!(blockers.iter().any(|entry| entry.contains("finalizer.agent.datadoghq.com")), "{blockers:?}");
        assert!(blockers.iter().any(|entry| entry.contains("datadogagents.datadoghq.com")), "{blockers:?}");
        // False conditions must contribute nothing.
        assert!(!blockers.iter().any(|entry| entry.contains("discovered")), "{blockers:?}");
    }

    #[test]
    fn a_broken_api_service_is_reported_in_the_controllers_own_words() {
        let conditions = vec![condition(
            "NamespaceDeletionDiscoveryFailure",
            "True",
            "Discovery failed for some groups, 1 failing: unable to retrieve the complete list of server APIs: external.metrics.k8s.io/v1beta1: the server is currently unable to handle the request",
        )];
        let blockers = blockers_from_conditions(&conditions);
        assert_eq!(blockers.len(), 1);
        assert!(blockers[0].contains("external.metrics.k8s.io"));
    }

    #[test]
    fn condition_messages_lose_their_counts_but_keep_their_subjects() {
        let tokens = first_words_after_colon(
            "Some resources are remaining: datadogagents.datadoghq.com has 1 resource instances, pods has 2 resource instances",
        );
        assert_eq!(tokens, ["datadogagents.datadoghq.com", "pods"]);
        assert!(first_words_after_colon("no colon here").is_empty());
    }

    #[test]
    fn an_active_namespace_needs_no_explanation() {
        let (health, reason) = health_of("Active", &[], "31d");
        assert_eq!(health, "good");
        assert_eq!(reason, "Active.");
    }

    #[test]
    fn a_terminating_namespace_names_what_is_holding_it_open() {
        let (health, reason) = health_of(
            "Terminating",
            &["metrics.k8s.io/v1beta1".to_string()],
            "6d",
        );
        assert_eq!(health, "serious");
        assert!(reason.contains("metrics.k8s.io/v1beta1"));
        assert!(reason.contains("6d"));
        assert!(reason.contains("finalizer"));
    }

    #[test]
    fn a_terminating_namespace_with_nothing_holding_it_is_only_a_warning() {
        // It is mid-delete, which is ordinary rather than stuck.
        let (health, reason) = health_of("Terminating", &[], "3s");
        assert_eq!(health, "warning");
        assert!(reason.contains("should disappear"));
    }

    #[test]
    fn the_name_label_is_not_repeated_as_a_label_chip() {
        let mut namespace = Namespace::default();
        let mut labels = std::collections::BTreeMap::new();
        labels.insert("kubernetes.io/metadata.name".to_string(), "payments".to_string());
        labels.insert("pod-security.kubernetes.io/enforce".to_string(), "restricted".to_string());
        labels.insert("some-internal-thing".to_string(), "x".to_string());
        namespace.metadata.labels = Some(labels);

        let shown = interesting_labels(&namespace);
        assert_eq!(shown, vec!["pod-security.kubernetes.io/enforce=restricted"]);
    }
}
