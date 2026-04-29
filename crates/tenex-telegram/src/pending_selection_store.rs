//! Disk-backed store for pending Telegram channel-to-project selection state.
//!
//! When an unbound channel sends its first message, the bot presents a numbered
//! list of projects and waits for the user to pick one. This state is persisted
//! so it survives daemon restarts.
//!
//! File: `{base_dir}/data/pending-channel-selections.json`
//! Format: JSON array of `PendingSelectionRecord`s, sorted for deterministic diffs.
//! TTL: 24 hours from `requested_at`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// 24-hour TTL in milliseconds, matching the TypeScript reference.
const PENDING_TTL_MS: i64 = 1_000 * 60 * 60 * 24;

/// A project option stored within a pending record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingProjectOption {
    pub project_id: String,
    pub title: Option<String>,
}

/// One pending selection record: an unbound channel waiting for a project choice.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSelectionRecord {
    pub agent_pubkey: String,
    pub channel_id: String,
    pub projects: Vec<PendingProjectOption>,
    /// Unix timestamp in milliseconds when the selection was first requested.
    pub requested_at: i64,
}

/// Disk-backed store for pending channel-to-project selection state.
pub struct PendingSelectionStore {
    path: PathBuf,
    records: HashMap<String, PendingSelectionRecord>,
}

impl PendingSelectionStore {
    /// Load (or create) the store at `path`. Expired entries are dropped on load;
    /// if any are dropped, the cleaned state is persisted immediately.
    pub fn open(path: PathBuf) -> Self {
        let now = now_ms();
        let raw: Vec<PendingSelectionRecord> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let raw_count = raw.len();
        let records: HashMap<String, PendingSelectionRecord> = raw
            .into_iter()
            .filter(|r| {
                !r.agent_pubkey.is_empty()
                    && !r.channel_id.is_empty()
                    && !is_expired(r.requested_at, now)
            })
            .map(|r| (make_key(&r.agent_pubkey, &r.channel_id), r))
            .collect();

        let store = Self { path, records };

        // Persist pruned state only when records were actually dropped.
        if store.records.len() < raw_count {
            let _ = store.save();
        }

        store
    }

    /// Look up pending projects for an unbound channel. Returns `None` if not
    /// found or if the record has expired (and removes it from disk).
    pub fn get(
        &mut self,
        agent_pubkey: &str,
        channel_id: &str,
    ) -> Option<Vec<PendingProjectOption>> {
        let key = make_key(agent_pubkey, channel_id);
        let record = self.records.get(&key)?;
        if is_expired(record.requested_at, now_ms()) {
            self.records.remove(&key);
            let _ = self.save();
            return None;
        }
        Some(record.projects.clone())
    }

    /// Store (or update) a pending selection and persist to disk.
    pub fn set(
        &mut self,
        agent_pubkey: &str,
        channel_id: &str,
        projects: Vec<PendingProjectOption>,
    ) -> Result<()> {
        self.prune_expired();
        let key = make_key(agent_pubkey, channel_id);
        self.records.insert(
            key,
            PendingSelectionRecord {
                agent_pubkey: agent_pubkey.to_string(),
                channel_id: channel_id.to_string(),
                projects,
                requested_at: now_ms(),
            },
        );
        self.save()
    }

    /// Remove a pending selection and persist.
    pub fn clear(&mut self, agent_pubkey: &str, channel_id: &str) -> Result<()> {
        let key = make_key(agent_pubkey, channel_id);
        if self.records.remove(&key).is_some() {
            self.save()?;
        }
        Ok(())
    }

    fn prune_expired(&mut self) {
        let now = now_ms();
        let before = self.records.len();
        self.records
            .retain(|_, r| !is_expired(r.requested_at, now));
        if self.records.len() != before {
            let _ = self.save();
        }
    }

    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut records: Vec<_> = self.records.values().cloned().collect();
        records.sort_by(|a, b| {
            (&a.agent_pubkey, &a.channel_id).cmp(&(&b.agent_pubkey, &b.channel_id))
        });

        let json = serde_json::to_string_pretty(&records)?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, format!("{json}\n"))?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

fn make_key(agent_pubkey: &str, channel_id: &str) -> String {
    format!("{agent_pubkey}::{channel_id}")
}

