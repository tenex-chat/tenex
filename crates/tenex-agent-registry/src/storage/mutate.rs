use anyhow::{anyhow, Context, Result};
use serde_json::Value;

use crate::doc::{AgentDoc, TelegramAgentConfig};
use crate::index::SlugEntry;
use crate::keys::derive_agent_pubkey_from_nsec;
use crate::paths::{agent_file_path, agents_dir, INDEX_FILENAME};
use crate::storage::AgentStorage;

impl AgentStorage {
    /// Mirror `cleanupDuplicateSlugs` (`AgentStorage.ts:488-546`).
    ///
    /// When a new agent is being saved with a slug that already exists,
    /// remove the old agent from projects that overlap with the new agent.
    /// The old agent's slug entry is updated; if it loses all its projects,
    /// the slug entry is removed entirely.
    fn cleanup_duplicate_slugs(
        &mut self,
        slug: &str,
        new_pubkey: &str,
        new_projects: &[String],
    ) -> Result<()> {
        let existing = match self.index.by_slug.get(slug) {
            Some(e) if e.pubkey != new_pubkey => e.clone(),
            _ => return Ok(()),
        };

        let overlapping: Vec<String> = existing
            .project_ids
            .iter()
            .filter(|p| new_projects.iter().any(|n| n == *p))
            .cloned()
            .collect();
        if overlapping.is_empty() {
            return Ok(());
        }

        for project_dtag in &overlapping {
            // Mirror TS: removeAgentFromProject(existing.pubkey, projectDTag).
            // After eviction, drop this project from the existing slug entry.
            self.remove_agent_from_project(&existing.pubkey, project_dtag)?;

            if let Some(entry) = self.index.by_slug.get_mut(slug) {
                entry.project_ids.retain(|p| p != project_dtag);
            }
        }

        // If old agent has no projects left in this slug entry, remove it.
        if let Some(entry) = self.index.by_slug.get(slug) {
            if entry.project_ids.is_empty() && entry.pubkey == existing.pubkey {
                self.index.by_slug.shift_remove(slug);
            }
        }

        Ok(())
    }

