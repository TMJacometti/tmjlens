//! Request vs usage, waste, and explainable recommendations. Admin-only
//! at the HTTP gate; this module never invents a zero for a missing series.

use crate::db::Db;
use crate::histogram::Histogram;
use crate::ingest::{list_containers, merged_usage, MergedUsage};
use crate::pricing;
use serde::Serialize;

const CPU_HEADROOM: f64 = 0.10;
const MEM_HEADROOM: f64 = 0.20;
const THROTTLE_NO_REDUCE: f64 = 0.05;

#[derive(Serialize, Clone)]
pub struct WorkloadRow {
    pub namespace: String,
    pub kind: String,
    pub name: String,
    pub container: String,
    pub cpu_request_milli: Option<f64>,
    pub cpu_p95_milli: Option<f64>,
    pub mem_request_bytes: Option<f64>,
    pub mem_max_bytes: Option<f64>,
    pub cpu_waste_milli: Option<f64>,
    pub mem_waste_bytes: Option<f64>,
    pub waste_usd_month: Option<f64>,
    pub confidence: String,
    pub days_of_data: f64,
    pub limited_data: bool,
    pub oom_kills: i64,
    pub throttle_ratio: Option<f64>,
    pub recommended_cpu_milli: Option<f64>,
    pub recommended_mem_bytes: Option<f64>,
}

#[derive(Serialize)]
pub struct WorkloadDetail {
    pub row: WorkloadRow,
    pub recommendation: Recommendation,
    pub notice: String,
}

#[derive(Serialize, Clone)]
pub struct Recommendation {
    pub cpu_request_milli: Option<f64>,
    pub mem_request_bytes: Option<f64>,
    pub confidence: String,
    pub days_of_data: f64,
    pub reason: String,
    pub would_reduce_cpu: bool,
    pub would_reduce_mem: bool,
}

