//! Prometheus-text parser for kubelet `/metrics/cadvisor`. Not a Prometheus
//! client: a handful of named series and their labels.

use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct ContainerSample {
    pub namespace: String,
    pub pod: String,
    pub container: String,
    /// Cumulative CPU seconds (counter).
    pub cpu_seconds: Option<f64>,
    pub memory_working_set: Option<f64>,
    pub throttle_periods: Option<f64>,
    pub cfs_periods: Option<f64>,
}

#[derive(Debug, Clone, Copy)]
struct Series<'a> {
    name: &'a str,
    labels: &'a str,
    value: f64,
}

/// Parse a cadvisor exposition. Ignores comments, HELP/TYPE, and series we
/// do not care about. Pod-sandbox / empty container names are dropped — they
/// are not a workload container.
pub fn parse_cadvisor(text: &str) -> Vec<ContainerSample> {
    let mut by_key: HashMap<(String, String, String), ContainerSample> = HashMap::new();
    for line in text.lines() {
        let Some(series) = parse_line(line) else { continue };
        let labels = parse_labels(series.labels);
        let namespace = labels.get("namespace").cloned().unwrap_or_default();
        let pod = labels
            .get("pod")
            .cloned()
            .or_else(|| labels.get("pod_name").cloned())
            .unwrap_or_default();
        let container = labels
            .get("container")
            .cloned()
            .or_else(|| labels.get("container_name").cloned())
            .unwrap_or_default();
        if namespace.is_empty() || pod.is_empty() || container.is_empty() || container == "POD" {
            continue;
        }
        let entry = by_key.entry((namespace.clone(), pod.clone(), container.clone())).or_insert_with(|| {
            ContainerSample { namespace, pod, container, ..Default::default() }
        });
        match series.name {
            "container_cpu_usage_seconds_total" => entry.cpu_seconds = Some(series.value),
            "container_memory_working_set_bytes" => entry.memory_working_set = Some(series.value),
            "container_cpu_cfs_throttled_periods_total" => entry.throttle_periods = Some(series.value),
            "container_cpu_cfs_periods_total" => entry.cfs_periods = Some(series.value),
            _ => {}
        }
    }
    by_key.into_values().collect()
}

fn parse_line(line: &str) -> Option<Series<'_>> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (name_and_labels, value_and_ts) = line.rsplit_once(' ')?;
    let value: f64 = value_and_ts.split_whitespace().next()?.parse().ok()?;
    if let Some((name, labels)) = name_and_labels.split_once('{') {
        let labels = labels.strip_suffix('}')?;
        Some(Series { name, labels, value })
    } else {
        Some(Series { name: name_and_labels, labels: "", value })
    }
}

fn parse_labels(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for piece in raw.split(',') {
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        let Some((k, v)) = piece.split_once('=') else { continue };
        let v = v.trim().trim_matches('"');
        out.insert(k.trim().to_string(), v.to_string());
    }
    out
}

/// CPU millicores from two cumulative-second readings. Falling counter
/// (container restart) → None, so the caller drops the sample.
pub fn cpu_millicores(prev: f64, next: f64, dt_secs: f64) -> Option<f64> {
    if dt_secs <= 0.0 || next < prev {
        return None;
    }
    Some(((next - prev) / dt_secs) * 1000.0)
}

pub fn throttle_ratio(throttled: Option<f64>, periods: Option<f64>) -> Option<f64> {
    let (t, p) = (throttled?, periods?);
    if p <= 0.0 {
        return None;
    }
    Some((t / p).clamp(0.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
# HELP container_cpu_usage_seconds_total Cumulative cpu time consumed
# TYPE container_cpu_usage_seconds_total counter
container_cpu_usage_seconds_total{container="api",namespace="shop",pod="checkout-7f9"} 12.5
container_memory_working_set_bytes{container="api",namespace="shop",pod="checkout-7f9"} 104857600
container_cpu_cfs_throttled_periods_total{container="api",namespace="shop",pod="checkout-7f9"} 2
container_cpu_cfs_periods_total{container="api",namespace="shop",pod="checkout-7f9"} 20
container_cpu_usage_seconds_total{container="POD",namespace="shop",pod="checkout-7f9"} 1
"#;

    #[test]
    fn parser_keeps_workload_containers_and_drops_pod_sandbox() {
        let samples = parse_cadvisor(SAMPLE);
        assert_eq!(samples.len(), 1);
        let s = &samples[0];
        assert_eq!(s.container, "api");
        assert_eq!(s.namespace, "shop");
        assert_eq!(s.cpu_seconds, Some(12.5));
        assert_eq!(s.memory_working_set, Some(104857600.0));
    }

    #[test]
    fn falling_cpu_counter_is_dropped() {
        assert_eq!(cpu_millicores(10.0, 4.0, 30.0), None);
        let rate = cpu_millicores(10.0, 11.5, 30.0).expect("rate");
        assert!((rate - 50.0).abs() < 0.01);
    }
}
