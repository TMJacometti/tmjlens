use kube::api::{Api, ListParams, PostParams};
use kube::core::{ApiResource, DynamicObject, GroupVersionKind};
use kube::Client;
use serde::Serialize;
use serde_json::{json, Value};

use crate::format_age;

/// Where Velero is installed by default. Every other namespace is discovered by
/// looking for the objects rather than by asking the operator to configure it.
const DEFAULT_NAMESPACE: &str = "velero";

fn resource(kind: &str) -> ApiResource {
    ApiResource::from_gvk(&GroupVersionKind::gvk("velero.io", "v1", kind))
}

fn api(client: Client, namespace: &str, kind: &str) -> Api<DynamicObject> {
    Api::namespaced_with(client, namespace, &resource(kind))
}

fn string_at(object: &DynamicObject, pointer: &str) -> Option<String> {
    object.data.pointer(pointer).and_then(Value::as_str).map(str::to_string)
}

fn number_at(object: &DynamicObject, pointer: &str) -> Option<i64> {
    object.data.pointer(pointer).and_then(Value::as_i64)
}

fn strings_at(object: &DynamicObject, pointer: &str) -> Vec<String> {
    object
        .data
        .pointer(pointer)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Velero writes a phase on every object it manages. Mapping it to the app's own
/// severity keeps one vocabulary across screens.
fn phase_health(phase: &str) -> &'static str {
    match phase {
        "Completed" | "Available" | "New" => "good",
        "InProgress" | "WaitingForPluginOperations" | "Finalizing" => "warning",
        "PartiallyFailed" | "Unavailable" => "serious",
        "Failed" | "FailedValidation" | "Deleting" => "critical",
        _ => "warning",
    }
}

