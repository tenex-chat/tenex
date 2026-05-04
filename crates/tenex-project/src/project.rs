//! [`Project`] — file-backed handle for project metadata and agents.
//!
//! Reads from:
//! - `<base_dir>/projects/<d_tag>/event.json` — kind:31933 Nostr event
//! - `<base_dir>/agents/<pubkey>.json` — per-agent files

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::id::{normalize_project_id, ProjectDTag};
use crate::identity::{log_unavailable_agent, IdentityServiceAgentNames, UnavailableAgentNames};
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

    /// Agents this backend has a local JSON projection for.
    ///
    /// Used by the daemon when it needs to spawn or sign-as an agent — i.e.,
    /// every code path that requires local nsec or full agent metadata. This
    /// is *not* the right method for "what agents exist in this project" —
    /// the project's 31933 event lists members regardless of where each
    /// runs. For the comprehensive list (used in agent prompts and any
    /// inter-backend awareness) call [`Self::all_project_agents`].
    pub fn agents(&self) -> Result<Vec<Agent>> {
        let pubkeys = self.member_pubkeys()?;
        let unavailable_names = IdentityServiceAgentNames::new(&self.base_dir);
        let mut agents = Vec::with_capacity(pubkeys.len());
        for pk in &pubkeys {
            let path = paths::agent_file(&self.base_dir, pk);
            match try_read_agent_file(&path, pk) {
                Ok(a) => agents.push(a),
                Err(AgentFileReadError::Unavailable) => {
                    log_unavailable_agent(pk, &unavailable_names)
                }
                Err(e) => {
                    tracing::warn!(pubkey = %pk, error = %e, "skipping unreadable agent file")
                }
            }
        }
        Ok(agents)
    }

    /// Every agent that the project's 31933 event names as a member.
    ///
    /// Locally-managed agents (JSON projection on disk) are returned with
    /// full metadata and `is_local = true` when the projection holds an
    /// nsec. Members without a local projection — i.e., agents that run on
    /// a different backend — are returned as stubs with `is_local = false`,
    /// `slug` and `name` filled from the identity service when available
    /// (falling back to a short pubkey), and the remaining fields `None`.
    ///
    /// This is the list every agent should be aware of. Remote agents
    /// cannot be delegated to via the local `delegate` tool (no usable
    /// slug, no signer here), but they *do* exist in the project, and the
    /// running agent must know that.
    pub fn all_project_agents(&self) -> Result<Vec<Agent>> {
        let pubkeys = self.member_pubkeys()?;
        let unavailable_names = IdentityServiceAgentNames::new(&self.base_dir);
        let mut agents = Vec::with_capacity(pubkeys.len());
        for pk in &pubkeys {
            let path = paths::agent_file(&self.base_dir, pk);
            match try_read_agent_file(&path, pk) {
                Ok(a) => agents.push(a),
                Err(AgentFileReadError::Unavailable) => {
                    agents.push(remote_agent_stub(pk, &unavailable_names));
                }
                Err(e) => {
                    tracing::warn!(
                        pubkey = %pk,
                        error = %e,
                        "treating unreadable agent file as remote stub",
                    );
                    agents.push(remote_agent_stub(pk, &unavailable_names));
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
        if !self.member_pubkeys()?.iter().any(|pk| pk == pubkey) {
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
        if parts.next().map(String::as_str) != Some("p") {
            continue;
        }

        if let Some(pk) = parts.next() {
            if pk.len() == 64 && pk.bytes().all(|b| b.is_ascii_hexdigit()) {
                out.push(pk.clone());
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

#[derive(Debug)]
enum AgentFileReadError {
    Unavailable,
    Other(Error),
}

impl std::fmt::Display for AgentFileReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => f.write_str("agent file unavailable"),
            Self::Other(e) => e.fmt(f),
        }
    }
}

fn read_agent_file(path: &Path, pubkey: &str) -> Result<Agent> {
    try_read_agent_file(path, pubkey).map_err(|e| match e {
        AgentFileReadError::Unavailable => Error::NotFound(format!("agent {pubkey}")),
        AgentFileReadError::Other(e) => e,
    })
}

fn try_read_agent_file(
    path: &Path,
    pubkey: &str,
) -> std::result::Result<Agent, AgentFileReadError> {
    if !path.is_file() {
        return Err(AgentFileReadError::Unavailable);
    }
    let raw = tenex_agent_registry::read_agent_projection_file(path, pubkey).map_err(|e| {
        AgentFileReadError::Other(Error::Other(format!(
            "read agent file {}: {e}",
            path.display()
        )))
    })?;
    let is_local = raw.signer_ref.is_some();
    Ok(Agent {
        pubkey: raw.pubkey,
        slug: raw.slug,
        name: raw.name,
        role: raw.role,
        description: raw.description,
        instructions: raw.instructions,
        use_criteria: raw.use_criteria,
        category: raw.category,
        signer_ref: raw.signer_ref,
        event_id: raw.event_id,
        status: raw.status,
        default_config_json: raw.default_config_json,
        telegram_config_json: raw.telegram_config_json,
        mcp_servers_json: raw.mcp_servers_json,
        is_local,
        backend_name: None,
    })
}

fn remote_agent_stub(pubkey: &str, names: &dyn UnavailableAgentNames) -> Agent {
    let short = pubkey
        .chars()
        .take(8.min(pubkey.len()))
        .collect::<String>();
    let view = names.view(pubkey);
    let name = view.display_name.unwrap_or_else(|| short.clone());
    Agent {
        pubkey: pubkey.to_string(),
        slug: view.slug.unwrap_or_else(|| name.clone()),
        name,
        role: None,
        description: view.about,
        instructions: None,
        use_criteria: view.use_criteria,
        category: None,
        signer_ref: None,
        event_id: None,
        status: None,
        default_config_json: None,
        telegram_config_json: None,
        mcp_servers_json: None,
        is_local: false,
        backend_name: view.backend_name,
    }
}
