use anyhow::Result;
use indexmap::IndexMap;

use crate::doc::AgentDoc;
use crate::index::{AgentIndexDoc, SlugEntry};
use crate::paths::{agents_dir, INDEX_FILENAME};
use crate::storage::AgentStorage;

impl AgentStorage {
    /// `rebuildIndex` (`AgentStorage.ts:374-422`).
    ///
    /// Rebuilds `bySlug` and `byEventId` by scanning every agent file.
    /// Active agents take precedence for slug ownership; if all agents with
    /// a slug are inactive, the first one encountered wins. Project
    /// membership lists are reset to empty (matching TS — they're populated
    /// by subsequent `add_agent_to_project` calls).
    pub fn rebuild_index(&mut self) -> Result<()> {
        let dir = agents_dir(&self.base_dir);
        let mut by_slug: IndexMap<String, SlugEntry> = IndexMap::new();
        let mut by_event_id: IndexMap<String, String> = IndexMap::new();
        let mut active_owners: indexmap::IndexSet<String> = indexmap::IndexSet::new();

        if dir.exists() {
            for entry in std::fs::read_dir(&dir)? {
                let entry = entry?;
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if !name.ends_with(".json") || name == INDEX_FILENAME {
                    continue;
                }
                let pubkey = name[..name.len() - 5].to_string();
                let Some(agent) = AgentDoc::load(&self.base_dir, &pubkey)? else {
                    continue;
                };
                let Some(slug) = agent.slug().map(str::to_owned) else {
                    continue;
                };
                let active = agent.is_active();

                let existing = by_slug.get(&slug).cloned();
                if let Some(existing) = existing {
                    if existing.pubkey != pubkey && active && !active_owners.contains(&slug) {
                        by_slug.insert(
                            slug.clone(),
                            SlugEntry {
                                pubkey: pubkey.clone(),
                                project_ids: Vec::new(),
                            },
                        );
                        active_owners.insert(slug.clone());
                    }
                } else {
                    by_slug.insert(
                        slug.clone(),
                        SlugEntry {
                            pubkey: pubkey.clone(),
                            project_ids: Vec::new(),
                        },
                    );
                    if active {
                        active_owners.insert(slug.clone());
                    }
                }

                if let Some(eid) = agent.event_id() {
                    by_event_id.insert(eid.to_owned(), pubkey.clone());
                }
            }
        }

        self.index = AgentIndexDoc {
            by_slug,
            by_event_id,
        };
        self.save_index()?;
        Ok(())
    }
}
