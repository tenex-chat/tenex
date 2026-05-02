use anyhow::{Context, Result};
use serde::Deserialize;
use std::{collections::HashMap, path::Path};
use tenex_llm_config::key_health::KeyHealthTracker;
use tenex_llm_config::resolver::ConfigStore;
use tenex_llm_config::ResolvedConfig;
use tenex_supervision::types::AgentCategory;

#[derive(Debug, Deserialize)]
pub(crate) struct AcpAgentConfig {
    pub name: String,
    pub slug: Option<String>,
    pub nsec: String,
    pub category: Option<String>,
    pub instructions: Option<String>,
    pub working_directory: Option<String>,
    pub default: Option<AgentDefaultConfig>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AgentDefaultConfig {
    pub model: Option<String>,
}

impl AcpAgentConfig {
    pub(crate) fn load(path: &str) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read agent config: {path}"))?;
        serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse ACP agent config: {path}"))
    }

    pub(crate) fn identity_name(&self) -> &str {
        self.slug.as_deref().unwrap_or(&self.name)
    }

    pub(crate) fn resolved_category(&self) -> Option<AgentCategory> {
        self.category.as_deref().and_then(|s| s.parse().ok())
    }

    pub(crate) fn default_model(&self) -> Option<&str> {
        self.default.as_ref()?.model.as_deref()
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AcpRuntimeConfig {
    pub backend: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub model: Option<String>,
    pub permission_policy: AcpPermissionPolicy,
}

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AcpPermissionPolicy {
    #[default]
    Allow,
    Deny,
}

pub(crate) fn load_acp_config(base_dir: &Path, config_name: &str) -> Result<AcpRuntimeConfig> {
    let store = ConfigStore::load(base_dir)?;
    let resolved = store.resolve_config(config_name, &KeyHealthTracker::new())?;
    let ResolvedConfig::Acp(config) = resolved else {
        anyhow::bail!("LLM config '{config_name}' is not an ACP config");
    };

    let permission_policy: AcpPermissionPolicy = config
        .permission_policy
        .as_deref()
        .and_then(|s| serde_json::from_value(serde_json::Value::String(s.to_string())).ok())
        .unwrap_or_default();

    Ok(AcpRuntimeConfig {
        backend: config.backend,
        command: config.command,
        args: config.args,
        env: config.env,
        model: config.model,
        permission_policy,
    })
}
