use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// How a context is classified by the operator. Purely a local label — it grants and
/// restricts nothing, it only makes the blast radius of an action visible before it runs.
pub const ENVIRONMENTS: [&str; 4] = ["production", "staging", "development", "unset"];

#[derive(Serialize, Deserialize, Clone)]
pub struct AppSettings {
    /// Context name → environment id. Never holds anything from the cluster itself.
    #[serde(default)]
    pub context_environments: BTreeMap<String, String>,
    #[serde(default = "default_true")]
    pub confirm_destructive_in_production: bool,
}

/// Written by hand rather than derived: `#[serde(default = …)]` only applies when
/// deserialising, so a derived Default would start the safety prompt switched off.
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            context_environments: BTreeMap::new(),
            confirm_destructive_in_production: true,
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Clone)]
pub struct KubeconfigView {
    pub path: Option<String>,
    /// False when KUBECONFIG merges several files: the merged result has no single
    /// file to write back to, so edits are refused rather than silently guessed.
    pub writable: bool,
    pub read_only_reason: Option<String>,
    pub current_context: Option<String>,
    pub contexts: Vec<KubeContextDetail>,
}

#[derive(Serialize, Clone)]
pub struct KubeContextDetail {
    pub name: String,
    pub current: bool,
    pub cluster: String,
    pub user: String,
    pub namespace: Option<String>,
    pub server: Option<String>,
    /// The authentication *method*, never the material behind it.
    pub auth_method: String,
    pub environment: String,
}

fn settings_file(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

pub fn load(config_dir: &Path) -> AppSettings {
    // A missing or corrupt settings file must never block the app: preferences are
    // conveniences, and losing them is cheaper than refusing to start.
    std::fs::read_to_string(settings_file(config_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(config_dir: &Path, settings: &AppSettings) -> Result<(), String> {
    std::fs::create_dir_all(config_dir)
        .map_err(|error| format!("Unable to create {}: {error}", config_dir.display()))?;
    let target = settings_file(config_dir);
    let body = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    write_atomically(&target, &body)
}

/// Writes through a sibling temp file and renames over the target, so an interrupted
/// write leaves the original intact rather than a half-written file.
pub fn write_atomically(target: &Path, body: &str) -> Result<(), String> {
    let temp = target.with_extension("tmp");
    std::fs::write(&temp, body).map_err(|error| format!("Unable to write {}: {error}", temp.display()))?;
    std::fs::rename(&temp, target).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("Unable to replace {}: {error}", target.display())
    })
}

/// Resolves the single kubeconfig file that edits should be applied to.
///
/// `KUBECONFIG` may list several files. kubectl merges them for reading but writes
/// only to the first; rather than reproduce that subtlety silently, a merged
/// configuration is reported as read-only.
pub fn resolve_path() -> (Option<PathBuf>, bool, Option<String>) {
    let separator = if cfg!(windows) { ';' } else { ':' };

    if let Ok(value) = std::env::var("KUBECONFIG") {
        let entries: Vec<&str> = value.split(separator).filter(|entry| !entry.trim().is_empty()).collect();
        return match entries.len() {
            0 => (default_path(), default_path().is_some(), None),
            1 => (Some(PathBuf::from(entries[0])), true, None),
            count => (
                Some(PathBuf::from(entries[0])),
                false,
                Some(format!(
                    "KUBECONFIG merges {count} files. tmjLens will not guess which one to edit, so this view is read-only."
                )),
            ),
        };
    }

    match default_path() {
        Some(path) => (Some(path), true, None),
        None => (None, false, Some("No kubeconfig was found. Set KUBECONFIG or create ~/.kube/config.".to_string())),
    }
}

fn default_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".kube").join("config"))
        .filter(|path| path.exists())
}

/// Reports which credential mechanism a user entry uses, without reading its value.
fn auth_method(config: &Kubeconfig, user_name: &str) -> String {
    let Some(named) = config.auth_infos.iter().find(|entry| entry.name == user_name) else {
        return "none".to_string();
    };
    let Some(info) = named.auth_info.as_ref() else {
        return "none".to_string();
    };

    if info.exec.is_some() {
        return "exec plugin".to_string();
    }
    if info.token.is_some() || info.token_file.is_some() {
        return "token".to_string();
    }
    if info.client_certificate.is_some() || info.client_certificate_data.is_some() {
        return "client certificate".to_string();
    }
    if info.username.is_some() {
        return "basic auth".to_string();
    }
    if info.auth_provider.is_some() {
        return "auth provider".to_string();
    }
    "none".to_string()
}

