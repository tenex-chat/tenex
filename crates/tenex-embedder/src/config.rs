//! Optional `~/.tenex/embedder.json` overrides for tuning constants.

use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EmbedderConfig {
    pub scan_interval_secs: Option<u64>,
    pub debounce_secs: Option<i64>,
    pub min_interval_ms: Option<i64>,
    pub embeddings_per_second: Option<f64>,
}

impl Default for EmbedderConfig {
    fn default() -> Self {
        Self {
            scan_interval_secs: None,
            debounce_secs: None,
            min_interval_ms: None,
            embeddings_per_second: None,
        }
    }
}

impl EmbedderConfig {
    pub fn load_from_base_dir(base: &Path) -> Self {
        let path = base.join("embedder.json");
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
}
