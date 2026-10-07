//! Admin resource editor: set a container's requests and limits straight from
//! the rightsizing recommendation — no HPA involved. Same contract as the HPA
//! manager: preview is a server-side dry-run, apply is server-side apply under
//! field manager `tmjlens`, undo restores what was there, and every write is
//! refused while the install flag is off.
//!
//! `apply_recommendation` is the seam for the day this becomes automatic: it
//! builds the same form a human would and goes through the same apply.

use crate::cluster::{parse_cpu_milli, parse_memory_bytes};
use crate::db::{sql_opt, sql_str, Db};
use crate::hpa::{gitops_guard, gitops_marker, vpa_on_target, FIELD_MANAGER};
use crate::ingest::merged_usage;
use crate::rightsizing::recommend;
use kube::api::{Patch, PatchParams};
use kube::core::{ApiResource, DynamicObject, GroupVersionKind};
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub fn editor_enabled() -> bool {
    matches!(
        std::env::var("TMJLENS_RESOURCE_EDITOR")
            .ok()
            .as_deref()
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Requests and limits for one container, in the units the rest of the app
/// speaks. None means "not set" — never zero.
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
pub struct ResourceSet {
    pub cpu_request_milli: Option<f64>,
    pub cpu_limit_milli: Option<f64>,
    pub mem_request_bytes: Option<f64>,
    pub mem_limit_bytes: Option<f64>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesForm {
    pub namespace: String,
    pub kind: String,
    pub name: String,
    pub container: String,
    pub cpu_request_milli: Option<f64>,
    pub cpu_limit_milli: Option<f64>,
    pub mem_request_bytes: Option<f64>,
    pub mem_limit_bytes: Option<f64>,
}

impl ResourcesForm {
    fn desired(&self) -> ResourceSet {
        ResourceSet {
            cpu_request_milli: self.cpu_request_milli,
            cpu_limit_milli: self.cpu_limit_milli,
            mem_request_bytes: self.mem_request_bytes,
            mem_limit_bytes: self.mem_limit_bytes,
        }
    }
}

#[derive(Serialize)]
pub struct ResourcesStatus {
    pub current: ResourceSet,
    /// Requests from the recommendation; limits kept from the workload, raised
    /// only where a recommended request would otherwise exceed them.
    pub recommended: ResourceSet,
    pub replicas: i64,
    /// True when tmjLens applied the current values and can restore the previous ones.
    pub ours: bool,
    pub editor_enabled: bool,
    pub warnings: Vec<String>,
    pub blocks: Vec<String>,
}

#[derive(Serialize)]
pub struct ResourcesPreview {
    pub before: String,
    pub after: String,
    pub warnings: Vec<String>,
    pub blocks: Vec<String>,
}

pub(crate) fn workload_api(client: Client, namespace: &str, kind: &str) -> Result<Api<DynamicObject>, String> {
    match kind {
        "Deployment" | "StatefulSet" | "DaemonSet" => {
            let resource = ApiResource::from_gvk(&GroupVersionKind::gvk("apps", "v1", kind));
            Ok(Api::namespaced_with(client, namespace, &resource))
        }
        other => Err(format!(
            "{other} is not a workload whose pod template tmjLens edits — Deployment, StatefulSet or DaemonSet"
        )),
    }
}

/// `250m` below a core, whole cores above; Kubernetes accepts both and
/// operators read both.
pub fn cpu_quantity(milli: f64) -> String {
    let milli = milli.ceil().max(1.0) as i64;
    if milli % 1000 == 0 {
        format!("{}", milli / 1000)
    } else {
        format!("{milli}m")
    }
}

/// Whole MiB, rounded up — a request is a floor, never a ceiling.
pub fn mem_quantity(bytes: f64) -> String {
    let mib = (bytes / (1024.0 * 1024.0)).ceil().max(1.0) as i64;
    format!("{mib}Mi")
}

/// The container's resources as the API server holds them.
pub fn container_resources(object: &DynamicObject, container: &str) -> Option<ResourceSet> {
    let containers = object.data.pointer("/spec/template/spec/containers")?.as_array()?;
    let target = containers
        .iter()
        .find(|c| c.get("name").and_then(Value::as_str) == Some(container))?;
    let quantity = |section: &str, key: &str| -> Option<String> {
        target
            .pointer(&format!("/resources/{section}/{key}"))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    Some(ResourceSet {
        cpu_request_milli: quantity("requests", "cpu").and_then(|q| parse_cpu_milli(&q)),
        cpu_limit_milli: quantity("limits", "cpu").and_then(|q| parse_cpu_milli(&q)),
        mem_request_bytes: quantity("requests", "memory").and_then(|q| parse_memory_bytes(&q)),
        mem_limit_bytes: quantity("limits", "memory").and_then(|q| parse_memory_bytes(&q)),
    })
}

fn replicas_of(object: &DynamicObject) -> i64 {
    object
        .data
        .pointer("/spec/replicas")
        .and_then(Value::as_i64)
        .or_else(|| object.data.pointer("/status/desiredNumberScheduled").and_then(Value::as_i64))
        .unwrap_or(1)
}

/// What a human reads in the diff: the resources block, nothing else.
pub fn render(set: &ResourceSet) -> String {
    let mut out = String::new();
    let mut section = |title: &str, cpu: Option<f64>, mem: Option<f64>, cpu_fmt: fn(f64) -> String| {
        if cpu.is_none() && mem.is_none() {
            return;
        }
        out.push_str(title);
        out.push_str(":\n");
        if let Some(c) = cpu {
            out.push_str(&format!("  cpu: {}\n", cpu_fmt(c)));
        }
        if let Some(m) = mem {
            out.push_str(&format!("  memory: {}\n", mem_quantity(m)));
        }
    };
    section("requests", set.cpu_request_milli, set.mem_request_bytes, cpu_quantity);
    section("limits", set.cpu_limit_milli, set.mem_limit_bytes, cpu_quantity);
    if out.is_empty() {
        out.push_str("(no requests or limits set)\n");
    }
    out
}

/// What Kubernetes would reject, said before the round trip.
pub fn validate(desired: &ResourceSet) -> Vec<String> {
    let mut blocks = Vec::new();
    for (label, value) in [
        ("CPU request", desired.cpu_request_milli),
        ("CPU limit", desired.cpu_limit_milli),
        ("memory request", desired.mem_request_bytes),
        ("memory limit", desired.mem_limit_bytes),
    ] {
        if let Some(v) = value {
            if !(v > 0.0) || !v.is_finite() {
                blocks.push(format!("{label} must be a positive number"));
            }
        }
    }
    if let (Some(req), Some(lim)) = (desired.cpu_request_milli, desired.cpu_limit_milli) {
        if req > lim {
            blocks.push(format!(
                "CPU request {} is above the CPU limit {} — Kubernetes rejects that; raise the limit or lower the request",
                cpu_quantity(req),
                cpu_quantity(lim)
            ));
        }
    }
    if let (Some(req), Some(lim)) = (desired.mem_request_bytes, desired.mem_limit_bytes) {
        if req > lim {
            blocks.push(format!(
                "memory request {} is above the memory limit {} — Kubernetes rejects that; raise the limit or lower the request",
                mem_quantity(req),
                mem_quantity(lim)
            ));
        }
    }
    if desired == &ResourceSet::default() {
        blocks.push("nothing to apply: no request or limit was given".into());
    }
    blocks
}

/// The server-side apply configuration: only the container named, only the
/// fields given. Containers are a list keyed by name, so SSA merges this into
/// the pod template without touching the other containers.
pub fn apply_config(form: &ResourcesForm) -> Value {
    let desired = form.desired();
    let mut requests = Map::new();
    let mut limits = Map::new();
    if let Some(v) = desired.cpu_request_milli {
        requests.insert("cpu".into(), Value::String(cpu_quantity(v)));
    }
    if let Some(v) = desired.mem_request_bytes {
        requests.insert("memory".into(), Value::String(mem_quantity(v)));
    }
    if let Some(v) = desired.cpu_limit_milli {
        limits.insert("cpu".into(), Value::String(cpu_quantity(v)));
    }
    if let Some(v) = desired.mem_limit_bytes {
        limits.insert("memory".into(), Value::String(mem_quantity(v)));
    }
    let mut resources = Map::new();
    if !requests.is_empty() {
        resources.insert("requests".into(), Value::Object(requests));
    }
    if !limits.is_empty() {
        resources.insert("limits".into(), Value::Object(limits));
    }
    json!({
        "apiVersion": "apps/v1",
        "kind": form.kind,
        "metadata": { "name": form.name, "namespace": form.namespace },
        "spec": { "template": { "spec": { "containers": [
            { "name": form.container, "resources": Value::Object(resources) }
        ] } } }
    })
}

struct Target {
    api: Api<DynamicObject>,
    current: ResourceSet,
    replicas: i64,
    warnings: Vec<String>,
    blocks: Vec<String>,
}

/// Reads the workload once and runs every guard the write needs.
async fn target(form: &ResourcesForm) -> Result<Target, String> {
    let client = crate::client_for_context("").await?;
    let api = workload_api(client.clone(), &form.namespace, &form.kind)?;
    let object = api
        .get(&form.name)
        .await
        .map_err(|e| crate::errors::humanize(&e.to_string()))?;
    let current = container_resources(&object, &form.container).ok_or_else(|| {
        format!(
            "{}/{} has no container named '{}'",
            form.kind, form.name, form.container
        )
    })?;
    let replicas = replicas_of(&object);

    let mut warnings = Vec::new();
    let mut blocks = Vec::new();
    if !editor_enabled() {
        blocks.push("Resource editor is disabled on this install (resourceEditor.enabled=false).".into());
    }
    if vpa_on_target(client.clone(), &form.namespace, &form.kind, &form.name)
        .await
        .unwrap_or(false)
    {
        blocks.push(
            "A VerticalPodAutoscaler already manages this workload's requests; two writers would fight over them."
                .into(),
        );
    }
    if let Some(reason) = gitops_marker(
        object.metadata.labels.as_ref(),
        object.metadata.annotations.as_ref(),
    ) {
        match gitops_guard() {
            "block" => blocks.push(format!(
                "GitOps ({reason}) manages this workload; the next sync would revert these resources. Change them in Git."
            )),
            "off" => {}
            _ => warnings.push(format!(
                "GitOps ({reason}) manages this workload. A sync may revert these resources — mirror the change in Git."
            )),
        }
    }
    warnings.push(format!(
        "Changing the pod template rolls the workload: {replicas} replica(s) restart."
    ));
    Ok(Target { api, current, replicas, warnings, blocks })
}

pub async fn status(
    db: &Db,
    namespace: &str,
    kind: &str,
    name: &str,
    container: &str,
) -> Result<ResourcesStatus, String> {
    let form = ResourcesForm {
        namespace: namespace.into(),
        kind: kind.into(),
        name: name.into(),
        container: container.into(),
        cpu_request_milli: None,
        cpu_limit_milli: None,
        mem_request_bytes: None,
        mem_limit_bytes: None,
    };
    let mut t = target(&form).await?;
    // The status is read-only; the rollout warning belongs to a write.
    t.warnings.retain(|w| !w.starts_with("Changing the pod template"));

    let usage = merged_usage(db, namespace, kind, name, container).ok().flatten();
    let recommended = match usage.as_ref() {
        Some(usage) => {
            let rec = recommend(usage, kind);
            let raise = |limit: Option<f64>, request: Option<f64>| match (limit, request) {
                (Some(l), Some(r)) if r > l => Some(r),
                (l, _) => l,
            };
            ResourceSet {
                cpu_request_milli: rec.cpu_request_milli.map(f64::ceil),
                mem_request_bytes: rec.mem_request_bytes,
                cpu_limit_milli: raise(t.current.cpu_limit_milli, rec.cpu_request_milli),
                mem_limit_bytes: raise(t.current.mem_limit_bytes, rec.mem_request_bytes),
            }
        }
        None => {
            t.warnings
                .push("No usage history for this container yet, so there is no recommendation to apply.".into());
            t.current.clone()
        }
    };
    let ours = !db
        .query(&format!(
            "SELECT id FROM resources_managed WHERE namespace = {} AND kind = {} AND name = {} AND container = {};",
            sql_str(namespace)?,
            sql_str(kind)?,
            sql_str(name)?,
            sql_str(container)?,
        ))?
        .rows
        .is_empty();
    Ok(ResourcesStatus {
        current: t.current,
        recommended,
        replicas: t.replicas,
        ours,
        editor_enabled: editor_enabled(),
        warnings: t.warnings,
        blocks: t.blocks,
    })
}

pub async fn preview(form: &ResourcesForm) -> Result<ResourcesPreview, String> {
    let desired = form.desired();
    let mut t = target(form).await?;
    t.blocks.extend(validate(&desired));
    if !t.blocks.is_empty() {
        return Ok(ResourcesPreview {
            before: render(&t.current),
            after: render(&desired),
            warnings: t.warnings,
            blocks: t.blocks,
        });
    }
    let config = apply_config(form);
    // First without force: a 409 names who owns these fields today — Helm,
    // kubectl, an operator — and that is worth saying before taking them.
    let gentle = PatchParams::apply(FIELD_MANAGER).dry_run();
    let applied = match t.api.patch(&form.name, &gentle, &Patch::Apply(&config)).await {
        Ok(object) => object,
        Err(kube::Error::Api(response)) if response.code == 409 => {
            t.warnings.push(format!(
                "Another field manager owns these resources today ({}). Applying takes ownership; \
                 the next `helm upgrade` or `kubectl apply` from that side will conflict until its \
                 source carries the same values.",
                owners_from(&response.message)
            ));
            let mut forced = PatchParams::apply(FIELD_MANAGER).dry_run();
            forced.force = true;
            t.api
                .patch(&form.name, &forced, &Patch::Apply(&config))
                .await
                .map_err(|e| crate::errors::humanize(&e.to_string()))?
        }
        Err(e) => return Err(crate::errors::humanize(&e.to_string())),
    };
    let after = container_resources(&applied, &form.container).unwrap_or_default();
    Ok(ResourcesPreview {
        before: render(&t.current),
        after: render(&after),
        warnings: t.warnings,
        blocks: t.blocks,
    })
}

/// The API server says `conflict with "helm"` for one field and `conflicts
/// with "helm"` for several — the manager's name is what the operator needs.
fn owners_from(message: &str) -> String {
    let mut owners: Vec<String> = Vec::new();
    for part in message.split("with \"").skip(1) {
        if let Some(end) = part.find('"') {
            let owner = part[..end].to_string();
            if !owners.contains(&owner) {
                owners.push(owner);
            }
        }
    }
    if owners.is_empty() { "unknown manager".into() } else { owners.join(", ") }
}

pub async fn apply(db: &Db, form: &ResourcesForm, actor: &str) -> Result<Value, String> {
    if !editor_enabled() {
        return Err("Resource editor is disabled on this install".into());
    }
    let desired = form.desired();
    let mut t = target(form).await?;
    t.blocks.extend(validate(&desired));
    if !t.blocks.is_empty() {
        return Err(t.blocks.join(" "));
    }
    let config = apply_config(form);
    let mut params = PatchParams::apply(FIELD_MANAGER);
    params.force = true;
    let applied = t
        .api
        .patch(&form.name, &params, &Patch::Apply(&config))
        .await
        .map_err(|e| crate::errors::humanize(&e.to_string()))?;
    let after = container_resources(&applied, &form.container).unwrap_or_default();
    remember(db, form, &after, Some(&t.current), actor)?;
    Ok(json!({ "applied": after, "replicas_restarting": t.replicas }))
}

/// The automation seam: apply exactly what the recommendation says, with the
/// limits raised only where the request would otherwise exceed them. A
/// scheduler calling this later goes through the same guards and audit.
pub async fn apply_recommendation(
    db: &Db,
    namespace: &str,
    kind: &str,
    name: &str,
    container: &str,
    actor: &str,
) -> Result<Value, String> {
    let current = status(db, namespace, kind, name, container).await?;
    if !current.blocks.is_empty() {
        return Err(current.blocks.join(" "));
    }
    let form = ResourcesForm {
        namespace: namespace.into(),
        kind: kind.into(),
        name: name.into(),
        container: container.into(),
        cpu_request_milli: current.recommended.cpu_request_milli,
        cpu_limit_milli: current.recommended.cpu_limit_milli,
        mem_request_bytes: current.recommended.mem_request_bytes,
        mem_limit_bytes: current.recommended.mem_limit_bytes,
    };
    apply(db, &form, actor).await
}

pub async fn undo(
    db: &Db,
    namespace: &str,
    kind: &str,
    name: &str,
    container: &str,
    actor: &str,
) -> Result<Value, String> {
    if !editor_enabled() {
        return Err("Resource editor is disabled on this install".into());
    }
    let row = db.query(&format!(
        "SELECT previous_json FROM resources_managed WHERE namespace = {} AND kind = {} AND name = {} AND container = {};",
        sql_str(namespace)?,
        sql_str(kind)?,
        sql_str(name)?,
        sql_str(container)?,
    ))?;
    let Some(previous) = row.rows.first().and_then(|r| r.first().cloned().flatten()) else {
        return Err("tmjLens has no recorded previous resources for this container".into());
    };
    let previous: ResourceSet =
        serde_json::from_str(&previous).map_err(|e| format!("stored previous resources are unreadable: {e}"))?;
    let form = ResourcesForm {
        namespace: namespace.into(),
        kind: kind.into(),
        name: name.into(),
        container: container.into(),
        cpu_request_milli: previous.cpu_request_milli,
        cpu_limit_milli: previous.cpu_limit_milli,
        mem_request_bytes: previous.mem_request_bytes,
        mem_limit_bytes: previous.mem_limit_bytes,
    };
    let t = target(&form).await?;
    let mut params = PatchParams::apply(FIELD_MANAGER);
    params.force = true;
    // Fields absent from the previous set are dropped from our ownership,
    // which removes them — exactly "put it back the way it was".
    t.api
        .patch(name, &params, &Patch::Apply(&apply_config(&form)))
        .await
        .map_err(|e| crate::errors::humanize(&e.to_string()))?;
    db.exec(&format!(
        "DELETE FROM resources_managed WHERE namespace = {} AND kind = {} AND name = {} AND container = {};",
        sql_str(namespace)?,
        sql_str(kind)?,
        sql_str(name)?,
        sql_str(container)?,
    ))?;
    let _ = actor;
    Ok(json!({ "restored": previous, "replicas_restarting": t.replicas }))
}

fn remember(
    db: &Db,
    form: &ResourcesForm,
    applied: &ResourceSet,
    previous: Option<&ResourceSet>,
    actor: &str,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let applied_json = serde_json::to_string(applied).map_err(|e| e.to_string())?;
    let previous_json = previous
        .map(|p| serde_json::to_string(p).map_err(|e| e.to_string()))
        .transpose()?;
    let found = db.query(&format!(
        "SELECT id FROM resources_managed WHERE namespace = {} AND kind = {} AND name = {} AND container = {};",
        sql_str(&form.namespace)?,
        sql_str(&form.kind)?,
        sql_str(&form.name)?,
        sql_str(&form.container)?,
    ))?;
    if found.rows.is_empty() {
        db.exec(&format!(
            "INSERT INTO resources_managed (namespace, kind, name, container, applied_json, previous_json, applied_at, applied_by) \
             VALUES ({}, {}, {}, {}, {}, {}, {}, {});",
            sql_str(&form.namespace)?,
            sql_str(&form.kind)?,
            sql_str(&form.name)?,
            sql_str(&form.container)?,
            sql_str(&applied_json)?,
            sql_opt(previous_json.as_deref())?,
            sql_str(&now)?,
            sql_str(actor)?,
        ))
    } else {
        // A second apply keeps the ORIGINAL previous: undo means "before
        // tmjLens touched it", not "before the last click".
        db.exec(&format!(
            "UPDATE resources_managed SET applied_json = {}, applied_at = {}, applied_by = {} \
             WHERE namespace = {} AND kind = {} AND name = {} AND container = {};",
            sql_str(&applied_json)?,
            sql_str(&now)?,
            sql_str(actor)?,
            sql_str(&form.namespace)?,
            sql_str(&form.kind)?,
            sql_str(&form.name)?,
            sql_str(&form.container)?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(set: ResourceSet) -> ResourcesForm {
        ResourcesForm {
            namespace: "payments".into(),
            kind: "Deployment".into(),
            name: "checkout-api".into(),
            container: "api".into(),
            cpu_request_milli: set.cpu_request_milli,
            cpu_limit_milli: set.cpu_limit_milli,
            mem_request_bytes: set.mem_request_bytes,
            mem_limit_bytes: set.mem_limit_bytes,
        }
    }

    #[test]
    fn quantities_read_the_way_operators_write_them() {
        assert_eq!(cpu_quantity(250.0), "250m");
        assert_eq!(cpu_quantity(110.4), "111m", "a request is a floor: round up");
        assert_eq!(cpu_quantity(2000.0), "2");
        assert_eq!(mem_quantity(144.0 * 1024.0 * 1024.0), "144Mi");
        assert_eq!(mem_quantity(144.0 * 1024.0 * 1024.0 + 1.0), "145Mi");
    }

    #[test]
    fn a_request_above_its_limit_is_refused_before_the_round_trip() {
        let blocks = validate(&ResourceSet {
            cpu_request_milli: Some(600.0),
            cpu_limit_milli: Some(500.0),
            mem_request_bytes: Some(1.0),
            mem_limit_bytes: Some(2.0),
        });
        assert_eq!(blocks.len(), 1, "{blocks:?}");
        assert!(blocks[0].contains("CPU request 600m is above the CPU limit 500m"));
        assert!(validate(&ResourceSet::default()).iter().any(|b| b.contains("nothing to apply")));
    }

    #[test]
    fn the_apply_config_touches_one_container_and_only_the_fields_given() {
        let config = apply_config(&form(ResourceSet {
            cpu_request_milli: Some(110.0),
            mem_request_bytes: Some(144.0 * 1024.0 * 1024.0),
            cpu_limit_milli: None,
            mem_limit_bytes: None,
        }));
        let containers = config.pointer("/spec/template/spec/containers").unwrap().as_array().unwrap();
        assert_eq!(containers.len(), 1);
        assert_eq!(containers[0]["name"], "api");
        assert_eq!(containers[0]["resources"]["requests"]["cpu"], "110m");
        assert_eq!(containers[0]["resources"]["requests"]["memory"], "144Mi");
        // No limits were given, so SSA must not claim ownership of any.
        assert!(containers[0]["resources"].get("limits").is_none());
        assert_eq!(config["kind"], "Deployment");
    }

    #[test]
    fn current_resources_are_read_from_the_named_container_only() {
        let object: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": { "name": "checkout-api", "namespace": "payments" },
            "spec": { "replicas": 3, "template": { "spec": { "containers": [
                { "name": "envoy", "resources": { "requests": { "cpu": "50m" } } },
                { "name": "api", "resources": {
                    "requests": { "cpu": "500m", "memory": "1Gi" },
                    "limits": { "memory": "2Gi" } } }
            ] } } }
        }))
        .unwrap();
        let set = container_resources(&object, "api").expect("api container");
        assert_eq!(set.cpu_request_milli, Some(500.0));
        assert_eq!(set.mem_request_bytes, Some(1024.0 * 1024.0 * 1024.0));
        assert_eq!(set.cpu_limit_milli, None);
        assert_eq!(set.mem_limit_bytes, Some(2.0 * 1024.0 * 1024.0 * 1024.0));
        assert_eq!(replicas_of(&object), 3);
        assert!(container_resources(&object, "missing").is_none());
    }

    #[test]
    fn the_diff_text_shows_only_what_is_set() {
        let text = render(&ResourceSet {
            cpu_request_milli: Some(110.0),
            mem_request_bytes: Some(144.0 * 1024.0 * 1024.0),
            cpu_limit_milli: None,
            mem_limit_bytes: Some(512.0 * 1024.0 * 1024.0),
        });
        assert_eq!(text, "requests:\n  cpu: 110m\n  memory: 144Mi\nlimits:\n  memory: 512Mi\n");
        assert_eq!(render(&ResourceSet::default()), "(no requests or limits set)\n");
    }

    #[test]
    fn conflict_messages_name_the_other_manager() {
        // Verbatim from the API server: plural for several fields…
        let plural = "Apply failed with 2 conflicts: conflicts with \"helm\" using apps/v1:
- .spec.template.spec.containers[name=\"scheduler\"].resources.requests.cpu
- .spec.template.spec.containers[name=\"scheduler\"].resources.requests.memory
Please review the fields above";
        assert_eq!(owners_from(plural), "helm");
        // …singular for one, and more than one manager is listed once each.
        let singular = "Apply failed with 1 conflict: conflict with \"kubectl-client-side-apply\" using apps/v1: .spec.replicas";
        assert_eq!(owners_from(singular), "kubectl-client-side-apply");
        let two = "conflicts with \"helm\" using apps/v1: a, conflicts with \"node-fetch\" using apps/v1: b";
        assert_eq!(owners_from(two), "helm, node-fetch");
        assert_eq!(owners_from("something else"), "unknown manager");
    }
}
