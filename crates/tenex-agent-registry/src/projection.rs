use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProjection {
    pub pubkey: String,
    pub slug: String,
    pub name: String,
    pub role: Option<String>,
    pub description: Option<String>,
    pub instructions: Option<String>,
    pub use_criteria: Option<String>,
    pub category: Option<String>,
    pub inferred_category: Option<String>,
    pub signer_ref: Option<String>,
    pub event_id: Option<String>,
    pub status: Option<String>,
    pub default_config_json: Option<String>,
    pub telegram_config_json: Option<String>,
    pub mcp_servers_json: Option<String>,
    pub runtime_config_json: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawStoredAgent {
    #[serde(default)]
    nsec: Option<String>,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    instructions: Option<String>,
    #[serde(default, rename = "useCriteria")]
    use_criteria: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default, rename = "inferredCategory")]
    inferred_category: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default, rename = "eventId")]
    event_id: Option<String>,
    #[serde(default)]
    default: Option<serde_json::Value>,
    #[serde(default)]
    telegram: Option<serde_json::Value>,
    #[serde(default, rename = "mcpServers")]
    mcp_servers: Option<serde_json::Value>,
    #[serde(default)]
    runtime: Option<serde_json::Value>,
}

pub fn read_agent_projection_file(path: &Path, pubkey: &str) -> anyhow::Result<AgentProjection> {
    let bytes = std::fs::read(path)?;
    let raw: RawStoredAgent = serde_json::from_slice(&bytes)?;
    let signer_ref = raw.nsec.as_ref().map(|n| format!("nsec:{n}"));
    let slug = raw.slug;
    let name = raw.name.unwrap_or_else(|| slug.clone().unwrap_or_default());
    let slug = slug.unwrap_or_else(|| pubkey[..8].to_string());
    Ok(AgentProjection {
        pubkey: pubkey.to_string(),
        slug,
        name,
        role: raw.role,
        description: raw.description,
        instructions: raw.instructions,
        use_criteria: raw.use_criteria,
        category: raw.category,
        inferred_category: raw.inferred_category,
        signer_ref,
        event_id: raw.event_id,
        status: raw.status,
        default_config_json: raw.default.as_ref().map(|v| v.to_string()),
        telegram_config_json: raw.telegram.as_ref().map(|v| v.to_string()),
        mcp_servers_json: raw.mcp_servers.as_ref().map(|v| v.to_string()),
        runtime_config_json: raw.runtime.as_ref().map(|v| v.to_string()),
    })
}
