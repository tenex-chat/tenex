//! [`Project`] — file-backed handle for project metadata and agents.
//!
//! Reads from:
//! - `<base_dir>/projects/<d_tag>/event.json` — kind:31933 Nostr event
//! - `<base_dir>/agents/<pubkey>.json` — per-agent files

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::id::{normalize_project_id, ProjectDTag};
use crate::models::{Agent, ProjectAgent, ProjectMetadata};
use crate::paths;
use crate::signer::{signer_for, Signer, SignerError};

pub struct Project {
    d_tag: ProjectDTag,
    base_dir: PathBuf,
}

impl Project {
    /// Open the project view for `project_id` under `base_dir`.
    ///
    /// `project_id` may be a NIP-33 coordinate (`31933:<pubkey>:<dTag>`) or a
    /// bare dTag.
    pub fn open(project_id: &str, base_dir: &Path) -> Result<Self> {
        let d_tag = normalize_project_id(project_id)?;
        Ok(Self {
            d_tag,
            base_dir: base_dir.to_path_buf(),
        })
    }

    /// Open under [`paths::default_base_dir`].
    pub fn open_default(project_id: &str) -> Result<Self> {
        let base = paths::default_base_dir();
        Self::open(project_id, &base)
    }

    pub fn d_tag(&self) -> &ProjectDTag {
        &self.d_tag
    }

    pub fn metadata(&self) -> Result<Option<ProjectMetadata>> {
        let path = paths::project_event_file(&self.base_dir, &self.d_tag);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = std::fs::read(&path)?;
        let ev: RawProjectEvent = serde_json::from_slice(&bytes)?;
        Ok(Some(metadata_from_event(&self.d_tag, &ev)))
    }

    pub fn agents(&self) -> Result<Vec<Agent>> {
        let pubkeys = self.member_pubkeys()?;
        let mut agents = Vec::with_capacity(pubkeys.len());
        for pk in &pubkeys {
            let path = paths::agent_file(&self.base_dir, pk);
            match read_agent_file(&path, pk) {
                Ok(a) => agents.push(a),
                Err(e) => {
                    tracing::warn!(pubkey = %pk, error = %e, "skipping unreadable agent file")
                }
            }
        }
        Ok(agents)
    }

    pub fn project_agents(&self) -> Result<Vec<ProjectAgent>> {
        let pubkeys = self.member_pubkeys()?;
        let pm_pubkey = pubkeys.first().cloned();
        Ok(pubkeys
            .into_iter()
            .map(|pk| ProjectAgent {
                is_pm: pm_pubkey.as_deref() == Some(&pk),
                agent_pubkey: pk,
            })
            .collect())
    }

    pub fn agent_by_pubkey(&self, pubkey: &str) -> Result<Option<Agent>> {
        if !self.member_pubkeys()?.contains(&pubkey.to_string()) {
            return Ok(None);
        }
        let path = paths::agent_file(&self.base_dir, pubkey);
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(read_agent_file(&path, pubkey)?))
    }

    pub fn agent_by_slug(&self, slug: &str) -> Result<Option<Agent>> {
        for a in self.agents()? {
            if a.slug == slug {
                return Ok(Some(a));
            }
        }
        Ok(None)
    }

    pub fn resolve_slug(&self, slug: &str) -> Result<Option<String>> {
        Ok(self.agent_by_slug(slug)?.map(|a| a.pubkey))
    }

    pub fn signer_for_agent(
        &self,
        pubkey: &str,
    ) -> Result<std::result::Result<Box<dyn Signer>, SignerError>> {
        let agent = self
            .agent_by_pubkey(pubkey)?
            .ok_or_else(|| Error::NotFound(format!("agent {pubkey}")))?;
        Ok(signer_for(&agent))
    }

    fn member_pubkeys(&self) -> Result<Vec<String>> {
        let path = paths::project_event_file(&self.base_dir, &self.d_tag);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let bytes = std::fs::read(&path)?;
        let ev: RawProjectEvent = serde_json::from_slice(&bytes)?;
        Ok(extract_p_tag_pubkeys(&ev))
    }
}

#[derive(Debug, Deserialize)]
struct RawProjectEvent {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    pubkey: Option<String>,
    #[serde(default)]
    created_at: Option<i64>,
    #[serde(default)]
    tags: Vec<Vec<String>>,
}

fn metadata_from_event(d_tag: &ProjectDTag, ev: &RawProjectEvent) -> ProjectMetadata {
    ProjectMetadata {
        d_tag: d_tag.as_str().to_string(),
        owner_pubkey: ev.pubkey.clone(),
        title: first_tag_value(&ev.tags, "title"),
        repo_url: first_tag_value(&ev.tags, "repo"),
        latest_event_id: ev.id.clone(),
        ingested_at: ev.created_at,
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

fn read_agent_file(path: &Path, pubkey: &str) -> Result<Agent> {
    let bytes = std::fs::read(path)?;
    let raw: RawStoredAgent = serde_json::from_slice(&bytes)?;
    let signer_ref = raw.nsec.as_ref().map(|n| format!("nsec:{n}"));
    Ok(Agent {
        pubkey: pubkey.to_string(),
        slug: raw.slug.clone().unwrap_or_else(|| pubkey[..8].to_string()),
        name: raw
            .name
            .clone()
            .unwrap_or_else(|| raw.slug.clone().unwrap_or_default()),
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
    })
}
