use anyhow::{Context, Result};
use serde::Deserialize;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tenex_llm_config::key_health::KeyHealthTracker;
use tenex_llm_config::resolver::{resolved_config_default_standard, ConfigStore};
use tenex_llm_config::{ApiKey, ResolvedConfig, StandardConfig};
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
    /// Every API key configured for this provider that was healthy at the
    /// moment of resolution. Each entry carries its original index in the
    /// provider's credential array so retry callers can report per-key
    /// failures back to [`Self::key_health`].
    pub api_keys: Vec<ApiKey>,
    /// Base URL override, used by Ollama and OpenAI-compatible providers.
    pub base_url: Option<String>,
    /// Shared per-process health tracker. Clones of `ResolvedModel` share the
    /// same tracker so a key marked failed during one LLM call is skipped on
    /// the next one — including calls made through cloned models in tools.
    pub key_health: Arc<KeyHealthTracker>,
}

impl ResolvedModel {
    /// Resolve the effective provider, model ID, API keys, and base URL.
    ///
    /// `tenex-llm-config` owns interpretation of `llms.json` and
    /// `providers.json`; the agent only passes the raw model reference from
    /// agent config or conversation state.
    pub fn resolve(
        base_dir: &Path,
        raw_model: Option<&str>,
        key_health: Arc<KeyHealthTracker>,
    ) -> Result<Self> {
        let store = ConfigStore::load(base_dir)?;
        let config = store.resolve_model_reference(raw_model, &key_health)?;
        Ok(Self::from_standard(config, key_health))
    }

    /// Resolve the agent's base config and select a specific variant from a
    /// meta config. When `variant_override` is `None`, behaves identically to
    /// [`resolve`]. When `variant_override` is `Some(name)`, the base config
    /// must resolve to a [`ResolvedConfig::Meta`] containing that variant.
    pub fn resolve_with_variant(
        base_dir: &Path,
        raw_model: Option<&str>,
        variant_override: Option<&str>,
        key_health: Arc<KeyHealthTracker>,
    ) -> Result<Self> {
        let Some(variant_name) = variant_override else {
            return Self::resolve(base_dir, raw_model, key_health);
        };

        let store = ConfigStore::load(base_dir)?;
        let resolved_config = resolve_to_resolved_config(&store, raw_model, &key_health)?;

        match resolved_config {
            ResolvedConfig::Meta(meta) => {
                let variant = meta.variants.get(variant_name).ok_or_else(|| {
                    anyhow::anyhow!(
                        "variant '{}' not found in meta config (available: {})",
                        variant_name,
                        meta.variants
                            .keys()
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                })?;
                Ok(Self::from_standard(variant.resolved.clone(), key_health))
            }
            _ => Err(anyhow::anyhow!(
                "variant override '{}' specified but the agent's base model is not a meta configuration",
                variant_name,
            )),
        }
    }

    /// Resolve a named role from `llms.json`, falling back to the `default`
    /// role when the requested role isn't assigned.
    pub fn resolve_role(
        base_dir: &Path,
        role: &str,
        key_health: Arc<KeyHealthTracker>,
    ) -> Result<Self> {
        let store = ConfigStore::load(base_dir)?;
        let resolved = store.resolve_role_or_default(role, &key_health)?;
        let standard = resolved_config_default_standard(resolved)?;
        Ok(Self::from_standard(standard, key_health))
    }

    /// Subset of `api_keys` that are currently healthy according to the
    /// shared tracker — `api_keys` was filtered once at resolution time, but
    /// further keys may have been marked failed since.
    ///
    /// Cooldown is a *preference*, not a hard exclusion: when every
    /// configured key is in cooldown, we return the full set anyway so the
    /// caller retries them rather than failing with no attempt. Marking a
    /// key bad only helps when there's an alternative; with no alternative
    /// it would just lock the agent out for the cooldown window.
    pub fn healthy_api_keys(&self) -> Vec<ApiKey> {
        let healthy: Vec<ApiKey> = self
            .api_keys
            .iter()
            .filter(|k| self.key_health.is_healthy(&self.provider, k.original_index))
            .cloned()
            .collect();
        if healthy.is_empty() && !self.api_keys.is_empty() {
            tracing::warn!(
                provider = %self.provider,
                key_count = self.api_keys.len(),
                "all API keys for provider are in cooldown; retrying anyway"
            );
            return self.api_keys.clone();
        }
        healthy
    }

    fn from_standard(config: StandardConfig, key_health: Arc<KeyHealthTracker>) -> Self {
        Self {
            provider: config.provider,
            model: config.model,
            api_keys: config.api_keys,
            base_url: config.base_url,
            key_health,
        }
    }
}

/// Resolve a raw model reference to its full [`ResolvedConfig`] (without
/// collapsing meta configs to their default variant). Mirrors the dispatch
/// in [`tenex_llm_config::resolver::resolve_model_reference`] but returns the
/// unflattened result so callers can inspect whether it's a meta config.
///
/// Inline references (`provider/model`, `provider:model`, bare model name)
/// can never produce a meta config — those paths return an error since the
/// only caller (variant override) requires a meta config.
fn resolve_to_resolved_config(
    store: &ConfigStore,
    raw_model: Option<&str>,
    key_health: &KeyHealthTracker,
) -> Result<ResolvedConfig> {
    let raw = raw_model.map(str::trim).filter(|s| !s.is_empty());

    let Some(raw) = raw.filter(|s| *s != "default") else {
        let default_name = store
            .llms
            .roles
            .get("default")
            .ok_or_else(|| anyhow::anyhow!("llms.json has no `default` role"))?;
        return store.resolve_config(default_name, key_health);
    };

    if store.llms.configurations.contains_key(raw) {
        return store.resolve_config(raw, key_health);
    }

    Err(anyhow::anyhow!(
        "model reference '{raw}' is not a named llms.json configuration"
    ))
}

pub(crate) fn read_global_system_prompt(base_dir: &Path) -> Option<String> {
    let path = base_dir.join("config.json");
    let bytes = std::fs::read(&path).ok()?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let block = raw
        .get("globalSystemPrompt")
        .and_then(|value| value.as_object())?;
    if block
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .is_some_and(|enabled| !enabled)
    {
        return None;
    }
    block
        .get("content")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .map(str::to_string)
}
