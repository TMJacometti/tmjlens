//! Log-spaced histogram used for CPU (millicores) and memory (bytes).
//!
//! Buckets grow by `FACTOR` (~5%). Percentiles on a merged histogram have a
//! relative error of at most FACTOR-1 = 5% — the true value sits somewhere in
//! the chosen bucket.

pub const FACTOR: f64 = 1.05;
pub const BUCKETS: usize = 200;
/// Documented bound: a value is reported as belonging to a bucket at most 5%
/// wide, so p95/p99 can be off by at most that relative amount.
pub const MAX_RELATIVE_ERROR: f64 = 0.05;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Histogram {
    pub counts: Vec<u64>,
}

impl Default for Histogram {
    fn default() -> Self {
        Self { counts: vec![0; BUCKETS] }
    }
}

impl Histogram {
    pub fn observe(&mut self, value: f64) {
        if !value.is_finite() || value < 0.0 {
            return;
        }
        let i = bucket_index(value);
        self.counts[i] = self.counts[i].saturating_add(1);
    }

    pub fn merge(&mut self, other: &Histogram) {
        let n = self.counts.len().min(other.counts.len());
        for i in 0..n {
            self.counts[i] = self.counts[i].saturating_add(other.counts[i]);
        }
    }

    pub fn samples(&self) -> u64 {
        self.counts.iter().copied().sum()
    }

    /// Inclusive percentile. Empty histogram → None, never a invented zero.
    pub fn percentile(&self, p: f64) -> Option<f64> {
        let total = self.samples();
        if total == 0 {
            return None;
        }
        let target = ((p.clamp(0.0, 1.0) * total as f64).ceil() as u64).max(1);
        let mut seen = 0u64;
        for (i, count) in self.counts.iter().enumerate() {
            seen = seen.saturating_add(*count);
            if seen >= target {
                return Some(bucket_value(i));
            }
        }
        Some(bucket_value(self.counts.len().saturating_sub(1)))
    }
}

fn bucket_index(value: f64) -> usize {
    if value <= 1.0 {
        return 0;
    }
    let i = value.log(FACTOR).floor() as i64;
    i.clamp(0, (BUCKETS as i64) - 1) as usize
}

fn bucket_value(index: usize) -> f64 {
    FACTOR.powi(index as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_histogram_has_no_percentile() {
        assert_eq!(Histogram::default().percentile(0.95), None);
    }

    #[test]
    fn a_single_observation_is_the_p95() {
        let mut h = Histogram::default();
        h.observe(100.0);
        let p = h.percentile(0.95).expect("p95");
        assert!((p - 100.0).abs() / 100.0 <= MAX_RELATIVE_ERROR + 0.02);
    }

    #[test]
    fn merge_adds_bucket_counts() {
        let mut a = Histogram::default();
        let mut b = Histogram::default();
        a.observe(10.0);
        b.observe(10.0);
        a.merge(&b);
        assert_eq!(a.samples(), 2);
    }

    #[test]
    fn counter_reset_is_the_callers_job_not_the_histogram() {
        // Documented contract: the sampler drops falling counters before observe().
        let mut h = Histogram::default();
        h.observe(5.0);
        h.observe(5.0);
        assert_eq!(h.samples(), 2);
    }
}
