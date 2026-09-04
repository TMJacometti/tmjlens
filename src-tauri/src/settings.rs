use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The desktop build persists these next to the kubeconfig it manages. The web
/// build keeps only the shape: `load_settings` answers with a default so the
/// frontend boots unchanged; per-user settings move into tmjLite when they
/// earn an admin screen.
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
