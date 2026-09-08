//! Helm releases, read the way `helm list` reads them.
//!
//! Helm 3 keeps each release revision as a Secret of type `helm.sh/release.v1` in the
//! release's own namespace, labelled with the release name, status and revision. The
//! payload is the full release — chart metadata, the values the operator set, the
//! rendered manifest — as base64-wrapped gzipped JSON. Listing and inspecting need
//! nothing but the Kubernetes API the app already holds.
//!
//! Uninstall and rollback are different: a real uninstall runs the chart's delete
//! hooks, and faking one by deleting manifest objects would silently skip them. Those
//! two go through the operator's own `helm` CLI, which reads the same kubeconfig.

use base64::Engine;
use k8s_openapi::api::core::v1::Secret;
use kube::api::ListParams;
use kube::{Api, Client};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Read;

use crate::format_age;

const RELEASE_SECRET_TYPE: &str = "helm.sh/release.v1";

#[derive(Serialize, Clone)]
pub struct HelmOverview {
    pub releases: Vec<ReleaseRow>,
    /// The `helm` CLI version, when one is on PATH. Uninstall and rollback need it;
    /// reading does not.
    pub cli_version: Option<String>,
    pub degraded_collectors: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ReleaseRow {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub health: String,
    pub reason: String,
    pub revision: i64,
    pub revisions: usize,
    pub updated: String,
    pub updated_at: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct RevisionInfo {
    pub revision: i64,
    pub status: String,
    pub description: String,
    pub chart_version: String,
    pub updated: String,
}

#[derive(Serialize, Clone)]
pub struct ReleaseDetail {
    pub name: String,
    pub namespace: String,
    pub revision: i64,
    pub chart: String,
    pub chart_version: String,
    pub app_version: String,
    pub description: String,
    pub notes: String,
    /// The values the operator set, as YAML. Chart defaults are not repeated here.
    pub values_yaml: String,
    pub manifest: String,
    pub first_deployed: Option<String>,
    pub last_deployed: Option<String>,
    pub history: Vec<RevisionInfo>,
}

/// Maps a Helm status to the app's severity vocabulary.
///
/// The pending states matter most: they are Helm's lock, and a release stuck in one
/// refuses every later install and upgrade with "another operation is in progress".
pub fn status_health(status: &str) -> (&'static str, String) {
    match status {
        "deployed" => ("good", "Deployed.".to_string()),
        "failed" => (
            "critical",
            "The last install or upgrade failed. Its resources may be mixed between versions."
                .to_string(),
        ),
        "pending-install" | "pending-upgrade" | "pending-rollback" => (
            "serious",
            format!(
                "Stuck in {status}. This is Helm's lock: every new operation on this release is \
                 refused until it clears — usually by rolling back to the previous revision."
            ),
        ),
        "uninstalling" => ("warning", "Being uninstalled.".to_string()),
        "uninstalled" => (
            "warning",
            "Uninstalled but its history is kept. Uninstalling it again removes the history too."
                .to_string(),
        ),
        "superseded" => ("warning", "An old revision, replaced by a newer one.".to_string()),
        other => ("warning", format!("Status {other}.")),
    }
}

fn label<'a>(secret: &'a Secret, key: &str) -> Option<&'a str> {
    secret.metadata.labels.as_ref()?.get(key).map(String::as_str)
}

