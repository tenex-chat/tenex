use std::fs;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use tenex_llm_config::key_health::KeyHealthTracker;
use tenex_llm_config::resolver::{resolved_config_default_standard, ConfigStore};

use crate::paths;

const DEFAULT_RELAYS: &[&str] = &["wss://relay.tenex.chat"];

pub struct Config {
    pub relays: Vec<String>,
    pub backend_secret_key: String,
    pub llm: LlmSelection,
}

impl Config {
    pub fn load() -> Result<Self> {
        let global = GlobalConfig::load()?;

        let relays = if global.relays.is_empty() {
            DEFAULT_RELAYS.iter().map(|s| s.to_string()).collect()
        } else {
            global
                .relays
                .into_iter()
                .filter(|u| u.starts_with("ws://") || u.starts_with("wss://"))
                .collect::<Vec<_>>()
        };
        if relays.is_empty() {
            return Err(anyhow!("no valid relays configured"));
        }

        let backend_secret_key = global.tenex_private_key.ok_or_else(|| {
            anyhow!(
                "no tenexPrivateKey in {} (run `tenex onboard` to provision a backend key)",
                paths::config_file().display()
            )
        })?;

        let llm = LlmSelection::resolve()?;

        Ok(Self {
            relays,
            backend_secret_key,
            llm,
        })
    }
}

#[derive(Debug, Deserialize)]
struct GlobalConfig {
    #[serde(default)]
    relays: Vec<String>,
    #[serde(rename = "tenexPrivateKey")]
    tenex_private_key: Option<String>,
}

impl GlobalConfig {
    fn load() -> Result<Self> {
        let path = paths::config_file();
        let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
    }
}

pub struct LlmSelection {
    pub provider: String,
    pub model: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl LlmSelection {
    fn resolve() -> Result<Self> {
        let store = ConfigStore::load(&paths::base_dir())?;
        let resolved =
            store.resolve_role_or_default("summarization", &KeyHealthTracker::new())?;
        let standard = resolved_config_default_standard(resolved)?;
        Ok(Self {
            provider: standard.provider,
            model: standard.model,
            api_key: standard.api_keys.first().map(|key| key.key.clone()),
            base_url: standard.base_url,
        })
    }
}
