//! Kyverno: the policies that judge this cluster, and the verdicts.
//!
//! Two sources, deliberately joined: the policies themselves (kyverno.io) say
//! what SHOULD hold and whether it is enforced or merely audited, and the
//! policy reports (wgpolicyk8s.io) say what actually FAILS. A policy screen
//! without the verdicts is a rules listing; the join is what tells an operator
//! "this rule is on, and these twelve resources violate it anyway".

use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::core::{ApiResource, DynamicObject, GroupVersionKind};
use kube::Client;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::format_age;

/// Reports can carry one result row per resource per rule; on a big cluster
/// that is tens of thousands. The screen keeps the worst slice and says so.
const VIOLATION_CAP: usize = 400;

fn policy_resource(kind: &str) -> ApiResource {
    ApiResource::from_gvk(&GroupVersionKind::gvk("kyverno.io", "v1", kind))
}

fn report_resource(kind: &str) -> ApiResource {
    ApiResource::from_gvk(&GroupVersionKind::gvk("wgpolicyk8s.io", "v1alpha2", kind))
}

#[derive(Serialize, Clone)]
pub struct PolicyRow {
    pub name: String,
    /// None for a ClusterPolicy — the badge the frontend renders hangs on this.
    pub namespace: Option<String>,
    /// "Enforce" blocks admission; "Audit" only reports. Kyverno's default is
    /// Audit, which surprises people who think writing a policy protects them.
    pub action: String,
    pub background: bool,
    /// Which of validate / mutate / generate / verifyImages the rules use.
    pub rule_kinds: Vec<String>,
    pub rules: usize,
    pub ready: bool,
    pub message: Option<String>,
    /// Failing results attributed to this policy across every report.
    pub fail_count: usize,
    pub health: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct ViolationRow {
    pub policy: String,
    pub rule: String,
    /// fail | warn | error — passes and skips are counted, not listed.
    pub result: String,
    pub severity: Option<String>,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub message: String,
}

#[derive(Serialize, Clone)]
pub struct KyvernoFinding {
    pub severity: String,
    pub title: String,
    pub targets: Vec<String>,
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct KyvernoOverview {
    pub installed: bool,
    pub reason: Option<String>,
    pub policies: Vec<PolicyRow>,
    pub violations: Vec<ViolationRow>,
    pub pass: u64,
    pub fail: u64,
    pub warn: u64,
    pub violations_capped: bool,
    pub findings: Vec<KyvernoFinding>,
    pub degraded_collectors: Vec<String>,
}

fn str_at(data: &Value, pointer: &str) -> Option<String> {
    data.pointer(pointer).and_then(Value::as_str).map(str::to_string)
}

/// One policy object — ClusterPolicy or Policy — to a row. Everything read
/// here has a stated default, because a half-written policy must still render.
fn policy_row(object: &DynamicObject, fail_counts: &HashMap<String, usize>) -> PolicyRow {
    let name = object.metadata.name.clone().unwrap_or_default();
    let namespace = object.metadata.namespace.clone();
    let data = &object.data;

    // Kyverno admits Audit when nothing is stated.
    let action = str_at(data, "/spec/validationFailureAction").unwrap_or_else(|| "Audit".to_string());
    let background = data
        .pointer("/spec/background")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let empty = Vec::new();
    let rules = data.pointer("/spec/rules").and_then(Value::as_array).unwrap_or(&empty);
    let mut rule_kinds: Vec<String> = Vec::new();
    for rule in rules {
        for (key, label) in [
            ("validate", "validate"),
            ("mutate", "mutate"),
            ("generate", "generate"),
            ("verifyImages", "verifyImages"),
        ] {
            if rule.get(key).is_some() && !rule_kinds.iter().any(|k| k == label) {
                rule_kinds.push(label.to_string());
            }
        }
    }

    let mut ready = false;
    let mut message = None;
    if let Some(conditions) = data.pointer("/status/conditions").and_then(Value::as_array) {
        for condition in conditions {
            if condition.get("type").and_then(Value::as_str) == Some("Ready") {
                ready = condition.get("status").and_then(Value::as_str) == Some("True");
                message = condition
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|m| !m.is_empty() && !ready)
                    .map(str::to_string);
            }
        }
    }

