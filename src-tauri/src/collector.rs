//! Node-local sampler. Talks to this node's kubelet and POSTs 5-minute rollups
//! at the web Deployment. Never opens tmjLite — the PVC is the web pod's.

use crate::cadvisor::{cpu_millicores, parse_cadvisor, throttle_ratio, ContainerSample};
use crate::histogram::Histogram;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_INTERVAL: Duration = Duration::from_secs(30);
const DEFAULT_WINDOW: Duration = Duration::from_secs(300);
const BUFFER_CAP_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
struct Prev {
    cpu_seconds: f64,
    throttle_periods: Option<f64>,
    cfs_periods: Option<f64>,
    at: Instant,
}

#[derive(Default)]
struct Acc {
    cpu: Histogram,
    memory: Histogram,
    memory_max: f64,
    samples: u64,
    throttle_sum: f64,
    throttle_n: u64,
}

#[derive(Serialize, serde::Deserialize)]
struct IngestBatch {
    node: String,
    window_start: String,
    window_secs: u64,
    samples: Vec<IngestSample>,
}

#[derive(Serialize, serde::Deserialize)]
struct IngestSample {
    namespace: String,
    pod: String,
    container: String,
    cpu: Histogram,
    memory: Histogram,
    memory_max: f64,
    samples: u64,
    throttle_ratio: Option<f64>,
}

fn env_duration(name: &str, default: Duration) -> Duration {
    std::env::var(name)
        .ok()
        .and_then(|raw| parse_duration(&raw))
        .unwrap_or(default)
}

fn parse_duration(raw: &str) -> Option<Duration> {
    let raw = raw.trim();
    if let Some(n) = raw.strip_suffix('s') {
        return n.parse::<u64>().ok().map(Duration::from_secs);
    }
    if let Some(n) = raw.strip_suffix('m') {
        return n.parse::<u64>().ok().map(|m| Duration::from_secs(m * 60));
    }
    raw.parse::<u64>().ok().map(Duration::from_secs)
}

fn buffer_dir() -> PathBuf {
    std::env::var("TMJLENS_COLLECTOR_BUFFER")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/var/lib/tmjlens-collector/buffer"))
}

pub async fn run() -> Result<(), String> {
    let node = std::env::var("NODE_NAME").map_err(|_| "NODE_NAME is required (Downward API spec.nodeName)")?;
    let node_ip = std::env::var("NODE_IP").map_err(|_| "NODE_IP is required (Downward API status.hostIP)")?;
    let ingest_url = std::env::var("TMJLENS_INGEST_URL")
        .map_err(|_| "TMJLENS_INGEST_URL is required (the web Service ingest URL)")?;
    let token = std::env::var("TMJLENS_INGEST_TOKEN")
        .map_err(|_| "TMJLENS_INGEST_TOKEN is required")?;
    let interval = env_duration("TMJLENS_COLLECTOR_INTERVAL", DEFAULT_INTERVAL);
    let window = env_duration("TMJLENS_COLLECTOR_WINDOW", DEFAULT_WINDOW);
    let insecure = matches!(
        std::env::var("TMJLENS_KUBELET_INSECURE").ok().as_deref(),
        Some("1" | "true" | "yes" | "on")
    );
    let ca_file = std::env::var("TMJLENS_KUBELET_CA").ok().filter(|s| !s.is_empty());
    let port_raw = std::env::var("KUBELET_PORT").unwrap_or_else(|_| "10250".into());
    let port: u16 = port_raw
        .parse()
        .map_err(|_| format!("KUBELET_PORT {port_raw} is not a port"))?;
    // SNI and cert hostname are the node name; the Downward API IP is only the dial target.
    let cadvisor_url = format!("https://{node}:{port}/metrics/cadvisor");

    let sa_token = std::fs::read_to_string("/var/run/secrets/kubernetes.io/serviceaccount/token")
        .map_err(|e| format!("could not read the ServiceAccount token: {e}"))?;
    let default_ca = PathBuf::from("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");

    let kubelet = kubelet_client(&node, &node_ip, port, ca_file.as_deref(), default_ca.as_path())?;
    let ingest = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let dir = buffer_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create buffer dir {}: {e}", dir.display()))?;

    if insecure {
        eprintln!(
            "collector.kubelet.insecureSkipVerify is set: TLS is still verified. \
             The scrape uses NODE_NAME as SNI and dials NODE_IP. Set kubelet.caFile if the cluster CA is not the kubelet serving CA."
        );
    }
    eprintln!(
        "tmjLens collector on {node} ({node_ip}) interval={}s window={}s",
        interval.as_secs(),
        window.as_secs()
    );

    let mut prev: HashMap<(String, String, String), Prev> = HashMap::new();
    let mut acc: HashMap<(String, String, String), Acc> = HashMap::new();
    let mut window_start = chrono::Utc::now();
    let mut last_flush = Instant::now();
    let mut tick = tokio::time::interval(interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tick.tick().await;
        match scrape(&kubelet, &cadvisor_url, sa_token.trim()).await {
            Ok(samples) => apply_samples(samples, &mut prev, &mut acc),
            Err(error) => eprintln!("kubelet scrape failed: {error}"),
        }
        if last_flush.elapsed() >= window {
            let batch = take_batch(&node, window_start, window.as_secs(), &mut acc);
            window_start = chrono::Utc::now();
            last_flush = Instant::now();
            if let Err(error) = send_or_buffer(&ingest, &ingest_url, &token, &dir, &batch).await {
                eprintln!("ingest failed: {error}");
            }
            flush_buffer(&ingest, &ingest_url, &token, &dir).await;
        }
    }
}

