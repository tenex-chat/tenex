use anyhow::{Context, Result};
use indexmap::IndexMap;
use std::path::PathBuf;

use crate::doc::AgentDoc;
use crate::index::AgentIndexDoc;
use crate::paths::agents_dir;

mod config_update;
mod mutate;
mod rebuild;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentDefaultConfigUpdate {
    pub model: Option<String>,
    pub tools: Option<Vec<String>>,
    pub blocked_skills: Option<Vec<String>>,
    pub skills: Option<Vec<String>>,
    pub mcp: Option<Vec<String>>,
}

impl AgentDefaultConfigUpdate {
    pub fn is_empty(&self) -> bool {
        self.model.is_none()
            && self.tools.is_none()
            && self.blocked_skills.is_none()
            && self.skills.is_none()
            && self.mcp.is_none()
    }
}

/// Mirror of the TS `AgentStorage` class (`src/agents/AgentStorage.ts:266`).
///
/// Wraps the index document and exposes the full mutation surface used by
/// `tenex agent` and the doctor flows: `save_agent`, `delete_agent`,
/// `add_agent_to_project`, `remove_agent_from_project`,
/// `cleanup_duplicate_slugs`, `find_alternative_slug_owner`, plus all the
/// read-side index lookups (`get_agent_by_slug`, `get_agent_by_event_id`,
/// `slug_exists`, `get_canonical_active_agents`, `get_all_stored_agents`,
/// `get_index_projects_for_agent`, `get_project_members_from_index`,
/// `rebuild_index`).
///
/// Index mutations are all in-memory; every public mutator writes the index
/// back to disk before returning, matching the TS `await this.saveIndex()`
/// discipline. Unlike TS we do not lazily `loadIndex()` from method bodies —
/// `new()` always loads (or creates an empty index), so `&mut self` methods
/// can mutate `self.index` directly without async re-entry.
pub struct AgentStorage {
    pub(crate) base_dir: PathBuf,
    pub(crate) index: AgentIndexDoc,
}

impl AgentStorage {
    /// Open storage rooted at `<base>/agents/`.
    /// Creates the directory when missing and loads an empty in-memory index
    /// when `index.json` is absent — matches `initialize()` plus
    /// `loadIndex()` (`AgentStorage.ts:279-321`).
    pub fn open(base_dir: &std::path::Path) -> Result<Self> {
        std::fs::create_dir_all(agents_dir(base_dir))
            .with_context(|| format!("create agents dir {}", agents_dir(base_dir).display()))?;
        let index = AgentIndexDoc::load(base_dir)?;
        Ok(Self {
            base_dir: base_dir.to_path_buf(),
            index,
        })
    }

    pub fn index(&self) -> &AgentIndexDoc {
        &self.index
    }

    /// Persist current in-memory index to disk.
    pub fn save_index(&self) -> Result<()> {
        self.index.save(&self.base_dir)
    }

    pub fn load_agent(&self, pubkey: &str) -> Result<Option<AgentDoc>> {
        AgentDoc::load(&self.base_dir, pubkey)
    }

    /// `slugExists` (`AgentStorage.ts:696-699`).
    pub fn slug_exists(&self, slug: &str) -> bool {
        self.index.by_slug.contains_key(slug)
    }

    /// `getAgentBySlug` (`:706-714`).
    pub fn get_agent_by_slug(&self, slug: &str) -> Result<Option<AgentDoc>> {
        let Some(entry) = self.index.by_slug.get(slug) else {
            return Ok(None);
        };
        AgentDoc::load(&self.base_dir, &entry.pubkey)
    }

    /// `getAgentBySlugForProject` (`:724-737`).
    pub fn get_agent_by_slug_for_project(
        &self,
        slug: &str,
        project_dtag: &str,
    ) -> Result<Option<AgentDoc>> {
        let Some(entry) = self.index.by_slug.get(slug) else {
            return Ok(None);
        };
        if !entry.project_ids.iter().any(|p| p == project_dtag) {
            return Ok(None);
        }
        AgentDoc::load(&self.base_dir, &entry.pubkey)
    }

    /// `getAgentByEventId` (`:742-750`).
    pub fn get_agent_by_event_id(&self, event_id: &str) -> Result<Option<AgentDoc>> {
        let Some(pubkey) = self.index.by_event_id.get(event_id) else {
            return Ok(None);
        };
        AgentDoc::load(&self.base_dir, pubkey)
    }

    /// Collect every dTag where `pubkey` is the canonical slug owner. Mirror
    /// `getIndexProjectsForAgent` (`:761-771`).
    pub fn get_index_projects_for_agent(&self, pubkey: &str) -> Vec<String> {
        let mut seen: IndexMap<String, ()> = IndexMap::new();
        for entry in self.index.by_slug.values() {
            if entry.pubkey != pubkey {
                continue;
            }
            for p in &entry.project_ids {
                seen.insert(p.clone(), ());
            }
        }
        seen.into_keys().collect()
    }

    /// Collect every slug-owner pubkey for `project_dtag`. Mirror
    /// `getProjectMembersFromIndex` (`:780-788`).
    pub fn get_project_members_from_index(&self, project_dtag: &str) -> Vec<String> {
        let mut out = Vec::new();
        for entry in self.index.by_slug.values() {
            if entry.project_ids.iter().any(|p| p == project_dtag) {
                out.push(entry.pubkey.clone());
            }
        }
        out
    }
}
