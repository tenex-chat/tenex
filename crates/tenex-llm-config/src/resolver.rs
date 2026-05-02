//! Load `llms.json` + `providers.json` and resolve model references.
//!
//! This module owns read-only interpretation of both files. Write operations
//! remain in `tenex/src/store/`; this crate is the single resolver that runtime
//! code should use instead of reparsing the files locally.

use std::path::Path;

use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::configs::{resolve_acp, resolve_inline, resolve_meta};
pub use crate::configs::{resolve_standard, resolved_config_default_standard};
pub use crate::files::{
    load_llms, load_providers, LlmDocs, ParsedKey, ProviderDocs, ProviderEntry,
};
use crate::key_health::KeyHealthTracker;
use crate::types::{ResolvedConfig, StandardConfig};

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