pub fn read_view(settings: &AppSettings) -> Result<KubeconfigView, String> {
    let (path, writable, reason) = resolve_path();

    // Read merged, exactly as the client does, so the list matches what actually works.
    let config = Kubeconfig::read().map_err(|error| format!("Unable to read kubeconfig: {error}"))?;
    let current = config.current_context.clone();

    let contexts = config
        .contexts
        .iter()
        .map(|named| {
            let context = named.context.as_ref();
            let cluster = context.map(|value| value.cluster.clone()).unwrap_or_default();
            let user = context.map(|value| value.user.clone()).unwrap_or_default();
            let server = config
                .clusters
                .iter()
                .find(|entry| entry.name == cluster)
                .and_then(|entry| entry.cluster.as_ref())
                .and_then(|entry| entry.server.clone());

            KubeContextDetail {
                current: current.as_deref() == Some(named.name.as_str()),
                environment: settings
                    .context_environments
                    .get(&named.name)
                    .cloned()
                    .unwrap_or_else(|| "unset".to_string()),
                auth_method: auth_method(&config, &user),
                namespace: context.and_then(|value| value.namespace.clone()).filter(|value| !value.is_empty()),
                name: named.name.clone(),
                cluster,
                user,
                server,
            }
        })
        .collect();

    Ok(KubeconfigView {
        path: path.map(|path| path.to_string_lossy().to_string()),
        writable,
        read_only_reason: reason,
        current_context: current,
        contexts,
    })
}

fn load_editable() -> Result<(PathBuf, Kubeconfig), String> {
    let (path, writable, reason) = resolve_path();
    if !writable {
        return Err(reason.unwrap_or_else(|| "This kubeconfig cannot be edited.".to_string()));
    }
    let path = path.ok_or_else(|| "No kubeconfig file to edit.".to_string())?;
    let config = Kubeconfig::read_from(&path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    Ok((path, config))
}

/// Backs the file up before replacing it. The kubeconfig is shared with kubectl, so a
/// bad write breaks more than this app — the copy is the undo.
fn persist(path: &Path, config: &Kubeconfig) -> Result<(), String> {
    let body = serde_yaml::to_string(config).map_err(|error| format!("Unable to serialise kubeconfig: {error}"))?;
    let backup = path.with_extension("tmjlens.bak");
    std::fs::copy(path, &backup)
        .map_err(|error| format!("Unable to back up to {}: {error}", backup.display()))?;
    write_atomically(path, &body)
}

pub fn set_current_context(name: &str) -> Result<(), String> {
    let (path, mut config) = load_editable()?;
    if !config.contexts.iter().any(|entry| entry.name == name) {
        return Err(format!("No context named {name} exists in this kubeconfig."));
    }
    config.current_context = Some(name.to_string());
    persist(&path, &config)
}

pub fn set_context_namespace(context: &str, namespace: Option<String>) -> Result<(), String> {
    let (path, mut config) = load_editable()?;
    let entry = config
        .contexts
        .iter_mut()
        .find(|entry| entry.name == context)
        .ok_or_else(|| format!("No context named {context} exists in this kubeconfig."))?;
    let target = entry
        .context
        .as_mut()
        .ok_or_else(|| format!("Context {context} has no body to edit."))?;
    target.namespace = namespace.filter(|value| !value.trim().is_empty());
    persist(&path, &config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_every_unlisted_context_to_unset() {
        let settings = AppSettings::default();
        assert!(settings.context_environments.is_empty());
        assert!(settings.confirm_destructive_in_production);
    }

    #[test]
    fn round_trips_settings_through_json() {
        let mut settings = AppSettings::default();
        settings.context_environments.insert("prod-shark".into(), "production".into());
        let raw = serde_json::to_string(&settings).unwrap();
        let parsed: AppSettings = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.context_environments.get("prod-shark").unwrap(), "production");
    }

    #[test]
    fn tolerates_a_corrupt_settings_file() {
        let dir = std::env::temp_dir().join("tmjlens-settings-corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(settings_file(&dir), "{ not json").unwrap();
        // A broken preferences file must degrade to defaults, never block startup.
        assert!(load(&dir).context_environments.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writes_atomically_without_leaving_a_temp_file() {
        let dir = std::env::temp_dir().join("tmjlens-atomic");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("value.json");
        write_atomically(&target, "first").unwrap();
        write_atomically(&target, "second").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "second");
        assert!(!target.with_extension("tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn every_environment_id_is_known() {
        assert!(ENVIRONMENTS.contains(&"production"));
        assert!(ENVIRONMENTS.contains(&"unset"));
        assert_eq!(ENVIRONMENTS.len(), 4);
    }
}
