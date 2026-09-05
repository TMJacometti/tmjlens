use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The desktop build persists these next to the kubeconfig it manages. The web
/// build never writes them: the instance environment comes from
/// `TMJLENS_ENVIRONMENT` at install time.
#[derive(Serialize, Deserialize, Clone)]
pub struct AppSettings {
    /// Context name → environment id. Never holds anything from the cluster itself.
    #[serde(default)]
    pub context_environments: BTreeMap<String, String>,
    #[serde(default = "default_true")]
    pub confirm_destructive_in_production: bool,
}

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

/// Maps the install-time string onto the four ids the UI already knows.
/// Anything unrecognised becomes production: the confirmation prompt is the
/// safe default, not a silent "this is fine to break".
pub fn normalize_environment(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "production" | "prod" | "prd" => "production".into(),
        "staging" | "hml" | "homolog" | "homologation" => "staging".into(),
        "development" | "dev" => "development".into(),
        _ => "production".into(),
    }
}

pub fn environment_from_env() -> String {
    std::env::var("TMJLENS_ENVIRONMENT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| normalize_environment(&value))
        .unwrap_or_else(|| "production".into())
}

#[cfg(test)]
mod tests {
    use super::normalize_environment;

    #[test]
    fn aliases_collapse_onto_the_three_real_environments() {
        assert_eq!(normalize_environment("Production"), "production");
        assert_eq!(normalize_environment("prd"), "production");
        assert_eq!(normalize_environment("Staging"), "staging");
        assert_eq!(normalize_environment("hml"), "staging");
        assert_eq!(normalize_environment("Dev"), "development");
        assert_eq!(normalize_environment("development"), "development");
    }

    #[test]
    fn an_unknown_value_is_treated_as_production() {
        assert_eq!(normalize_environment("lab"), "production");
        assert_eq!(normalize_environment(""), "production");
    }
}
