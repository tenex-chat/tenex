use anyhow::{anyhow, bail, Context, Result};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use crate::files::{LlmDocs, ParsedKey, ProviderDocs, ProviderEntry};
use crate::key_health::KeyHealthTracker;
use crate::types::{
    AcpConfig, ApiKey, MetaConfig, ResolvedConfig, ResolvedVariant, StandardConfig,
};

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
                original_index: i,
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

pub(crate) fn resolve_meta(
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

        let keywords = variant_object
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

pub(crate) fn resolve_acp(config_name: &str, config: &Value) -> Result<AcpConfig> {
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

pub(crate) fn resolve_inline(
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
