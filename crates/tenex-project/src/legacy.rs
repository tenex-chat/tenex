//! One-shot migration from the canonical TS-format on-disk state.
//!
//! Reads:
//! - `<base>/agents/<pubkey>.json` (filename is the agent pubkey, not the slug;
//!   `AgentStorage.ts` stores agents flat with the hex pubkey as the filename).
//!   The `default`, `telegram`, and `mcpServers` blocks are preserved verbatim
//!   into JSON columns on the `agents` row.
//! - `<base>/projects/<dTag>/event.json` — the persisted kind:31933 project
//!   event. Project membership is derived from its `p` tags (mirrors the bun
//!   side's `ProjectMembersReader`); there is no separate membership file.
//!
//! Idempotent: re-running the migration applies the same upserts. Old files
//! are not touched.

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::error::Result;
use crate::id::ProjectDTag;
use crate::models::{Agent, ProjectAgent, ProjectMetadata};
use crate::paths;
use crate::project::Project;

#[derive(Debug, Default)]
pub struct MigrationReport {
    pub project_metadata_written: bool,
    pub agents_written: usize,
    pub project_agents_written: usize,
    pub skipped_pubkeys: Vec<String>,
}

impl Project {
    /// Read legacy on-disk state and upsert it into the project DB.
    ///
    /// Safe to run repeatedly; non-destructive for the original files.
    pub fn migrate_from_legacy(&self, base_dir: &Path) -> Result<MigrationReport> {
        let mut report = MigrationReport::default();
        let d_tag = self.d_tag();

        let event = read_project_event(base_dir, d_tag)?;

        if let Some(ev) = &event {
            self.upsert_metadata(&project_metadata_from_event(d_tag, ev))?;
            report.project_metadata_written = true;
        }

        let assigned_pubkeys = event
            .as_ref()
            .map(|e| extract_p_tag_pubkeys(e))
            .unwrap_or_default();
        let pm_pubkey = assigned_pubkeys.first().cloned();

        let agents_dir = paths::agents_dir(base_dir);
        let mut agents_by_pubkey: HashMap<String, RawStoredAgent> = HashMap::new();
        if agents_dir.is_dir() {
            for entry in std::fs::read_dir(&agents_dir)? {
                let entry = entry?;
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };
                if file_name == "index.json" || !file_name.ends_with(".json") {
                    continue;
                }
                let pubkey = file_name.trim_end_matches(".json").to_string();
                if pubkey.len() != 64 || !pubkey.bytes().all(|b| b.is_ascii_hexdigit()) {
                    continue;
                }
                match read_agent(&path) {
                    Ok(agent) => {
                        agents_by_pubkey.insert(pubkey, agent);
                    }
                    Err(e) => {
                        tracing::warn!(?path, error = %e, "tenex-project: skipping unreadable agent file");
                    }
                }
            }
        }

        for pubkey in &assigned_pubkeys {
            let Some(raw) = agents_by_pubkey.get(pubkey) else {
                report.skipped_pubkeys.push(pubkey.clone());
                tracing::warn!(pubkey = %pubkey, "tenex-project: assigned agent has no agent.json on disk");
                continue;
            };
            let agent = agent_from_raw(pubkey, raw);
            self.upsert_agent(&agent)?;
            report.agents_written += 1;

            let project_agent = ProjectAgent {
                agent_pubkey: pubkey.clone(),
                is_pm: pm_pubkey.as_deref() == Some(pubkey.as_str()),
                ..Default::default()
            };
            self.upsert_project_agent(&project_agent)?;
            report.project_agents_written += 1;
        }

        Ok(report)
    }
}

#[derive(Debug, Deserialize)]
struct RawProjectEvent {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    pubkey: Option<String>,
    #[serde(default)]
    tags: Vec<Vec<String>>,
}

fn read_project_event(base_dir: &Path, d_tag: &ProjectDTag) -> Result<Option<RawProjectEvent>> {
    let path = paths::project_event_file(base_dir, d_tag);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)?;
    let event: RawProjectEvent = serde_json::from_slice(&bytes)?;
    Ok(Some(event))
}

fn project_metadata_from_event(d_tag: &ProjectDTag, ev: &RawProjectEvent) -> ProjectMetadata {
    let title = first_tag_value(&ev.tags, "title");
    let repo_url = first_tag_value(&ev.tags, "repo");
    ProjectMetadata {
        d_tag: d_tag.as_str().to_string(),
        owner_pubkey: ev.pubkey.clone(),
        title,
        repo_url,
        working_directory: None,
        latest_event_id: ev.id.clone(),
        ingested_at: now_seconds(),
    }
}

fn extract_p_tag_pubkeys(ev: &RawProjectEvent) -> Vec<String> {
    let mut out = Vec::new();
    for tag in &ev.tags {
        let mut parts = tag.iter();
        if parts.next().map(String::as_str) == Some("p") {
            if let Some(pk) = parts.next() {
                if pk.len() == 64 && pk.bytes().all(|b| b.is_ascii_hexdigit()) {
                    out.push(pk.clone());
                }
            }
        }
    }
    out
}

fn first_tag_value(tags: &[Vec<String>], name: &str) -> Option<String> {
    tags.iter().find_map(|tag| {
        let mut iter = tag.iter();
        if iter.next().map(String::as_str) == Some(name) {
            iter.next().cloned()
        } else {
            None
        }
    })
}

fn now_seconds() -> Option<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
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
}

fn read_agent(path: &Path) -> Result<RawStoredAgent> {
    let bytes = std::fs::read(path)?;
    let raw: RawStoredAgent = serde_json::from_slice(&bytes)?;
    Ok(raw)
}

fn agent_from_raw(pubkey: &str, raw: &RawStoredAgent) -> Agent {
    let signer_ref = raw.nsec.as_ref().map(|n| format!("nsec:{n}"));
    Agent {
        pubkey: pubkey.to_string(),
        slug: raw.slug.clone().unwrap_or_else(|| pubkey[..8].to_string()),
        name: raw.name.clone().unwrap_or_else(|| raw.slug.clone().unwrap_or_default()),
        role: raw.role.clone(),
        description: raw.description.clone(),
        instructions: raw.instructions.clone(),
        use_criteria: raw.use_criteria.clone(),
        category: raw.category.clone(),
        inferred_category: raw.inferred_category.clone(),
        signer_ref,
        event_id: raw.event_id.clone(),
        status: raw.status.clone(),
        default_config_json: raw.default.as_ref().map(|v| v.to_string()),
        telegram_config_json: raw.telegram.as_ref().map(|v| v.to_string()),
        mcp_servers_json: raw.mcp_servers.as_ref().map(|v| v.to_string()),
    }
}
