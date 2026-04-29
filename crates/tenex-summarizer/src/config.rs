use std::collections::HashMap;
use std::fs;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

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
                "no tenexPrivateKey in {} (run the bun setup once to provision a backend key)",
                paths::config_file().display()
            )
        })?;

        let llms = LlmsConfig::load();
        let providers = ProvidersConfig::load();
        let llm = LlmSelection::resolve(llms.as_ref(), providers.as_ref())?;

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

#[derive(Debug, Deserialize)]
struct LlmsConfig {
    configurations: HashMap<String, LlmEntry>,
    default: Option<String>,
    summarization: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LlmEntry {
    provider: String,
    model: String,
}

impl LlmsConfig {
    fn load() -> Option<Self> {
        let bytes = fs::read(paths::llms_file()).ok()?;
        serde_json::from_slice(&bytes).ok()
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ApiKeyValue {
    Single(String),
    List(Vec<String>),
}

impl ApiKeyValue {
    fn first(&self) -> &str {
        match self {
            ApiKeyValue::Single(s) => s.split_whitespace().next().unwrap_or(s),
            ApiKeyValue::List(v) => v
                .first()
                .map(|s| s.split_whitespace().next().unwrap_or(s))
                .unwrap_or(""),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ProviderEntry {
    #[serde(rename = "apiKey")]
    api_key: Option<ApiKeyValue>,
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProvidersConfig {
    providers: HashMap<String, ProviderEntry>,
}

impl ProvidersConfig {
    fn load() -> Option<Self> {
        let bytes = fs::read(paths::providers_file()).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    fn api_key(&self, provider: &str) -> Option<String> {
        let entry = self.providers.get(provider)?;
        let key = entry.api_key.as_ref()?.first();
        if key.is_empty() || key == "none" || key == "local" {
            None
        } else {
            Some(key.to_string())
        }
    }

    fn ollama_base_url(&self) -> Option<String> {
        let entry = self.providers.get("ollama")?;
        if let Some(url) = &entry.base_url {
            return Some(url.clone());
        }
        let key = entry.api_key.as_ref()?.first();
        if key.is_empty() || key == "none" || key == "local" {
            None
        } else {
            Some(key.to_string())
        }
    }
}

impl LlmSelection {
    fn resolve(llms: Option<&LlmsConfig>, providers: Option<&ProvidersConfig>) -> Result<Self> {
        let llms = llms
            .ok_or_else(|| anyhow!("{} is missing or unreadable", paths::llms_file().display()))?;

        let preset_name = llms
            .summarization
            .as_deref()
            .or(llms.default.as_deref())
            .ok_or_else(|| anyhow!("llms.json has neither `summarization` nor `default`"))?;

        let entry = llms
            .configurations
            .get(preset_name)
            .ok_or_else(|| anyhow!("llms.json: configuration `{preset_name}` not found"))?;

        let provider = entry.provider.clone();
        let model = entry.model.clone();
        let (api_key, base_url) = resolve_credentials(&provider, providers);
        Ok(Self {
            provider,
            model,
            api_key,
            base_url,
        })
    }
}

fn resolve_credentials(
    provider: &str,
    providers: Option<&ProvidersConfig>,
) -> (Option<String>, Option<String>) {
    if provider == "ollama" {
        let base = std::env::var("OLLAMA_API_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| providers.and_then(|p| p.ollama_base_url()));
        return (None, base);
    }
    let env_var = format!("{}_API_KEY", provider.to_uppercase().replace('-', "_"));
    let key = std::env::var(&env_var)
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| providers.and_then(|p| p.api_key(provider)));
    (key, None)
}
