use k8s_openapi::api::{
    apps::v1::{DaemonSet, Deployment, StatefulSet},
    batch::v1::{CronJob, Job},
    core::v1::{ConfigMap, Namespace, Node, PersistentVolumeClaim, Pod, Secret, Service},
    networking::v1::Ingress,
};
use kube::{api::ListParams, Api, Client, ResourceExt};
use serde::Serialize;

/// Enough to fill the palette without making the operator scroll a wall of near-misses.
const MAX_RESULTS: usize = 60;
/// Per-kind cap on what is pulled back, so one enormous kind cannot starve the rest.
const PER_KIND_LIMIT: u32 = 500;

#[derive(Serialize, Clone)]
pub struct SearchHit {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    /// Lower sorts first. Exact match beats prefix beats substring.
    pub rank: u8,
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct SearchResults {
    pub query: String,
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
    pub degraded_collectors: Vec<String>,
}

/// How well a name matches, or `None` when it does not.
///
/// Deliberately not fuzzy: an operator searching a cluster is usually typing a name
/// they already know, and fuzzy matching would bury the exact hit under coincidences.
fn rank_of(name: &str, query: &str) -> Option<u8> {
    let name = name.to_lowercase();
    if name == query {
        Some(0)
    } else if name.starts_with(query) {
        Some(1)
    } else if name.contains(query) {
        Some(2)
    } else {
        None
    }
}

fn hit<K: ResourceExt>(item: &K, kind: &str, query: &str, detail: String) -> Option<SearchHit> {
    let name = item.name_any();
    let rank = rank_of(&name, query)?;
    Some(SearchHit {
        kind: kind.to_string(),
        namespace: item.namespace(),
        name,
        rank,
        detail,
    })
}

/// Searches the whole cluster by resource name.
///
/// Secrets are matched by name only and never carry their contents into a result —
/// the app's rule is that a Secret's value is not shown unless explicitly asked for,
/// and a search box is not asking.
pub async fn search(client: Client, query: &str) -> Result<SearchResults, String> {
    let needle = query.trim().to_lowercase();
    if needle.len() < 2 {
        return Ok(SearchResults {
            query: query.to_string(),
            hits: Vec::new(),
            truncated: false,
            degraded_collectors: vec!["Type at least two characters to search.".to_string()],
        });
    }

    let params = ListParams::default().limit(PER_KIND_LIMIT);
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut degraded: Vec<String> = Vec::new();

    macro_rules! sweep {
        ($type:ty, $label:literal, $detail:expr) => {{
            let api: Api<$type> = Api::all(client.clone());
            match api.list(&params).await {
                Ok(list) => {
                    let describe: fn(&$type) -> String = $detail;
                    hits.extend(
                        list.items
                            .iter()
                            .filter_map(|item| hit(item, $label, &needle, describe(item))),
                    );
                }
                Err(error) => degraded.push(format!("{} could not be searched ({error}).", $label)),
            }
        }};
    }

    sweep!(Pod, "Pod", |pod| pod
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Unknown".into()));
    sweep!(Deployment, "Deployment", |item| {
        let ready = item.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
        let desired = item.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        format!("{ready}/{desired} ready")
    });
    sweep!(StatefulSet, "StatefulSet", |item| {
        let ready = item.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
        let desired = item.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        format!("{ready}/{desired} ready")
    });
    sweep!(DaemonSet, "DaemonSet", |item| {
        let ready = item.status.as_ref().map(|s| s.number_ready).unwrap_or(0);
        let desired = item.status.as_ref().map(|s| s.desired_number_scheduled).unwrap_or(0);
        format!("{ready}/{desired} nodes")
    });
    sweep!(Job, "Job", |item| {
        let succeeded = item.status.as_ref().and_then(|s| s.succeeded).unwrap_or(0);
        format!("{succeeded} succeeded")
    });
    sweep!(CronJob, "CronJob", |item| item
        .spec
        .as_ref()
        .map(|spec| spec.schedule.clone())
        .unwrap_or_default());
    sweep!(Service, "Service", |item| item
        .spec
        .as_ref()
        .and_then(|spec| spec.type_.clone())
        .unwrap_or_else(|| "ClusterIP".into()));
    sweep!(Ingress, "Ingress", |item| item
        .spec
        .as_ref()
        .and_then(|spec| spec.ingress_class_name.clone())
        .map(|class| format!("class {class}"))
        .unwrap_or_else(|| "no class".into()));
    sweep!(ConfigMap, "ConfigMap", |item| {
        let keys = item.data.as_ref().map(|data| data.len()).unwrap_or(0);
        format!("{keys} key(s)")
    });
    // Name and key count only. The values stay where they are.
    sweep!(Secret, "Secret", |item| {
        let keys = item.data.as_ref().map(|data| data.len()).unwrap_or(0);
        format!("{keys} key(s), values hidden")
    });
    sweep!(PersistentVolumeClaim, "PersistentVolumeClaim", |item| item
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Unknown".into()));
    sweep!(Node, "Node", |item| item
        .status
        .as_ref()
        .and_then(|status| status.conditions.as_ref())
        .and_then(|conditions| conditions.iter().find(|c| c.type_ == "Ready"))
        .map(|c| if c.status == "True" { "Ready".to_string() } else { "NotReady".to_string() })
        .unwrap_or_else(|| "Unknown".into()));
    sweep!(Namespace, "Namespace", |item| item
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Active".into()));

    hits.sort_by(|left, right| {
        left.rank
            .cmp(&right.rank)
            .then_with(|| left.name.len().cmp(&right.name.len()))
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.name.cmp(&right.name))
    });

    let truncated = hits.len() > MAX_RESULTS;
    hits.truncate(MAX_RESULTS);

    Ok(SearchResults {
        query: query.to_string(),
        hits,
        truncated,
        degraded_collectors: degraded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_exact_before_prefix_before_substring() {
        assert_eq!(rank_of("checkout", "checkout"), Some(0));
        assert_eq!(rank_of("checkout-api", "checkout"), Some(1));
        assert_eq!(rank_of("my-checkout-api", "checkout"), Some(2));
        assert_eq!(rank_of("payments", "checkout"), None);
    }

    #[test]
    fn matching_ignores_case() {
        // The query arrives lowercased; the name may not be.
        assert_eq!(rank_of("Checkout-API", "checkout"), Some(1));
    }

    #[test]
    fn sorts_by_rank_then_by_how_close_the_name_is() {
        let mut hits = vec![
            SearchHit { kind: "Pod".into(), name: "my-checkout-api".into(), namespace: None, rank: 2, detail: String::new() },
            SearchHit { kind: "Pod".into(), name: "checkout".into(), namespace: None, rank: 0, detail: String::new() },
            SearchHit { kind: "Pod".into(), name: "checkout-api-longer".into(), namespace: None, rank: 1, detail: String::new() },
            SearchHit { kind: "Pod".into(), name: "checkout-api".into(), namespace: None, rank: 1, detail: String::new() },
        ];
        hits.sort_by(|left, right| {
            left.rank
                .cmp(&right.rank)
                .then_with(|| left.name.len().cmp(&right.name.len()))
                .then_with(|| left.kind.cmp(&right.kind))
                .then_with(|| left.name.cmp(&right.name))
        });

        let names: Vec<&str> = hits.iter().map(|hit| hit.name.as_str()).collect();
        assert_eq!(names, ["checkout", "checkout-api", "checkout-api-longer", "my-checkout-api"]);
    }
}