    let fail_count = fail_counts.get(&name).copied().unwrap_or(0);

    // Not ready outranks everything: the policy may not be doing its job at
    // all. An Audit policy with failures reports and blocks nothing — worse
    // than an Enforce one with failures, where at least new violations bounce.
    let health = if !ready {
        "critical"
    } else if fail_count > 0 && action == "Audit" {
        "serious"
    } else if fail_count > 0 {
        "warning"
    } else {
        "good"
    };

    let age = object
        .metadata
        .creation_timestamp
        .as_ref()
        .map(|stamp| format_age(stamp.0))
        .unwrap_or_else(|| "n/a".to_string());

    PolicyRow {
        name,
        namespace,
        action,
        background,
        rule_kinds,
        rules: rules.len(),
        ready,
        message,
        fail_count,
        health: health.to_string(),
        age,
    }
}

/// Pulls the failing results out of one report. Passes and skips only feed
/// the totals — a list of ten thousand "pass" rows helps nobody.
fn collect_violations(object: &DynamicObject, out: &mut Vec<ViolationRow>, totals: &mut (u64, u64, u64)) {
    let data = &object.data;
    if let Some(summary) = data.pointer("/summary") {
        totals.0 += summary.get("pass").and_then(Value::as_u64).unwrap_or(0);
        totals.1 += summary.get("fail").and_then(Value::as_u64).unwrap_or(0);
        totals.2 += summary.get("warn").and_then(Value::as_u64).unwrap_or(0);
    }
    let Some(results) = data.pointer("/results").and_then(Value::as_array) else {
        return;
    };
    for result in results {
        let verdict = result.get("result").and_then(Value::as_str).unwrap_or("");
        if !matches!(verdict, "fail" | "warn" | "error") {
            continue;
        }
        let policy = result.get("policy").and_then(Value::as_str).unwrap_or("").to_string();
        let rule = result.get("rule").and_then(Value::as_str).unwrap_or("").to_string();
        let severity = result.get("severity").and_then(Value::as_str).map(str::to_string);
        let message = result.get("message").and_then(Value::as_str).unwrap_or("").to_string();
        let resources = result.get("resources").and_then(Value::as_array);
        let rows: Vec<(String, Option<String>, String)> = match resources {
            Some(resources) if !resources.is_empty() => resources
                .iter()
                .map(|resource| {
                    (
                        resource.get("kind").and_then(Value::as_str).unwrap_or("?").to_string(),
                        resource.get("namespace").and_then(Value::as_str).map(str::to_string),
                        resource.get("name").and_then(Value::as_str).unwrap_or("?").to_string(),
                    )
                })
                .collect(),
            // A report scoped to one object may carry no resources array; the
            // report's own scope (its owner) is that object, rendered as such.
            _ => vec![("?".to_string(), object.metadata.namespace.clone(), "?".to_string())],
        };
        for (kind, namespace, name) in rows {
            out.push(ViolationRow {
                policy: policy.clone(),
                rule: rule.clone(),
                result: verdict.to_string(),
                severity: severity.clone(),
                kind,
                namespace,
                name,
                message: message.clone(),
            });
        }
    }
}

fn result_rank(result: &str) -> u8 {
    match result {
        "fail" => 0,
        "error" => 1,
        _ => 2,
    }
}

fn build_findings(policies: &[PolicyRow]) -> Vec<KyvernoFinding> {
    let mut findings = Vec::new();

    let not_ready: Vec<&PolicyRow> = policies.iter().filter(|p| !p.ready).collect();
    if !not_ready.is_empty() {
        findings.push(KyvernoFinding {
            severity: "critical".to_string(),
            title: "Policies are not ready".to_string(),
            targets: not_ready.iter().map(|p| p.name.clone()).collect(),
            detail: not_ready
                .first()
                .and_then(|p| p.message.clone())
                .unwrap_or_else(|| {
                    "Kyverno has not accepted these policies, so their rules are not being applied.".to_string()
                }),
        });
    }

    let audit_failing: Vec<&PolicyRow> =
        policies.iter().filter(|p| p.ready && p.action == "Audit" && p.fail_count > 0).collect();
    if !audit_failing.is_empty() {
        findings.push(KyvernoFinding {
            severity: "serious".to_string(),
            title: "Reporting, not blocking".to_string(),
            targets: audit_failing.iter().map(|p| p.name.clone()).collect(),
            detail: format!(
                "These policies are in Audit mode with failing resources — the same violations keep \
                 being admitted. Switching to Enforce blocks new ones ({} failure(s) recorded).",
                audit_failing.iter().map(|p| p.fail_count).sum::<usize>()
            ),
        });
    }

    let enforce_failing: Vec<&PolicyRow> =
        policies.iter().filter(|p| p.ready && p.action == "Enforce" && p.fail_count > 0).collect();
    if !enforce_failing.is_empty() {
        findings.push(KyvernoFinding {
            severity: "warning".to_string(),
            title: "Existing violations under Enforce".to_string(),
            targets: enforce_failing.iter().map(|p| p.name.clone()).collect(),
            detail: "Enforce blocks new admissions, but these resources were already in the cluster \
                     and still violate — they stay until someone fixes or replaces them."
                .to_string(),
        });
    }

    findings
}

pub async fn overview(client: Client) -> Result<KyvernoOverview, String> {
    let params = ListParams::default();
    let mut degraded = Vec::new();

    let cluster_api: Api<DynamicObject> = Api::all_with(client.clone(), &policy_resource("ClusterPolicy"));
    let cluster_policies = match cluster_api.list(&params).await {
        Ok(list) => list.items,
        Err(kube::Error::Api(response)) if response.code == 404 => {
            return Ok(KyvernoOverview {
                installed: false,
                reason: Some(
                    "Kyverno is not installed in this cluster, or its custom resources are absent \
                     — no ClusterPolicy definition was found."
                        .to_string(),
                ),
                policies: Vec::new(),
                violations: Vec::new(),
                pass: 0,
                fail: 0,
                warn: 0,
                violations_capped: false,
                findings: Vec::new(),
                degraded_collectors: Vec::new(),
            });
        }
        Err(error) => return Err(crate::errors::humanize(&error.to_string())),
    };

    let namespaced_api: Api<DynamicObject> = Api::all_with(client.clone(), &policy_resource("Policy"));
    let namespaced_policies = match namespaced_api.list(&params).await {
        Ok(list) => list.items,
        Err(error) => {
            degraded.push(format!("Namespaced Policies could not be listed ({error})."));
            Vec::new()
        }
    };

    let mut violations: Vec<ViolationRow> = Vec::new();
    let mut totals = (0u64, 0u64, 0u64);
    for kind in ["PolicyReport", "ClusterPolicyReport"] {
        let api: Api<DynamicObject> = Api::all_with(client.clone(), &report_resource(kind));
        match api.list(&params).await {
            Ok(list) => {
                for report in &list.items {
                    collect_violations(report, &mut violations, &mut totals);
                }
            }
            Err(kube::Error::Api(response)) if response.code == 404 => degraded.push(format!(
                "{kind} is not served here, so verdicts from that scope are missing — \
                 policy reporting may be disabled in this Kyverno install."
            )),
            Err(error) => degraded.push(format!("{kind} could not be listed ({error}).")),
        }
    }

    // Worst first, then a stable order inside each band.
    violations.sort_by(|a, b| {
        result_rank(&a.result)
            .cmp(&result_rank(&b.result))
            .then_with(|| a.policy.cmp(&b.policy))
            .then_with(|| a.name.cmp(&b.name))
    });
    let violations_capped = violations.len() > VIOLATION_CAP;
    violations.truncate(VIOLATION_CAP);

    let mut fail_counts: HashMap<String, usize> = HashMap::new();
    for violation in &violations {
        if violation.result == "fail" {
            *fail_counts.entry(violation.policy.clone()).or_default() += 1;
        }
    }

    let mut policies: Vec<PolicyRow> = cluster_policies
        .iter()
        .chain(namespaced_policies.iter())
        .map(|object| policy_row(object, &fail_counts))
        .collect();
    policies.sort_by(|a, b| {
        a.ready
            .cmp(&b.ready)
            .then_with(|| b.fail_count.cmp(&a.fail_count))
            .then_with(|| a.name.cmp(&b.name))
    });

    let findings = build_findings(&policies);

    Ok(KyvernoOverview {
        installed: true,
        reason: None,
        policies,
        violations,
        pass: totals.0,
        fail: totals.1,
        warn: totals.2,
        violations_capped,
        findings,
        degraded_collectors: degraded,
    })
}

/// Enforce ⇄ Audit, compare-and-set: the caller states what it believes the
/// current mode is, and a policy that changed underneath is refused with both
/// values named — never silently overwritten.
pub async fn set_policy_action(
    client: Client,
    namespace: Option<String>,
    name: &str,
    expected: &str,
    action: &str,
) -> Result<String, String> {
    for value in [expected, action] {
        if !matches!(value, "Enforce" | "Audit") {
            return Err(format!("'{value}' is not a Kyverno mode — Enforce or Audit"));
        }
    }
    if expected == action {
        return Err(format!("{name} is already {action}; nothing to change"));
    }

    let api: Api<DynamicObject> = match namespace.as_deref() {
        Some(namespace) => Api::namespaced_with(client, namespace, &policy_resource("Policy")),
        None => Api::all_with(client, &policy_resource("ClusterPolicy")),
    };
    let current = api.get(name).await.map_err(|e| crate::errors::humanize(&e.to_string()))?;
    let now = str_at(&current.data, "/spec/validationFailureAction").unwrap_or_else(|| "Audit".to_string());
    if now != expected {
        return Err(format!(
            "{name} changed underneath: expected {expected}, found {now}. Reload and decide again."
        ));
    }

    let patch = Patch::Merge(json!({ "spec": { "validationFailureAction": action } }));
    let patch_params = PatchParams {
        field_manager: Some("tmjlens".to_string()),
        ..Default::default()
    };
    api.patch(name, &patch_params, &patch)
        .await
        .map_err(|e| crate::errors::humanize(&e.to_string()))?;
    Ok(format!(
        "{name} is now {action} — {}",
        if action == "Enforce" {
            "new violations will be blocked at admission"
        } else {
            "violations are only reported from here on; nothing is blocked"
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_fixture(spec_status: Value) -> DynamicObject {
        let mut object: Value = json!({
            "apiVersion": "kyverno.io/v1",
            "kind": "ClusterPolicy",
            "metadata": { "name": "require-limits" }
        });
        object.as_object_mut().unwrap().extend(
            spec_status.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())),
        );
        serde_json::from_value(object).expect("fixture")
    }

    #[test]
    fn a_policy_without_a_stated_action_is_audit_because_that_is_kyvernos_default() {
        let policy = policy_fixture(json!({
            "spec": { "rules": [{ "name": "r", "validate": {} }] },
            "status": { "conditions": [{ "type": "Ready", "status": "True" }] }
        }));
        let row = policy_row(&policy, &HashMap::new());
        assert_eq!(row.action, "Audit");
        assert!(row.background, "background scanning defaults on");
        assert_eq!(row.rule_kinds, ["validate"]);
        assert!(row.ready);
        assert_eq!(row.health, "good");
    }

    #[test]
    fn audit_with_failures_outranks_enforce_with_failures() {
        // Audit + failures = the same violations keep being admitted.
        let mut counts = HashMap::new();
        counts.insert("require-limits".to_string(), 3usize);
        let audit = policy_fixture(json!({
            "spec": { "validationFailureAction": "Audit", "rules": [{ "name": "r", "validate": {} }] },
            "status": { "conditions": [{ "type": "Ready", "status": "True" }] }
        }));
        let enforce = policy_fixture(json!({
            "spec": { "validationFailureAction": "Enforce", "rules": [{ "name": "r", "validate": {} }] },
            "status": { "conditions": [{ "type": "Ready", "status": "True" }] }
        }));
        assert_eq!(policy_row(&audit, &counts).health, "serious");
        assert_eq!(policy_row(&enforce, &counts).health, "warning");
    }

    #[test]
    fn a_policy_kyverno_rejected_is_critical_with_its_own_words() {
        let policy = policy_fixture(json!({
            "spec": { "rules": [{ "name": "r", "validate": {} }] },
            "status": { "conditions": [{
                "type": "Ready", "status": "False",
                "message": "variable substitution failed in rule r"
            }] }
        }));
        let row = policy_row(&policy, &HashMap::new());
        assert_eq!(row.health, "critical");
        assert_eq!(row.message.as_deref(), Some("variable substitution failed in rule r"));
    }

    #[test]
    fn every_rule_kind_is_named_once() {
        let policy = policy_fixture(json!({
            "spec": { "rules": [
                { "name": "a", "validate": {} },
                { "name": "b", "validate": {} },
                { "name": "c", "mutate": {} },
                { "name": "d", "generate": {} },
                { "name": "e", "verifyImages": [] }
            ] }
        }));
        let row = policy_row(&policy, &HashMap::new());
        assert_eq!(row.rule_kinds, ["validate", "mutate", "generate", "verifyImages"]);
        assert_eq!(row.rules, 5);
    }

    #[test]
    fn reports_yield_failures_per_resource_and_feed_the_totals() {
        let report: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "wgpolicyk8s.io/v1alpha2",
            "kind": "PolicyReport",
            "metadata": { "name": "r", "namespace": "payments" },
            "summary": { "pass": 10, "fail": 2, "warn": 1, "skip": 4 },
            "results": [
                {
                    "policy": "require-limits", "rule": "check-limits", "result": "fail",
                    "severity": "medium", "message": "resource limits are required",
                    "resources": [
                        { "kind": "Deployment", "namespace": "payments", "name": "checkout-api" },
                        { "kind": "Deployment", "namespace": "payments", "name": "fraud-scoring" }
                    ]
                },
                { "policy": "p2", "rule": "r2", "result": "pass",
                  "resources": [{ "kind": "Pod", "namespace": "payments", "name": "ok" }] }
            ]
        }))
        .expect("fixture");
        let mut out = Vec::new();
        let mut totals = (0, 0, 0);
        collect_violations(&report, &mut out, &mut totals);
        assert_eq!(totals, (10, 2, 1));
        // One row per failing resource; the pass row is counted, not listed.
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|v| v.policy == "require-limits" && v.result == "fail"));
        assert!(out.iter().any(|v| v.name == "checkout-api"));
    }

    #[test]
    fn findings_name_the_audit_gap_and_the_not_ready_policies() {
        let mut counts = HashMap::new();
        counts.insert("audit-failing".to_string(), 2usize);
        let rows = vec![
            {
                let mut row = policy_row(
                    &policy_fixture(json!({
                        "spec": { "validationFailureAction": "Audit", "rules": [{ "name": "r", "validate": {} }] },
                        "status": { "conditions": [{ "type": "Ready", "status": "True" }] }
                    })),
                    &counts,
                );
                row.name = "audit-failing".to_string();
                row.fail_count = 2;
                row
            },
            {
                let mut row = policy_row(
                    &policy_fixture(json!({
                        "status": { "conditions": [{ "type": "Ready", "status": "False", "message": "broken" }] }
                    })),
                    &HashMap::new(),
                );
                row.name = "broken-policy".to_string();
                row
            },
        ];
        let findings = build_findings(&rows);
        assert!(findings.iter().any(|f| f.title == "Policies are not ready" && f.targets == ["broken-policy"]));
        assert!(findings.iter().any(|f| f.title == "Reporting, not blocking" && f.targets == ["audit-failing"]));
    }
}
