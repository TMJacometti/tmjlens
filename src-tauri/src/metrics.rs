//! Live pod usage from metrics-server, joined with requests and limits.
//!
//! Usage alone answers "how much" but not "how close to trouble". The join is what
//! makes the number readable: memory against its limit is the OOMKill distance, CPU
//! against its limit is where throttling starts. Requests and limits come from the pod
//! spec; usage comes from `metrics.k8s.io`, which metrics-server refreshes on its own
//! cadence — the sample timestamp travels with the data so the screen can say how old
//! it is instead of implying it is instantaneous.

use k8s_openapi::api::core::v1::Pod;
use kube::api::ListParams;
use kube::{Api, Client};
use serde::Serialize;
use std::collections::HashMap;

use crate::cluster::{parse_cpu_milli, parse_memory_bytes, pod_resources};

#[derive(Serialize, Clone)]
pub struct ContainerUsage {
    pub name: String,
    /// None when metrics-server reported nothing for this container.
    pub cpu_milli: Option<f64>,
    pub memory_bytes: Option<f64>,
    pub cpu_request_milli: f64,
    pub cpu_limit_milli: f64,
    pub memory_request_bytes: f64,
    pub memory_limit_bytes: f64,
}

#[derive(Serialize, Clone)]
pub struct PodUsageRow {
    pub name: String,
    pub cpu_milli: Option<f64>,
    pub memory_bytes: Option<f64>,
    pub cpu_request_milli: f64,
    pub cpu_limit_milli: f64,
    pub memory_request_bytes: f64,
    pub memory_limit_bytes: f64,
    pub containers: Vec<ContainerUsage>,
    /// When metrics-server took this sample, verbatim. The screen renders its age.
    pub sampled_at: Option<String>,
    /// The averaging window the sample covers, e.g. "30s".
    pub window: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct PodMetricsSnapshot {
    /// False when metrics-server is absent or not ready — stated, never implied by
    /// columns full of zeros.
    pub available: bool,
    pub reason: Option<String>,
    pub pods: Vec<PodUsageRow>,
}

/// Requests and limits per container: plain containers and sidecar init containers
/// (restartPolicy Always), which run for the pod's whole life. Ordinary init
/// containers are finished by the time a usage sample matters.
fn container_resources(pod: &Pod) -> HashMap<String, (f64, f64, f64, f64)> {
    let mut map = HashMap::new();
    let Some(spec) = pod.spec.as_ref() else { return map };

    let running = spec.containers.iter().chain(
        spec.init_containers
            .iter()
            .flatten()
            .filter(|container| container.restart_policy.as_deref() == Some("Always")),
    );

    for container in running {
        let quantity = |map: Option<&std::collections::BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>, key: &str| {
            map.and_then(|inner| inner.get(key)).map(|value| value.0.clone())
        };
        let resources = container.resources.as_ref();
        let requests = resources.and_then(|inner| inner.requests.as_ref());
        let limits = resources.and_then(|inner| inner.limits.as_ref());
        map.insert(
            container.name.clone(),
            (
                quantity(requests, "cpu").and_then(|value| parse_cpu_milli(&value)).unwrap_or(0.0),
                quantity(limits, "cpu").and_then(|value| parse_cpu_milli(&value)).unwrap_or(0.0),
                quantity(requests, "memory").and_then(|value| parse_memory_bytes(&value)).unwrap_or(0.0),
                quantity(limits, "memory").and_then(|value| parse_memory_bytes(&value)).unwrap_or(0.0),
            ),
        );
    }
    map
}

/// Joins one PodMetrics item with its Pod's spec. Public for tests; the shapes are
/// plain JSON because metrics.k8s.io has no typed client in k8s-openapi.
pub fn usage_row(item: &serde_json::Value, pod: Option<&Pod>) -> Option<PodUsageRow> {
    let name = item.pointer("/metadata/name")?.as_str()?.to_string();

    let per_container = pod.map(container_resources).unwrap_or_default();
    let (cpu_request, memory_request, cpu_limit, memory_limit) =
        pod.map(pod_resources).unwrap_or((0.0, 0.0, 0.0, 0.0));

    let mut containers = Vec::new();
    let mut cpu_total: Option<f64> = None;
    let mut memory_total: Option<f64> = None;

    for container in item.get("containers").and_then(|value| value.as_array()).into_iter().flatten() {
        let Some(container_name) = container.pointer("/name").and_then(|value| value.as_str()) else { continue };
        let cpu = container
            .pointer("/usage/cpu")
            .and_then(|value| value.as_str())
            .and_then(parse_cpu_milli_str);
        let memory = container
            .pointer("/usage/memory")
            .and_then(|value| value.as_str())
            .and_then(parse_memory_bytes_str);

        if let Some(cpu) = cpu {
            *cpu_total.get_or_insert(0.0) += cpu;
        }
        if let Some(memory) = memory {
            *memory_total.get_or_insert(0.0) += memory;
        }

        let (cpu_request, cpu_limit, memory_request, memory_limit) =
            per_container.get(container_name).copied().unwrap_or((0.0, 0.0, 0.0, 0.0));
        containers.push(ContainerUsage {
            name: container_name.to_string(),
            cpu_milli: cpu,
            memory_bytes: memory,
            cpu_request_milli: cpu_request,
            cpu_limit_milli: cpu_limit,
            memory_request_bytes: memory_request,
            memory_limit_bytes: memory_limit,
        });
    }

    // Heaviest consumer first, which is what the panel is opened to find.
    containers.sort_by(|left, right| {
        right
            .memory_bytes
            .unwrap_or(0.0)
            .total_cmp(&left.memory_bytes.unwrap_or(0.0))
    });

    Some(PodUsageRow {
        name,
        cpu_milli: cpu_total,
        memory_bytes: memory_total,
        cpu_request_milli: cpu_request,
        cpu_limit_milli: cpu_limit,
        memory_request_bytes: memory_request,
        memory_limit_bytes: memory_limit,
        containers,
        sampled_at: item.pointer("/timestamp").and_then(|value| value.as_str()).map(String::from),
        window: item.pointer("/window").and_then(|value| value.as_str()).map(String::from),
    })
}

fn parse_cpu_milli_str(value: &str) -> Option<f64> {
    parse_cpu_milli(value)
}

fn parse_memory_bytes_str(value: &str) -> Option<f64> {
    parse_memory_bytes(value)
}

/// Why usage is missing, in words an operator can act on. A 404 and a 503 are
/// different problems with different fixes.
pub fn unavailable_reason(error: &kube::Error) -> String {
    match error {
        kube::Error::Api(response) if response.code == 404 => {
            "metrics-server is not installed in this cluster, so live usage cannot be shown. \
             Requests and limits are still exact."
                .to_string()
        }
        kube::Error::Api(response) if response.code == 503 => {
            "metrics-server is installed but not ready. Usage returns when it is.".to_string()
        }
        kube::Error::Api(response) if response.code == 403 => {
            "This identity may not read pod metrics.".to_string()
        }
        other => format!("Pod metrics could not be read: {other}"),
    }
}

/// Reads live usage for one namespace and joins it with the pod specs there.
pub async fn pod_metrics(client: Client, namespace: &str) -> Result<PodMetricsSnapshot, String> {
    let request = http::Request::get(format!("/apis/metrics.k8s.io/v1beta1/namespaces/{namespace}/pods"))
        .body(Vec::new())
        .map_err(|error| error.to_string())?;

    let pods_api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let params = ListParams::default();
    let (metrics, pods) = tokio::join!(
        client.request::<serde_json::Value>(request),
        pods_api.list(&params),
    );

    let metrics = match metrics {
        Ok(value) => value,
        Err(error) => {
            return Ok(PodMetricsSnapshot {
                available: false,
                reason: Some(unavailable_reason(&error)),
                pods: Vec::new(),
            })
        }
    };

    let by_name: HashMap<String, Pod> = pods
        .map(|list| list.items)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|pod| Some((pod.metadata.name.clone()?, pod)))
        .collect();

