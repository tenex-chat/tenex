use anyhow::{Context, Result};
use serde::Deserialize;
use std::fs;
use tenex_llm_config::resolver::{load_providers, ProviderDocs};
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

// ─── LLM config ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct LlmEntry {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
pub struct LlmsConfig {
    pub configurations: std::collections::HashMap<String, LlmEntry>,
    pub default: Option<String>,
}

impl LlmsConfig {
    pub fn load() -> Option<Self> {
        let path = dirs_next::home_dir()?.join(".tenex/llms.json");
        let content = fs::read_to_string(path).ok()?;
        serde_json::from_str(&content).ok()
    }
}

// ─── Providers config ─────────────────────────────────────────────────────────

pub fn load_providers_config() -> Option<ProviderDocs> {
    let base_dir = dirs_next::home_dir()?.join(".tenex");
    load_providers(&base_dir).ok()
}

// ─── Model resolution ─────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct ResolvedModel {
    pub provider: String,
    pub model: String,
    pub api_key: Option<String>,
    /// Base URL override — populated for ollama (and other providers with a custom endpoint).
    pub base_url: Option<String>,
}

impl ResolvedModel {
    /// Resolve the effective provider, model ID, API key, and base URL from an agent config.
    ///
    /// Model resolution order:
    /// 1. Look up raw_model in llms.json configurations (named presets)
    /// 2. Parse `provider:model` or `provider/model` inline format
    /// 3. Fall back to raw model string with "anthropic" as provider
    ///
    /// API keys are resolved only from ~/.tenex/providers.json.
    pub fn resolve(
        raw_model: Option<&str>,
        llms: Option<&LlmsConfig>,
        providers: Option<&ProviderDocs>,
    ) -> Self {
        let (provider, model) = resolve_provider_model(raw_model, llms);
        let (api_key, base_url) = resolve_credentials(&provider, providers);
        Self {
            provider,
            model,
            api_key,
            base_url,
        }
    }
}

fn resolve_provider_model(raw_model: Option<&str>, llms: Option<&LlmsConfig>) -> (String, String) {
    let raw = match raw_model {
        None | Some("default") | Some("") => {
            let default_key = llms
                .and_then(|l| l.default.as_deref())
                .unwrap_or("anthropic/claude-sonnet-4-6");
            return resolve_from_string(default_key, llms);
        }
        Some(s) => s,
    };

    resolve_from_string(raw, llms)
}

fn resolve_from_string(raw: &str, llms: Option<&LlmsConfig>) -> (String, String) {
    // 1. Named preset in llms.json
    if let Some(entry) = llms.and_then(|l| l.configurations.get(raw)) {
        return (entry.provider.clone(), entry.model.clone());
    }

    // 2. Inline "provider/model" format — checked first because "ollama/model:tag"
    //    would otherwise be mis-split at the colon in step 3.
    if let Some((provider, model)) = raw.split_once('/') {
        let known_providers = [
            "anthropic",
            "openai",
            "openrouter",
            "ollama",
            "groq",
            "mistral",
        ];
        if known_providers.contains(&provider) {
            return (provider.to_string(), model.to_string());
        }
    }

    // 3. Inline "provider:model" format (legacy TENEX style)
    if let Some((provider, model)) = raw.split_once(':') {
        if !provider.is_empty() && !model.is_empty() {
            return (provider.to_string(), model.to_string());
        }
    }

    // 4. Raw model name with default provider
    ("anthropic".to_string(), raw.to_string())
}

fn resolve_credentials(
    provider: &str,
    providers: Option<&ProviderDocs>,
) -> (Option<String>, Option<String>) {
    if provider == "ollama" {
        let base_url = std::env::var("OLLAMA_API_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| ollama_base_url(providers));
        return (None, base_url);
    }

    let api_key = providers
        .and_then(|docs| docs.providers.get(provider))
        .and_then(|entry| entry.api_keys.first())
        .map(|key| key.key.clone());

    (api_key, None)
}

fn ollama_base_url(providers: Option<&ProviderDocs>) -> Option<String> {
    let entry = providers?.providers.get("ollama")?;
    // Prefer explicit baseUrl; fall back to apiKey field (TypeScript convention).
    let url = entry
        .base_url
        .clone()
        .or_else(|| entry.api_keys.first().map(|k| k.key.clone()))?;
    if url.is_empty() || url == "none" || url == "local" {
        None
    } else {
        Some(url)
    }
}
