use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const TELEGRAM_TRANSPORT: &str = "telegram";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportBindingRecord {
    pub transport: String,
    pub agent_pubkey: String,
    pub channel_id: String,
    pub project_id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct BindingStore {
    path: PathBuf,
    bindings: HashMap<String, TransportBindingRecord>,
}

impl BindingStore {
    /// Load (or create) the binding store at `path`.
    ///
    /// A missing file yields an empty store. Any other I/O error or a JSON
    /// parse error returns `Err`; silently emptying a corrupt file would let
    /// the next write overwrite all known bindings.
    pub fn open(path: PathBuf) -> Result<Self> {
        let raw: Vec<TransportBindingRecord> = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s)
                .with_context(|| format!("parse binding store at {}", path.display()))?,
            Err(e) if e.kind() == ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                return Err(e)
                    .with_context(|| format!("read binding store at {}", path.display()));
            }
        };

        let bindings = raw
            .into_iter()
            .filter(|record| {
                !record.transport.is_empty()
                    && !record.agent_pubkey.is_empty()
                    && !record.channel_id.is_empty()
                    && !record.project_id.is_empty()
            })
            .map(|record| {
                (
                    make_key(&record.transport, &record.agent_pubkey, &record.channel_id),
                    record,
                )
            })
            .collect();

        Ok(Self { path, bindings })
    }

    pub fn get_telegram(
        &self,
        agent_pubkey: &str,
        channel_id: &str,
    ) -> Option<&TransportBindingRecord> {
        self.bindings
            .get(&make_key(TELEGRAM_TRANSPORT, agent_pubkey, channel_id))
    }

    pub fn remember_telegram(
        &mut self,
        agent_pubkey: &str,
        channel_id: &str,
        project_id: &str,
    ) -> Result<()> {
        let key = make_key(TELEGRAM_TRANSPORT, agent_pubkey, channel_id);
        let now = now_ms();
        let created_at = self
            .bindings
            .get(&key)
            .map(|record| record.created_at)
            .unwrap_or(now);
        self.bindings.insert(
            key,
            TransportBindingRecord {
                transport: TELEGRAM_TRANSPORT.to_string(),
                agent_pubkey: agent_pubkey.to_string(),
                channel_id: channel_id.to_string(),
                project_id: project_id.to_string(),
                created_at,
                updated_at: now,
            },
        );
        self.save()
    }

    pub fn clear_telegram(&mut self, agent_pubkey: &str, channel_id: &str) -> Result<bool> {
        let removed = self
            .bindings
            .remove(&make_key(TELEGRAM_TRANSPORT, agent_pubkey, channel_id))
            .is_some();
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    /// Return all Telegram bindings for the given agent pubkey and project ID.
    pub fn list_telegram_for_agent_project(
        &self,
        agent_pubkey: &str,
        project_id: &str,
    ) -> Vec<&TransportBindingRecord> {
        self.bindings
            .values()
            .filter(|r| {
                r.transport == TELEGRAM_TRANSPORT
                    && r.agent_pubkey == agent_pubkey
                    && r.project_id == project_id
            })
            .collect()
    }

    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut records: Vec<_> = self.bindings.values().cloned().collect();
        records.sort_by(|a, b| {
            (&a.transport, &a.agent_pubkey, &a.channel_id).cmp(&(
                &b.transport,
                &b.agent_pubkey,
                &b.channel_id,
            ))
        });
        let json = serde_json::to_string_pretty(&records)?;
        std::fs::write(&self.path, format!("{json}\n"))?;
        Ok(())
    }
}

fn make_key(transport: &str, agent_pubkey: &str, channel_id: &str) -> String {
    format!("{transport}::{agent_pubkey}::{channel_id}")
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

    #[test]
    fn remembers_telegram_binding_by_agent_and_channel() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("transport-bindings.json");
        let mut store = BindingStore::open(path.clone()).unwrap();

        store
            .remember_telegram("agent1", "telegram:chat:1", "project1")
            .unwrap();

        let reloaded = BindingStore::open(path).unwrap();
        let binding = reloaded.get_telegram("agent1", "telegram:chat:1").unwrap();
        assert_eq!(binding.project_id, "project1");
        assert_eq!(binding.transport, "telegram");
    }

    #[test]
    fn list_telegram_for_agent_project_filters_correctly() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("transport-bindings.json");
        let mut store = BindingStore::open(path).unwrap();

        store
            .remember_telegram("agent1", "telegram:chat:1", "project1")
            .unwrap();
        store
            .remember_telegram("agent1", "telegram:chat:2", "project1")
            .unwrap();
        store
            .remember_telegram("agent1", "telegram:chat:3", "project2")
            .unwrap();
        store
            .remember_telegram("agent2", "telegram:chat:1", "project1")
            .unwrap();

        let bindings = store.list_telegram_for_agent_project("agent1", "project1");
        let mut channel_ids: Vec<&str> = bindings.iter().map(|b| b.channel_id.as_str()).collect();
        channel_ids.sort();
        assert_eq!(channel_ids, vec!["telegram:chat:1", "telegram:chat:2"]);
    }

    #[test]
    fn same_channel_can_bind_different_agents_independently() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("transport-bindings.json");
        let mut store = BindingStore::open(path).unwrap();

        store
            .remember_telegram("agent1", "telegram:chat:1", "project1")
            .unwrap();
        store
            .remember_telegram("agent2", "telegram:chat:1", "project2")
            .unwrap();

        assert_eq!(
            store
                .get_telegram("agent1", "telegram:chat:1")
                .unwrap()
                .project_id,
            "project1"
        );
        assert_eq!(
            store
                .get_telegram("agent2", "telegram:chat:1")
                .unwrap()
                .project_id,
            "project2"
        );
    }

    #[test]
    fn parse_error_returns_err_and_does_not_clobber() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("transport-bindings.json");

        let original = "this is not valid json — but represents existing bindings";
        std::fs::write(&path, original).unwrap();

        let err = match BindingStore::open(path.clone()) {
            Ok(_) => panic!("expected parse error, got Ok"),
            Err(e) => e,
        };
        let msg = format!("{err:#}");
        assert!(
            msg.contains("parse binding store"),
            "unexpected error: {msg}"
        );

        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, original);
    }

    #[test]
    fn missing_file_yields_empty_store() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("does-not-exist.json");
        let store = BindingStore::open(path).unwrap();
        assert!(store.get_telegram("agent", "channel").is_none());
    }

    /// Mirrors the poller's lock topology: many tasks contending on a single
    /// `Arc<tokio::sync::Mutex<BindingStore>>`. Confirms the new lock type
    /// serializes writes without deadlocking.
    #[tokio::test]
    async fn concurrent_writes_through_tokio_mutex_serialize_cleanly() {
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("transport-bindings.json");
        let store = Arc::new(Mutex::new(BindingStore::open(path.clone()).unwrap()));

        let mut handles = Vec::new();
        for i in 0..16 {
            let store = Arc::clone(&store);
            handles.push(tokio::spawn(async move {
                let agent = format!("agent-{i}");
                let channel = format!("telegram:chat:{i}");
                store
                    .lock()
                    .await
                    .remember_telegram(&agent, &channel, "project-x")
                    .unwrap();
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        let reloaded = BindingStore::open(path).unwrap();
        for i in 0..16 {
            let agent = format!("agent-{i}");
            let channel = format!("telegram:chat:{i}");
            let binding = reloaded.get_telegram(&agent, &channel).unwrap();
            assert_eq!(binding.project_id, "project-x");
        }
    }
}
