use serde::{Deserialize, Serialize};

/// Single-row project metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectMetadata {
    pub d_tag: String,
    pub owner_pubkey: Option<String>,
    pub title: Option<String>,
    pub repo_url: Option<String>,
    pub latest_event_id: Option<String>,
    pub ingested_at: Option<i64>,
}

/// A globally-defined agent (keyed on its pubkey).
///
/// `signer_ref` is an opaque, scheme-prefixed handle. Today's only scheme is
/// `nsec:<bech32>`. See [`crate::signer`].
///
/// `default_config_json`, `telegram_config_json`, and `mcp_servers_json` mirror
/// the agent's on-disk JSON shape: pre-enabled skills, model preferences,
/// transport bindings, and per-agent MCP server definitions live on the agent
/// itself, not in separate tables. Skill *catalogs* are filesystem + relay
/// discovery, never persisted here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Agent {
    pub pubkey: String,
    pub slug: String,
    pub name: String,
    pub role: Option<String>,
    pub description: Option<String>,
    pub instructions: Option<String>,
    pub use_criteria: Option<String>,
    pub category: Option<String>,
    pub signer_ref: Option<String>,
    pub event_id: Option<String>,
    pub status: Option<String>,
    pub default_config_json: Option<String>,
    pub telegram_config_json: Option<String>,
    pub mcp_servers_json: Option<String>,
    /// True when this backend can sign as the agent (its on-disk projection
    /// holds an nsec). False when the agent is a project member but runs on a
    /// different backend — we may have its metadata but not its key, and any
    /// inter-agent coordination must assume disjoint filesystems.
    pub is_local: bool,
}

/// Project-scoped membership row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProjectAgent {
    pub agent_pubkey: String,
    pub is_pm: bool,
}
