//! JSON-backed session store mapping canonical Telegram channel IDs to Nostr
//! conversation root event IDs.
//!
//! Key: `telegram:chat:<chat_id>` for DMs / whole chats, or
//! `telegram:group:<chat_id>:topic:<thread_id>` for forum topics.
//! Value: hex Nostr event ID of the conversation root.

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::Result;

pub struct SessionStore {
    path: PathBuf,
    map: HashMap<String, String>,
}

impl SessionStore {
    /// Load (or create) the store at `path`.
    pub fn open(path: PathBuf) -> Self {
        let map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { path, map }
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