    /// Mirror `findAlternativeSlugOwner` (`AgentStorage.ts:432-454`).
    /// Scans every `*.json` (excluding `index.json`) for an active agent
    /// owning the same slug, excluding `exclude_pubkey`.
    fn find_alternative_slug_owner(
        &self,
        slug: &str,
        exclude_pubkey: &str,
    ) -> Result<Option<String>> {
        let dir = agents_dir(&self.base_dir);
        if !dir.exists() {
            return Ok(None);
        }
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.ends_with(".json") || name == INDEX_FILENAME {
                continue;
            }
            let pubkey = &name[..name.len() - 5];
            if pubkey == exclude_pubkey {
                continue;
            }
            let Some(agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
                continue;
            };
            if agent.slug() == Some(slug) && agent.is_active() {
                return Ok(Some(pubkey.to_string()));
            }
        }
        Ok(None)
    }

    /// `saveAgent` (`AgentStorage.ts:551-636`).
    ///
    /// Writes the agent file (with persistence sanitization), updates the
    /// `bySlug` index honoring slug-ownership transitions, updates
    /// `byEventId`, and invokes `cleanup_duplicate_slugs` for overlapping
    /// projects. Pubkey is derived from `agent.nsec`.
    pub fn save_agent(&mut self, agent: &AgentDoc) -> Result<String> {
        let nsec = agent
            .nsec()
            .ok_or_else(|| anyhow!("save_agent: missing nsec"))?;
        let slug = agent
            .slug()
            .ok_or_else(|| anyhow!("save_agent: missing slug"))?
            .to_string();
        let pubkey = derive_agent_pubkey_from_nsec(nsec)?;

        // Existing on-disk agent (for slug/eventId diff).
        let existing = AgentDoc::load(&self.base_dir, &pubkey)?;

        // Cleanup any overlapping projects for the same slug owned by another agent.
        let current_projects = self.get_index_projects_for_agent(&pubkey);
        self.cleanup_duplicate_slugs(&slug, &pubkey, &current_projects)?;

        // Persist the agent file (sanitized).
        agent.save(&self.base_dir, &pubkey)?;

        // ── Update bySlug ──
        // Remove old slug entry if slug changed and we owned it.
        if let Some(existing) = &existing {
            if let Some(old_slug) = existing.slug() {
                if old_slug != slug {
                    if let Some(old_entry) = self.index.by_slug.get(old_slug) {
                        if old_entry.pubkey == pubkey {
                            self.index.by_slug.shift_remove(old_slug);
                        }
                    }
                }
            }
        }

        // Remove old eventId if changed and pointed at us.
        let new_event_id = agent.event_id().map(str::to_owned);
        if let Some(existing) = &existing {
            if let Some(old_eid) = existing.event_id() {
                if Some(old_eid) != new_event_id.as_deref()
                    && self.index.by_event_id.get(old_eid).map(String::as_str) == Some(&pubkey)
                {
                    self.index.by_event_id.shift_remove(old_eid);
                }
            }
        }

        if agent.is_active() {
            // Active: claim the slug if we own it or it's unowned. We do NOT
            // overwrite a different active owner — slug takeover for new
            // agents happens in `add_agent_to_project` after cleanup.
            let agent_projects = self.get_index_projects_for_agent(&pubkey);
            let claim = match self.index.by_slug.get(&slug) {
                None => true,
                Some(e) if e.pubkey == pubkey => true,
                _ => false,
            };
            if claim {
                self.index.by_slug.insert(
                    slug.clone(),
                    SlugEntry {
                        pubkey: pubkey.clone(),
                        project_ids: agent_projects,
                    },
                );
            }
        } else {
            // Inactive: handle ownership transition.
            let current = self.index.by_slug.get(&slug).cloned();
            match current {
                Some(e) if e.pubkey == pubkey => {
                    // We were the canonical owner but are now inactive.
                    let alt = self.find_alternative_slug_owner(&slug, &pubkey)?;
                    if let Some(alt) = alt {
                        let alt_projects = self.get_index_projects_for_agent(&alt);
                        self.index.by_slug.insert(
                            slug.clone(),
                            SlugEntry {
                                pubkey: alt,
                                project_ids: alt_projects,
                            },
                        );
                    } else {
                        // Keep the entry pointing at us with refreshed projects.
                        let our_projects = self.get_index_projects_for_agent(&pubkey);
                        self.index.by_slug.insert(
                            slug.clone(),
                            SlugEntry {
                                pubkey: pubkey.clone(),
                                project_ids: our_projects,
                            },
                        );
                    }
                }
                None => {
                    // No owner — claim it for reactivation lookup.
                    self.index.by_slug.insert(
                        slug.clone(),
                        SlugEntry {
                            pubkey: pubkey.clone(),
                            project_ids: Vec::new(),
                        },
                    );
                }
                Some(_) => {
                    // Another agent owns the slug — leave it alone.
                }
            }
        }

        // Update byEventId.
        if let Some(eid) = new_event_id {
            self.index.by_event_id.insert(eid, pubkey.clone());
        }

        self.save_index()?;
        Ok(pubkey)
    }

    /// `deleteAgent` (`AgentStorage.ts:652-690`).
    ///
    /// Permanently removes the agent's file and clears the slug/eventId
    /// index entries that pointed at it. Returns `true` if an agent was
    /// found and deleted, `false` if the file was already gone (matching
    /// TS `if (!agent) return;` behavior).
    pub fn delete_agent(&mut self, pubkey: &str) -> Result<bool> {
        let Some(agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
            return Ok(false);
        };

        let path = agent_file_path(&self.base_dir, pubkey);
        std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;

        if let Some(slug) = agent.slug() {
            if let Some(entry) = self.index.by_slug.get(slug) {
                if entry.pubkey == pubkey {
                    self.index.by_slug.shift_remove(slug);
                }
            }
        }

        if let Some(eid) = agent.event_id() {
            if self.index.by_event_id.get(eid).map(String::as_str) == Some(pubkey) {
                self.index.by_event_id.shift_remove(eid);
            }
        }

        self.save_index()?;
        Ok(true)
    }

    /// `addAgentToProject` (`AgentStorage.ts:796-829`).
    ///
    /// Reactivates an inactive agent if necessary, evicts other agents that
    /// own the same slug in this project, and writes back the agent file
    /// with `status: "active"`.
    pub fn add_agent_to_project(&mut self, pubkey: &str, project_dtag: &str) -> Result<()> {
        let mut agent = AgentDoc::load(&self.base_dir, pubkey)?
            .ok_or_else(|| anyhow!("Agent {pubkey} not found"))?;
        let slug = agent
            .slug()
            .ok_or_else(|| anyhow!("agent {pubkey} missing slug"))?
            .to_string();

        self.cleanup_duplicate_slugs(&slug, pubkey, &[project_dtag.to_string()])?;

        // Update bySlug — last writer claims slug ownership.
        match self.index.by_slug.get_mut(&slug) {
            Some(entry) if entry.pubkey == pubkey => {
                if !entry.project_ids.iter().any(|p| p == project_dtag) {
                    entry.project_ids.push(project_dtag.to_string());
                }
            }
            _ => {
                self.index.by_slug.insert(
                    slug.clone(),
                    SlugEntry {
                        pubkey: pubkey.to_string(),
                        project_ids: vec![project_dtag.to_string()],
                    },
                );
            }
        }

        // Reactivate.
        agent
            .raw_mut()
            .insert("status".into(), Value::String("active".into()));
        self.save_agent(&agent)?;
        Ok(())
    }

    /// `removeAgentFromProject` (`AgentStorage.ts:895-916`).
    pub fn remove_agent_from_project(&mut self, pubkey: &str, project_dtag: &str) -> Result<()> {
        let Some(mut agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
            return Ok(());
        };
        let Some(slug) = agent.slug().map(str::to_owned) else {
            return Ok(());
        };

        if let Some(entry) = self.index.by_slug.get_mut(&slug) {
            if entry.pubkey == pubkey {
                entry.project_ids.retain(|p| p != project_dtag);
            }
        }

        let remaining = self.get_index_projects_for_agent(pubkey);
        let new_status = if remaining.is_empty() {
            "inactive"
        } else {
            "active"
        };
        agent
            .raw_mut()
            .insert("status".into(), Value::String(new_status.into()));
        self.save_agent(&agent)?;
        Ok(())
    }

    /// `getCanonicalActiveAgents` (`AgentStorage.ts:1020-1035`).
    pub fn get_canonical_active_agents(&self) -> Result<Vec<AgentDoc>> {
        let mut out = Vec::new();
        for entry in self.index.by_slug.values() {
            let Some(agent) = AgentDoc::load(&self.base_dir, &entry.pubkey)? else {
                continue;
            };
            if agent.is_active() {
                out.push(agent);
            }
        }
        Ok(out)
    }

    /// `getAllStoredAgents` (`AgentStorage.ts:1044-1060`).
    /// Includes inactive + duplicates. File order is the OS readdir order.
    pub fn get_all_stored_agents(&self) -> Result<Vec<(String, AgentDoc)>> {
        let dir = agents_dir(&self.base_dir);
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
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
            if let Some(agent) = AgentDoc::load(&self.base_dir, &pubkey)? {
                out.push((pubkey, agent));
            }
        }
        Ok(out)
    }

    /// Set the agent's `category` field to the canonical kebab-case literal
    /// and persist via [`Self::save_agent`]. Returns `Ok(false)` when the
    /// agent file is missing.
    ///
    /// Taking [`crate::category::AgentCategory`] makes it impossible for the
    /// caller to write a stale literal — the enum is the only spelling on
    /// disk.
    pub fn update_category(
        &mut self,
        pubkey: &str,
        category: crate::category::AgentCategory,
    ) -> Result<bool> {
        let Some(mut agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
            return Ok(false);
        };
        agent.raw_mut().insert(
            "category".into(),
            Value::String(category.as_str().to_owned()),
        );
        self.save_agent(&agent)?;
        Ok(true)
    }

    /// Mirror `updateAgentTelegramConfig` (`AgentStorage.ts:996-1012`).
    ///
    /// `Some(config)` → write a sanitized telegram block; `None` → drop
    /// the block entirely (i.e. disable the per-agent bot). Either way
    /// runs through `save_agent` so the persistence sanitiser collapses
    /// empties + reapplies index updates. Returns `Ok(false)` when the
    /// agent file is missing — matches TS `if (!agent) return false`.
    pub fn update_agent_telegram_config(
        &mut self,
        pubkey: &str,
        config: Option<&TelegramAgentConfig>,
    ) -> Result<bool> {
        let Some(mut agent) = AgentDoc::load(&self.base_dir, pubkey)? else {
            return Ok(false);
        };
        match config {
            None => {
                agent.raw_mut().shift_remove("telegram");
            }
            Some(c) => {
                let mut block = serde_json::Map::new();
                block.insert("botToken".into(), Value::String(c.bot_token.clone()));
                if let Some(b) = c.allow_dms {
                    block.insert("allowDMs".into(), Value::Bool(b));
                }
                if let Some(u) = &c.api_base_url {
                    block.insert("apiBaseUrl".into(), Value::String(u.clone()));
                }
                if let Some(b) = c.publish_reasoning_to_telegram {
                    block.insert("publishReasoningToTelegram".into(), Value::Bool(b));
                }
                if let Some(b) = c.publish_conversation_to_telegram {
                    block.insert("publishConversationToTelegram".into(), Value::Bool(b));
                }
                agent
                    .raw_mut()
                    .insert("telegram".into(), Value::Object(block));
            }
        }
        self.save_agent(&agent)?;
        Ok(true)
    }
}
