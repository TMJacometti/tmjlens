//! Argo Workflows, read and maintained through its own custom resources.
//!
//! Everything Argo runs is a CRD — runs (`Workflow`), schedules (`CronWorkflow`) and
//! the definitions they come from (`WorkflowTemplate`) — so listing and editing need
//! nothing but the Kubernetes API the app already holds, under normal RBAC.
//!
//! The maintenance this module exists for is the one operators actually do: changing
//! the image a workflow runs. That edit goes through `replace` on a fresh read, so the
//! object's resourceVersion travels with it and a concurrent change comes back as a
//! conflict instead of being silently overwritten — and the expected image is checked
//! against what is actually there before anything is written.

use kube::api::{DeleteParams, ListParams, Patch, PostParams};
use kube::core::{ApiResource, DynamicObject, GroupVersionKind};
use kube::{Api, Client};
use serde::Serialize;
use serde_json::{json, Value};

use crate::format_age;

fn resource(kind: &str) -> ApiResource {
    ApiResource::from_gvk(&GroupVersionKind::gvk("argoproj.io", "v1alpha1", kind))
}

fn api_all(client: Client, kind: &str) -> Api<DynamicObject> {
    Api::all_with(client, &resource(kind))
}

fn api_in(client: Client, namespace: &str, kind: &str) -> Api<DynamicObject> {
    Api::namespaced_with(client, namespace, &resource(kind))
}

// ---------------------------------------------------------------- shapes

#[derive(Serialize, Clone)]
pub struct ArgoOverview {
    pub installed: bool,
    pub reason: Option<String>,
    pub workflows: Vec<WorkflowRow>,
    pub cron_workflows: Vec<CronRow>,
    pub templates: Vec<TemplateRow>,
    pub degraded_collectors: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct WorkflowRow {
    pub name: String,
    pub namespace: String,
    pub phase: String,
    pub health: String,
    pub reason: String,
    /// "3/5" — nodes finished over nodes total, as Argo reports it.
    pub progress: Option<String>,
    pub started_at: Option<String>,
    pub duration: Option<String>,
    pub from_template: Option<String>,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct CronRow {
    pub name: String,
    pub namespace: String,
    pub schedule: String,
    pub suspended: bool,
    pub health: String,
    pub reason: String,
    pub last_scheduled: Option<String>,
    pub images: Vec<ImageSlot>,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct TemplateRow {
    pub name: String,
    pub namespace: String,
    pub entrypoint: String,
    pub images: Vec<ImageSlot>,
    pub age: String,
}

/// One image somewhere in a workflow spec: which template step, which container, and
/// what it currently runs.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct ImageSlot {
    pub template: String,
    /// "main" for a plain container or script step; the container's own name inside a
    /// containerSet.
    pub container: String,
    pub image: String,
}

// ---------------------------------------------------------------- pure logic

/// Maps a Workflow phase to the shared severity vocabulary.
pub fn phase_health(phase: &str, message: Option<&str>, progress: Option<&str>) -> (&'static str, String) {
    match phase {
        "Succeeded" => ("good", "Completed.".to_string()),
        "Failed" | "Error" => (
            "critical",
            message.filter(|text| !text.is_empty()).map(String::from).unwrap_or_else(|| "The run failed.".to_string()),
        ),
        "Running" => (
            "warning",
            match progress {
                Some(progress) => format!("Running · {progress} nodes done."),
                None => "Running.".to_string(),
            },
        ),
        "Pending" => ("warning", "Waiting to start — check quota and scheduling.".to_string()),
        other => ("warning", format!("Phase {other}.")),
    }
}

/// Every image in a workflow spec's templates, with where it lives.
///
/// Covers the three places Argo puts an image: `container` and `script` steps (whose
/// running container Argo names "main"), and each named container of a containerSet.
/// Steps/dag templates carry no image of their own, so they yield nothing.
pub fn image_slots(workflow_spec: &Value) -> Vec<ImageSlot> {
    let mut slots = Vec::new();
    for template in workflow_spec.get("templates").and_then(Value::as_array).into_iter().flatten() {
        let Some(template_name) = template.get("name").and_then(Value::as_str) else { continue };

        for key in ["container", "script"] {
            if let Some(image) = template.pointer(&format!("/{key}/image")).and_then(Value::as_str) {
                slots.push(ImageSlot {
                    template: template_name.to_string(),
                    container: "main".to_string(),
                    image: image.to_string(),
                });
            }
        }
        for container in template
            .pointer("/containerSet/containers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(name), Some(image)) = (
                container.get("name").and_then(Value::as_str),
                container.get("image").and_then(Value::as_str),
            ) {
                slots.push(ImageSlot {
                    template: template_name.to_string(),
                    container: name.to_string(),
                    image: image.to_string(),
                });
            }
        }
    }
    slots
}

/// Where a kind keeps its workflow spec. A CronWorkflow nests it one level down.
pub fn spec_root_pointer(kind: &str) -> &'static str {
    match kind {
        "CronWorkflow" => "/spec/workflowSpec",
        _ => "/spec",
    }
}