/// Groups release secrets into one row per release, current revision first-class.
///
/// The labels are authoritative for name, status and revision; parsing the secret name
/// would re-derive what Helm already wrote down.
pub fn release_rows(secrets: Vec<Secret>) -> Vec<ReleaseRow> {
    struct Latest {
        revision: i64,
        status: String,
        updated_at: Option<chrono::DateTime<chrono::Utc>>,
        count: usize,
    }
    let mut by_release: BTreeMap<(String, String), Latest> = BTreeMap::new();

    for secret in &secrets {
        let Some(name) = label(secret, "name") else { continue };
        let namespace = secret.metadata.namespace.clone().unwrap_or_default();
        let revision: i64 = label(secret, "version").and_then(|value| value.parse().ok()).unwrap_or(0);
        let status = label(secret, "status").unwrap_or("unknown").to_string();
        let created = secret.metadata.creation_timestamp.as_ref().map(|stamp| stamp.0);

        let entry = by_release
            .entry((namespace, name.to_string()))
            .or_insert(Latest { revision: -1, status: String::new(), updated_at: None, count: 0 });
        entry.count += 1;
        if revision > entry.revision {
            entry.revision = revision;
            entry.status = status;
            entry.updated_at = created;
        }
    }

    let mut rows: Vec<ReleaseRow> = by_release
        .into_iter()
        .map(|((namespace, name), latest)| {
            let (health, reason) = status_health(&latest.status);
            ReleaseRow {
                name,
                namespace,
                status: latest.status,
                health: health.to_string(),
                reason,
                revision: latest.revision,
                revisions: latest.count,
                updated: latest.updated_at.map(format_age).unwrap_or_default(),
                updated_at: latest.updated_at.map(|stamp| stamp.to_rfc3339()),
            }
        })
        .collect();

    // Worst first, then by name, so the list opens on what needs attention.
    rows.sort_by(|left, right| {
        crate::insights::severity_rank(&right.health)
            .cmp(&crate::insights::severity_rank(&left.health))
            .then_with(|| left.name.cmp(&right.name))
    });
    rows
}

/// Decodes one release payload: base64, then gzip, then JSON.
///
/// The Secret's `release` field already crossed one base64 layer when the API decoded
/// the Secret data; Helm wraps its own base64 inside that, around the gzip.
pub fn decode_release(raw: &[u8]) -> Result<serde_json::Value, String> {
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|error| format!("The release payload is not valid base64: {error}"))?;
    let mut decoder = flate2::read::GzDecoder::new(compressed.as_slice());
    let mut json = String::new();
    decoder
        .read_to_string(&mut json)
        .map_err(|error| format!("The release payload did not decompress: {error}"))?;
    serde_json::from_str(&json)
        .map_err(|error| format!("The release payload is not the JSON Helm writes: {error}"))
}

fn text(value: &serde_json::Value, pointer: &str) -> String {
    value.pointer(pointer).and_then(serde_json::Value::as_str).unwrap_or_default().to_string()
}

/// Reads releases in one API call — scoped to a namespace when one is given,
/// because listing every release Secret cluster-wide is what made the screen
/// slow on large clusters.
pub async fn overview(client: Client, namespace: Option<&str>) -> Result<HelmOverview, String> {
    let api: Api<Secret> = match namespace {
        Some(namespace) => Api::namespaced(client, namespace),
        None => Api::all(client),
    };
    // The owner label is how Helm itself finds its releases.
    let params = ListParams::default().labels("owner=helm");
    let list = api
        .list(&params)
        .await
        .map_err(|error| crate::errors::humanize(&error.to_string()))?;

    let secrets: Vec<Secret> = list
        .items
        .into_iter()
        .filter(|secret| secret.type_.as_deref() == Some(RELEASE_SECRET_TYPE))
        .collect();

    Ok(HelmOverview {
        releases: release_rows(secrets),
        cli_version: cli_version().await,
        degraded_collectors: Vec::new(),
    })
}

