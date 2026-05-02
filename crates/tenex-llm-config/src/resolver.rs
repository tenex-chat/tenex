//! Load `llms.json` + `providers.json` and resolve model references.
//!
//! This module owns read-only interpretation of both files. Write operations
//! remain in `tenex/src/store/`; this crate is the single resolver that runtime
//! code should use instead of reparsing the files locally.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use crate::key_health::KeyHealthTracker;
use crate::types::{
    AcpConfig, ApiKey, MetaConfig, ResolvedConfig, ResolvedVariant, StandardConfig,
};

#[derive(Debug, Default)]
pub struct LlmDocs {
    /// Named configurations from `llms.json`. Value is the raw JSON object.
    pub configurations: IndexMap<String, Value>,
    /// Role-to-config-name mappings (default, summarization, supervision, ...).
    pub roles: IndexMap<String, String>,
}

#[derive(Debug, Default)]
pub struct ProviderDocs {
    pub providers: IndexMap<String, ProviderEntry>,
}

#[derive(Debug)]
pub struct ConfigStore {
    pub llms: LlmDocs,
    pub providers: ProviderDocs,
}

impl ConfigStore {
    pub fn load(base_dir: &Path) -> Result<Self> {
        Ok(Self {
            llms: load_llms(base_dir)?,
            providers: load_providers(base_dir)?,
        })
    }

    pub fn resolve_config(
        &self,
        name: &str,
        key_health: &KeyHealthTracker,
    ) -> Result<ResolvedConfig> {
        resolve_config(name, &self.llms, &self.providers, key_health)
    }

    pub fn resolve_role(
        &self,
        role: &str,
        key_health: &KeyHealthTracker,
    ) -> Result<ResolvedConfig> {
        resolve_role(role, &self.llms, &self.providers, key_health)
    }

    pub fn resolve_model_reference(
        &self,
        raw_model: Option<&str>,
        key_health: &KeyHealthTracker,
    ) -> Result<StandardConfig> {
        resolve_model_reference(raw_model, &self.llms, &self.providers, key_health)
    }
}

/// A single API key parsed from the on-disk string.
///
/// Any key string may carry a trailing alias after the first space:
/// `"sk-or-v1-... alice@example.com"` or `"sk-or-v1-... work-key"`.
/// The alias is informational and is stripped before the key is handed to an
/// LLM provider SDK.
#[derive(Debug, Clone)]
pub struct ParsedKey {
    pub key: String,
    pub alias: Option<String>,
}

impl ParsedKey {
    fn parse(raw: &str) -> Self {
        let raw = raw.trim();
        raw.find(' ').map_or_else(
            || Self {
                key: raw.to_string(),
                alias: None,
            },
            |idx| {
                let alias = raw[idx + 1..].trim();
                Self {
                    key: raw[..idx].to_string(),
                    alias: if alias.is_empty() {
                        None
                    } else {
                        Some(alias.to_string())
                    },
                }
            },
        )
    }
}

#[derive(Debug)]
pub struct ProviderEntry {
    pub api_keys: Vec<ParsedKey>,
    pub base_url: Option<String>,
    pub timeout: Option<u64>,
}

