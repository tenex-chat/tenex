use anyhow::{Context, Result};
use serde::Deserialize;
use std::{collections::HashMap, path::Path};
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
    let llms = tenex_llm_config::resolver::load_llms(base_dir).context("loading llms.json")?;
    let config = llms
        .configurations
        .get(config_name)
        .with_context(|| format!("LLM config '{config_name}' not found in llms.json"))?;
    let obj = config
        .as_object()
        .with_context(|| format!("LLM config '{config_name}' is not a JSON object"))?;

    let provider = obj
        .get("provider")
        .and_then(|v| v.as_str())
        .with_context(|| format!("LLM config '{config_name}' missing 'provider'"))?;
    anyhow::ensure!(
        provider == "acp",
        "LLM config '{config_name}' has provider '{provider}', expected 'acp'"
    );

    let backend = obj
        .get("backend")
        .and_then(|v| v.as_str())
        .unwrap_or("custom")
        .to_string();
    let command = obj
        .get("command")
        .and_then(|v| v.as_str())
        .with_context(|| format!("ACP config '{config_name}' missing 'command'"))?
        .to_string();
    let args: Vec<String> = obj
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let env: HashMap<String, String> = obj
        .get("env")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let model = obj
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let permission_policy: AcpPermissionPolicy = obj
        .get("permissionPolicy")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_value(serde_json::Value::String(s.to_string())).ok())
        .unwrap_or_default();

    Ok(AcpRuntimeConfig {
        backend,
        command,
        args,
        env,
        model,
        permission_policy,
    })
}
