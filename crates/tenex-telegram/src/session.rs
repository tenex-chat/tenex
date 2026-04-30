//! JSON-backed session store mapping canonical Telegram channel IDs to Nostr
//! conversation root event IDs.
//!
//! Key: `telegram:chat:<chat_id>` for DMs / whole chats, or
//! `telegram:group:<chat_id>:topic:<thread_id>` for forum topics.
//! Value: hex Nostr event ID of the conversation root.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::PathBuf;

use anyhow::{Context, Result};

pub struct SessionStore {
    path: PathBuf,
    map: HashMap<String, String>,
}

impl SessionStore {
    /// Load (or create) the store at `path`.
    ///
    /// A missing file yields an empty store. Any other I/O error or a JSON
    /// parse error returns `Err` so the caller can refuse to start rather than
    /// silently overwriting corrupted state on the next write.
    pub fn open(path: PathBuf) -> Result<Self> {
        let map = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw)
                .with_context(|| format!("parse session store at {}", path.display()))?,
            Err(e) if e.kind() == ErrorKind::NotFound => HashMap::new(),
            Err(e) => {
                return Err(e)
                    .with_context(|| format!("read session store at {}", path.display()));
            }
        };
        Ok(Self { path, map })
    }

    /// Canonical channel ID for a DM, whole group, or group topic.
    pub fn channel_key(chat_id: &str, thread_id: Option<&str>) -> String {
        match thread_id {
            Some(tid) if !tid.is_empty() => format!("telegram:group:{chat_id}:topic:{tid}"),
            _ => format!("telegram:chat:{chat_id}"),
        }
    }

    /// Look up the conversation root for a channel.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.map.get(key).map(|s| s.as_str())
    }

    /// Store (or update) the conversation root for a channel and persist.
    pub fn set(&mut self, key: String, root_event_id: String) -> Result<()> {
        self.map.insert(key, root_event_id);
        self.save()
    }

    /// Remove a session (called on /new command) and persist.
    pub fn clear(&mut self, key: &str) -> Result<()> {
        self.map.remove(key);
        self.save()
    }

    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&self.map)?;
        std::fs::write(&self.path, json)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn missing_file_yields_empty_store() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("does-not-exist.json");
        let store = SessionStore::open(path).unwrap();
        assert!(store.get("anything").is_none());
    }

    #[test]
    fn round_trips_session() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("sessions.json");

        {
            let mut store = SessionStore::open(path.clone()).unwrap();
            store
                .set("telegram:chat:1".to_string(), "deadbeef".to_string())
                .unwrap();
        }

        let store = SessionStore::open(path).unwrap();
        assert_eq!(store.get("telegram:chat:1"), Some("deadbeef"));
    }

    #[test]
    fn parse_error_returns_err_and_does_not_clobber() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("sessions.json");

        // Write invalid JSON containing real binding-like data.
        let original = "{ this is not valid json but represents existing bindings }";
        std::fs::write(&path, original).unwrap();

        let result = SessionStore::open(path.clone());
        let err = match result {
            Ok(_) => panic!("expected parse error, got Ok"),
            Err(e) => e,
        };
        let msg = format!("{err:#}");
        assert!(
            msg.contains("parse session store"),
            "unexpected error: {msg}"
        );

        // The file must remain untouched — the previous (corrupted but
        // recoverable) data is the operator's last-known-good payload.
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, original);
    }
}
