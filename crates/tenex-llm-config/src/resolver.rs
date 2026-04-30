//! Load `llms.json` + `providers.json` and resolve config names to protocol
//! response objects.
//!
//! This module owns minimal read-only representations of both files.  Write
//! operations remain in `tenex/src/store/`; this crate only reads.

use std::path::Path;

use anyhow::{Context, Result};
use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::key_health::KeyHealthTracker;
use crate::protocol::{ApiKey, MetaConfigResponse, ResolvedVariant, StandardConfigResponse};

// ── On-disk representations ───────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct LlmDocs {
    /// Named configurations from `llms.json`.  Value is the raw JSON object.
    pub configurations: IndexMap<String, Value>,
    /// Role-to-config-name mappings (default, summarization, supervision, …).
    pub roles: IndexMap<String, String>,
}

#[derive(Debug, Default)]
pub struct ProviderDocs {
    pub providers: IndexMap<String, ProviderEntry>,
}

/// A single API key parsed from the on-disk string.
///
/// Any key string may carry a trailing alias after the first space:
/// `"sk-or-v1-... alice@example.com"` or `"sk-or-v1-... work-key"`.
/// The alias is purely informational (useful for logging which key is in use)
/// and is stripped before the key is handed to any LLM provider SDK.
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

// ── File loading ──────────────────────────────────────────────────────────────

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
        .and_then(|v| v.as_object())
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    const ROLE_KEYS: &[&str] = &[
        "default",
        "summarization",
        "supervision",
        "promptCompilation",
        "categorization",
        "contextDiscovery",
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
                    .filter_map(|v| v.as_str())
                    .map(ParsedKey::parse)
                    .collect(),
                _ => vec![],
            };
            let base_url = obj
                .get("baseUrl")
                .and_then(|v| v.as_str())
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

// ── Resolution ────────────────────────────────────────────────────────────────

/// Resolve a config name to a JSON response value ready to write to the wire.
/// Returns an error-shaped value rather than `Err` so the caller can send it
/// directly without special-casing.
pub fn resolve_config(
    name: &str,
    llms: &LlmDocs,
    providers: &ProviderDocs,
    key_health: &KeyHealthTracker,
) -> Value {
    let config = match llms.configurations.get(name) {
        Some(c) => c,
        None => return err_val(format!("unknown config '{name}'")),
    };

    let is_meta = config.get("provider").and_then(Value::as_str) == Some("meta")
        && config.get("variants").is_some();

    if is_meta {
        resolve_meta(config, llms, providers, key_health)
    } else {
        match resolve_standard(name, config, providers, key_health) {
            Ok(r) => serde_json::to_value(r)
                .unwrap_or_else(|e| err_val(format!("serialize StandardConfigResponse: {e}"))),
            Err(e) => err_val(e),
        }
    }
}

/// Build a `StandardConfigResponse` by joining the config object with its
/// provider's credentials.
pub(crate) fn resolve_standard(
    config_name: &str,
    config: &Value,
    providers: &ProviderDocs,
    key_health: &KeyHealthTracker,
) -> Result<StandardConfigResponse, String> {
    let obj = config
        .as_object()
        .ok_or_else(|| format!("config '{config_name}' is not a JSON object"))?;

    let provider = obj
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("config '{config_name}' missing 'provider'"))?
        .to_string();

    let model = obj
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("config '{config_name}' missing 'model'"))?
        .to_string();

    let entry = providers.providers.get(&provider);
    let all_keys: &[ParsedKey] = entry.map_or(&[], |e| e.api_keys.as_slice());
    let base_url = entry.and_then(|e| e.base_url.clone());
    let timeout = entry.and_then(|e| e.timeout);

    let api_keys: Vec<ApiKey> = if all_keys.is_empty() {
        // Provider has no configured keys (e.g. claude-code, ollama).
        vec![]
    } else {
        let healthy = key_health.healthy_indices(&provider, all_keys.len());
        if healthy.is_empty() {
            return Err(format!(
                "all API keys for provider '{provider}' are in cooldown"
            ));
        }
        healthy
            .into_iter()
            .map(|i| ApiKey {
                key: all_keys[i].key.clone(),
                alias: all_keys[i].alias.clone(),
            })
            .collect()
    };

    // Extras: every field from llms.json except the two we promote to named fields.
    let extras: Map<String, Value> = obj
        .iter()
        .filter(|(k, _)| k.as_str() != "provider" && k.as_str() != "model")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    Ok(StandardConfigResponse {
        ok: true,
        kind: "standard",
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
) -> Value {
    let Some(obj) = config.as_object() else {
        return err_val("meta config is not a JSON object");
    };

    let default = match obj.get("default").and_then(Value::as_str) {
        Some(d) => d.to_string(),
        None => return err_val("meta config missing 'default'"),
    };

    let Some(variants_obj) = obj.get("variants").and_then(Value::as_object) else {
        return err_val("meta config missing 'variants'");
    };

    let mut variants: IndexMap<String, ResolvedVariant> = IndexMap::new();

    for (variant_name, variant_val) in variants_obj {
        let Some(variant_object) = variant_val.as_object() else {
            return err_val(format!("variant '{variant_name}' is not a JSON object"));
        };

        let model_config = match variant_object.get("model").and_then(Value::as_str) {
            Some(m) => m.to_string(),
            None => return err_val(format!("variant '{variant_name}' missing 'model'")),
        };

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

        let underlying = match llms.configurations.get(&model_config) {
            Some(c) => c,
            None => {
                return err_val(format!(
                    "variant '{variant_name}' references unknown config '{model_config}'"
                ))
            }
        };

        let resolved = match resolve_standard(&model_config, underlying, providers, key_health) {
            Ok(r) => r,
            Err(e) => return err_val(format!("variant '{variant_name}' -> '{model_config}': {e}")),
        };

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

    serde_json::to_value(MetaConfigResponse {
        ok: true,
        kind: "meta",
        default,
        variants,
    })
    .unwrap_or_else(|e| err_val(format!("serialize MetaConfigResponse: {e}")))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn err_val(msg: impl Into<String>) -> Value {
    // The `json!` macro is infallible for owned data, so this never panics.
    serde_json::json!({
        "ok": false,
        "error": msg.into(),
    })
}