pub async fn list_workloads(db: &Db) -> Result<Vec<WorkloadRow>, String> {
    let keys = list_containers(db)?;
    let price = pricing::unit_prices().await;
    let mut out = Vec::with_capacity(keys.len());
    for (ns, kind, name, container) in keys {
        if let Some(row) = row_for(db, &ns, &kind, &name, &container, price.as_ref())? {
            out.push(row);
        }
    }
    out.sort_by(|a, b| {
        b.cpu_waste_milli
            .unwrap_or(0.0)
            .partial_cmp(&a.cpu_waste_milli.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

pub async fn workload_detail(
    db: &Db,
    namespace: &str,
    kind: &str,
    name: &str,
    container: Option<&str>,
) -> Result<WorkloadDetail, String> {
    let keys = list_containers(db)?;
    let container = match container {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => keys
            .iter()
            .find(|(ns, k, n, _)| ns == namespace && k == kind && n == name)
            .map(|t| t.3.clone())
            .ok_or_else(|| format!("no rightsizing data for {kind}/{name} in {namespace}"))?,
    };
    let price = pricing::unit_prices().await;
    let row = row_for(db, namespace, kind, name, &container, price.as_ref())?
        .ok_or_else(|| format!("no rightsizing data for {kind}/{name}/{container}"))?;
    let usage = merged_usage(db, namespace, kind, name, &container)?
        .ok_or_else(|| "usage could not be collected for this container".to_string())?;
    let recommendation = recommend(&usage, kind);
    Ok(WorkloadDetail {
        row,
        recommendation,
        notice: "Reducing requests only lowers the bill if the node autoscaler consolidates nodes. \
                 Requests that shrink on a still-full node do not change the invoice."
            .into(),
    })
}

fn row_for(
    db: &Db,
    namespace: &str,
    kind: &str,
    name: &str,
    container: &str,
    price: Option<&pricing::UnitPrices>,
) -> Result<Option<WorkloadRow>, String> {
    let Some(usage) = merged_usage(db, namespace, kind, name, container)? else {
        return Ok(None);
    };
    let rec = recommend(&usage, kind);
    let cpu_p95 = usage.cpu.percentile(0.95);
    let cpu_waste = match (usage.cpu_request_milli, rec.cpu_request_milli) {
        (Some(req), Some(want)) if req > want => Some(req - want),
        _ => None,
    };
    let mem_waste = match (usage.mem_request_bytes, rec.mem_request_bytes) {
        (Some(req), Some(want)) if req > want => Some(req - want),
        _ => None,
    };
    let waste_usd_month = match price {
        Some(p) => {
            let cpu = cpu_waste.unwrap_or(0.0) / 1000.0 * p.usd_per_vcpu_hour * 730.0;
            let mem = mem_waste.unwrap_or(0.0) / (1024.0 * 1024.0 * 1024.0) * p.usd_per_gib_hour * 730.0;
            if cpu + mem > 0.0 { Some(cpu + mem) } else { None }
        }
        None => None,
    };
    Ok(Some(WorkloadRow {
        namespace: namespace.into(),
        kind: kind.into(),
        name: name.into(),
        container: container.into(),
        cpu_request_milli: usage.cpu_request_milli,
        cpu_p95_milli: cpu_p95,
        mem_request_bytes: usage.mem_request_bytes,
        mem_max_bytes: if usage.memory_max > 0.0 { Some(usage.memory_max) } else { None },
        cpu_waste_milli: cpu_waste,
        mem_waste_bytes: mem_waste,
        waste_usd_month,
        confidence: rec.confidence.clone(),
        days_of_data: rec.days_of_data,
        limited_data: usage.limited_data,
        oom_kills: usage.oom_kills,
        throttle_ratio: usage.throttle_ratio,
        recommended_cpu_milli: rec.cpu_request_milli,
        recommended_mem_bytes: rec.mem_request_bytes,
    }))
}

pub fn recommend(usage: &MergedUsage, kind: &str) -> Recommendation {
    let days = days_of_data(usage);
    let confidence = if kind == "Job" || kind == "CronJob" {
        "none".into()
    } else if days < 3.0 {
        "low".into()
    } else if days < 7.0 {
        "medium".into()
    } else {
        "high".into()
    };

    if kind == "Job" || kind == "CronJob" {
        return Recommendation {
            cpu_request_milli: None,
            mem_request_bytes: None,
            confidence,
            days_of_data: days,
            reason: "Jobs and CronJobs are ephemeral; tmjLens does not recommend requests for them.".into(),
            would_reduce_cpu: false,
            would_reduce_mem: false,
        };
    }

    let cpu_p95 = usage.cpu.percentile(0.95);
    let mut reasons = Vec::new();
    let cpu_want = cpu_p95.map(|p| (p * (1.0 + CPU_HEADROOM)).max(1.0));
    if let Some(p95) = cpu_p95 {
        reasons.push(format!(
            "CPU request ≈ p95 ({:.0}m) + {:.0}% headroom.",
            p95,
            CPU_HEADROOM * 100.0
        ));
    } else {
        reasons.push("CPU histogram is empty, so there is no CPU recommendation.".into());
    }
    if usage.throttle_ratio.unwrap_or(0.0) >= THROTTLE_NO_REDUCE {
        reasons.push(format!(
            "CFS throttling is {:.1}% of periods — CPU will not be recommended down.",
            usage.throttle_ratio.unwrap_or(0.0) * 100.0
        ));
    }

    let mem_want = if usage.memory_max > 0.0 {
        Some((usage.memory_max * (1.0 + MEM_HEADROOM)).max(1.0))
    } else {
        None
    };
    if usage.memory_max > 0.0 {
        reasons.push(format!(
            "Memory request ≈ peak working set ({:.0} bytes) + {:.0}% headroom. Mean is not used.",
            usage.memory_max,
            MEM_HEADROOM * 100.0
        ));
    } else {
        reasons.push("No memory samples, so there is no memory recommendation.".into());
    }
    if usage.oom_kills > 0 {
        reasons.push(format!(
            "{} OOMKill(s) in the window — memory will not be recommended down.",
            usage.oom_kills
        ));
    }
    reasons.push(format!(
        "{:.1} day(s) of data; confidence is {confidence}.",
        days
    ));

    let would_reduce_cpu = match (usage.cpu_request_milli, cpu_want) {
        (Some(req), Some(want)) => want < req && usage.throttle_ratio.unwrap_or(0.0) < THROTTLE_NO_REDUCE,
        _ => false,
    };
    let cpu_final = match (usage.cpu_request_milli, cpu_want) {
        (Some(req), Some(want)) if !would_reduce_cpu && want < req => Some(req),
        (_, want) => want,
    };
    let would_reduce_mem = match (usage.mem_request_bytes, mem_want) {
        (Some(req), Some(want)) => want < req && usage.oom_kills == 0,
        _ => false,
    };
    let mem_final = match (usage.mem_request_bytes, mem_want) {
        (Some(req), Some(want)) if !would_reduce_mem && want < req => Some(req),
        (_, want) => want,
    };

    Recommendation {
        cpu_request_milli: cpu_final,
        mem_request_bytes: mem_final,
        confidence,
        days_of_data: days,
        reason: reasons.join(" "),
        would_reduce_cpu,
        would_reduce_mem,
    }
}

fn days_of_data(usage: &MergedUsage) -> f64 {
    let (Some(first), Some(last)) = (&usage.first_window, &usage.last_window) else {
        return 0.0;
    };
    let parse = |s: &str| {
        chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|t| t.with_timezone(&chrono::Utc))
    };
    match (parse(first), parse(last)) {
        (Some(a), Some(b)) => ((b - a).num_seconds().max(0) as f64) / 86_400.0,
        _ => 0.0,
    }
}

/// Suggested HPA numbers from the same history. CPU target is p95 as a
/// percentage of the current request; max replicas is observed peak with
/// headroom, capped by the install ceiling.
pub fn hpa_suggestion(usage: &MergedUsage, current_replicas: i32, ceiling: i32) -> HpaSuggestion {
    let cpu_p95 = usage.cpu.percentile(0.95);
    let target = match (cpu_p95, usage.cpu_request_milli) {
        (Some(p95), Some(req)) if req > 0.0 => ((p95 / req) * 100.0).clamp(20.0, 90.0).round() as i32,
        _ => 70,
    };
    let max = (current_replicas * 2).clamp(current_replicas.max(1), ceiling.max(1));
    let min = 1.max(current_replicas / 2);
    HpaSuggestion {
        min_replicas: min,
        max_replicas: max,
        target_cpu_utilization: target,
        reason: format!(
            "Target CPU utilisation is p95 relative to the current request ({}). \
             maxReplicas is twice the current count, capped at {ceiling}.",
            cpu_p95.map(|v| format!("{v:.0}m")).unwrap_or_else(|| "unknown".into())
        ),
    }
}

#[derive(Serialize)]
pub struct HpaSuggestion {
    pub min_replicas: i32,
    pub max_replicas: i32,
    pub target_cpu_utilization: i32,
    pub reason: String,
}

pub fn empty_usage() -> MergedUsage {
    MergedUsage {
        cpu: Histogram::default(),
        memory: Histogram::default(),
        memory_max: 0.0,
        samples: 0,
        oom_kills: 0,
        throttle_ratio: None,
        cpu_request_milli: None,
        mem_request_bytes: None,
        first_window: None,
        last_window: None,
        limited_data: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(cpu: &[f64], mem_max: f64, req_cpu: Option<f64>, req_mem: Option<f64>) -> MergedUsage {
        let mut u = empty_usage();
        for v in cpu {
            u.cpu.observe(*v);
        }
        u.memory_max = mem_max;
        u.cpu_request_milli = req_cpu;
        u.mem_request_bytes = req_mem;
        u.first_window = Some("2026-09-01T00:00:00+00:00".into());
        u.last_window = Some("2026-09-10T00:00:00+00:00".into());
        u
    }

    #[test]
    fn oomkill_blocks_a_memory_reduction() {
        let mut u = usage(&[100.0], 100.0, Some(1000.0), Some(1000.0));
        u.oom_kills = 1;
        u.memory_max = 100.0;
        let rec = recommend(&u, "Deployment");
        assert!(!rec.would_reduce_mem, "OOM must pin memory");
        assert_eq!(rec.mem_request_bytes, Some(1000.0));
        assert!(rec.reason.contains("OOMKill"));
    }

    #[test]
    fn throttling_blocks_a_cpu_reduction() {
        let mut u = usage(&[50.0], 100.0, Some(500.0), Some(1000.0));
        u.throttle_ratio = Some(0.2);
        let rec = recommend(&u, "Deployment");
        assert!(!rec.would_reduce_cpu);
        assert!(rec.reason.contains("throttl"));
    }

    #[test]
    fn cold_start_is_low_confidence() {
        let mut u = usage(&[80.0], 200.0, Some(200.0), Some(400.0));
        u.last_window = u.first_window.clone();
        let rec = recommend(&u, "Deployment");
        assert_eq!(rec.confidence, "low");
    }

    #[test]
    fn jobs_get_no_recommendation() {
        let u = usage(&[80.0], 200.0, Some(200.0), Some(400.0));
        let rec = recommend(&u, "Job");
        assert_eq!(rec.confidence, "none");
        assert!(rec.cpu_request_milli.is_none());
    }

    #[test]
    fn empty_histogram_is_not_a_zero() {
        let rec = recommend(&empty_usage(), "Deployment");
        assert!(rec.cpu_request_milli.is_none());
        assert!(rec.reason.contains("empty"));
    }
}
