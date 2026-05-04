use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::fs;
use std::path::Path;
use tenex_llm_config::key_health::KeyHealthTracker;
use tenex_llm_config::resolver::{resolved_config_default_standard, ConfigStore};
use tenex_llm_config::StandardConfig;
use tenex_telegram::config::TelegramAgentConfig;

#[derive(Debug, Deserialize)]
pub struct AgentDefault {
    pub model: Option<String>,
    pub skills: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct AgentConfig {
    pub name: String,
    /// Slug identifier used in identity prompt (e.g. "code-reviewer")
    pub slug: Option<String>,
    pub nsec: String,
    pub category: Option<String>,
    pub instructions: Option<String>,
    pub working_directory: Option<String>,
    pub default: Option<AgentDefault>,
    pub telegram: Option<TelegramAgentConfig>,
}

impl AgentConfig {
    pub fn load(path: &str) -> Result<Self> {
        let content = fs::read_to_string(path)
            .with_context(|| format!("Failed to read agent config: {path}"))?;
        serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse agent config: {path}"))
    }

    /// The identifier used in prompts — prefer slug over name.
    pub fn identity_name(&self) -> &str {
        self.slug.as_deref().unwrap_or(&self.name)
    }

    /// Raw model string from the config, before resolution.
    pub fn raw_model(&self) -> Option<&str> {
        self.default.as_ref().and_then(|d| d.model.as_deref())
    }
}

#[derive(Clone)]
pub struct ResolvedModel {
    pub provider: String,
    pub model: String,
    pub api_key: Option<String>,
    /// Base URL override, used by Ollama and OpenAI-compatible providers.
    pub base_url: Option<String>,
}

impl ResolvedModel {
    /// Resolve the effective provider, model ID, API key, and base URL.
    ///
    /// `tenex-llm-config` owns interpretation of `llms.json` and
    /// `providers.json`; the agent only passes the raw model reference from
    /// agent config or conversation state.
    pub fn resolve(base_dir: &Path, raw_model: Option<&str>) -> Result<Self> {
        let store = ConfigStore::load(base_dir)?;
        let config = store.resolve_model_reference(raw_model, &KeyHealthTracker::new())?;
        Ok(Self::from_standard(config))
    }

    /// Resolve a named role from `llms.json`, falling back to the `default`
    /// role when the requested role isn't assigned. Mirrors the pattern in
    /// `tenex-summarizer::config::LlmSelection::resolve`.
    pub fn resolve_role(base_dir: &Path, role: &str) -> Result<Self> {
        let store = ConfigStore::load(base_dir)?;
        let key_health = KeyHealthTracker::new();
        let resolved_role = if store.llms.roles.contains_key(role) {
            role
        } else if store.llms.roles.contains_key("default") {
            "default"
        } else {
            return Err(anyhow!(
                "llms.json has neither `{role}` nor `default` role"
            ));
        };
        let standard =
            resolved_config_default_standard(store.resolve_role(resolved_role, &key_health)?)?;
        Ok(Self::from_standard(standard))
    }

    fn from_standard(config: StandardConfig) -> Self {
        Self {
            provider: config.provider,
            model: config.model,
            api_key: config.api_keys.first().map(|key| key.key.clone()),
            base_url: config.base_url,
        }
    }
}