pub fn load_llms(base_dir: &Path) -> Result<LlmDocs> {
    let path = base_dir.join("llms.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(LlmDocs::default()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };

    let raw: IndexMap<String, Value> =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;

    let configurations: IndexMap<String, Value> = raw
        .get("configurations")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    const ROLE_KEYS: &[&str] = &[
        "default",
        "summarization",
        "supervision",
        "promptCompilation",
        "categorization",
        "contextDiscovery",
        "firewall",
    ];
    let mut roles = IndexMap::new();
    for &key in ROLE_KEYS {
        if let Some(Value::String(s)) = raw.get(key) {
            roles.insert(key.to_string(), s.clone());
        }
    }

    Ok(LlmDocs {
        configurations,
        roles,
    })
}

pub fn load_providers(base_dir: &Path) -> Result<ProviderDocs> {
    let path = base_dir.join("providers.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ProviderDocs::default()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };

    let raw: Map<String, Value> =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;

    let mut providers = IndexMap::new();
    if let Some(Value::Object(pmap)) = raw.get("providers") {
        for (id, creds) in pmap {
            let Some(obj) = creds.as_object() else {
                continue;
            };
            let api_keys = match obj.get("apiKey") {
                Some(Value::String(s)) => vec![ParsedKey::parse(s)],
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ParsedKey::parse)
                    .collect(),
                _ => vec![],
            };
            let base_url = obj
                .get("baseUrl")
                .and_then(Value::as_str)
                .map(str::to_string);
            let timeout = obj.get("timeout").and_then(Value::as_u64);
            providers.insert(
                id.clone(),
                ProviderEntry {
                    api_keys,
                    base_url,
                    timeout,
                },
            );
        }
    }

    Ok(ProviderDocs { providers })
}

pub fn resolve_role(
    role: &str,
    llms: &LlmDocs,
    providers: &ProviderDocs,
    key_health: &KeyHealthTracker,
) -> Result<ResolvedConfig> {
    let config_name = llms
        .roles
        .get(role)
        .ok_or_else(|| anyhow!("no config assigned to role '{role}'"))?;
    resolve_config(config_name, llms, providers, key_health)
}

pub fn resolve_config(
    name: &str,
    llms: &LlmDocs,
    providers: &ProviderDocs,
    key_health: &KeyHealthTracker,
) -> Result<ResolvedConfig> {
    let config = llms
        .configurations
        .get(name)
        .ok_or_else(|| anyhow!("unknown config '{name}'"))?;

    match config.get("provider").and_then(Value::as_str) {
        Some("meta") if config.get("variants").is_some() => Ok(ResolvedConfig::Meta(resolve_meta(
            config, llms, providers, key_health,
        )?)),
        Some("acp") => Ok(ResolvedConfig::Acp(resolve_acp(name, config)?)),
        _ => Ok(ResolvedConfig::Standard(resolve_standard(
            name, config, providers, key_health,
        )?)),
    }
}

pub fn resolve_model_reference(
    raw_model: Option<&str>,
    llms: &LlmDocs,
    providers: &ProviderDocs,
    key_health: &KeyHealthTracker,
) -> Result<StandardConfig> {
    let raw = raw_model.map(str::trim).filter(|s| !s.is_empty());

    let Some(raw) = raw.filter(|s| *s != "default") else {
        if let Some(default_name) = llms.roles.get("default") {
            return resolved_config_default_standard(resolve_config(
                default_name,
                llms,
                providers,
                key_health,
            )?);
        }
        return resolve_inline("anthropic", "claude-sonnet-4-6", providers, key_health);
    };

    if llms.configurations.contains_key(raw) {
        return resolved_config_default_standard(resolve_config(raw, llms, providers, key_health)?);
    }

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
            return resolve_inline(provider, model, providers, key_health);
        }
    }

    if let Some((provider, model)) = raw.split_once(':') {
        if !provider.is_empty() && !model.is_empty() {
            return resolve_inline(provider, model, providers, key_health);
        }
    }

    resolve_inline("anthropic", raw, providers, key_health)
}

pub fn resolved_config_default_standard(resolved: ResolvedConfig) -> Result<StandardConfig> {
    match resolved {
        ResolvedConfig::Standard(config) => Ok(config),
        ResolvedConfig::Meta(meta) => {
            let variant = meta
                .variants
                .get(&meta.default)
                .ok_or_else(|| anyhow!("meta config missing default variant '{}'", meta.default))?;
            Ok(variant.resolved.clone())
        }
        ResolvedConfig::Acp(_) => bail!("ACP config cannot be used as a standard LLM model"),
    }
}