    let rows = metrics
        .get("items")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let name = item.pointer("/metadata/name")?.as_str()?;
            usage_row(item, by_name.get(name))
        })
        .collect();

    Ok(PodMetricsSnapshot { available: true, reason: None, pods: rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(name: &str) -> serde_json::Value {
        serde_json::json!({
            "metadata": { "name": name, "namespace": "payments" },
            "timestamp": "2026-08-24T12:00:00Z",
            "window": "30s",
            "containers": [
                { "name": "api", "usage": { "cpu": "250m", "memory": "512Mi" } },
                { "name": "sidecar", "usage": { "cpu": "50000000n", "memory": "64Mi" } }
            ]
        })
    }

    fn pod_with_resources() -> Pod {
        serde_json::from_value(serde_json::json!({
            "metadata": { "name": "checkout", "namespace": "payments" },
            "spec": {
                "containers": [
                    {
                        "name": "api",
                        "resources": {
                            "requests": { "cpu": "200m", "memory": "256Mi" },
                            "limits": { "cpu": "500m", "memory": "1Gi" }
                        }
                    },
                    { "name": "sidecar" }
                ]
            }
        }))
        .expect("valid pod")
    }

    #[test]
    fn container_usage_sums_into_the_pod_total() {
        let row = usage_row(&sample("checkout"), Some(&pod_with_resources())).expect("row");
        // 250m + 50000000n (= 50m) of CPU; 512Mi + 64Mi of memory.
        assert_eq!(row.cpu_milli, Some(300.0));
        assert_eq!(row.memory_bytes, Some(576.0 * 1024.0 * 1024.0));
    }

    #[test]
    fn each_container_carries_its_own_requests_and_limits() {
        let row = usage_row(&sample("checkout"), Some(&pod_with_resources())).expect("row");
        let api = row.containers.iter().find(|container| container.name == "api").expect("api");
        assert_eq!(api.cpu_request_milli, 200.0);
        assert_eq!(api.memory_limit_bytes, 1024.0 * 1024.0 * 1024.0);

        // A container with no resources block is zeroes, not an absent row.
        let sidecar = row.containers.iter().find(|container| container.name == "sidecar").expect("sidecar");
        assert_eq!(sidecar.cpu_limit_milli, 0.0);
        assert_eq!(sidecar.cpu_milli, Some(50.0));
    }

    #[test]
    fn containers_sort_heaviest_memory_first() {
        let row = usage_row(&sample("checkout"), Some(&pod_with_resources())).expect("row");
        assert_eq!(row.containers[0].name, "api");
    }

    #[test]
    fn a_pod_the_metrics_know_but_the_list_does_not_still_shows_usage() {
        // Requests fall to zero rather than the row disappearing: usage is the point.
        let row = usage_row(&sample("ghost"), None).expect("row");
        assert_eq!(row.cpu_milli, Some(300.0));
        assert_eq!(row.cpu_request_milli, 0.0);
    }

    #[test]
    fn the_sample_time_and_window_travel_with_the_row() {
        let row = usage_row(&sample("checkout"), Some(&pod_with_resources())).expect("row");
        assert_eq!(row.sampled_at.as_deref(), Some("2026-08-24T12:00:00Z"));
        assert_eq!(row.window.as_deref(), Some("30s"));
    }

    #[test]
    fn a_missing_metrics_server_names_the_fix_not_a_status_code() {
        let error = kube::Error::Api(kube::error::ErrorResponse {
            status: "Failure".into(),
            message: "not found".into(),
            reason: "NotFound".into(),
            code: 404,
        });
        assert!(unavailable_reason(&error).contains("not installed"));

        let warming = kube::Error::Api(kube::error::ErrorResponse {
            status: "Failure".into(),
            message: "unavailable".into(),
            reason: "ServiceUnavailable".into(),
            code: 503,
        });
        assert!(unavailable_reason(&warming).contains("not ready"));
    }
}