/// Reads one release in full: the current revision decoded, plus the whole history.
pub async fn detail(client: Client, namespace: &str, name: &str) -> Result<ReleaseDetail, String> {
    let api: Api<Secret> = Api::namespaced(client, namespace);
    let params = ListParams::default().labels(&format!("owner=helm,name={name}"));
    let list = api
        .list(&params)
        .await
        .map_err(|error| crate::errors::humanize(&error.to_string()))?;

    let mut revisions: Vec<(i64, Secret)> = list
        .items
        .into_iter()
        .filter(|secret| secret.type_.as_deref() == Some(RELEASE_SECRET_TYPE))
        .filter_map(|secret| {
            let revision: i64 = label(&secret, "version")?.parse().ok()?;
            Some((revision, secret))
        })
        .collect();
    revisions.sort_by_key(|(revision, _)| std::cmp::Reverse(*revision));

    let (current_revision, current) = revisions
        .first()
        .ok_or_else(|| format!("No Helm release named {name} exists in {namespace}."))?;

    let payload = current
        .data
        .as_ref()
        .and_then(|data| data.get("release"))
        .ok_or_else(|| format!("The release secret for {name} carries no payload."))?;
    let release = decode_release(&payload.0)?;

    // The operator's own values. An empty object means the chart ran on defaults,
    // which is worth saying rather than showing an empty pane.
    let values_yaml = match release.pointer("/config") {
        Some(config) if config.as_object().is_some_and(|map| !map.is_empty()) => {
            serde_yaml::to_string(config).unwrap_or_else(|_| "# unrenderable values".to_string())
        }
        _ => "# No overrides — this release runs on the chart's defaults.".to_string(),
    };

    // History decodes each revision but keeps only its summary — the manifests of old
    // revisions would multiply memory for nothing the history table shows.
    let history = revisions
        .iter()
        .map(|(revision, secret)| {
            let summary = secret
                .data
                .as_ref()
                .and_then(|data| data.get("release"))
                .and_then(|payload| decode_release(&payload.0).ok());
            RevisionInfo {
                revision: *revision,
                status: label(secret, "status").unwrap_or("unknown").to_string(),
                description: summary
                    .as_ref()
                    .map(|value| text(value, "/info/description"))
                    .unwrap_or_default(),
                chart_version: summary
                    .as_ref()
                    .map(|value| text(value, "/chart/metadata/version"))
                    .unwrap_or_default(),
                updated: secret
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|stamp| format_age(stamp.0))
                    .unwrap_or_default(),
            }
        })
        .collect();

    Ok(ReleaseDetail {
        name: name.to_string(),
        namespace: namespace.to_string(),
        revision: *current_revision,
        chart: text(&release, "/chart/metadata/name"),
        chart_version: text(&release, "/chart/metadata/version"),
        app_version: text(&release, "/chart/metadata/appVersion"),
        description: text(&release, "/info/description"),
        notes: text(&release, "/info/notes"),
        manifest: text(&release, "/manifest"),
        first_deployed: release
            .pointer("/info/first_deployed")
            .and_then(serde_json::Value::as_str)
            .map(String::from),
        last_deployed: release
            .pointer("/info/last_deployed")
            .and_then(serde_json::Value::as_str)
            .map(String::from),
        values_yaml,
        history,
    })
}

// ---------------------------------------------------------------- the CLI side

/// Runs the operator's helm binary with plain arguments — no shell, so nothing in a
/// release or context name is ever interpreted.
async fn run_helm(arguments: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("helm")
            .args(&arguments)
            .output()
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => "The helm CLI is not installed or not on PATH. \
                     Reading releases works without it; uninstall and rollback are helm's own \
                     operations and run through it."
                    .to_string(),
                other => format!("helm could not be started: {other}"),
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if output.status.success() {
            Ok(if stdout.is_empty() { stderr } else { stdout })
        } else {
            Err(if stderr.is_empty() { stdout } else { stderr })
        }
    })
    .await
    .map_err(|error| format!("helm task failed: {error}"))?
}

async fn cli_version() -> Option<String> {
    run_helm(vec!["version".into(), "--template".into(), "{{.Version}}".into()])
        .await
        .ok()
        .filter(|version| version.starts_with('v'))
}

/// A real uninstall: hooks run, history goes, exactly as `helm uninstall` defines it.
pub async fn uninstall(context: &str, namespace: &str, name: &str) -> Result<String, String> {
    run_helm(vec![
        "uninstall".into(),
        name.into(),
        "--namespace".into(),
        namespace.into(),
        "--kube-context".into(),
        context.into(),
    ])
    .await
}