pub fn resolve_standard(
    config_name: &str,
    config: &Value,
    providers: &ProviderDocs,
    key_health: &KeyHealthTracker,
) -> Result<StandardConfig> {
    let obj = config
        .as_object()
        .ok_or_else(|| anyhow!("config '{config_name}' is not a JSON object"))?;

    let provider = obj
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("config '{config_name}' missing 'provider'"))?
        .to_string();

    let model = obj
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("config '{config_name}' missing 'model'"))?
        .to_string();

    let entry = providers.providers.get(&provider);
    let all_keys: &[ParsedKey] = entry.map_or(&[], |e| e.api_keys.as_slice());
    let base_url = resolve_base_url(&provider, entry);
    let timeout = entry.and_then(|e| e.timeout);

    let api_keys: Vec<ApiKey> = if provider == "ollama" || all_keys.is_empty() {
        Vec::new()
    } else {
        let healthy = key_health.healthy_indices(&provider, all_keys.len());
        if healthy.is_empty() {
            bail!("all API keys for provider '{provider}' are in cooldown");
        }
        healthy
            .into_iter()
            .map(|i| ApiKey {
                key: all_keys[i].key.clone(),
                alias: all_keys[i].alias.clone(),
            })
            .collect()
    };

    let extras: Map<String, Value> = obj
        .iter()
        .filter(|(k, _)| k.as_str() != "provider" && k.as_str() != "model")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    Ok(StandardConfig {
        provider,
        model,
        api_keys,
        base_url,
        timeout,
        extras,
    })
}

fn resolve_meta(
    config: &Value,
    llms: &LlmDocs,
    providers: &ProviderDocs,
    key_health: &KeyHealthTracker,
) -> Result<MetaConfig> {
    let obj = config
        .as_object()
        .ok_or_else(|| anyhow!("meta config is not a JSON object"))?;

    let default = obj
        .get("default")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("meta config missing 'default'"))?
        .to_string();

    let variants_obj = obj
        .get("variants")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("meta config missing 'variants'"))?;

    let mut variants: IndexMap<String, ResolvedVariant> = IndexMap::new();

    for (variant_name, variant_val) in variants_obj {
        let variant_object = variant_val
            .as_object()
            .ok_or_else(|| anyhow!("variant '{variant_name}' is not a JSON object"))?;

        let model_config = variant_object
            .get("model")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("variant '{variant_name}' missing 'model'"))?
            .to_string();

        let keywords: Vec<String> = variant_object
            .get("keywords")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        let description = variant_object
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string);

        let system_prompt = variant_object
            .get("systemPrompt")
            .and_then(Value::as_str)
            .map(str::to_string);

        let underlying = llms.configurations.get(&model_config).ok_or_else(|| {
            anyhow!("variant '{variant_name}' references unknown config '{model_config}'")
        })?;

        let resolved = resolve_standard(&model_config, underlying, providers, key_health)
            .with_context(|| format!("variant '{variant_name}' -> '{model_config}'"))?;

        variants.insert(
            variant_name.clone(),
            ResolvedVariant {
                model_config,
                keywords,
                description,
                system_prompt,
                resolved,
            },
        );
    }

    Ok(MetaConfig { default, variants })
}

fn resolve_acp(config_name: &str, config: &Value) -> Result<AcpConfig> {
    let obj = config
        .as_object()
        .ok_or_else(|| anyhow!("ACP config '{config_name}' is not a JSON object"))?;

    let backend = obj
        .get("backend")
        .and_then(Value::as_str)
        .unwrap_or("custom")
        .to_string();
    let command = obj
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("ACP config '{config_name}' missing 'command'"))?
        .to_string();
    let args = obj
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let env = obj
        .get("env")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let model = obj.get("model").and_then(Value::as_str).map(str::to_string);
    let permission_policy = obj
        .get("permissionPolicy")
        .and_then(Value::as_str)
        .map(str::to_string);

    Ok(AcpConfig {
        backend,
        command,
        args,
        env,
        model,
        permission_policy,
    })
}

fn resolve_inline(
    provider: &str,
    model: &str,
    providers: &ProviderDocs,
    key_health: &KeyHealthTracker,
) -> Result<StandardConfig> {
    let config = json!({
        "provider": provider,
        "model": model,
    });
    resolve_standard("<inline>", &config, providers, key_health)
}

fn resolve_base_url(provider: &str, entry: Option<&ProviderEntry>) -> Option<String> {
    if provider != "ollama" {
        return entry.and_then(|e| e.base_url.clone());
    }

    std::env::var("OLLAMA_API_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| entry.and_then(|e| e.base_url.clone()))
        .or_else(|| entry.and_then(|e| e.api_keys.first().map(|k| k.key.clone())))
        .filter(|url| !url.is_empty() && url != "none" && url != "local")
}
