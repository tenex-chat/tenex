use std::collections::HashMap;
use std::fs;

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::paths;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SlugEntry {
    /// New format: { pubkey, projectIds: [] }
    Full { pubkey: String },
    /// Legacy format: plain pubkey string.
    Legacy(String),
}

impl SlugEntry {
    fn pubkey(&self) -> &str {
        match self {
            SlugEntry::Full { pubkey } => pubkey,
            SlugEntry::Legacy(s) => s,
        }
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AgentIndex {
    #[serde(default)]
    by_slug: HashMap<String, SlugEntry>,
}

/// Resolve an agent slug to a hex pubkey via `~/.tenex/agents/index.json`.
/// Returns `None` if the index is absent or the slug is unknown.
pub fn resolve_slug(slug: &str) -> Result<Option<String>> {
    let path = paths::agents_index_file();
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let index: AgentIndex =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    Ok(index.by_slug.get(slug).map(|e| e.pubkey().to_string()))
}
