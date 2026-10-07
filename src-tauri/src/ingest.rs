//! Collector ingest: correlate pods with workloads, merge histograms into
//! tmjLite, compact 5m → 1h → 1d, expire old windows. The only writer of
//! rightsizing tables — the DaemonSet never opens the database.

use crate::cluster::{parse_cpu_milli, parse_memory_bytes};
use crate::db::{sql_str, Db};
use crate::histogram::Histogram;
use k8s_openapi::api::apps::v1::ReplicaSet;
use k8s_openapi::api::core::v1::Pod;
use kube::{api::ListParams, Api, Client};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
pub struct IngestBatch {
    pub node: String,
    pub window_start: String,
    #[allow(dead_code)]
    pub window_secs: u64,
    pub samples: Vec<IngestSample>,
}

#[derive(Debug, Deserialize)]
pub struct IngestSample {
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub cpu: Histogram,
    pub memory: Histogram,
    pub memory_max: f64,
    pub samples: u64,
    pub throttle_ratio: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct WorkloadKey {
    pub namespace: String,
    pub kind: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct IngestResult {
    pub accepted: usize,
    pub skipped: usize,
    pub skip_reason: Option<String>,
}

struct ContainerRes {
    cpu_request: Option<f64>,
    cpu_limit: Option<f64>,
    mem_request: Option<f64>,
    mem_limit: Option<f64>,
    oom: bool,
}

/// A batch with its owners resolved — everything the write phase needs, and
/// nothing that still requires the network.
pub struct PreparedBatch {
    node: String,
    window_start: String,
    rows: Vec<(WorkloadKey, IngestSample, ContainerRes)>,
    skipped: usize,
}

/// Phase one, async: resolve every sample's workload owner against the API.
/// Nothing here touches the database, so nothing here blocks a runtime thread.
/// A node has a few hundred containers at most; a batch far beyond that is
/// not a collector talking. Bounding it here keeps the request body from
/// dictating memory, which is what CodeQL flagged in the old with_capacity.
const MAX_SAMPLES_PER_BATCH: usize = 10_000;

pub async fn prepare(batch: IngestBatch) -> Result<PreparedBatch, String> {
    if batch.samples.len() > MAX_SAMPLES_PER_BATCH {
        return Err(format!(
            "batch carries {} samples; a node's collector sends at most a few hundred",
            batch.samples.len()
        ));
    }
    let mut prepared = PreparedBatch {
        node: batch.node.clone(),
        window_start: batch.window_start.clone(),
        rows: Vec::new(),
        skipped: 0,
    };
    if batch.samples.is_empty() {
        return Ok(prepared);
    }
    let client = crate::client_for_context("").await?;
    let pods: Api<Pod> = Api::all(client.clone());
    let listed = pods
        .list(&ListParams::default())
        .await
        .map_err(|e| crate::errors::humanize(&e.to_string()))?;
    let mut by_ns_name: HashMap<(String, String), Pod> = HashMap::new();
    for pod in listed.items {
        let ns = pod.metadata.namespace.clone().unwrap_or_default();
        if let Some(name) = pod.metadata.name.clone() {
            by_ns_name.insert((ns, name), pod);
        }
    }
    let mut rs_cache: HashMap<(String, String), Option<WorkloadKey>> = HashMap::new();
    for sample in batch.samples {
        let Some(pod) = by_ns_name.get(&(sample.namespace.clone(), sample.pod.clone())) else {
            prepared.skipped += 1;
            continue;
        };
        let Some(owner) = resolve_owner(client.clone(), pod, &mut rs_cache).await? else {
            prepared.skipped += 1;
            continue;
        };
        let res = container_resources(pod, &sample.container);
        prepared.rows.push((owner, sample, res));
    }
    Ok(prepared)
}

/// Every tmjLite call is synchronous FFI with an fsync behind it. Batches
/// apply one at a time: twelve collectors landing in the same minute would
/// otherwise contend for the engine's write lock across as many threads, and
/// serialising here keeps the thread pool honest too.
static APPLY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Phase two, blocking: the writes. Call from `spawn_blocking` — it never
/// awaits, and on a runtime worker it would starve every other request,
/// /healthz included, which is exactly how the web pod ended up in a
/// liveness restart loop under twelve collectors.
pub fn apply(db: &Db, prepared: PreparedBatch) -> Result<IngestResult, String> {
    let _serial = APPLY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    // One transaction per batch. tmjLite binds a shared-handle transaction to
    // the calling thread, and this whole function runs on one spawn_blocking
    // thread under the lock above — BEGIN and COMMIT cannot drift apart.
    // Hundreds of writes then cost one commit instead of hundreds.
    db.exec("BEGIN;")?;
    let written = (|| -> Result<usize, String> {
        let mut accepted = 0usize;
        for (owner, sample, res) in &prepared.rows {
            upsert_5m(db, owner, sample, res, &prepared.window_start)?;
            merge_up(db, owner, &sample.container, &prepared.window_start)?;
            accepted += 1;
        }
        touch_node(db, &prepared.node)?;
        Ok(accepted)
    })();
    let accepted = match written {
        Ok(accepted) => {
            db.exec("COMMIT;")?;
            accepted
        }
        Err(error) => {
            // A half-applied batch is worse than a retried one: the collector
            // keeps its buffer until it hears 200. tmjLite 0.3.0 propagates
            // ROLLBACK failures; if restore failed, this handle is spent.
            if let Err(rollback) = db.exec("ROLLBACK;") {
                return Err(format!(
                    "{error} (and ROLLBACK failed: {rollback} — restart the process so the database is reopened)"
                ));
            }
            return Err(error);
        }
    };
    // Retention runs in its own commit — a purge that touches thousands of
    // rows should not sit inside the batch's transaction.
    purge_if_due(db)?;
    let skip_reason = if prepared.skipped > 0 {
        Some(format!(
            "{} sample(s) had no resolvable workload owner (pod gone, or no controller)",
            prepared.skipped
        ))
    } else {
        None
    };
    Ok(IngestResult { accepted, skipped: prepared.skipped, skip_reason })
}

async fn resolve_owner(
    client: Client,
    pod: &Pod,
    rs_cache: &mut HashMap<(String, String), Option<WorkloadKey>>,
) -> Result<Option<WorkloadKey>, String> {
    let ns = pod.metadata.namespace.clone().unwrap_or_default();
    let Some(owners) = pod.metadata.owner_references.as_ref() else {
        return Ok(None);
    };
    let Some(ctrl) = owners.iter().find(|o| o.controller == Some(true)).or(owners.first()) else {
        return Ok(None);
    };
    match ctrl.kind.as_str() {
        "ReplicaSet" => {
            let key = (ns.clone(), ctrl.name.clone());
            if let Some(cached) = rs_cache.get(&key) {
                return Ok(cached.clone());
            }
            let api: Api<ReplicaSet> = Api::namespaced(client, &ns);
            let rs = api.get(&ctrl.name).await.ok();
            let resolved = rs.and_then(|rs| {
                let owners = rs.metadata.owner_references.unwrap_or_default();
                let parent = owners.iter().find(|o| o.controller == Some(true))?;
                Some(WorkloadKey {
                    namespace: ns.clone(),
                    kind: parent.kind.clone(),
                    name: parent.name.clone(),
                })
            });
            rs_cache.insert(key, resolved.clone());
            Ok(resolved)
        }
        kind @ ("Deployment" | "StatefulSet" | "DaemonSet" | "Job" | "CronJob") => {
            Ok(Some(WorkloadKey {
                namespace: ns,
                kind: kind.to_string(),
                name: ctrl.name.clone(),
            }))
        }
        _ => Ok(None),
    }
}

fn container_resources(pod: &Pod, container: &str) -> ContainerRes {
    let spec = pod.spec.as_ref();
    let ctr = spec.and_then(|s| {
        s.containers
            .iter()
            .find(|c| c.name == container)
            .or_else(|| s.init_containers.as_ref()?.iter().find(|c| c.name == container))
    });
    let req = ctr.and_then(|c| c.resources.as_ref()).and_then(|r| r.requests.as_ref());
    let lim = ctr.and_then(|c| c.resources.as_ref()).and_then(|r| r.limits.as_ref());
    let qty = |map: Option<&std::collections::BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>,
               key: &str,
               parse: fn(&str) -> Option<f64>| {
        map.and_then(|m| m.get(key)).and_then(|q| parse(&q.0))
    };
    let oom = pod
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref())
        .and_then(|cs| cs.iter().find(|c| c.name == container))
        .and_then(|c| c.last_state.as_ref())
        .and_then(|st| st.terminated.as_ref())
        .map(|t| t.reason.as_deref() == Some("OOMKilled"))
        .unwrap_or(false);
    ContainerRes {
        cpu_request: qty(req, "cpu", parse_cpu_milli),
        cpu_limit: qty(lim, "cpu", parse_cpu_milli),
        mem_request: qty(req, "memory", parse_memory_bytes),
        mem_limit: qty(lim, "memory", parse_memory_bytes),
        oom,
    }
}

fn hist_json(h: &Histogram) -> Result<String, String> {
    serde_json::to_string(&h.counts).map_err(|e| e.to_string())
}

fn parse_hist(raw: &str) -> Histogram {
    let counts: Vec<u64> = serde_json::from_str(raw).unwrap_or_default();
    let mut h = Histogram::default();
    let n = h.counts.len().min(counts.len());
    h.counts[..n].copy_from_slice(&counts[..n]);
    h
}

fn num_opt(v: Option<f64>) -> Result<String, String> {
    match v {
        None => Ok("NULL".into()),
        Some(n) if n.is_finite() => sql_str(&format!("{n:.4}")),
        Some(_) => Ok("NULL".into()),
    }
}

fn upsert_5m(
    db: &Db,
    owner: &WorkloadKey,
    sample: &IngestSample,
    res: &ContainerRes,
    window_start: &str,
) -> Result<(), String> {
    let existing = db.query(&format!(
        "SELECT cpu_hist, mem_hist, mem_max_bytes, samples, oom_kills FROM rs_rollup_5m \
         WHERE namespace = {} AND kind = {} AND workload = {} AND container = {} AND window_start = {};",
        sql_str(&owner.namespace)?,
        sql_str(&owner.kind)?,
        sql_str(&owner.name)?,
        sql_str(&sample.container)?,
        sql_str(window_start)?,
    ))?;
    if let Some(row) = existing.rows.first() {
        let mut cpu = parse_hist(row[0].as_deref().unwrap_or("[]"));
        let mut mem = parse_hist(row[1].as_deref().unwrap_or("[]"));
        cpu.merge(&sample.cpu);
        mem.merge(&sample.memory);
        let prev_max: f64 = row[2].as_deref().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let mem_max = prev_max.max(sample.memory_max);
        let samples: u64 = row[3].as_deref().and_then(|s| s.parse().ok()).unwrap_or(0) + sample.samples;
        let ooms: i64 = row[4].as_deref().and_then(|s| s.parse().ok()).unwrap_or(0)
            + if res.oom { 1 } else { 0 };
        db.exec(&format!(
            "UPDATE rs_rollup_5m SET cpu_hist = {}, mem_hist = {}, mem_max_bytes = {}, samples = {samples}, \
             oom_kills = {ooms}, throttle_ratio = {}, cpu_request_milli = {}, cpu_limit_milli = {}, \
             mem_request_bytes = {}, mem_limit_bytes = {} \
             WHERE namespace = {} AND kind = {} AND workload = {} AND container = {} AND window_start = {};",
            sql_str(&hist_json(&cpu)?)?,
            sql_str(&hist_json(&mem)?)?,
            sql_str(&format!("{mem_max:.0}"))?,
            num_opt(sample.throttle_ratio)?,
            num_opt(res.cpu_request)?,
            num_opt(res.cpu_limit)?,
            num_opt(res.mem_request)?,
            num_opt(res.mem_limit)?,
            sql_str(&owner.namespace)?,
            sql_str(&owner.kind)?,
            sql_str(&owner.name)?,
            sql_str(&sample.container)?,
            sql_str(window_start)?,
        ))
    } else {
        db.exec(&format!(
            "INSERT INTO rs_rollup_5m (namespace, kind, workload, container, window_start, cpu_hist, mem_hist, \
             mem_max_bytes, samples, oom_kills, throttle_ratio, cpu_request_milli, cpu_limit_milli, \
             mem_request_bytes, mem_limit_bytes, replicas, limited_data) VALUES (\
             {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, NULL, FALSE);",
            sql_str(&owner.namespace)?,
            sql_str(&owner.kind)?,
            sql_str(&owner.name)?,
            sql_str(&sample.container)?,
            sql_str(window_start)?,
            sql_str(&hist_json(&sample.cpu)?)?,
            sql_str(&hist_json(&sample.memory)?)?,
            sql_str(&format!("{:.0}", sample.memory_max))?,
            sample.samples,
            if res.oom { 1 } else { 0 },
            num_opt(sample.throttle_ratio)?,
            num_opt(res.cpu_request)?,
            num_opt(res.cpu_limit)?,
            num_opt(res.mem_request)?,
            num_opt(res.mem_limit)?,
        ))
    }
}

fn merge_up(db: &Db, owner: &WorkloadKey, container: &str, window_start: &str) -> Result<(), String> {
    let ts = chrono::DateTime::parse_from_rfc3339(window_start)
        .map(|t| t.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());
    let hour = ts.format("%Y-%m-%dT%H:00:00+00:00").to_string();
    let day = ts.format("%Y-%m-%dT00:00:00+00:00").to_string();
    compact_into(db, "rs_rollup_5m", "rs_rollup_1h", owner, container, &hour, |stamp| {
        stamp.starts_with(&ts.format("%Y-%m-%dT%H:").to_string())
    })?;
    compact_into(db, "rs_rollup_1h", "rs_rollup_1d", owner, container, &day, |stamp| {
        stamp.starts_with(&ts.format("%Y-%m-%dT").to_string())
    })?;
    Ok(())
}

/// Rebuild the coarser window from every finer row that belongs to it.
fn compact_into(
    db: &Db,
    from: &str,
    into: &str,
    owner: &WorkloadKey,
    container: &str,
    window_start: &str,
    belongs: impl Fn(&str) -> bool,
) -> Result<(), String> {
    let rows = db.query(&format!(
        "SELECT cpu_hist, mem_hist, mem_max_bytes, samples, oom_kills, throttle_ratio, window_start, \
         cpu_request_milli, cpu_limit_milli, mem_request_bytes, mem_limit_bytes, replicas, limited_data FROM {from} \
         WHERE namespace = {} AND kind = {} AND workload = {} AND container = {};",
        sql_str(&owner.namespace)?,
        sql_str(&owner.kind)?,
        sql_str(&owner.name)?,
        sql_str(container)?,
    ))?;
    let matched: Vec<&Vec<Option<String>>> = rows
        .rows
        .iter()
        .filter(|row| row.get(6).and_then(|v| v.as_deref()).map(&belongs).unwrap_or(false))
        .collect();
    if matched.is_empty() {
        return Ok(());
    }
    let mut cpu = Histogram::default();
    let mut mem = Histogram::default();
    let mut mem_max = 0.0f64;
    let mut samples = 0u64;
    let mut ooms = 0i64;
    let mut thr_sum = 0.0f64;
    let mut thr_n = 0u64;
    for row in &matched {
        cpu.merge(&parse_hist(row[0].as_deref().unwrap_or("[]")));
        mem.merge(&parse_hist(row[1].as_deref().unwrap_or("[]")));
        let mx: f64 = row[2].as_deref().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        mem_max = mem_max.max(mx);
        samples += row[3].as_deref().and_then(|s| s.parse().ok()).unwrap_or(0);
        ooms += row[4].as_deref().and_then(|s| s.parse().ok()).unwrap_or(0);
        if let Some(t) = row[5].as_deref().and_then(|s| s.parse::<f64>().ok()) {
            thr_sum += t;
            thr_n += 1;
        }
    }
    let throttle = if thr_n == 0 { None } else { Some(thr_sum / thr_n as f64) };
    // Requests, limits and replicas are not aggregates: the newest window says
    // what the workload asks for today. They used to be left NULL here, so
    // every 1h/1d row — the ones the screen reads first — rendered "—".
    let newest = matched
        .iter()
        .max_by(|a, b| a[6].cmp(&b[6]))
        .expect("matched is non-empty");
    let carry = |index: usize| -> Result<String, String> {
        match newest.get(index).and_then(|v| v.as_deref()) {
            Some(raw) if raw != "NULL" && !raw.is_empty() => sql_str(raw),
            _ => Ok("NULL".to_string()),
        }
    };
    let (cpu_req, cpu_lim, mem_req, mem_lim) = (carry(7)?, carry(8)?, carry(9)?, carry(10)?);
    let replicas = match newest.get(11).and_then(|v| v.as_deref()) {
        Some(raw) if raw.parse::<i64>().is_ok() => raw.to_string(),
        _ => "NULL".to_string(),
    };
    let limited = matched
        .iter()
        .any(|row| row.get(12).and_then(|v| v.as_deref()) == Some("true"));
    let exists = db.query(&format!(
        "SELECT id FROM {into} WHERE namespace = {} AND kind = {} AND workload = {} AND container = {} AND window_start = {};",
        sql_str(&owner.namespace)?,
        sql_str(&owner.kind)?,
        sql_str(&owner.name)?,
        sql_str(container)?,
        sql_str(window_start)?,
    ))?;
    if exists.rows.is_empty() {
        db.exec(&format!(
            "INSERT INTO {into} (namespace, kind, workload, container, window_start, cpu_hist, mem_hist, \
             mem_max_bytes, samples, oom_kills, throttle_ratio, cpu_request_milli, cpu_limit_milli, \
             mem_request_bytes, mem_limit_bytes, replicas, limited_data) VALUES (\
             {}, {}, {}, {}, {}, {}, {}, {}, {samples}, {ooms}, {}, {cpu_req}, {cpu_lim}, {mem_req}, {mem_lim}, {replicas}, {});",
            sql_str(&owner.namespace)?,
            sql_str(&owner.kind)?,
            sql_str(&owner.name)?,
            sql_str(container)?,
            sql_str(window_start)?,
            sql_str(&hist_json(&cpu)?)?,
            sql_str(&hist_json(&mem)?)?,
            sql_str(&format!("{mem_max:.0}"))?,
            num_opt(throttle)?,
            if limited { "TRUE" } else { "FALSE" },
        ))
    } else {
        db.exec(&format!(
            "UPDATE {into} SET cpu_hist = {}, mem_hist = {}, mem_max_bytes = {}, samples = {samples}, \
             oom_kills = {ooms}, throttle_ratio = {}, cpu_request_milli = {cpu_req}, cpu_limit_milli = {cpu_lim}, \
             mem_request_bytes = {mem_req}, mem_limit_bytes = {mem_lim}, replicas = {replicas} \
             WHERE namespace = {} AND kind = {} AND workload = {} AND container = {} AND window_start = {};",
            sql_str(&hist_json(&cpu)?)?,
            sql_str(&hist_json(&mem)?)?,
            sql_str(&format!("{mem_max:.0}"))?,
            num_opt(throttle)?,
            sql_str(&owner.namespace)?,
            sql_str(&owner.kind)?,
            sql_str(&owner.name)?,
            sql_str(container)?,
            sql_str(window_start)?,
        ))
    }
}

fn touch_node(db: &Db, node: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let found = db.query(&format!(
        "SELECT id FROM collector_nodes WHERE node_name = {};",
        sql_str(node)?
    ))?;
    if found.rows.is_empty() {
        db.exec(&format!(
            "INSERT INTO collector_nodes (node_name, last_seen, limited_data) VALUES ({}, {}, FALSE);",
            sql_str(node)?,
            sql_str(&now)?
        ))
    } else {
        db.exec(&format!(
            "UPDATE collector_nodes SET last_seen = {} WHERE node_name = {};",
            sql_str(&now)?,
            sql_str(node)?
        ))
    }
}

fn retention_raw() -> chrono::Duration {
    parse_retention_env("TMJLENS_RETENTION_RAW", chrono::Duration::hours(48))
}

fn retention_rollup() -> chrono::Duration {
    parse_retention_env("TMJLENS_RETENTION_ROLLUP", chrono::Duration::days(90))
}

fn parse_retention_env(name: &str, default: chrono::Duration) -> chrono::Duration {
    let Some(raw) = std::env::var(name).ok() else {
        return default;
    };
    let raw = raw.trim();
    if let Some(n) = raw.strip_suffix('h').and_then(|s| s.parse::<i64>().ok()) {
        return chrono::Duration::hours(n);
    }
    if let Some(n) = raw.strip_suffix('d').and_then(|s| s.parse::<i64>().ok()) {
        return chrono::Duration::days(n);
    }
    default
}

/// Retention deletes scan whole tables (window_start is not the leading
/// index column). Once an hour is plenty for a 48h/90d policy; once per
/// batch — twelve times a minute under load — was most of the CPU.
const PURGE_EVERY: std::time::Duration = std::time::Duration::from_secs(60 * 60);
static LAST_PURGE: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

pub fn purge_due(last: Option<std::time::Instant>, now: std::time::Instant) -> bool {
    match last {
        None => true,
        Some(at) => now.duration_since(at) >= PURGE_EVERY,
    }
}

fn purge_if_due(db: &Db) -> Result<(), String> {
    let now = std::time::Instant::now();
    let mut last = LAST_PURGE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !purge_due(*last, now) {
        return Ok(());
    }
    *last = Some(now);
    drop(last);
    purge(db)
}

pub fn purge(db: &Db) -> Result<(), String> {
    let raw_cut = (chrono::Utc::now() - retention_raw()).to_rfc3339();
    let roll_cut = (chrono::Utc::now() - retention_rollup()).to_rfc3339();
    let _ = db.exec(&format!(
        "DELETE FROM rs_rollup_5m WHERE window_start < {};",
        sql_str(&raw_cut)?
    ));
    let _ = db.exec(&format!(
        "DELETE FROM rs_rollup_1h WHERE window_start < {};",
        sql_str(&roll_cut)?
    ));
    let _ = db.exec(&format!(
        "DELETE FROM rs_rollup_1d WHERE window_start < {};",
        sql_str(&roll_cut)?
    ));
    Ok(())
}

/// Load every 1d (falling back to 1h, then 5m) histogram for a container and merge.
pub fn merged_usage(
    db: &Db,
    namespace: &str,
    kind: &str,
    workload: &str,
    container: &str,
) -> Result<Option<MergedUsage>, String> {
    for table in ["rs_rollup_1d", "rs_rollup_1h", "rs_rollup_5m"] {
        let rows = db.query(&format!(
            "SELECT cpu_hist, mem_hist, mem_max_bytes, samples, oom_kills, throttle_ratio, \
             cpu_request_milli, mem_request_bytes, window_start, limited_data FROM {table} \
             WHERE namespace = {} AND kind = {} AND workload = {} AND container = {} \
             ORDER BY window_start;",
            sql_str(namespace)?,
            sql_str(kind)?,
            sql_str(workload)?,
            sql_str(container)?,
        ))?;
        if rows.rows.is_empty() {
            continue;
        }
        return Ok(Some(fold_rows(&rows.rows)));
    }
    Ok(None)
}

pub fn list_containers(db: &Db) -> Result<Vec<(String, String, String, String)>, String> {
    let mut seen = std::collections::BTreeSet::new();
    for table in ["rs_rollup_5m", "rs_rollup_1h", "rs_rollup_1d"] {
        // No DISTINCT: tmjLite does not parse it. The BTreeSet below is the dedup.
        let rows = db.query(&format!(
            "SELECT namespace, kind, workload, container FROM {table};"
        ))?;
        for r in rows.rows {
            if let (Some(ns), Some(kind), Some(name), Some(ctr)) = (r[0].clone(), r[1].clone(), r[2].clone(), r[3].clone()) {
                seen.insert((ns, kind, name, ctr));
            }
        }
    }
    Ok(seen.into_iter().collect())
}

#[derive(Clone)]
pub struct MergedUsage {
    pub cpu: Histogram,
    pub memory: Histogram,
    pub memory_max: f64,
    pub samples: u64,
    pub oom_kills: i64,
    pub throttle_ratio: Option<f64>,
    pub cpu_request_milli: Option<f64>,
    pub mem_request_bytes: Option<f64>,
    pub first_window: Option<String>,
    pub last_window: Option<String>,
    pub limited_data: bool,
}

fn fold_rows(rows: &[Vec<Option<String>>]) -> MergedUsage {
    let mut cpu = Histogram::default();
    let mut mem = Histogram::default();
    let mut memory_max: f64 = 0.0;
    let mut samples = 0u64;
    let mut oom_kills = 0i64;
    let mut thr_sum = 0.0;
    let mut thr_n = 0u64;
    let mut cpu_request = None;
    let mut mem_request = None;
    let mut first_window = None;
    let mut last_window = None;
    let mut limited_data = false;
    for row in rows {
        cpu.merge(&parse_hist(row[0].as_deref().unwrap_or("[]")));
        mem.merge(&parse_hist(row[1].as_deref().unwrap_or("[]")));
        memory_max = memory_max.max(row[2].as_deref().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0));
        samples += row[3].as_deref().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        oom_kills += row[4].as_deref().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
        if let Some(t) = row[5].as_deref().and_then(|s| s.parse::<f64>().ok()) {
            thr_sum += t;
            thr_n += 1;
        }
        if cpu_request.is_none() {
            cpu_request = row[6].as_deref().and_then(|s| s.parse::<f64>().ok());
        }
        if mem_request.is_none() {
            mem_request = row[7].as_deref().and_then(|s| s.parse::<f64>().ok());
        }
        if first_window.is_none() {
            first_window = row[8].clone();
        }
        last_window = row[8].clone();
        if row.get(9).and_then(|v| v.as_deref()) == Some("true") {
            limited_data = true;
        }
    }
    MergedUsage {
        cpu,
        memory: mem,
        memory_max,
        samples,
        oom_kills,
        throttle_ratio: if thr_n == 0 { None } else { Some(thr_sum / thr_n as f64) },
        cpu_request_milli: cpu_request,
        mem_request_bytes: mem_request,
        first_window,
        last_window,
        limited_data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: this query once said `SELECT DISTINCT …`, which tmjLite
    /// does not parse — the Rightsizing screen opened straight into
    /// "Parse error: expected From, got Identifier(namespace)". The dedup
    /// belongs to the BTreeSet in Rust, not to a keyword the engine lacks.
    #[test]
    fn listing_containers_speaks_tmjlites_sql_and_dedups_in_rust() {
        let dir = std::env::temp_dir().join("tmjlens-db-tests");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join(format!(
            "ingest-containers-{}-{}.tmjp",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let db = crate::db::Db::open(&path).expect("open");
        for (window, workload) in [("w1", "checkout-api"), ("w2", "checkout-api"), ("w1", "fraud-scoring")] {
            db.exec(&format!(
                "INSERT INTO rs_rollup_5m (namespace, kind, workload, container, window_start, cpu_hist,                  mem_hist, samples, oom_kills) VALUES ('payments', 'Deployment', '{workload}', 'app',                  '{window}', '{{}}', '{{}}', 1, 0);"
            ))
            .expect("seed row");
        }

        let containers = list_containers(&db).expect("the query must parse on tmjLite");
        // Two windows of the same container collapse to one entry.
        assert_eq!(
            containers,
            vec![
                ("payments".into(), "Deployment".into(), "checkout-api".into(), "app".into()),
                ("payments".into(), "Deployment".into(), "fraud-scoring".into(), "app".into()),
            ]
        );
    }

    #[test]
    fn retention_runs_on_the_first_batch_then_at_most_hourly() {
        let t0 = std::time::Instant::now();
        assert!(purge_due(None, t0));
        assert!(!purge_due(Some(t0), t0 + std::time::Duration::from_secs(59 * 60)));
        assert!(purge_due(Some(t0), t0 + std::time::Duration::from_secs(61 * 60)));
    }

    /// Production showed P95 and peak but "—" for every request: the 1h/1d
    /// rows the screen reads first were compacted with requests left NULL.
    /// Compaction must carry the NEWEST window's request/limit/replicas.
    #[test]
    fn compaction_carries_the_newest_requests_into_the_coarser_window() {
        let dir = std::env::temp_dir().join("tmjlens-db-tests");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join(format!(
            "ingest-compact-{}-{}.tmjp",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let db = crate::db::Db::open(&path).expect("open");
        // Two 5m windows in the same hour; the request grew between them.
        for (window, cpu_req, mem_req) in [
            ("2026-09-29T10:05:00+00:00", "250", "268435456"),
            ("2026-09-29T10:10:00+00:00", "500", "1073741824"),
        ] {
            db.exec(&format!(
                "INSERT INTO rs_rollup_5m (namespace, kind, workload, container, window_start, cpu_hist,                  mem_hist, samples, oom_kills, cpu_request_milli, mem_request_bytes, cpu_limit_milli, replicas)                  VALUES ('payments', 'Deployment', 'checkout-api', 'app', '{window}', '{{}}', '{{}}', 3, 0,                  '{cpu_req}', '{mem_req}', '500', 3);"
            ))
            .expect("seed");
        }
        let owner = WorkloadKey {
            namespace: "payments".into(),
            kind: "Deployment".into(),
            name: "checkout-api".into(),
        };
        compact_into(&db, "rs_rollup_5m", "rs_rollup_1h", &owner, "app", "2026-09-29T10:00:00+00:00", |stamp| {
            stamp.starts_with("2026-09-29T10:")
        })
        .expect("compact");

        let row = db
            .query("SELECT cpu_request_milli, mem_request_bytes, cpu_limit_milli, replicas, samples FROM rs_rollup_1h;")
            .expect("query");
        assert_eq!(row.rows.len(), 1);
        let cells: Vec<&str> = row.rows[0].iter().map(|c| c.as_deref().unwrap_or("NULL")).collect();
        assert_eq!(cells[0], "500", "newest request wins: {cells:?}");
        assert_eq!(cells[1], "1073741824", "{cells:?}");
        assert_eq!(cells[2], "500", "{cells:?}");
        assert_eq!(cells[3], "3", "{cells:?}");
        assert_eq!(cells[4], "6", "samples are summed: {cells:?}");
    }

    #[test]
    fn hist_json_round_trips() {
        let mut h = Histogram::default();
        h.observe(42.0);
        let raw = hist_json(&h).unwrap();
        let back = parse_hist(&raw);
        assert_eq!(h.samples(), back.samples());
    }
}
