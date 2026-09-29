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

/// One line of Prometheus text format: `name{labels} value [timestamp_ms]`.
///
/// The kubelet's cAdvisor endpoint stamps every usage series with a
/// timestamp — `container_cpu_usage_seconds_total{…} 2892.85 1790713931439` —
/// while `container_spec_*` and `container_start_time_seconds` come without.
/// An earlier version split on the LAST space, so exactly the series that
/// carry a value failed to parse and only the spec lines came through: the
/// collector knew every container and measured none of them. The labels end
/// at the closing brace; whatever follows is the value and, optionally, a
/// timestamp this collector does not need (it stamps windows itself).
fn parse_line(line: &str) -> Option<Series<'_>> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (name, labels, rest) = match line.find('{') {
        Some(open) => {
            // Label values are quoted and may hold spaces, so the closing
            // brace — not a space — is the boundary.
            let close = open + line[open..].find('}')?;
            (&line[..open], &line[open + 1..close], &line[close + 1..])
        }
        None => {
            let (name, rest) = line.split_once(char::is_whitespace)?;
            (name, "", rest)
        }
    };
    let value: f64 = rest.split_whitespace().next()?.parse().ok()?;
    Some(Series { name, labels, value })
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

    /// Verbatim shape from a kubelet (labels invented): usage series carry a
    /// trailing timestamp, spec series do not. Both must parse, and the
    /// timestamped ones are the ones that matter.
    #[test]
    fn timestamped_series_parse_and_carry_their_value() {
        let text = concat!(
            "container_memory_working_set_bytes{container=\"api\",namespace=\"payments\",pod=\"checkout-api-1\"} 1.61245184e+09 1790713931439\n",
            "container_cpu_usage_seconds_total{container=\"api\",namespace=\"payments\",pod=\"checkout-api-1\"} 2892.855872 1790713931439\n",
            "container_start_time_seconds{container=\"api\",namespace=\"payments\",pod=\"checkout-api-1\"} 1.790700e+09\n",
        );
        let samples = parse_cadvisor(text);
        assert_eq!(samples.len(), 1, "{samples:?}");
        let sample = &samples[0];
        assert_eq!(sample.memory_working_set, Some(1.61245184e9));
        assert_eq!(sample.cpu_seconds, Some(2892.855872));
    }

    #[test]
    fn a_label_value_with_a_space_does_not_break_the_line() {
        let text = "container_cpu_usage_seconds_total{container=\"api\",image=\"reg/x:1 latest\",namespace=\"n\",pod=\"p\"} 5.5 1790713931439\n";
        let samples = parse_cadvisor(text);
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].cpu_seconds, Some(5.5));
    }

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