/// Rolls back to a revision — also how a stuck pending lock is released.
pub async fn rollback(context: &str, namespace: &str, name: &str, revision: i64) -> Result<String, String> {
    run_helm(vec![
        "rollback".into(),
        name.into(),
        revision.to_string(),
        "--namespace".into(),
        namespace.into(),
        "--kube-context".into(),
        context.into(),
    ])
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn release_secret(name: &str, namespace: &str, revision: i64, status: &str) -> Secret {
        let mut secret = Secret::default();
        secret.metadata.name = Some(format!("sh.helm.release.v1.{name}.v{revision}"));
        secret.metadata.namespace = Some(namespace.to_string());
        secret.type_ = Some(RELEASE_SECRET_TYPE.to_string());
        let mut labels = std::collections::BTreeMap::new();
        labels.insert("owner".to_string(), "helm".to_string());
        labels.insert("name".to_string(), name.to_string());
        labels.insert("status".to_string(), status.to_string());
        labels.insert("version".to_string(), revision.to_string());
        secret.metadata.labels = Some(labels);
        secret
    }

    #[test]
    fn revisions_collapse_into_one_row_led_by_the_newest() {
        let rows = release_rows(vec![
            release_secret("checkout", "payments", 1, "superseded"),
            release_secret("checkout", "payments", 2, "superseded"),
            release_secret("checkout", "payments", 3, "deployed"),
        ]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].revision, 3);
        assert_eq!(rows[0].status, "deployed");
        assert_eq!(rows[0].revisions, 3);
    }

    #[test]
    fn the_same_release_name_in_two_namespaces_is_two_releases() {
        let rows = release_rows(vec![
            release_secret("redis", "payments", 1, "deployed"),
            release_secret("redis", "ledger", 4, "deployed"),
        ]);
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn broken_releases_sort_above_healthy_ones() {
        let rows = release_rows(vec![
            release_secret("aaa-fine", "payments", 1, "deployed"),
            release_secret("zzz-broken", "payments", 2, "failed"),
        ]);
        assert_eq!(rows[0].name, "zzz-broken");
    }

    #[test]
    fn a_pending_status_is_named_as_helms_lock() {
        // The stuck lock is the Helm problem operators actually hit.
        let (health, reason) = status_health("pending-upgrade");
        assert_eq!(health, "serious");
        assert!(reason.contains("lock"));
        assert!(reason.contains("rolling back"));
    }

    #[test]
    fn every_status_maps_into_the_shared_vocabulary() {
        assert_eq!(status_health("deployed").0, "good");
        assert_eq!(status_health("failed").0, "critical");
        assert_eq!(status_health("uninstalling").0, "warning");
        // Unknown is never silently healthy.
        assert_eq!(status_health("something-new").0, "warning");
    }

    #[test]
    fn a_release_payload_round_trips_through_the_double_encoding() {
        let release = serde_json::json!({
            "name": "checkout",
            "version": 3,
            "info": { "status": "deployed", "description": "Upgrade complete" },
            "chart": { "metadata": { "name": "checkout", "version": "5.2.1", "appVersion": "1.9.0" } },
            "config": { "replicaCount": 3 },
            "manifest": "---\nkind: Deployment\n"
        });
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(release.to_string().as_bytes()).unwrap();
        let gzipped = encoder.finish().unwrap();
        let wrapped = base64::engine::general_purpose::STANDARD.encode(gzipped);

        let decoded = decode_release(wrapped.as_bytes()).expect("decodes");
        assert_eq!(
            decoded.pointer("/chart/metadata/version").and_then(|value| value.as_str()),
            Some("5.2.1")
        );
        assert_eq!(
            decoded.pointer("/info/description").and_then(|value| value.as_str()),
            Some("Upgrade complete")
        );
    }

    #[test]
    fn a_payload_that_is_not_helms_says_which_layer_failed() {
        assert!(decode_release(b"not base64!!").unwrap_err().contains("base64"));
        let plain = base64::engine::general_purpose::STANDARD.encode("not gzip");
        assert!(decode_release(plain.as_bytes()).unwrap_err().contains("decompress"));
    }
}
