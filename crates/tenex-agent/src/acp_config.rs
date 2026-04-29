use anyhow::{Context, Result};
use serde::Deserialize;
use std::{collections::HashMap, fs};
use tenex_supervision::types::AgentCategory;
use tenex_telegram::config::TelegramAgentConfig;

#[derive(Debug, Deserialize)]
pub(crate) struct AcpAgentConfig {
    pub name: String,
    pub slug: Option<String>,
    pub nsec: String,
    pub category: Option<String>,
    pub instructions: Option<String>,
    pub working_directory: Option<String>,
    pub telegram: Option<TelegramAgentConfig>,
    pub runtime: Option<AgentRuntimeConfig>,
}

impl AcpAgentConfig {
    pub(crate) fn load(path: &str) -> Result<Self> {
        let content = fs::read_to_string(path)
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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum AgentRuntimeConfig {
    Tenex,
    Acp(AcpRuntimeConfig),
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AcpRuntimeConfig {
    pub backend: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub model: Option<String>,
    #[serde(default, rename = "permissionPolicy")]
    pub permission_policy: AcpPermissionPolicy,
}

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AcpPermissionPolicy {
    #[default]
    Allow,
    Deny,
}
