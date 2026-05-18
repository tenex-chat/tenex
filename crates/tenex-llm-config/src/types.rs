use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;

/// A single API key, optionally tagged with a human-readable alias.
///
/// `original_index` is the 0-based position this key occupies in the
/// provider's credential array (in `providers.json`). It is preserved so
/// that callers can report per-key failures back to the shared
/// [`crate::key_health::KeyHealthTracker`] using a stable identifier.
#[derive(Clone, Debug, Serialize)]
pub struct ApiKey {
    pub key: String,
    pub original_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

/// A fully resolved standard LLM config.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandardConfig {
    pub provider: String,
    pub model: String,
    pub api_keys: Vec<ApiKey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    #[serde(flatten)]
    pub extras: Map<String, Value>,
}

/// One variant within a meta config, with its underlying standard config
/// already resolved.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedVariant {
    pub model_config: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    pub resolved: StandardConfig,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaConfig {
    pub default: String,
    pub variants: IndexMap<String, ResolvedVariant>,
}

/// A resolved Agent Client Protocol backend config.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpConfig {
    pub backend: String,
    pub command: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub env: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_policy: Option<String>,
}

#[derive(Clone, Debug)]
pub enum ResolvedConfig {
    Standard(StandardConfig),
    Meta(MetaConfig),
    Acp(AcpConfig),
}
