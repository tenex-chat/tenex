use std::path::{Path, PathBuf};

use serde::Deserialize;
use tenex_llm_config::resolver::load_providers;

#[derive(Debug, Deserialize)]
struct EmbedDoc {
    provider: String,
    model: String,
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
}

impl EmbedDoc {
    fn load(base_dir: &Path) -> Option<Self> {
        let path = base_dir.join("embed.json");
        let content = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&content).ok()
    }
}

#[derive(Debug, Clone)]
pub struct EmbedConfig {
    pub provider: String,
    pub model: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl EmbedConfig {
    pub fn load() -> Option<Self> {
        Self::load_from_base_dir(&default_base_dir())
    }

    pub fn load_from_base_dir(base_dir: &Path) -> Option<Self> {
        let doc = EmbedDoc::load(base_dir)?;
        let providers = load_providers(base_dir).ok()?;

        let entry = providers.providers.get(&doc.provider);
        let api_key = entry
            .and_then(|e| e.api_keys.first())
            .map(|k| k.key.clone());
        let base_url = doc
            .base_url
            .or_else(|| entry.and_then(|e| e.base_url.clone()));

        Some(Self {
            provider: doc.provider,
            model: doc.model,
            api_key,
            base_url,
        })
    }
}

fn default_base_dir() -> PathBuf {
    if let Ok(base) = std::env::var("TENEX_BASE_DIR") {
        if !base.is_empty() {
            return PathBuf::from(base);
        }
    }
    dirs_next::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".tenex")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_from_base_dir_reads_embed_and_providers_under_that_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("embed.json"),
            r#"{"provider":"openai","model":"text-embedding-3-small"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("providers.json"),
            r#"{
              "providers": {
                "openai": {
                  "apiKey": "sk-test",
                  "baseUrl": "https://example.test/v1"
                }
              }
            }"#,
        )
        .unwrap();

        let config = EmbedConfig::load_from_base_dir(dir.path()).unwrap();
        assert_eq!(config.provider, "openai");
        assert_eq!(config.model, "text-embedding-3-small");
        assert_eq!(config.api_key.as_deref(), Some("sk-test"));
        assert_eq!(config.base_url.as_deref(), Some("https://example.test/v1"));
    }
}
