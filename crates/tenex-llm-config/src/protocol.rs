//! Wire types for the NDJSON Unix-socket protocol.
//!
//! **Socket path:** `<base_dir>/llm-config.sock`
//!
//! Each side sends one JSON object per line, terminated by `\n`.
//!
//! ## Requests (TypeScript → daemon)
//!
//! | method | extra fields | action |
//! |--------|-------------|--------|
//! | `"resolve"` | `"name": "<config-name>"` | Resolve a named config |
//! | `"resolve_role"` | `"role": "<role>"` | Resolve by role (`"default"`, `"summarization"`, etc.) |
//! | `"report_failure"` | `"provider": "<id>"`, `"keyIndex": <n>` | Mark key[n] failed for cooldown |
//!
//! ## Responses (daemon → TypeScript)
//!
//! All responses share `"ok": true | false`.
//!
//! On error: `{"ok": false, "error": "<message>"}`
//!
//! On ACK (report_failure): `{"ok": true}`
//!
//! On standard config:
//! ```json
//! {"ok":true,"kind":"standard","provider":"anthropic","model":"claude-opus-4-5",
//!  "apiKeys":["sk-ant-..."],"baseUrl":null,"temperature":0.7}
//! ```
//!
//! On meta config:
//! ```json
//! {"ok":true,"kind":"meta","default":"fast","variants":{"fast":{
//!   "modelConfig":"openrouter-fast","keywords":["quick","fast"],
//!   "description":"...","systemPrompt":null,
//!   "resolved":{/* standard config */}}}}
//! ```

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// ── Key type ──────────────────────────────────────────────────────────────────

/// A single API key, optionally tagged with a human-readable alias.
///
/// Any key string may carry a trailing alias after the first space:
/// `"sk-or-v1-... alice@example.com"` or `"sk-or-v1-... work-key"`.
/// The crate splits these at load time so callers always receive a clean
/// `key` and never have to parse the raw string.
#[derive(Debug, Serialize)]
pub struct ApiKey {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

// ── Requests ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "method")]
pub enum Request {
    #[serde(rename = "resolve")]
    Resolve { name: String },

    #[serde(rename = "resolve_role")]
    ResolveRole { role: String },

    /// `keyIndex` identifies the key by position in the provider's key array.
    /// Using an index rather than the key string avoids echoing secrets back.
    #[serde(rename = "report_failure")]
    ReportFailure {
        provider: String,
        #[serde(rename = "keyIndex")]
        key_index: usize,
    },
}

// ── Responses ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct AckResponse {
    pub ok: bool,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub ok: bool,
    pub error: String,
}

/// A fully resolved standard (non-meta) LLM config.
///
/// `extras` contains every field from `llms.json` beyond `provider` and
/// `model` (e.g. `temperature`, `maxTokens`, Codex-specific fields).
/// They are serialized flat so the caller sees a single, consistent object.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandardConfigResponse {
    pub ok: bool,
    pub kind: &'static str, // always "standard"
    pub provider: String,
    pub model: String,
    /// Healthy API keys from providers.json, filtered by key-health tracker.
    /// Each entry has a clean `key` (alias stripped) and an optional `alias`.
    pub api_keys: Vec<ApiKey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    /// Provider-specific extras (temperature, maxTokens, effort, …).
    /// Serialised flat — no wrapper object.
    #[serde(flatten)]
    pub extras: Map<String, Value>,
}

/// One variant within a meta config, with its underlying standard config
/// already resolved and inlined.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedVariant {
    /// The config name in `llms.json` that this variant maps to.
    pub model_config: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Fully resolved standard config for this variant's underlying model.
    pub resolved: StandardConfigResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaConfigResponse {
    pub ok: bool,
    pub kind: &'static str, // always "meta"
    pub default: String,
    pub variants: IndexMap<String, ResolvedVariant>,
}