#[derive(Serialize, Clone)]
pub struct VeleroStatus {
    pub installed: bool,
    pub namespace: String,
    /// Why Velero could not be read, when it could not.
    pub reason: Option<String>,
    pub backups: Vec<BackupRow>,
    pub restores: Vec<RestoreRow>,
    pub schedules: Vec<ScheduleRow>,
    pub locations: Vec<StorageLocation>,
    pub degraded_collectors: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct BackupRow {
    pub name: String,
    pub phase: String,
    pub health: String,
    pub included_namespaces: Vec<String>,
    pub storage_location: Option<String>,
    pub started: Option<String>,
    pub completed: Option<String>,
    pub expires: Option<String>,
    pub age: String,
    pub items_backed_up: Option<i64>,
    pub errors: i64,
    pub warnings: i64,
    /// Set when the backup finished but is not safe to rely on.
    pub caveat: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct RestoreRow {
    pub name: String,
    pub backup: Option<String>,
    pub phase: String,
    pub health: String,
    pub started: Option<String>,
    pub completed: Option<String>,
    pub age: String,
    pub errors: i64,
    pub warnings: i64,
}

#[derive(Serialize, Clone)]
pub struct ScheduleRow {
    pub name: String,
    pub cron: String,
    pub paused: bool,
    pub last_backup: Option<String>,
    pub phase: String,
    pub health: String,
    pub age: String,
}

#[derive(Serialize, Clone)]
pub struct StorageLocation {
    pub name: String,
    pub provider: String,
    pub bucket: Option<String>,
    pub prefix: Option<String>,
    pub phase: String,
    pub health: String,
    pub is_default: bool,
    pub last_synced: Option<String>,
    pub access_mode: Option<String>,
}

fn age_of(object: &DynamicObject) -> String {
    object
        .metadata
        .creation_timestamp
        .as_ref()
        .map(|stamp| format_age(stamp.0))
        .unwrap_or_else(|| "n/a".to_string())
}

fn backup_row(object: DynamicObject) -> BackupRow {
    let phase = string_at(&object, "/status/phase").unwrap_or_else(|| "Unknown".to_string());
    let errors = number_at(&object, "/status/errors").unwrap_or(0);
    let warnings = number_at(&object, "/status/warnings").unwrap_or(0);

    // A PartiallyFailed backup exists and can be restored from, but it does not
    // contain everything that was asked for. Saying so is the point.
    let caveat = match phase.as_str() {
        "PartiallyFailed" => Some(format!(
            "Finished with {errors} error(s): some resources are missing from this backup."
        )),
        "Failed" | "FailedValidation" => Some("This backup did not complete. Do not restore from it.".to_string()),
        _ if warnings > 0 => Some(format!("{warnings} warning(s) during backup.")),
        _ => None,
    };

    BackupRow {
        age: age_of(&object),
        included_namespaces: {
            let listed = strings_at(&object, "/spec/includedNamespaces");
            // Velero treats an empty list, and `*`, as "everything".
            if listed.is_empty() || listed.iter().any(|entry| entry == "*") {
                vec!["all namespaces".to_string()]
            } else {
                listed
            }
        },
        storage_location: string_at(&object, "/spec/storageLocation"),
        started: string_at(&object, "/status/startTimestamp"),
        completed: string_at(&object, "/status/completionTimestamp"),
        expires: string_at(&object, "/status/expiration"),
        items_backed_up: number_at(&object, "/status/progress/itemsBackedUp"),
        health: phase_health(&phase).to_string(),
        name: object.metadata.name.unwrap_or_default(),
        phase,
        errors,
        warnings,
        caveat,
    }
}

fn restore_row(object: DynamicObject) -> RestoreRow {
    let phase = string_at(&object, "/status/phase").unwrap_or_else(|| "Unknown".to_string());
    RestoreRow {
        age: age_of(&object),
        backup: string_at(&object, "/spec/backupName"),
        started: string_at(&object, "/status/startTimestamp"),
        completed: string_at(&object, "/status/completionTimestamp"),
        errors: number_at(&object, "/status/errors").unwrap_or(0),
        warnings: number_at(&object, "/status/warnings").unwrap_or(0),
        health: phase_health(&phase).to_string(),
        name: object.metadata.name.unwrap_or_default(),
        phase,
    }
}

fn schedule_row(object: DynamicObject) -> ScheduleRow {
    let phase = string_at(&object, "/status/phase").unwrap_or_else(|| "Unknown".to_string());
    let paused = object
        .data
        .pointer("/spec/paused")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    ScheduleRow {
        age: age_of(&object),
        cron: string_at(&object, "/spec/schedule").unwrap_or_default(),
        last_backup: string_at(&object, "/status/lastBackup"),
        // A paused schedule is not failing, but it is also not protecting anything.
        health: if paused { "warning" } else { phase_health(&phase) }.to_string(),
        name: object.metadata.name.unwrap_or_default(),
        phase,
        paused,
    }
}

/// Reads a BackupStorageLocation. The bucket and prefix come from the object, and
/// its phase is Velero's own verdict on whether that bucket is reachable.
impl StorageLocation {
    fn fill(self, object: DynamicObject, phase: String) -> Self {
        StorageLocation {
            is_default: object
                .data
                .pointer("/spec/default")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            provider: string_at(&object, "/spec/provider").unwrap_or_else(|| "unknown".to_string()),
            bucket: string_at(&object, "/spec/objectStorage/bucket"),
            prefix: string_at(&object, "/spec/objectStorage/prefix"),
            last_synced: string_at(&object, "/status/lastSyncedTime"),
            access_mode: string_at(&object, "/spec/accessMode"),
            health: phase_health(&phase).to_string(),
            name: object.metadata.name.unwrap_or_default(),
            phase,
        }
    }
}

impl Default for StorageLocation {
    fn default() -> Self {
        Self {
            name: String::new(),
            provider: String::new(),
            bucket: None,
            prefix: None,
            phase: String::new(),
            health: String::new(),
            is_default: false,
            last_synced: None,
            access_mode: None,
        }
    }
}

/// Reads everything the Velero screen shows.
///
/// No object-storage credential is involved. Velero keeps backup metadata as custom
/// resources in the cluster, and the bucket only holds the archives — so listing works
/// under the same RBAC as the rest of the app, and works the same on S3, Azure Blob
/// or GCS. The storage location's own status is what reports whether the bucket is
/// reachable, which Velero itself determines.
pub async fn status(client: Client, namespace: Option<String>) -> Result<VeleroStatus, String> {
    let namespace = namespace.unwrap_or_else(|| DEFAULT_NAMESPACE.to_string());
    let params = ListParams::default();
    let mut degraded = Vec::new();

    let backups = api(client.clone(), &namespace, "Backup").list(&params).await;

    // A missing CRD means Velero is not installed here; a 403 means it is, and this
    // identity may not read it. Those are different answers and are reported apart.
    if let Err(error) = &backups {
        let reason = match error {
            kube::Error::Api(response) if response.code == 404 => format!(
                "Velero is not installed in this cluster, or its custom resources are absent \
                 (looked in namespace {namespace})."
            ),
            kube::Error::Api(response) if response.code == 403 => format!(
                "This identity may not read Velero backups in namespace {namespace}."
            ),
            other => crate::errors::humanize(&other.to_string()),
        };
        return Ok(VeleroStatus {
            installed: false,
            namespace,
            reason: Some(reason),
            backups: Vec::new(),
            restores: Vec::new(),
            schedules: Vec::new(),
            locations: Vec::new(),
            degraded_collectors: Vec::new(),
        });
    }

    let restore_api = api(client.clone(), &namespace, "Restore");
    let schedule_api = api(client.clone(), &namespace, "Schedule");
    let location_api = api(client, &namespace, "BackupStorageLocation");
    let (restores, schedules, locations) = tokio::join!(
        restore_api.list(&params),
        schedule_api.list(&params),
        location_api.list(&params),
    );

    let mut backup_rows: Vec<BackupRow> = backups.unwrap().items.into_iter().map(backup_row).collect();
    // Newest first: the question is almost always about the most recent one.
    backup_rows.sort_by(|left, right| right.started.cmp(&left.started));

    let mut restore_rows: Vec<RestoreRow> = match restores {
        Ok(list) => list.items.into_iter().map(restore_row).collect(),
        Err(error) => {
            degraded.push(format!("Restores could not be listed ({error})."));
            Vec::new()
        }
    };
    restore_rows.sort_by(|left, right| right.started.cmp(&left.started));

    let schedule_rows = match schedules {
        Ok(list) => list.items.into_iter().map(schedule_row).collect(),
        Err(error) => {
            degraded.push(format!("Schedules could not be listed ({error})."));
            Vec::new()
        }
    };

    let location_rows = match locations {
        Ok(list) => list.items.into_iter().map(|object| {
            let phase = string_at(&object, "/status/phase").unwrap_or_else(|| "Unknown".to_string());
            StorageLocation::default().fill(object, phase)
        }).collect(),
        Err(error) => {
            degraded.push(format!("Backup storage locations could not be listed ({error})."));
            Vec::new()
        }
    };

    Ok(VeleroStatus {
        installed: true,
        namespace,
        reason: None,
        backups: backup_rows,
        restores: restore_rows,
        schedules: schedule_rows,
        locations: location_rows,
        degraded_collectors: degraded,
    })
}

/// Creates a Backup. Velero's controller does the work; this only asks for it.
pub async fn create_backup(
    client: Client,
    namespace: &str,
    name: &str,
    included_namespaces: Vec<String>,
    ttl_hours: u32,
    storage_location: Option<String>,
    include_volumes: bool,
) -> Result<String, String> {
    let mut spec = json!({
        "ttl": format!("{ttl_hours}h0m0s"),
        "includedNamespaces": if included_namespaces.is_empty() { vec!["*".to_string()] } else { included_namespaces },
        // Off by default: snapshotting volumes needs a working volume plugin and
        // costs real money, so it is opted into rather than assumed.
        "snapshotVolumes": include_volumes,
    });
    if let Some(location) = storage_location {
        spec["storageLocation"] = json!(location);
    }

    let object = DynamicObject {
        types: Some(kube::core::TypeMeta {
            api_version: "velero.io/v1".to_string(),
            kind: "Backup".to_string(),
        }),
        metadata: kube::core::ObjectMeta {
            name: Some(name.to_string()),
            namespace: Some(namespace.to_string()),
            ..Default::default()
        },
        data: json!({ "spec": spec }),
    };

    let created = api(client, namespace, "Backup")
        .create(&PostParams::default(), &object)
        .await
        .map_err(|error| match &error {
            kube::Error::Api(response) if response.code == 409 => {
                format!("A backup named {name} already exists.")
            }
            kube::Error::Api(response) if response.code == 403 => {
                "This identity may not create Velero backups.".to_string()
            }
            other => crate::errors::humanize(&other.to_string()),
        })?;

    Ok(created.metadata.name.unwrap_or_else(|| name.to_string()))
}

/// Creates a Restore from an existing backup.
pub async fn create_restore(
    client: Client,
    namespace: &str,
    name: &str,
    backup_name: &str,
    included_namespaces: Vec<String>,
) -> Result<String, String> {
    let mut spec = json!({ "backupName": backup_name });
    if !included_namespaces.is_empty() {
        spec["includedNamespaces"] = json!(included_namespaces);
    }

    let object = DynamicObject {
        types: Some(kube::core::TypeMeta {
            api_version: "velero.io/v1".to_string(),
            kind: "Restore".to_string(),
        }),
        metadata: kube::core::ObjectMeta {
            name: Some(name.to_string()),
            namespace: Some(namespace.to_string()),
            ..Default::default()
        },
        data: json!({ "spec": spec }),
    };

    let created = api(client, namespace, "Restore")
        .create(&PostParams::default(), &object)
        .await
        .map_err(|error| match &error {
            kube::Error::Api(response) if response.code == 409 => {
                format!("A restore named {name} already exists.")
            }
            kube::Error::Api(response) if response.code == 403 => {
                "This identity may not create Velero restores.".to_string()
            }
            other => crate::errors::humanize(&other.to_string()),
        })?;

    Ok(created.metadata.name.unwrap_or_else(|| name.to_string()))
}

/// Velero requires a DNS-1123 name, and a rejected name after a long form is filled in
/// is a poor way to find that out.
pub fn suggest_name(prefix: &str, stamp: &str) -> String {
    let cleaned: String = prefix
        .to_lowercase()
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() { character } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    let base = if trimmed.is_empty() { "manual" } else { trimmed };
    // Trimmed again after truncating, so a cut that lands on a dash does not leave one
    // dangling before the timestamp. Every character here is ASCII, so slicing is safe.
    let truncated = base[..base.len().min(40)].trim_end_matches('-');
    let truncated = if truncated.is_empty() { "manual" } else { truncated };
    format!("{truncated}-{stamp}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_velero_phase_to_one_vocabulary() {
        assert_eq!(phase_health("Completed"), "good");
        assert_eq!(phase_health("Available"), "good");
        assert_eq!(phase_health("InProgress"), "warning");
        assert_eq!(phase_health("PartiallyFailed"), "serious");
        assert_eq!(phase_health("Failed"), "critical");
        assert_eq!(phase_health("FailedValidation"), "critical");
        // An unknown phase is not silently treated as healthy.
        assert_eq!(phase_health("SomethingNew"), "warning");
    }

    #[test]
    fn suggested_names_are_dns_safe() {
        assert_eq!(suggest_name("payments", "20260819-1400"), "payments-20260819-1400");
        assert_eq!(suggest_name("My Namespace", "x"), "my-namespace-x");
        assert_eq!(suggest_name("arn:aws:eks", "x"), "arn-aws-eks-x");
        // Leading and trailing separators are invalid in a DNS-1123 name.
        assert_eq!(suggest_name("---", "x"), "manual-x");
        assert_eq!(suggest_name("", "x"), "manual-x");
    }

    #[test]
    fn a_long_prefix_is_truncated_rather_than_rejected_by_the_server() {
        let name = suggest_name(&"a".repeat(120), "stamp");
        assert!(name.starts_with(&"a".repeat(40)));
        assert!(name.ends_with("-stamp"));
    }
}