fn kubelet_client(
    node: &str,
    node_ip: &str,
    port: u16,
    ca_file: Option<&str>,
    default_ca: &Path,
) -> Result<reqwest::Client, String> {
    let ip: IpAddr = node_ip
        .parse()
        .map_err(|e| format!("NODE_IP {node_ip} is not an IP address: {e}"))?;
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .resolve(node, SocketAddr::new(ip, port));
    let pem_path = ca_file.map(PathBuf::from).unwrap_or_else(|| default_ca.to_path_buf());
    if pem_path.exists() {
        let pem = std::fs::read(&pem_path)
            .map_err(|e| format!("could not read kubelet CA {}: {e}", pem_path.display()))?;
        let cert = reqwest::Certificate::from_pem(&pem)
            .map_err(|e| format!("kubelet CA is not a PEM certificate: {e}"))?;
        builder = builder.add_root_certificate(cert);
    }
    builder.build().map_err(|e| e.to_string())
}

async fn scrape(client: &reqwest::Client, url: &str, token: &str) -> Result<Vec<ContainerSample>, String> {
    let response = client
        .get(url)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "text/plain")
        .send()
        .await
        .map_err(|e| error_chain(&e))?;
    if !response.status().is_success() {
        return Err(format!("kubelet answered {}", response.status()));
    }
    let text = response.text().await.map_err(|e| e.to_string())?;
    Ok(parse_cadvisor(&text))
}

fn apply_samples(
    samples: Vec<ContainerSample>,
    prev: &mut HashMap<(String, String, String), Prev>,
    acc: &mut HashMap<(String, String, String), Acc>,
) {
    let now = Instant::now();
    for sample in samples {
        let key = (sample.namespace.clone(), sample.pod.clone(), sample.container.clone());
        let entry = acc.entry(key.clone()).or_default();
        if let Some(mem) = sample.memory_working_set {
            entry.memory.observe(mem);
            if mem > entry.memory_max {
                entry.memory_max = mem;
            }
        }
        if let Some(cpu) = sample.cpu_seconds {
            if let Some(last) = prev.get(&key) {
                let dt = now.duration_since(last.at).as_secs_f64();
                if let Some(milli) = cpu_millicores(last.cpu_seconds, cpu, dt) {
                    entry.cpu.observe(milli);
                    entry.samples = entry.samples.saturating_add(1);
                }
                if let Some(ratio) = throttle_ratio(
                    delta_opt(last.throttle_periods, sample.throttle_periods),
                    delta_opt(last.cfs_periods, sample.cfs_periods),
                ) {
                    entry.throttle_sum += ratio;
                    entry.throttle_n = entry.throttle_n.saturating_add(1);
                }
            }
            prev.insert(
                key,
                Prev {
                    cpu_seconds: cpu,
                    throttle_periods: sample.throttle_periods,
                    cfs_periods: sample.cfs_periods,
                    at: now,
                },
            );
        }
    }
}

fn delta_opt(prev: Option<f64>, next: Option<f64>) -> Option<f64> {
    match (prev, next) {
        (Some(p), Some(n)) if n >= p => Some(n - p),
        _ => None,
    }
}