/// Replaces one image in place, only if what is there now is what the caller saw.
///
/// The check is the point: between reading the screen and clicking save, someone else
/// may have edited the same template. Writing anyway would silently discard their
/// change; refusing with both values named lets the operator re-read and decide.
pub fn set_image_in(
    data: &mut Value,
    root_pointer: &str,
    template: &str,
    container: &str,
    expected: &str,
    new_image: &str,
) -> Result<(), String> {
    let templates = data
        .pointer_mut(&format!("{root_pointer}/templates"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "This object carries no workflow templates.".to_string())?;

    for entry in templates.iter_mut() {
        if entry.get("name").and_then(Value::as_str) != Some(template) {
            continue;
        }

        let target = if container == "main" {
            // Found immutably first, then borrowed mutably once — a find_map closure
            // would trap the mutable borrow inside itself.
            let key = ["container", "script"]
                .into_iter()
                .find(|key| entry.pointer(&format!("/{key}/image")).is_some());
            key.and_then(|key| entry.pointer_mut(&format!("/{key}/image")))
        } else {
            entry
                .pointer_mut("/containerSet/containers")
                .and_then(Value::as_array_mut)
                .and_then(|containers| {
                    containers
                        .iter_mut()
                        .find(|inner| inner.get("name").and_then(Value::as_str) == Some(container))
                })
                .and_then(|inner| inner.pointer_mut("/image"))
        };

        let Some(image) = target else {
            return Err(format!("Template {template} has no container {container} with an image."));
        };
        let current = image.as_str().unwrap_or_default().to_string();
        if current != expected {
            return Err(format!(
                "The image changed since you read it: it is now {current}, not {expected}. \
                 Refresh and edit again."
            ));
        }
        *image = json!(new_image);
        return Ok(());
    }

    Err(format!("No template named {template} exists in this object."))
}

fn duration_between(started: Option<&str>, finished: Option<&str>) -> Option<String> {
    let start = chrono::DateTime::parse_from_rfc3339(started?).ok()?;
    let end = chrono::DateTime::parse_from_rfc3339(finished?).ok()?;
    let seconds = (end - start).num_seconds().max(0);
    Some(if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3_600 {
        format!("{}m {}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h {}m", seconds / 3_600, (seconds % 3_600) / 60)
    })
}

fn text_at(object: &DynamicObject, pointer: &str) -> Option<String> {
    object.data.pointer(pointer).and_then(Value::as_str).map(String::from)
}

fn age_of(object: &DynamicObject) -> String {
    object
        .metadata
        .creation_timestamp
        .as_ref()
        .map(|stamp| format_age(stamp.0))
        .unwrap_or_default()
}

// ---------------------------------------------------------------- collectors

fn workflow_row(object: DynamicObject) -> WorkflowRow {
    let phase = text_at(&object, "/status/phase").unwrap_or_else(|| "Pending".to_string());
    let message = text_at(&object, "/status/message");
    let progress = text_at(&object, "/status/progress");
    let (health, reason) = phase_health(&phase, message.as_deref(), progress.as_deref());
    let started = text_at(&object, "/status/startedAt");
    let finished = text_at(&object, "/status/finishedAt");

    WorkflowRow {
        namespace: object.metadata.namespace.clone().unwrap_or_default(),
        duration: duration_between(started.as_deref(), finished.as_deref()),
        from_template: text_at(&object, "/spec/workflowTemplateRef/name"),
        age: age_of(&object),
        name: object.metadata.name.unwrap_or_default(),
        health: health.to_string(),
        started_at: started,
        progress,
        reason,
        phase,
    }
}

fn cron_row(object: DynamicObject) -> CronRow {
    let suspended = object
        .data
        .pointer("/spec/suspend")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let (health, reason) = if suspended {
        ("warning", "Suspended — it will not run on its schedule.".to_string())
    } else {
        ("good", "Scheduled.".to_string())
    };

    CronRow {
        namespace: object.metadata.namespace.clone().unwrap_or_default(),
        schedule: text_at(&object, "/spec/schedule")
            .or_else(|| {
                // Newer Argo allows several schedules; show them joined.
                object
                    .data
                    .pointer("/spec/schedules")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
            })
            .unwrap_or_default(),
        last_scheduled: text_at(&object, "/status/lastScheduledTime"),
        images: image_slots(object.data.pointer("/spec/workflowSpec").unwrap_or(&Value::Null)),
        age: age_of(&object),
        name: object.metadata.name.unwrap_or_default(),
        health: health.to_string(),
        suspended,
        reason,
    }
}

fn template_row(object: DynamicObject) -> TemplateRow {
    TemplateRow {
        namespace: object.metadata.namespace.clone().unwrap_or_default(),
        entrypoint: text_at(&object, "/spec/entrypoint").unwrap_or_default(),
        images: image_slots(object.data.pointer("/spec").unwrap_or(&Value::Null)),
        age: age_of(&object),
        name: object.metadata.name.unwrap_or_default(),
    }
}

/// Reads everything the Argo Workflows screen shows, cluster-wide.
pub async fn overview(client: Client) -> Result<ArgoOverview, String> {
    let params = ListParams::default();
    let mut degraded = Vec::new();

    let workflows = api_all(client.clone(), "Workflow").list(&params).await;

    // A missing CRD means Argo Workflows is not installed; a 403 means it is and this
    // identity may not read it. Different answers, reported apart.
    if let Err(error) = &workflows {
        let reason = match error {
            kube::Error::Api(response) if response.code == 404 => {
                "Argo Workflows is not installed in this cluster — its custom resources are absent."
                    .to_string()
            }
            kube::Error::Api(response) if response.code == 403 => {
                "This identity may not read Argo workflows.".to_string()
            }
            other => crate::errors::humanize(&other.to_string()),
        };
        return Ok(ArgoOverview {
            installed: false,
            reason: Some(reason),
            workflows: Vec::new(),
            cron_workflows: Vec::new(),
            templates: Vec::new(),
            degraded_collectors: Vec::new(),
        });
    }

    let cron_api = api_all(client.clone(), "CronWorkflow");
    let template_api = api_all(client, "WorkflowTemplate");
    let (crons, templates) = tokio::join!(cron_api.list(&params), template_api.list(&params));

    let mut workflow_rows: Vec<WorkflowRow> =
        workflows.unwrap().items.into_iter().map(workflow_row).collect();
    // Newest first: the question is almost always about the latest run.
    workflow_rows.sort_by(|left, right| right.started_at.cmp(&left.started_at));

    let mut cron_rows: Vec<CronRow> = match crons {
        Ok(list) => list.items.into_iter().map(cron_row).collect(),
        Err(error) => {
            degraded.push(format!("Cron workflows could not be listed ({error})."));
            Vec::new()
        }
    };
    cron_rows.sort_by(|left, right| left.name.cmp(&right.name));

    let mut template_rows: Vec<TemplateRow> = match templates {
        Ok(list) => list.items.into_iter().map(template_row).collect(),
        Err(error) => {
            degraded.push(format!("Workflow templates could not be listed ({error})."));
            Vec::new()
        }
    };
    template_rows.sort_by(|left, right| left.name.cmp(&right.name));

    Ok(ArgoOverview {
        installed: true,
        reason: None,
        workflows: workflow_rows,
        cron_workflows: cron_rows,
        templates: template_rows,
        degraded_collectors: degraded,
    })
}

// ---------------------------------------------------------------- writes

/// Changes one image on a WorkflowTemplate or CronWorkflow.
///
/// Read fresh, verify, replace: the resourceVersion from the read travels with the
/// replace, so a concurrent editor gets a 409 instead of being overwritten.
pub async fn set_image(
    client: Client,
    kind: &str,
    namespace: &str,
    name: &str,
    template: &str,
    container: &str,
    expected: &str,
    new_image: &str,
) -> Result<(), String> {
    if kind != "WorkflowTemplate" && kind != "CronWorkflow" {
        return Err(format!("{kind} is not a kind whose image this screen edits."));
    }

    let api = api_in(client, namespace, kind);
    let mut object = api
        .get(name)
        .await
        .map_err(|error| crate::errors::humanize(&error.to_string()))?;

    set_image_in(&mut object.data, spec_root_pointer(kind), template, container, expected, new_image)?;

    api.replace(name, &PostParams::default(), &object)
        .await
        .map_err(|error| match &error {
            kube::Error::Api(response) if response.code == 409 => {
                "Someone changed this object while you were editing. Refresh and edit again."
                    .to_string()
            }
            other => crate::errors::humanize(&other.to_string()),
        })?;
    Ok(())
}

pub async fn set_cron_suspend(
    client: Client,
    namespace: &str,
    name: &str,
    suspend: bool,
) -> Result<(), String> {
    let api = api_in(client, namespace, "CronWorkflow");
    let patch = json!({ "spec": { "suspend": suspend } });
    api.patch(name, &crate::merge_patch_params(), &Patch::Merge(&patch))
        .await
        .map_err(|error| crate::errors::humanize(&error.to_string()))?;
    Ok(())
}

/// Starts a run from a WorkflowTemplate — what `argo submit --from` does, as a plain
/// create of a Workflow that references the template.
pub async fn submit_from_template(client: Client, namespace: &str, name: &str) -> Result<String, String> {
    let workflow = DynamicObject {
        types: Some(kube::core::TypeMeta {
            api_version: "argoproj.io/v1alpha1".to_string(),
            kind: "Workflow".to_string(),
        }),
        metadata: kube::core::ObjectMeta {
            generate_name: Some(format!("{name}-")),
            namespace: Some(namespace.to_string()),
            ..Default::default()
        },
        data: json!({ "spec": { "workflowTemplateRef": { "name": name } } }),
    };

    let created = api_in(client, namespace, "Workflow")
        .create(&PostParams::default(), &workflow)
        .await
        .map_err(|error| crate::errors::humanize(&error.to_string()))?;
    Ok(created.metadata.name.unwrap_or_else(|| format!("{name}-…")))
}

/// Stops a running workflow the way Argo defines it: `spec.shutdown: Stop` lets exit
/// handlers run, rather than deleting the object out from under them.
pub async fn stop_workflow(client: Client, namespace: &str, name: &str) -> Result<(), String> {
    let api = api_in(client, namespace, "Workflow");
    let patch = json!({ "spec": { "shutdown": "Stop" } });
    api.patch(name, &crate::merge_patch_params(), &Patch::Merge(&patch))
        .await
        .map_err(|error| crate::errors::humanize(&error.to_string()))?;
    Ok(())
}

pub async fn delete_workflow(client: Client, namespace: &str, name: &str) -> Result<(), String> {
    let api = api_in(client, namespace, "Workflow");
    api.delete(name, &DeleteParams::default())
        .await
        .map_err(|error| crate::errors::humanize(&error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> Value {
        json!({
            "entrypoint": "build",
            "templates": [
                { "name": "build", "container": { "image": "acme/builder:1.4.0" } },
                { "name": "scan", "script": { "image": "acme/scanner:2.0.1", "source": "echo hi" } },
                { "name": "publish", "containerSet": { "containers": [
                    { "name": "push", "image": "acme/pusher:3.1.0" },
                    { "name": "sign", "image": "acme/signer:1.0.0" }
                ]}},
                { "name": "flow", "steps": [[ { "name": "a", "template": "build" } ]] }
            ]
        })
    }

    #[test]
    fn every_image_is_found_with_its_place() {
        let slots = image_slots(&spec());
        assert_eq!(slots.len(), 4);
        assert!(slots.contains(&ImageSlot { template: "build".into(), container: "main".into(), image: "acme/builder:1.4.0".into() }));
        assert!(slots.contains(&ImageSlot { template: "scan".into(), container: "main".into(), image: "acme/scanner:2.0.1".into() }));
        assert!(slots.contains(&ImageSlot { template: "publish".into(), container: "sign".into(), image: "acme/signer:1.0.0".into() }));
    }

    #[test]
    fn a_steps_template_yields_no_slot_rather_than_a_broken_one() {
        let slots = image_slots(&spec());
        assert!(!slots.iter().any(|slot| slot.template == "flow"));
    }

    #[test]
    fn an_image_is_replaced_only_where_it_was_asked() {
        let mut data = json!({ "spec": spec() });
        set_image_in(&mut data, "/spec", "build", "main", "acme/builder:1.4.0", "acme/builder:1.5.0").unwrap();
        assert_eq!(
            data.pointer("/spec/templates/0/container/image").and_then(Value::as_str),
            Some("acme/builder:1.5.0")
        );
        // The other templates are untouched.
        assert_eq!(
            data.pointer("/spec/templates/1/script/image").and_then(Value::as_str),
            Some("acme/scanner:2.0.1")
        );
    }

    #[test]
    fn a_containerset_member_is_addressed_by_its_own_name() {
        let mut data = json!({ "spec": spec() });
        set_image_in(&mut data, "/spec", "publish", "sign", "acme/signer:1.0.0", "acme/signer:1.1.0").unwrap();
        assert_eq!(
            data.pointer("/spec/templates/2/containerSet/containers/1/image").and_then(Value::as_str),
            Some("acme/signer:1.1.0")
        );
    }

    #[test]
    fn a_stale_expectation_is_refused_with_both_values_named() {
        // Someone else already bumped the image; writing anyway would discard that.
        let mut data = json!({ "spec": spec() });
        let error = set_image_in(&mut data, "/spec", "build", "main", "acme/builder:1.3.9", "acme/builder:1.5.0")
            .unwrap_err();
        assert!(error.contains("acme/builder:1.4.0"));
        assert!(error.contains("acme/builder:1.3.9"));
        // And nothing was written.
        assert_eq!(
            data.pointer("/spec/templates/0/container/image").and_then(Value::as_str),
            Some("acme/builder:1.4.0")
        );
    }

    #[test]
    fn an_unknown_template_or_container_is_named_in_the_refusal() {
        let mut data = json!({ "spec": spec() });
        assert!(set_image_in(&mut data, "/spec", "missing", "main", "x", "y").unwrap_err().contains("missing"));
        assert!(set_image_in(&mut data, "/spec", "publish", "ghost", "x", "y").unwrap_err().contains("ghost"));
    }

    #[test]
    fn a_cron_workflow_nests_its_spec_one_level_down() {
        assert_eq!(spec_root_pointer("CronWorkflow"), "/spec/workflowSpec");
        assert_eq!(spec_root_pointer("WorkflowTemplate"), "/spec");

        let mut data = json!({ "spec": { "schedule": "0 2 * * *", "workflowSpec": spec() } });
        set_image_in(&mut data, "/spec/workflowSpec", "build", "main", "acme/builder:1.4.0", "acme/builder:2.0.0").unwrap();
        assert_eq!(
            data.pointer("/spec/workflowSpec/templates/0/container/image").and_then(Value::as_str),
            Some("acme/builder:2.0.0")
        );
    }

    #[test]
    fn phases_map_into_the_shared_vocabulary() {
        assert_eq!(phase_health("Succeeded", None, None).0, "good");
        assert_eq!(phase_health("Failed", Some("step build failed"), None).0, "critical");
        // The failure carries Argo's own message, not a generic sentence.
        assert!(phase_health("Failed", Some("step build failed"), None).1.contains("step build failed"));
        assert_eq!(phase_health("Running", None, Some("2/5")).0, "warning");
        assert!(phase_health("Running", None, Some("2/5")).1.contains("2/5"));
        assert_eq!(phase_health("Pending", None, None).0, "warning");
    }

    #[test]
    fn durations_read_in_the_unit_that_fits() {
        assert_eq!(
            duration_between(Some("2026-08-26T10:00:00Z"), Some("2026-08-26T10:00:42Z")),
            Some("42s".to_string())
        );
        assert_eq!(
            duration_between(Some("2026-08-26T10:00:00Z"), Some("2026-08-26T10:04:30Z")),
            Some("4m 30s".to_string())
        );
        assert_eq!(
            duration_between(Some("2026-08-26T10:00:00Z"), Some("2026-08-26T12:15:00Z")),
            Some("2h 15m".to_string())
        );
        // A run still going has no duration yet, rather than a fake one.
        assert_eq!(duration_between(Some("2026-08-26T10:00:00Z"), None), None);
    }
}
