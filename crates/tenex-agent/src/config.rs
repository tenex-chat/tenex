use anyhow::{Context, Result};
use serde::Deserialize;
use std::fs;

#[derive(Debug, Deserialize)]
pub struct AgentDefault {
    pub model: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AgentConfig {
    pub name: String,
    /// Slug identifier used in identity prompt (e.g. "code-reviewer")
    pub slug: Option<String>,
    pub nsec: String,
    #[allow(dead_code)]
    pub role: Option<String>,
    pub category: Option<String>,
    pub instructions: Option<String>,
    #[allow(dead_code)]
    pub description: Option<String>,
    pub working_directory: Option<String>,
    pub default: Option<AgentDefault>,
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
struct ProvidersMap {
    providers: std::collections::HashMap<String, ProviderEntry>,
}

pub struct ProvidersConfig {
    inner: ProvidersMap,
}

impl ProvidersConfig {
    pub fn load() -> Option<Self> {
        let path = dirs_next::home_dir()?.join(".tenex/providers.json");
        let content = fs::read_to_string(path).ok()?;
        let inner = serde_json::from_str(&content).ok()?;
        Some(Self { inner })
    }

    pub fn api_key(&self, provider: &str) -> Option<String> {
        let entry = self.inner.providers.get(provider)?;
        let key = entry.api_key.as_ref()?.first();
        if key.is_empty() || key == "none" || key == "local" {
            None
        } else {
            Some(key.to_string())
        }
    }

    // For ollama, TypeScript repurposes `apiKey` as the base URL.
    // We also honor an explicit `baseUrl` field if present.
    pub fn ollama_base_url(&self) -> Option<String> {
        let entry = self.inner.providers.get("ollama")?;
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

// ─── Model resolution ─────────────────────────────────────────────────────────

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
    /// API key resolution order:
    /// 1. Provider-specific env var (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, …)
    /// 2. ~/.tenex/providers.json
    pub fn resolve(
        raw_model: Option<&str>,
        llms: Option<&LlmsConfig>,
        providers: Option<&ProvidersConfig>,
    ) -> Self {
        let (provider, model) = resolve_provider_model(raw_model, llms);
        let (api_key, base_url) = resolve_credentials(&provider, providers);
        Self { provider, model, api_key, base_url }
    }
}

fn resolve_provider_model(
    raw_model: Option<&str>,
    llms: Option<&LlmsConfig>,
) -> (String, String) {
    let raw = match raw_model {
        None | Some("default") | Some("") => {
            // No model set: use llms.json default
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

    // 2. Inline "provider:model" format (TENEX style)
    if let Some((provider, model)) = raw.split_once(':') {
        if !provider.is_empty() && !model.is_empty() {
            return (provider.to_string(), model.to_string());
        }
    }

    // 3. Inline "provider/model" format
    if let Some((provider, model)) = raw.split_once('/') {
        // Distinguish "anthropic/claude-haiku" (provider/model) from "openai/gpt-4o" (which
        // IS the OpenRouter model name). Heuristic: if the left side is a known provider name,
        // treat as provider/model; otherwise treat as the full model name for openrouter.
        let known_providers = ["anthropic", "openai", "openrouter", "ollama", "groq", "mistral"];
        if known_providers.contains(&provider) {
            return (provider.to_string(), model.to_string());
        }
    }

    // 4. Raw model name with default provider
    ("anthropic".to_string(), raw.to_string())
}

fn resolve_credentials(
    provider: &str,
    providers: Option<&ProvidersConfig>,
) -> (Option<String>, Option<String>) {
    if provider == "ollama" {
        // Ollama needs no API key; resolve base URL instead.
        let base_url = std::env::var("OLLAMA_API_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| providers.and_then(|p| p.ollama_base_url()));
        return (None, base_url);
    }

    // Env var takes priority for API key
    let env_var = format!("{}_API_KEY", provider.to_uppercase().replace('-', "_"));
    let api_key = std::env::var(&env_var)
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| providers.and_then(|p| p.api_key(provider)));

    (api_key, None)
}
