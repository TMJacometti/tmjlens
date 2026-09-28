//! Admin HPA manager: preview (server-side dry-run), apply (SSA, field
//! manager `tmjlens`), undo. Writes are refused when the install flag is off.

use crate::db::{sql_opt, sql_str, Db};
use crate::ingest::merged_usage;
use crate::rightsizing::{hpa_suggestion, HpaSuggestion};
use k8s_openapi::api::apps::v1::{Deployment, StatefulSet};
use k8s_openapi::api::autoscaling::v2::{
    HorizontalPodAutoscaler, HorizontalPodAutoscalerSpec, HPAScalingPolicy, HPAScalingRules,
    HorizontalPodAutoscalerBehavior, MetricSpec, MetricTarget, ResourceMetricSource,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::api::{Patch, PatchParams, ListParams};
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const FIELD_MANAGER: &str = "tmjlens";
pub const MANAGED_BY: &str = "tmjlens";
pub const ANNOTATION_ORIGIN: &str = "tmjlens.io/origin";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HpaForm {
    pub namespace: String,
    pub target_kind: String,
    pub target_name: String,
    pub name: Option<String>,
    pub min_replicas: i32,
    pub max_replicas: i32,
    pub metric: Option<String>,
    pub target_utilization: i32,
    pub stabilize_up_seconds: Option<i32>,
    pub stabilize_down_seconds: Option<i32>,
    /// Required when an existing HPA is not labelled as ours.
    pub import_existing: Option<bool>,
}

#[derive(Serialize)]
pub struct HpaStatus {
    pub present: bool,
    pub name: Option<String>,
    pub ours: bool,
    pub yaml: Option<String>,
    pub desired_replicas: Option<i32>,
    pub current_replicas: Option<i32>,
    pub suggestion: HpaSuggestion,
    pub warnings: Vec<String>,
    pub blocks: Vec<String>,
    pub manager_enabled: bool,
}

#[derive(Serialize)]
pub struct HpaPreview {
    pub yaml: String,
    pub before: String,
    pub after: String,
    pub warnings: Vec<String>,
    pub blocks: Vec<String>,
}

pub fn manager_enabled() -> bool {
    matches!(
        std::env::var("TMJLENS_HPA_MANAGER").ok().as_deref().map(|s| s.to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

pub fn max_replicas_ceiling() -> i32 {
    std::env::var("TMJLENS_HPA_MAX_REPLICAS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50)
        .max(1)
}

fn gitops_guard() -> &'static str {
    match std::env::var("TMJLENS_HPA_GITOPS_GUARD").ok().as_deref() {
        Some("block") => "block",
        Some("off") => "off",
        _ => "warn",
    }
}

pub async fn status(
    db: &Db,
    namespace: &str,
    kind: &str,
    name: &str,
) -> Result<HpaStatus, String> {
    let client = crate::client_for_context("").await?;
    let replicas = current_replicas(client.clone(), namespace, kind, name).await.unwrap_or(1);
    let usage = merged_usage(db, namespace, kind, name, "")
        .ok()
        .flatten();
    let suggestion = hpa_suggestion(
        usage.as_ref().unwrap_or(&crate::rightsizing::empty_usage()),
        replicas,
        max_replicas_ceiling(),
    );
    let api: Api<HorizontalPodAutoscaler> = Api::namespaced(client.clone(), namespace);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| crate::errors::humanize(&e.to_string()))?;
    let found = list.items.into_iter().find(|h| {
        h.spec
            .as_ref()
            .map(|s| {
                s.scale_target_ref.name == name
                    && s.scale_target_ref.kind.eq_ignore_ascii_case(kind)
            })
            .unwrap_or(false)
    });
    let mut warnings = Vec::new();
    let mut blocks = Vec::new();
    probe_guards(client.clone(), namespace, kind, name, &mut warnings, &mut blocks).await;
    if !manager_enabled() {
        blocks.push("HPA manager is disabled on this install (hpaManager.enabled=false).".into());
    }
    match found {
        Some(hpa) => {
            let ours = is_ours(&hpa);
            if !ours {
                warnings.push(format!(
                    "An HPA named {} already targets this workload and is not managed by tmjLens. \
                     Import it explicitly before editing; a second HPA will not be created.",
                    hpa.metadata.name.clone().unwrap_or_default()
                ));
            }
            Ok(HpaStatus {
                present: true,
                name: hpa.metadata.name.clone(),
                ours,
                yaml: serde_yaml::to_string(&hpa).ok(),
                desired_replicas: hpa.status.as_ref().map(|s| s.desired_replicas),
                current_replicas: hpa.status.as_ref().and_then(|s| s.current_replicas),
                suggestion,
                warnings,
                blocks,
                manager_enabled: manager_enabled(),
            })
        }
        None => Ok(HpaStatus {
            present: false,
            name: None,
            ours: false,
            yaml: None,
            desired_replicas: None,
            current_replicas: Some(replicas),
            suggestion,
            warnings,
            blocks,
            manager_enabled: manager_enabled(),
        }),
    }
}

pub async fn preview(form: &HpaForm) -> Result<HpaPreview, String> {
    let (hpa, warnings, blocks) = build(form).await?;
    if !blocks.is_empty() {
        return Ok(HpaPreview {
            yaml: serde_yaml::to_string(&hpa).unwrap_or_default(),
            before: String::new(),
            after: serde_yaml::to_string(&hpa).unwrap_or_default(),
            warnings,
            blocks,
        });
    }
    let client = crate::client_for_context("").await?;
    let api: Api<HorizontalPodAutoscaler> = Api::namespaced(client, &form.namespace);
    let name = hpa.metadata.name.clone().unwrap_or_default();
    let before = match api.get(&name).await {
        Ok(existing) => serde_yaml::to_string(&existing).unwrap_or_default(),
        Err(_) => String::new(),
    };
    let params = PatchParams::apply(FIELD_MANAGER).dry_run();
    let applied = api
        .patch(&name, &params, &Patch::Apply(&hpa))
        .await
        .map_err(|e| crate::errors::humanize(&e.to_string()))?;
    let after = serde_yaml::to_string(&applied).unwrap_or_default();
    Ok(HpaPreview {
        yaml: after.clone(),
        before,
        after,
        warnings,
        blocks,
    })
}

pub async fn apply(db: &Db, form: &HpaForm, actor: &str) -> Result<Value, String> {
    if !manager_enabled() {
        return Err("HPA manager is disabled on this install".into());
    }
    let (hpa, _warnings, blocks) = build(form).await?;
    if !blocks.is_empty() {
        return Err(blocks.join(" "));
    }
    let client = crate::client_for_context("").await?;
    let api: Api<HorizontalPodAutoscaler> = Api::namespaced(client, &form.namespace);
    let name = hpa.metadata.name.clone().unwrap_or_default();
    let previous = match api.get(&name).await {
        Ok(existing) => {
            if !is_ours(&existing) && form.import_existing != Some(true) {
                return Err(
                    "an HPA already exists for this workload and is not managed by tmjLens; \
                     set importExisting to confirm"
                        .into(),
                );
            }
            serde_yaml::to_string(&existing).ok()
        }
        Err(_) => None,
    };
    let params = PatchParams::apply(FIELD_MANAGER);
    let applied = api
        .patch(&name, &params, &Patch::Apply(&hpa))
        .await
        .map_err(|e| crate::errors::humanize(&e.to_string()))?;
    let yaml = serde_yaml::to_string(&applied).unwrap_or_default();
    remember(db, &form.namespace, &name, &form.target_kind, &form.target_name, &yaml, previous.as_deref(), actor)?;
    Ok(json!({ "name": name, "yaml": yaml }))
}

pub async fn undo(db: &Db, namespace: &str, name: &str, actor: &str) -> Result<Value, String> {
    if !manager_enabled() {
        return Err("HPA manager is disabled on this install".into());
    }
    let row = db.query(&format!(
        "SELECT previous_yaml, applied_yaml FROM hpa_managed WHERE namespace = {} AND name = {};",
        sql_str(namespace)?,
        sql_str(name)?,
    ))?;
    let Some(r) = row.rows.first() else {
        return Err("tmjLens has no recorded previous version of this HPA".into());
    };
    let client = crate::client_for_context("").await?;
    let api: Api<HorizontalPodAutoscaler> = Api::namespaced(client, namespace);
    match &r[0] {
        None => {
            api.delete(name, &Default::default())
                .await
                .map_err(|e| crate::errors::humanize(&e.to_string()))?;
            db.exec(&format!(
                "DELETE FROM hpa_managed WHERE namespace = {} AND name = {};",
                sql_str(namespace)?,
                sql_str(name)?,
            ))?;
            let _ = actor;
            Ok(json!({ "removed": true }))
        }
        Some(prev) => {
            let hpa: HorizontalPodAutoscaler =
                serde_yaml::from_str(prev).map_err(|e| format!("stored previous YAML is unreadable: {e}"))?;
            let params = PatchParams::apply(FIELD_MANAGER);
            api.patch(name, &params, &Patch::Apply(&hpa))
                .await
                .map_err(|e| crate::errors::humanize(&e.to_string()))?;
            remember(db, namespace, name, "", "", prev, r[1].as_deref(), actor)?;
            Ok(json!({ "restored": true }))
        }
    }
}

fn remember(
    db: &Db,
    namespace: &str,
    name: &str,
    kind: &str,
    target: &str,
    yaml: &str,
    previous: Option<&str>,
    actor: &str,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let found = db.query(&format!(
        "SELECT id FROM hpa_managed WHERE namespace = {} AND name = {};",
        sql_str(namespace)?,
        sql_str(name)?,
    ))?;
    if found.rows.is_empty() {
        db.exec(&format!(
            "INSERT INTO hpa_managed (namespace, name, target_kind, target_name, applied_yaml, previous_yaml, applied_at, applied_by) \
             VALUES ({}, {}, {}, {}, {}, {}, {}, {});",
            sql_str(namespace)?,
            sql_str(name)?,
            sql_str(kind)?,
            sql_str(target)?,
            sql_str(yaml)?,
            sql_opt(previous)?,
            sql_str(&now)?,
            sql_str(actor)?,
        ))
    } else {
        db.exec(&format!(
            "UPDATE hpa_managed SET applied_yaml = {}, previous_yaml = {}, applied_at = {}, applied_by = {}, \
             target_kind = {}, target_name = {} WHERE namespace = {} AND name = {};",
            sql_str(yaml)?,
            sql_opt(previous)?,
            sql_str(&now)?,
            sql_str(actor)?,
            sql_str(kind)?,
            sql_str(target)?,
            sql_str(namespace)?,
            sql_str(name)?,
        ))
    }
}

async fn build(form: &HpaForm) -> Result<(HorizontalPodAutoscaler, Vec<String>, Vec<String>), String> {
    let mut warnings = Vec::new();
    let mut blocks = Vec::new();
    if !manager_enabled() {
        blocks.push("HPA manager is disabled on this install (hpaManager.enabled=false).".into());
    }
    if form.max_replicas > max_replicas_ceiling() {
        blocks.push(format!(
            "maxReplicas {} exceeds the install ceiling of {}",
            form.max_replicas,
            max_replicas_ceiling()
        ));
    }
    if form.max_replicas < form.min_replicas.max(1) {
        blocks.push("maxReplicas must be >= minReplicas".into());
    }
    let metric = form.metric.clone().unwrap_or_else(|| "cpu".into());
    if metric == "memory" {
        warnings.push(
            "Memory as an HPA metric rarely falls after a scale-up, so the HPA may not scale down. CPU is the default."
                .into(),
        );
    }
    let client = crate::client_for_context("").await?;
    probe_guards(
        client.clone(),
        &form.namespace,
        &form.target_kind,
        &form.target_name,
        &mut warnings,
        &mut blocks,
    )
    .await;

    let api: Api<HorizontalPodAutoscaler> = Api::namespaced(client, &form.namespace);
    if let Ok(list) = api.list(&ListParams::default()).await {
        for existing in list.items {
            let targets = existing.spec.as_ref().map(|s| {
                s.scale_target_ref.name == form.target_name
                    && s.scale_target_ref.kind.eq_ignore_ascii_case(&form.target_kind)
            }).unwrap_or(false);
            if !targets {
                continue;
            }
            let existing_name = existing.metadata.name.clone().unwrap_or_default();
            let wanted = form.name.clone().unwrap_or_else(|| format!("{}-hpa", form.target_name));
            if existing_name != wanted && is_ours(&existing) {
                blocks.push(format!(
                    "tmjLens already manages HPA {existing_name} for this workload; edit that one instead of creating another"
                ));
            } else if existing_name != wanted && !is_ours(&existing) && form.import_existing != Some(true) {
                blocks.push(format!(
                    "HPA {existing_name} already targets this workload. Import it (importExisting) instead of creating a second HPA."
                ));
            }
        }
    }

    let name = form
        .name
        .clone()
        .unwrap_or_else(|| format!("{}-hpa", form.target_name));
    let mut labels = BTreeMap::new();
    labels.insert("app.kubernetes.io/managed-by".into(), MANAGED_BY.into());
    let mut annotations = BTreeMap::new();
    annotations.insert(ANNOTATION_ORIGIN.into(), "hpa-manager".into());
    let resource_name = if metric == "memory" { "memory" } else { "cpu" };
    let spec = HorizontalPodAutoscalerSpec {
        scale_target_ref: k8s_openapi::api::autoscaling::v2::CrossVersionObjectReference {
            api_version: Some("apps/v1".into()),
            kind: form.target_kind.clone(),
            name: form.target_name.clone(),
        },
        min_replicas: Some(form.min_replicas.max(1)),
        max_replicas: form.max_replicas,
        metrics: Some(vec![MetricSpec {
            type_: "Resource".into(),
            resource: Some(ResourceMetricSource {
                name: resource_name.into(),
                target: MetricTarget {
                    type_: "Utilization".into(),
                    average_utilization: Some(form.target_utilization.clamp(1, 100)),
                    ..Default::default()
                },
            }),
            ..Default::default()
        }]),
        behavior: Some(HorizontalPodAutoscalerBehavior {
            scale_up: form.stabilize_up_seconds.map(|s| HPAScalingRules {
                stabilization_window_seconds: Some(s),
                policies: Some(vec![HPAScalingPolicy {
                    type_: "Percent".into(),
                    value: 100,
                    period_seconds: 15,
                }]),
                ..Default::default()
            }),
            scale_down: form.stabilize_down_seconds.map(|s| HPAScalingRules {
                stabilization_window_seconds: Some(s),
                policies: Some(vec![HPAScalingPolicy {
                    type_: "Percent".into(),
                    value: 100,
                    period_seconds: 15,
                }]),
                ..Default::default()
            }),
        }),
        ..Default::default()
    };
    let hpa = HorizontalPodAutoscaler {
        metadata: ObjectMeta {
            name: Some(name),
            namespace: Some(form.namespace.clone()),
            labels: Some(labels),
            annotations: Some(annotations),
            ..Default::default()
        },
        spec: Some(spec),
        status: None,
    };
    Ok((hpa, warnings, blocks))
}

fn is_ours(hpa: &HorizontalPodAutoscaler) -> bool {
    hpa.metadata
        .labels
        .as_ref()
        .and_then(|l| l.get("app.kubernetes.io/managed-by"))
        .map(|v| v == MANAGED_BY)
        .unwrap_or(false)
}

async fn probe_guards(
    client: Client,
    namespace: &str,
    kind: &str,
    name: &str,
    warnings: &mut Vec<String>,
    blocks: &mut Vec<String>,
) {
    match metrics_present(client.clone()).await {
        Ok(true) => {}
        Ok(false) => {
            blocks.push("metrics-server is not installed; an HPA cannot function without it.".into())
        }
        Err(e) => warnings.push(format!("could not check metrics-server: {e}")),
    }
    if vpa_on_target(client.clone(), namespace, kind, name).await.unwrap_or(false) {
        blocks.push(
            "A VerticalPodAutoscaler targets this workload. VPA and HPA on the same metric fight; refuse both."
                .into(),
        );
    }
    if let Ok(Some(reason)) = gitops_on_target(client, namespace, kind, name).await {
        match gitops_guard() {
            "block" => blocks.push(format!(
                "GitOps ({reason}) manages this workload. Applying an HPA here will likely be reverted (set gitopsGuard, or ignoreDifferences)."
            )),
            "off" => {}
            _ => warnings.push(format!(
                "GitOps ({reason}) manages this workload. A sync may revert the HPA or fight spec.replicas. Consider ignoreDifferences."
            )),
        }
    }
}

async fn metrics_present(client: Client) -> Result<bool, String> {
    let request = http::Request::get("/apis/metrics.k8s.io/v1beta1")
        .body(Vec::new())
        .map_err(|e| e.to_string())?;
    match client.request::<serde_json::Value>(request).await {
        Ok(_) => Ok(true),
        Err(kube::Error::Api(resp)) if resp.code == 404 => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

async fn vpa_on_target(client: Client, namespace: &str, kind: &str, name: &str) -> Result<bool, String> {
    let request = http::Request::get(format!(
        "/apis/autoscaling.k8s.io/v1/namespaces/{namespace}/verticalpodautoscalers"
    ))
    .body(Vec::new())
    .map_err(|e| e.to_string())?;
    let body = match client.request::<serde_json::Value>(request).await {
        Ok(v) => v,
        Err(kube::Error::Api(resp)) if resp.code == 404 => return Ok(false),
        Err(_) => return Ok(false),
    };
    let Some(items) = body.get("items").and_then(|v| v.as_array()) else {
        return Ok(false);
    };
    Ok(items.iter().any(|item| {
        let target = item.pointer("/spec/targetRef");
        target.and_then(|t| t.get("name")).and_then(|v| v.as_str()) == Some(name)
            && target
                .and_then(|t| t.get("kind"))
                .and_then(|v| v.as_str())
                .map(|k| k.eq_ignore_ascii_case(kind))
                .unwrap_or(false)
    }))
}

async fn gitops_on_target(
    client: Client,
    namespace: &str,
    kind: &str,
    name: &str,
) -> Result<Option<String>, String> {
    let labels = match kind {
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, namespace);
            api.get(name).await.ok().map(|o| (o.metadata.labels, o.metadata.annotations))
        }
        _ => {
            let api: Api<Deployment> = Api::namespaced(client, namespace);
            api.get(name).await.ok().map(|o| (o.metadata.labels, o.metadata.annotations))
        }
    };
    let Some((labels, annotations)) = labels else {
        return Ok(None);
    };
    let mut keys: Vec<(String, String)> = Vec::new();
    if let Some(m) = labels {
        keys.extend(m);
    }
    if let Some(m) = annotations {
        keys.extend(m);
    }
    for (k, v) in keys {
        if k.starts_with("argocd.argoproj.io/") {
            return Ok(Some(format!("Argo CD {k}={v}")));
        }
        if k.starts_with("kustomize.toolkit.fluxcd.io/") || k.starts_with("helm.toolkit.fluxcd.io/") {
            return Ok(Some(format!("Flux {k}={v}")));
        }
    }
    Ok(None)
}

async fn current_replicas(client: Client, namespace: &str, kind: &str, name: &str) -> Result<i32, String> {
    match kind {
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, namespace);
            Ok(api.get(name).await.ok().and_then(|s| s.spec?.replicas).unwrap_or(1))
        }
        _ => {
            let api: Api<Deployment> = Api::namespaced(client, namespace);
            Ok(api.get(name).await.ok().and_then(|d| d.spec?.replicas).unwrap_or(1))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_flag_is_off_by_default() {
        std::env::remove_var("TMJLENS_HPA_MANAGER");
        assert!(!manager_enabled());
    }

    #[test]
    fn ceiling_defaults_to_fifty() {
        std::env::remove_var("TMJLENS_HPA_MAX_REPLICAS");
        assert_eq!(max_replicas_ceiling(), 50);
    }
}
