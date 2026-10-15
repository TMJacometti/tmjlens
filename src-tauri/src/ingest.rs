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
        window_start: align_5m(&batch.window_start),
        rows: Vec::new(),
        skipped: 0,
    };
    if batch.samples.is_empty() {
        return Ok(prepared);
    }
    let client = crate::client_for_context("").await?;
    // Only this node's pods. The unscoped list pulled EVERY pod in the
    // cluster — managedFields and all — once per batch, with up to four
    // batches in flight: a transient peak the allocator never gives back,
    // which is where the web pod's 2 GiB baseline in production came from.
    let pods: Api<Pod> = Api::all(client.clone());
    let listed = pods
        .list(&node_scope(&batch.node))
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

/// The collector's NODE_NAME comes from the Downward API (spec.nodeName),
/// so the same string selects exactly the pods the kubelet it scraped runs.
fn node_scope(node: &str) -> ListParams {
    ListParams::default().fields(&format!("spec.nodeName={node}"))
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

    // Compaction REBUILDS the hour from the 5m rows present. A batch older
    // than the raw retention floor would rebuild it from whatever the purge
    // left — a complete hourly row overwritten by a partial one. Such a
    // batch (a collector flushing days of buffer) is dropped, and the
    // collector hears why instead of retrying it forever.
    let floor = stamp(raw_retention_floor(chrono::Utc::now()));
    if prepared.window_start.as_str() < floor.as_str() {
        return Ok(IngestResult {
            accepted: 0,
            skipped: prepared.rows.len() + prepared.skipped,
            skip_reason: Some(format!(
                "window {} is older than TMJLENS_RETENTION_RAW ({}h, floor {floor}); dropped rather than \
                 rebuilding an hourly row from a partly purged day",
                prepared.window_start,
                retention_raw().num_hours()
            )),
        });
    }

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
    // rows should not sit inside the batch's transaction. A failed purge is
    // recorded and retried soon; it never makes the collector resend a batch
    // that already landed.
    purge_if_due(db);
    let skip_reason = if prepared.skipped > 0 {
        Some(format!(
            "{} sample(s) had no resolvable workload owner (pod gone, not scheduled on node {}, or no controller)",
            prepared.skipped, prepared.node
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

/// Every window stamp this module writes: fixed-width RFC 3339 in UTC, so the
/// string order IS the time order and `window_start >= a AND window_start < b`
/// is a range the engine can walk on the index.
const STAMP: &str = "%Y-%m-%dT%H:%M:%S+00:00";

fn stamp(t: chrono::DateTime<chrono::Utc>) -> String {
    t.format(STAMP).to_string()
}

/// The collector stamps a batch with the wall clock at the start of its
/// window, nanoseconds and all. The 5m table keys on that stamp, so two
/// batches of the same five minutes — a buffered flush landing beside a live
/// one — became two rows instead of one merge. Floor it to the bucket.
pub fn align_5m(raw: &str) -> String {
    use chrono::Timelike;
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(raw) else {
        return raw.to_string();
    };
    let t = parsed.with_timezone(&chrono::Utc);
    t.with_minute(t.minute() - t.minute() % 5)
        .and_then(|t| t.with_second(0))
        .and_then(|t| t.with_nanosecond(0))
        .map(stamp)
        .unwrap_or_else(|| raw.to_string())
}

fn floor_hour(t: chrono::DateTime<chrono::Utc>) -> chrono::DateTime<chrono::Utc> {
    use chrono::Timelike;
    t.with_minute(0)
        .and_then(|t| t.with_second(0))
        .and_then(|t| t.with_nanosecond(0))
        .unwrap_or(t)
}

fn merge_up(db: &Db, owner: &WorkloadKey, container: &str, window_start: &str) -> Result<(), String> {
    use chrono::Timelike;
    let ts = chrono::DateTime::parse_from_rfc3339(window_start)
        .map(|t| t.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());
    let hour = floor_hour(ts);
    let day = hour.with_hour(0).unwrap_or(hour);
    compact_into(db, "rs_rollup_5m", "rs_rollup_1h", owner, container,
        &stamp(hour), &stamp(hour + chrono::Duration::hours(1)))?;
    compact_into(db, "rs_rollup_1h", "rs_rollup_1d", owner, container,
        &stamp(day), &stamp(day + chrono::Duration::days(1)))?;
    Ok(())
}

/// Rebuild the coarser window `[window_start, window_end)` from the finer rows
/// inside it. The range is in the WHERE on purpose: the index is (namespace,
/// kind, workload, container, window_start), so this is a walk over ~12 rows.
/// Without the bound it read the container's whole retained history — twice
/// per sample, growing with retention — and that is what OOM-killed the web
/// pod in production once the history was a day old.
fn compact_into(
    db: &Db,
    from: &str,
    into: &str,
    owner: &WorkloadKey,
    container: &str,
    window_start: &str,
    window_end: &str,
) -> Result<(), String> {
    // One row in memory at a time (tmjLite 0.3.1 cursor): the window's
    // ~12 rows stream through this fold and only the merged result survives.
    #[derive(Default)]
    struct Fold {
        rows: usize,
        cpu: Histogram,
        mem: Histogram,
        mem_max: f64,
        samples: u64,
        ooms: i64,
        thr_sum: f64,
        thr_n: u64,
        newest_stamp: String,
        // cpu_request, cpu_limit, mem_request, mem_limit, replicas of the newest row
        newest: [Option<String>; 5],
        limited: bool,
    }
    let f = db.fold(
        &format!(
            "SELECT cpu_hist, mem_hist, mem_max_bytes, samples, oom_kills, throttle_ratio, window_start, \
             cpu_request_milli, cpu_limit_milli, mem_request_bytes, mem_limit_bytes, replicas, limited_data FROM {from} \
             WHERE namespace = {} AND kind = {} AND workload = {} AND container = {} \
             AND window_start >= {} AND window_start < {};",
            sql_str(&owner.namespace)?,
            sql_str(&owner.kind)?,
            sql_str(&owner.name)?,
            sql_str(container)?,
            sql_str(window_start)?,
            sql_str(window_end)?,
        ),
        Fold::default(),
        |mut f, row| {
            f.rows += 1;
            f.cpu.merge(&parse_hist(row.text(0).unwrap_or("[]")));
            f.mem.merge(&parse_hist(row.text(1).unwrap_or("[]")));
            f.mem_max = f.mem_max.max(row.f64(2).unwrap_or(0.0));
            f.samples += row.i64(3).unwrap_or(0).max(0) as u64;
            f.ooms += row.i64(4).unwrap_or(0);
            if let Some(t) = row.f64(5) {
                f.thr_sum += t;
                f.thr_n += 1;
            }
            // Requests, limits and replicas are not aggregates: the newest
            // window says what the workload asks for today. They used to be
            // left NULL here, so every 1h/1d row rendered "—".
            let stamp = row.text(6).unwrap_or("");
            if f.rows == 1 || stamp > f.newest_stamp.as_str() {
                f.newest_stamp = stamp.to_string();
                f.newest = [7, 8, 9, 10, 11].map(|col| row.text(col).filter(|v| !v.is_empty()).map(str::to_string));
            }
            if row.bool(12) == Some(true) {
                f.limited = true;
            }
            Ok(f)
        },
    )?;
    if f.rows == 0 {
        return Ok(());
    }
    let Fold { cpu, mem, mem_max, samples, ooms, thr_sum, thr_n, newest, limited, .. } = f;
    let throttle = if thr_n == 0 { None } else { Some(thr_sum / thr_n as f64) };
    let carry = |index: usize| -> Result<String, String> {
        match newest[index].as_deref() {
            Some(raw) => sql_str(raw),
            None => Ok("NULL".to_string()),
        }
    };
    let (cpu_req, cpu_lim, mem_req, mem_lim) = (carry(0)?, carry(1)?, carry(2)?, carry(3)?);
    let replicas = match newest[4].as_deref() {
        Some(raw) if raw.parse::<i64>().is_ok() => raw.to_string(),
        _ => "NULL".to_string(),
    };
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
/// batch — twelve times a minute under load — was most of the CPU. A run
/// that FAILS is retried in five minutes and shown in the Admin popup: a
/// purge that silently never happens is how a 1Gi volume fills up.
const PURGE_EVERY: std::time::Duration = std::time::Duration::from_secs(60 * 60);
const PURGE_RETRY: std::time::Duration = std::time::Duration::from_secs(5 * 60);

#[derive(Default)]
struct PurgeState {
    last_attempt: Option<std::time::Instant>,
    last_error: Option<String>,
    next_due: Option<std::time::Instant>,
}

static PURGE_STATE: std::sync::Mutex<PurgeState> = std::sync::Mutex::new(PurgeState {
    last_attempt: None,
    last_error: None,
    next_due: None,
});

pub fn purge_due(next_due: Option<std::time::Instant>, now: std::time::Instant) -> bool {
    next_due.map_or(true, |due| now >= due)
}

fn record_purge(state: &mut PurgeState, now: std::time::Instant, outcome: Result<(), String>) {
    state.last_attempt = Some(now);
    match outcome {
        Ok(()) => {
            state.last_error = None;
            state.next_due = Some(now + PURGE_EVERY);
        }
        Err(error) => {
            eprintln!("retention purge failed: {error} — retrying in {}s", PURGE_RETRY.as_secs());
            state.last_error = Some(error);
            state.next_due = Some(now + PURGE_RETRY);
        }
    }
}

fn purge_if_due(db: &Db) {
    let now = std::time::Instant::now();
    {
        let state = PURGE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !purge_due(state.next_due, now) {
            return;
        }
    }
    let outcome = purge(db);
    let mut state = PURGE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    record_purge(&mut state, now, outcome);
}

/// The oldest hour the 5m tier keeps, aligned to the hour so every hour at
/// or after it is complete. Purge deletes below it; apply drops below it.
pub fn raw_retention_floor(now: chrono::DateTime<chrono::Utc>) -> chrono::DateTime<chrono::Utc> {
    floor_hour(now - retention_raw())
}

pub fn purge(db: &Db) -> Result<(), String> {
    use chrono::Timelike;
    let now = chrono::Utc::now();
    let raw_cut = stamp(raw_retention_floor(now));
    let roll_hour = floor_hour(now - retention_rollup());
    let roll_cut_1h = stamp(roll_hour);
    let roll_cut_1d = stamp(roll_hour.with_hour(0).unwrap_or(roll_hour));
    db.exec(&format!("DELETE FROM rs_rollup_5m WHERE window_start < {};", sql_str(&raw_cut)?))?;
    db.exec(&format!("DELETE FROM rs_rollup_1h WHERE window_start < {};", sql_str(&roll_cut_1h)?))?;
    db.exec(&format!("DELETE FROM rs_rollup_1d WHERE window_start < {};", sql_str(&roll_cut_1d)?))?;
    Ok(())
}

const TIERS: [(&str, &str); 3] = [
    ("rs_rollup_5m", "5-minute windows"),
    ("rs_rollup_1h", "Hourly windows"),
    ("rs_rollup_1d", "Daily windows"),
];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CollectedTable {
    pub table: String,
    pub label: String,
    pub rows: u64,
    pub oldest: Option<String>,
    pub newest: Option<String>,
}

/// What the collector has written, for the Admin popup on Rightsizing.
#[derive(Serialize, Clone, Debug)]
pub struct CollectedData {
    pub tables: Vec<CollectedTable>,
    pub collector_nodes: u64,
    pub database_path: String,
    /// None when the file could not be stat'ed — said so, not shown as 0.
    pub database_bytes: Option<u64>,
    pub wal_bytes: Option<u64>,
    pub retention_raw: String,
    pub retention_rollup: String,
    pub last_purge_minutes_ago: Option<u64>,
    /// Why the last retention run failed, if it did — shown, not swallowed.
    pub last_purge_error: Option<String>,
    /// The web process's resident memory now and at its peak (Linux /proc;
    /// None elsewhere). The two apart tell a transient peak from a leak.
    pub process_rss_bytes: Option<u64>,
    pub process_peak_rss_bytes: Option<u64>,
}

/// VmRSS and VmHWM from a /proc/<pid>/status body, in bytes.
fn parse_proc_status(text: &str) -> (Option<u64>, Option<u64>) {
    let kib = |key: &str| -> Option<u64> {
        text.lines()
            .find(|line| line.starts_with(key))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|n| n.parse::<u64>().ok())
            .map(|k| k * 1024)
    };
    (kib("VmRSS:"), kib("VmHWM:"))
}

fn process_memory() -> (Option<u64>, Option<u64>) {
    std::fs::read_to_string("/proc/self/status")
        .map(|text| parse_proc_status(&text))
        .unwrap_or((None, None))
}

#[derive(Serialize, Clone, Debug)]
pub struct PurgedTable {
    pub table: String,
    pub rows: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct PurgeOutcome {
    pub mode: String,
    pub deleted: Vec<PurgedTable>,
}

fn cell(row: &[Option<String>], index: usize) -> Option<String> {
    match row.get(index).and_then(|v| v.as_deref()) {
        Some(raw) if raw != "NULL" && !raw.is_empty() => Some(raw.to_string()),
        _ => None,
    }
}

fn table_stats(db: &Db, table: &str, label: &str) -> Result<CollectedTable, String> {
    let result = db.query(&format!(
        "SELECT COUNT(*), MIN(window_start), MAX(window_start) FROM {table};"
    ))?;
    let row = result
        .rows
        .first()
        .ok_or_else(|| format!("the engine returned no aggregate row for {table}"))?;
    Ok(CollectedTable {
        table: table.to_string(),
        label: label.to_string(),
        rows: cell(row, 0).and_then(|s| s.parse().ok()).unwrap_or(0),
        oldest: cell(row, 1),
        newest: cell(row, 2),
    })
}

fn count_rows(db: &Db, table: &str) -> Result<u64, String> {
    let result = db.query(&format!("SELECT COUNT(*) FROM {table};"))?;
    Ok(result
        .rows
        .first()
        .and_then(|row| cell(row, 0))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0))
}

/// Blocking: three aggregate queries plus a stat. Call from `block_in_place`.
pub fn collected_data(db: &Db) -> Result<CollectedData, String> {
    let mut tables = Vec::with_capacity(TIERS.len());
    for (table, label) in TIERS {
        tables.push(table_stats(db, table, label)?);
    }
    let database_path = crate::db::configured_path();
    let database_bytes = std::fs::metadata(&database_path).ok().map(|m| m.len());
    let wal_bytes = [format!("{database_path}.pwal"), database_path.replace(".tmjp", ".pwal")]
        .iter()
        .find_map(|candidate| std::fs::metadata(candidate).ok().map(|m| m.len()));
    let state = PURGE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let last_purge_minutes_ago = state.last_attempt.map(|at| at.elapsed().as_secs() / 60);
    let last_purge_error = state.last_error.clone();
    drop(state);
    Ok(CollectedData {
        tables,
        collector_nodes: count_rows(db, "collector_nodes")?,
        database_path,
        database_bytes,
        wal_bytes,
        retention_raw: format!("{}h", retention_raw().num_hours()),
        retention_rollup: format!("{}d", retention_rollup().num_days()),
        last_purge_minutes_ago,
        last_purge_error,
        process_rss_bytes: process_memory().0,
        process_peak_rss_bytes: process_memory().1,
    })
}

/// `retention` runs the hourly purge now; `all` empties every rollup table and
/// the collector heartbeats so the next window starts from nothing. Under the
/// same lock as ingest — a batch must not land between the count and the delete.
pub fn purge_collected(db: &Db, mode: &str) -> Result<PurgeOutcome, String> {
    if mode != "retention" && mode != "all" {
        return Err(format!("unknown purge mode '{mode}': use 'retention' or 'all'"));
    }
    let _serial = APPLY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let tables: Vec<&str> = TIERS.iter().map(|(table, _)| *table).chain(["collector_nodes"]).collect();
    let mut before = Vec::with_capacity(tables.len());
    for table in &tables {
        before.push(count_rows(db, table)?);
    }
    if mode == "all" {
        for table in &tables {
            db.exec(&format!("DELETE FROM {table};"))?;
        }
    } else {
        let outcome = purge(db);
        let mut state = PURGE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        record_purge(&mut state, std::time::Instant::now(), outcome.clone());
        drop(state);
        outcome?;
    }
    let mut deleted = Vec::with_capacity(tables.len());
    for (index, table) in tables.iter().enumerate() {
        let after = count_rows(db, table)?;
        deleted.push(PurgedTable { table: table.to_string(), rows: before[index].saturating_sub(after) });
    }
    Ok(PurgeOutcome { mode: mode.to_string(), deleted })
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
        // Streams the container's whole history for this tier — which is
        // why it must be a cursor fold and never a materialised query.
        let folder = db.fold(
            &format!(
                "SELECT cpu_hist, mem_hist, mem_max_bytes, samples, oom_kills, throttle_ratio, \
                 cpu_request_milli, mem_request_bytes, window_start, limited_data FROM {table} \
                 WHERE namespace = {} AND kind = {} AND workload = {} AND container = {} \
                 ORDER BY window_start;",
                sql_str(namespace)?,
                sql_str(kind)?,
                sql_str(workload)?,
                sql_str(container)?,
            ),
            UsageFolder::default(),
            |mut folder, row| {
                folder.push(|col| row.text(col));
                Ok(folder)
            },
        )?;
        if folder.rows == 0 {
            continue;
        }
        return Ok(Some(folder.finish()));
    }
    Ok(None)
}

pub fn list_containers(db: &Db) -> Result<Vec<(String, String, String, String)>, String> {
    let mut seen = std::collections::BTreeSet::new();
    for table in ["rs_rollup_5m", "rs_rollup_1h", "rs_rollup_1d"] {
        // No DISTINCT: the BTreeSet is the dedup, fed one row at a time so
        // the whole table never sits in memory as strings.
        seen = db.fold(
            &format!("SELECT namespace, kind, workload, container FROM {table};"),
            seen,
            |mut seen, row| {
                if let (Some(ns), Some(kind), Some(name), Some(ctr)) = (row.text(0), row.text(1), row.text(2), row.text(3)) {
                    seen.insert((ns.to_string(), kind.to_string(), name.to_string(), ctr.to_string()));
                }
                Ok(seen)
            },
        )?;
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

/// Accumulates one tier's history into a MergedUsage, one row at a time, in
/// `ORDER BY window_start` order. Columns: cpu_hist, mem_hist, mem_max_bytes,
/// samples, oom_kills, throttle_ratio, cpu_request_milli, mem_request_bytes,
/// window_start, limited_data.
#[derive(Default)]
struct UsageFolder {
    rows: usize,
    cpu: Histogram,
    mem: Histogram,
    memory_max: f64,
    samples: u64,
    oom_kills: i64,
    thr_sum: f64,
    thr_n: u64,
    cpu_request: Option<f64>,
    mem_request: Option<f64>,
    first_window: Option<String>,
    last_window: Option<String>,
    limited_data: bool,
}

impl UsageFolder {
    fn push<'a>(&mut self, cell: impl Fn(usize) -> Option<&'a str>) {
        self.rows += 1;
        self.cpu.merge(&parse_hist(cell(0).unwrap_or("[]")));
        self.mem.merge(&parse_hist(cell(1).unwrap_or("[]")));
        self.memory_max = self.memory_max.max(cell(2).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0));
        self.samples += cell(3).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        self.oom_kills += cell(4).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
        if let Some(t) = cell(5).and_then(|s| s.parse::<f64>().ok()) {
            self.thr_sum += t;
            self.thr_n += 1;
        }
        // Rows arrive oldest first; the last one with a value is what the
        // workload asked for most recently. Keeping the FIRST value — as this
        // once did — froze the screen on the original request forever.
        if let Some(v) = cell(6).and_then(|s| s.parse::<f64>().ok()) {
            self.cpu_request = Some(v);
        }
        if let Some(v) = cell(7).and_then(|s| s.parse::<f64>().ok()) {
            self.mem_request = Some(v);
        }
        if self.first_window.is_none() {
            self.first_window = cell(8).map(str::to_string);
        }
        self.last_window = cell(8).map(str::to_string);
        if cell(9) == Some("true") {
            self.limited_data = true;
        }
    }

    fn finish(self) -> MergedUsage {
        MergedUsage {
            cpu: self.cpu,
            memory: self.mem,
            memory_max: self.memory_max,
            samples: self.samples,
            oom_kills: self.oom_kills,
            throttle_ratio: if self.thr_n == 0 { None } else { Some(self.thr_sum / self.thr_n as f64) },
            cpu_request_milli: self.cpu_request,
            mem_request_bytes: self.mem_request,
            first_window: self.first_window,
            last_window: self.last_window,
            limited_data: self.limited_data,
        }
    }
}

#[cfg(test)]
fn fold_rows(rows: &[Vec<Option<String>>]) -> MergedUsage {
    let mut folder = UsageFolder::default();
    for row in rows {
        folder.push(|col| row.get(col).and_then(|v| v.as_deref()));
    }
    folder.finish()
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
    fn retention_runs_on_the_first_batch_then_hourly_and_retries_a_failure_in_five_minutes() {
        let t0 = std::time::Instant::now();
        let mut state = PurgeState::default();
        assert!(purge_due(state.next_due, t0), "nothing scheduled yet: run now");

        record_purge(&mut state, t0, Ok(()));
        assert!(state.last_error.is_none());
        assert!(!purge_due(state.next_due, t0 + std::time::Duration::from_secs(59 * 60)));
        assert!(purge_due(state.next_due, t0 + std::time::Duration::from_secs(61 * 60)));

        let t1 = t0 + std::time::Duration::from_secs(61 * 60);
        record_purge(&mut state, t1, Err("disk is full".into()));
        assert_eq!(state.last_error.as_deref(), Some("disk is full"), "the failure is kept, not swallowed");
        assert!(!purge_due(state.next_due, t1 + std::time::Duration::from_secs(4 * 60)));
        assert!(purge_due(state.next_due, t1 + std::time::Duration::from_secs(6 * 60)), "retry in five, not sixty");
    }

    /// `let _ = db.exec(DELETE …)` once hid every purge failure. Now the
    /// error comes back — proven by taking a table away.
    #[test]
    fn a_failing_purge_reports_instead_of_pretending() {
        let db = scratch_db("purge-fails");
        assert!(purge(&db).is_ok());
        db.exec("DROP TABLE rs_rollup_1d;").expect("drop");
        let error = purge(&db).expect_err("deleting from a missing table must fail");
        assert!(error.to_lowercase().contains("rs_rollup_1d"), "names the table: {error}");
    }

    /// A collector flushing days of buffer sends windows older than the raw
    /// retention. Compacting those would rebuild complete hourly rows from
    /// the few 5m rows the purge left. They are dropped, with the reason.
    #[test]
    fn a_batch_older_than_the_retention_floor_is_dropped_with_a_reason() {
        let db = scratch_db("stale-batch");
        let prepared = PreparedBatch {
            node: "node-a".into(),
            window_start: "2026-01-01T00:00:00+00:00".into(),
            rows: vec![(
                WorkloadKey { namespace: "shop".into(), kind: "Deployment".into(), name: "checkout".into() },
                IngestSample {
                    namespace: "shop".into(),
                    pod: "checkout-1".into(),
                    container: "api".into(),
                    cpu: Histogram::default(),
                    memory: Histogram::default(),
                    memory_max: 0.0,
                    samples: 1,
                    throttle_ratio: None,
                },
                ContainerRes { cpu_request: None, cpu_limit: None, mem_request: None, mem_limit: None, oom: false },
            )],
            skipped: 0,
        };
        let result = apply(&db, prepared).expect("apply answers, it does not fail");
        assert_eq!((result.accepted, result.skipped), (0, 1));
        assert!(result.skip_reason.as_deref().unwrap_or("").contains("older than TMJLENS_RETENTION_RAW"));
        assert_eq!(count_rows(&db, "rs_rollup_5m").unwrap(), 0, "nothing was written");
        assert_eq!(count_rows(&db, "collector_nodes").unwrap(), 0, "a dropped batch is not a heartbeat");
    }

    #[test]
    fn the_pod_list_is_scoped_to_the_collectors_node() {
        let params = node_scope("ip-10-42-7-11.sa-east-1.compute.internal");
        assert_eq!(params.field_selector.as_deref(), Some("spec.nodeName=ip-10-42-7-11.sa-east-1.compute.internal"));
        assert!(params.label_selector.is_none());
    }

    #[test]
    fn process_memory_is_read_from_proc_status_or_honestly_absent() {
        let text = "Name:\ttmjlens\nVmPeak:\t 3000000 kB\nVmSize:\t 2500000 kB\nVmHWM:\t 2191360 kB\nVmRSS:\t 2165760 kB\nThreads:\t3\n";
        assert_eq!(parse_proc_status(text), (Some(2165760 * 1024), Some(2191360 * 1024)));
        assert_eq!(parse_proc_status("Name:\tx\n"), (None, None), "missing lines are None, never zero");
    }

    #[test]
    fn the_retention_floor_is_a_whole_hour_in_the_fixed_stamp() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-15T17:42:09.5+00:00").unwrap().with_timezone(&chrono::Utc);
        let floor = raw_retention_floor(now);
        assert_eq!(stamp(floor), "2026-10-13T17:00:00+00:00", "48h back, minutes and seconds zeroed");
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
        compact_into(&db, "rs_rollup_5m", "rs_rollup_1h", &owner, "app",
            "2026-09-29T10:00:00+00:00", "2026-09-29T11:00:00+00:00")
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

    fn scratch_db(tag: &str) -> crate::db::Db {
        let dir = std::env::temp_dir().join("tmjlens-db-tests");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join(format!(
            "ingest-{tag}-{}-{}.tmjp",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        crate::db::Db::open(&path).expect("open")
    }

    fn seed_5m(db: &crate::db::Db, window: &str, samples: u32) {
        db.exec(&format!(
            "INSERT INTO rs_rollup_5m (namespace, kind, workload, container, window_start, cpu_hist, mem_hist, \
             samples, oom_kills, cpu_request_milli) VALUES ('payments', 'Deployment', 'checkout-api', 'app', \
             '{window}', '[]', '[]', {samples}, 0, '250');"
        ))
        .expect("seed");
    }

    /// Production OOM: compaction read the container's WHOLE history to
    /// rebuild one hour. The query must be bounded to the window — this test
    /// seeds three hours and expects the hour to see only its own rows.
    #[test]
    fn compaction_reads_only_the_window_it_rebuilds() {
        let db = scratch_db("bounded");
        seed_5m(&db, "2026-10-14T09:55:00+00:00", 100);
        seed_5m(&db, "2026-10-14T10:00:00+00:00", 1);
        seed_5m(&db, "2026-10-14T10:55:00+00:00", 2);
        seed_5m(&db, "2026-10-14T11:00:00+00:00", 100);
        let owner = WorkloadKey {
            namespace: "payments".into(),
            kind: "Deployment".into(),
            name: "checkout-api".into(),
        };
        merge_up(&db, &owner, "app", "2026-10-14T10:35:00+00:00").expect("merge");
        let hours = db.query("SELECT window_start, samples FROM rs_rollup_1h;").expect("query");
        assert_eq!(hours.rows.len(), 1, "one hour rebuilt: {:?}", hours.rows);
        assert_eq!(hours.rows[0][0].as_deref(), Some("2026-10-14T10:00:00+00:00"));
        assert_eq!(hours.rows[0][1].as_deref(), Some("3"), "09:55 and 11:00 must not leak in");
        let days = db.query("SELECT window_start, samples FROM rs_rollup_1d;").expect("query");
        assert_eq!(days.rows.len(), 1);
        assert_eq!(days.rows[0][0].as_deref(), Some("2026-10-14T00:00:00+00:00"));
        assert_eq!(days.rows[0][1].as_deref(), Some("3"), "the day is built from the 1h rows, not the 5m ones");
    }

    #[test]
    fn batch_windows_are_floored_to_their_five_minute_bucket() {
        assert_eq!(align_5m("2026-10-14T17:09:12.123456789+00:00"), "2026-10-14T17:05:00+00:00");
        assert_eq!(align_5m("2026-10-14T17:09:12Z"), "2026-10-14T17:05:00+00:00", "Z is normalised to +00:00");
        assert_eq!(align_5m("2026-10-14T14:09:12-03:00"), "2026-10-14T17:05:00+00:00", "offsets land in UTC");
        assert_eq!(align_5m("2026-10-14T17:00:00+00:00"), "2026-10-14T17:00:00+00:00");
        assert_eq!(align_5m("not a stamp"), "not a stamp", "garbage passes through for the engine to reject");
    }

    #[test]
    fn collected_data_counts_each_tier_and_purge_all_empties_them() {
        let db = scratch_db("collected");
        seed_5m(&db, "2026-10-12T00:00:00+00:00", 1);
        seed_5m(&db, "2026-10-14T17:05:00+00:00", 1);
        touch_node(&db, "node-a").expect("node");
        let data = collected_data(&db).expect("collected");
        let five = &data.tables[0];
        assert_eq!((five.table.as_str(), five.rows), ("rs_rollup_5m", 2));
        assert_eq!(five.oldest.as_deref(), Some("2026-10-12T00:00:00+00:00"));
        assert_eq!(five.newest.as_deref(), Some("2026-10-14T17:05:00+00:00"));
        let hour = &data.tables[1];
        assert_eq!((hour.rows, hour.oldest.clone(), hour.newest.clone()), (0, None, None), "empty is None, never a fake stamp");
        assert_eq!(data.collector_nodes, 1);
        assert_eq!(data.retention_raw, "48h");

        assert!(purge_collected(&db, "everything").is_err(), "unknown modes are refused");
        let outcome = purge_collected(&db, "all").expect("purge");
        let by_table: Vec<(&str, u64)> = outcome.deleted.iter().map(|d| (d.table.as_str(), d.rows)).collect();
        assert_eq!(by_table, [("rs_rollup_5m", 2), ("rs_rollup_1h", 0), ("rs_rollup_1d", 0), ("collector_nodes", 1)]);
        let after = collected_data(&db).expect("collected");
        assert_eq!(after.tables[0].rows, 0);
        assert_eq!(after.collector_nodes, 0);
    }

    #[test]
    fn folding_history_keeps_the_newest_request() {
        let row = |window: &str, cpu: &str, mem: &str| -> Vec<Option<String>> {
            vec![
                Some("[]".into()), Some("[]".into()), Some("0".into()), Some("1".into()), Some("0".into()),
                None, Some(cpu.into()), Some(mem.into()), Some(window.into()), Some("false".into()),
            ]
        };
        let usage = fold_rows(&[
            row("2026-10-07T10:00:00+00:00", "500", "1073741824"),
            row("2026-10-07T10:05:00+00:00", "250", "536870912"),
        ]);
        assert_eq!(usage.cpu_request_milli, Some(250.0), "the request was lowered at 10:05");
        assert_eq!(usage.mem_request_bytes, Some(536870912.0));
        assert_eq!(usage.first_window.as_deref(), Some("2026-10-07T10:00:00+00:00"));
        assert_eq!(usage.last_window.as_deref(), Some("2026-10-07T10:05:00+00:00"));
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