fn take_batch(
    node: &str,
    window_start: chrono::DateTime<chrono::Utc>,
    window_secs: u64,
    acc: &mut HashMap<(String, String, String), Acc>,
) -> IngestBatch {
    let samples = acc
        .drain()
        .map(|((namespace, pod, container), a)| IngestSample {
            namespace,
            pod,
            container,
            cpu: a.cpu,
            memory: a.memory,
            memory_max: a.memory_max,
            samples: a.samples,
            throttle_ratio: if a.throttle_n == 0 {
                None
            } else {
                Some(a.throttle_sum / a.throttle_n as f64)
            },
        })
        .collect();
    IngestBatch {
        node: node.to_string(),
        window_start: window_start.to_rfc3339(),
        window_secs,
        samples,
    }
}

async fn send_or_buffer(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    dir: &Path,
    batch: &IngestBatch,
) -> Result<(), String> {
    match post_batch(http, url, token, batch).await {
        Ok(()) => Ok(()),
        Err(error) => {
            buffer_write(dir, batch)?;
            Err(error)
        }
    }
}

async fn post_batch(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    batch: &IngestBatch,
) -> Result<(), String> {
    let response = http
        .post(url)
        .bearer_auth(token)
        .json(batch)
        .send()
        .await
        .map_err(|e| error_chain(&e))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("ingest answered {}", response.status()))
    }
}

fn buffer_write(dir: &Path, batch: &IngestBatch) -> Result<(), String> {
    enforce_cap(dir)?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("{ts}.json"));
    let bytes = serde_json::to_vec(batch).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not buffer {}: {e}", path.display()))?;
    eprintln!("buffered rollup at {} — will retry (central unreachable, not dropped)", path.display());
    Ok(())
}

fn enforce_cap(dir: &Path) -> Result<(), String> {
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    let mut total = 0u64;
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(()),
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        total = total.saturating_add(len);
        files.push((len, path));
    }
    if total <= BUFFER_CAP_BYTES {
        return Ok(());
    }
    files.sort_by(|a, b| a.1.cmp(&b.1));
    for (len, path) in files {
        if total <= BUFFER_CAP_BYTES {
            break;
        }
        eprintln!(
            "ERROR: collector buffer is over {} bytes; dropping oldest {} so newer rollups can be kept. This is a loss.",
            BUFFER_CAP_BYTES,
            path.display()
        );
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
    Ok(())
}

async fn flush_buffer(http: &reqwest::Client, url: &str, token: &str, dir: &Path) {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    paths.sort();
    for path in paths {
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let batch: IngestBatch = match serde_json::from_slice(&bytes) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("dropping unreadable buffer file {}: {e}", path.display());
                let _ = std::fs::remove_file(&path);
                continue;
            }
        };
        match post_batch(http, url, token, &batch).await {
            Ok(()) => {
                let _ = std::fs::remove_file(&path);
            }
            Err(error) => {
                eprintln!("still cannot flush {}: {error}", path.display());
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_parses_seconds_and_minutes() {
        assert_eq!(parse_duration("30s"), Some(Duration::from_secs(30)));
        assert_eq!(parse_duration("5m"), Some(Duration::from_secs(300)));
        assert_eq!(parse_duration("15"), Some(Duration::from_secs(15)));
    }

    #[test]
    fn falling_cpu_is_not_observed() {
        let mut prev = HashMap::new();
        let mut acc = HashMap::new();
        let first = ContainerSample {
            namespace: "shop".into(),
            pod: "api-1".into(),
            container: "api".into(),
            cpu_seconds: Some(10.0),
            memory_working_set: Some(100.0),
            throttle_periods: Some(0.0),
            cfs_periods: Some(10.0),
        };
        apply_samples(vec![first.clone()], &mut prev, &mut acc);
        assert_eq!(acc[&("shop".into(), "api-1".into(), "api".into())].samples, 0);
        let mut second = first.clone();
        second.cpu_seconds = Some(4.0);
        apply_samples(vec![second], &mut prev, &mut acc);
        assert_eq!(acc[&("shop".into(), "api-1".into(), "api".into())].cpu.samples(), 0);
    }
}

/// reqwest's Display stops at "error sending request for url"; the cause —
/// timeout, connection refused, DNS — sits in the source chain. An operator
/// reading the log needs that word, not the wrapper.
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(inner) = source {
        parts.push(inner.to_string());
        source = inner.source();
    }
    parts.dedup();
    parts.join(": ")
}