fn is_expired(requested_at: i64, now: i64) -> bool {
    now - requested_at > PENDING_TTL_MS
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    fn project_opts(ids: &[&str]) -> Vec<PendingProjectOption> {
        ids.iter()
            .map(|id| PendingProjectOption {
                project_id: id.to_string(),
                title: Some(id.to_string()),
            })
            .collect()
    }

    #[test]
    fn round_trips_pending_selection() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("data").join("pending-channel-selections.json");

        {
            let mut store = PendingSelectionStore::open(path.clone());
            store
                .set("agent-1", "telegram:chat:42", project_opts(&["proj-a", "proj-b"]))
                .unwrap();
        }

        let mut store2 = PendingSelectionStore::open(path);
        let projects = store2.get("agent-1", "telegram:chat:42").unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].project_id, "proj-a");
        assert_eq!(projects[1].project_id, "proj-b");
    }

    #[test]
    fn clear_removes_entry_from_disk() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("data").join("pending-channel-selections.json");

        let mut store = PendingSelectionStore::open(path.clone());
        store
            .set("agent-1", "telegram:chat:1", project_opts(&["proj-a"]))
            .unwrap();
        store.clear("agent-1", "telegram:chat:1").unwrap();

        let mut store2 = PendingSelectionStore::open(path);
        assert!(store2.get("agent-1", "telegram:chat:1").is_none());
    }

    #[test]
    fn drops_expired_entries_on_load() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("data").join("pending-channel-selections.json");

        // Write a record that is already older than 24h.
        let expired_at = now_ms() - PENDING_TTL_MS - 1;
        let record = PendingSelectionRecord {
            agent_pubkey: "agent-1".to_string(),
            channel_id: "telegram:chat:1".to_string(),
            projects: project_opts(&["proj-a"]),
            requested_at: expired_at,
        };
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&vec![record]).unwrap(),
        )
        .unwrap();

        let mut store = PendingSelectionStore::open(path);
        assert!(store.get("agent-1", "telegram:chat:1").is_none());
    }

    #[test]
    fn get_evicts_expired_entry_and_persists() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("data").join("pending-channel-selections.json");

        // Write a record that is still fresh.
        let fresh_at = now_ms() - 1_000; // 1 second ago — well within 24h
        let record = PendingSelectionRecord {
            agent_pubkey: "agent-1".to_string(),
            channel_id: "telegram:chat:1".to_string(),
            projects: project_opts(&["proj-a"]),
            requested_at: fresh_at,
        };
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(&vec![record]).unwrap()).unwrap();

        // Manually corrupt the in-memory requested_at by re-reading with a manipulated file.
        // Instead: write an already-expired record directly.
        let expired_at = now_ms() - PENDING_TTL_MS - 1;
        let expired_record = PendingSelectionRecord {
            agent_pubkey: "agent-1".to_string(),
            channel_id: "telegram:chat:1".to_string(),
            projects: project_opts(&["proj-a"]),
            requested_at: expired_at,
        };
        // Re-open with a fresh store so it loads the expired record (bypassing
        // the on-load prune by writing directly after open).
        let mut store = PendingSelectionStore::open(path.clone());
        // Insert expired record directly into the map (bypassing set's prune).
        store.records.insert(
            make_key("agent-1", "telegram:chat:1"),
            expired_record,
        );

        // get() should detect expiry and return None.
        assert!(store.get("agent-1", "telegram:chat:1").is_none());

        // Reloading should confirm removal was persisted.
        let mut store2 = PendingSelectionStore::open(path);
        assert!(store2.get("agent-1", "telegram:chat:1").is_none());
    }

    #[test]
    fn multiple_agents_tracked_independently() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("data").join("pending-channel-selections.json");

        let mut store = PendingSelectionStore::open(path.clone());
        store
            .set("agent-1", "telegram:chat:1", project_opts(&["proj-a"]))
            .unwrap();
        store
            .set("agent-2", "telegram:chat:1", project_opts(&["proj-b"]))
            .unwrap();

        let mut store2 = PendingSelectionStore::open(path);
        let p1 = store2.get("agent-1", "telegram:chat:1").unwrap();
        let p2 = store2.get("agent-2", "telegram:chat:1").unwrap();
        assert_eq!(p1[0].project_id, "proj-a");
        assert_eq!(p2[0].project_id, "proj-b");
    }
}
