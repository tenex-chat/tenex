//! Walk-backward cursor: the oldest `created_at` (in Unix seconds)
//! we've reached on each relay during a backfill walk. One row per
//! `(relay_url, scope_a_tags_hash)` so a scope change starts a fresh
//! walk rather than skipping events that would now match.
//!
//! The persisted value is monotonically *decreasing* across writes —
//! every page successfully fetched moves the boundary further back in
//! time, so on conflict we keep the smaller of the two values. This
//! makes restarts idempotent: a crash, restart, or transient relay
//! failure resumes from where we last persisted, not from `now`.

use std::path::Path;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

pub struct CursorStore {
    conn: Mutex<Connection>,
}

impl CursorStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create dir {}", parent.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("open cursor db {}", path.display()))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS relay_cursor (
                 relay_url   TEXT NOT NULL,
                 scope_hash  TEXT NOT NULL,
                 since_secs  INTEGER NOT NULL,
                 PRIMARY KEY (relay_url, scope_hash)
             );",
        )
        .context("init cursor schema")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get(&self, relay_url: &str, scope_hash: &str) -> Result<Option<i64>> {
        let conn = self.conn.lock();
        let row = conn
            .query_row(
                "SELECT since_secs FROM relay_cursor WHERE relay_url = ?1 AND scope_hash = ?2",
                params![relay_url, scope_hash],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .context("read relay_cursor")?;
        Ok(row)
    }

    pub fn put(&self, relay_url: &str, scope_hash: &str, since_secs: i64) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO relay_cursor(relay_url, scope_hash, since_secs)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(relay_url, scope_hash) DO UPDATE SET
                 since_secs = MIN(since_secs, excluded.since_secs)",
            params![relay_url, scope_hash, since_secs],
        )
        .context("upsert relay_cursor")?;
        Ok(())
    }

    pub fn reset(&self, relay_url: &str, scope_hash: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM relay_cursor WHERE relay_url = ?1 AND scope_hash = ?2",
            params![relay_url, scope_hash],
        )
        .context("delete relay_cursor")?;
        Ok(())
    }
}

/// Stable hash of a scope (`a`-tag list). Used to bucket cursors so a
/// scope change starts a fresh walk rather than skipping events that
/// would now match.
pub fn scope_hash(a_tags: &[String]) -> String {
    let mut sorted: Vec<&str> = a_tags.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    let mut h = Sha256::new();
    for tag in sorted {
        h.update(tag.as_bytes());
        h.update(b"\n");
    }
    hex::encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn open_temp() -> (CursorStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let store = CursorStore::open(&dir.path().join("c.db")).unwrap();
        (store, dir)
    }

    #[test]
    fn missing_returns_none() {
        let (s, _d) = open_temp();
        assert!(s.get("wss://r", "h").unwrap().is_none());
    }

    #[test]
    fn put_and_get_round_trip() {
        let (s, _d) = open_temp();
        s.put("wss://r", "h", 100).unwrap();
        assert_eq!(s.get("wss://r", "h").unwrap(), Some(100));
    }

    #[test]
    fn put_takes_min_when_lower_arrives() {
        // Walking backward, every page lowers the boundary. The cursor
        // must keep the smaller (older) value on conflict.
        let (s, _d) = open_temp();
        s.put("wss://r", "h", 200).unwrap();
        s.put("wss://r", "h", 100).unwrap();
        assert_eq!(s.get("wss://r", "h").unwrap(), Some(100));
    }

    #[test]
    fn put_ignores_higher_value_after_lower_persisted() {
        // A late "we got back to 500" arriving after we already
        // persisted "we got back to 100" must not move the cursor
        // forward in time.
        let (s, _d) = open_temp();
        s.put("wss://r", "h", 100).unwrap();
        s.put("wss://r", "h", 500).unwrap();
        assert_eq!(s.get("wss://r", "h").unwrap(), Some(100));
    }

    #[test]
    fn reset_clears_row() {
        let (s, _d) = open_temp();
        s.put("wss://r", "h", 100).unwrap();
        s.reset("wss://r", "h").unwrap();
        assert!(s.get("wss://r", "h").unwrap().is_none());
    }

    #[test]
    fn scope_hash_is_order_independent() {
        let a = vec!["31933:p:a".to_string(), "31933:p:b".to_string()];
        let b = vec!["31933:p:b".to_string(), "31933:p:a".to_string()];
        assert_eq!(scope_hash(&a), scope_hash(&b));
    }

    #[test]
    fn scope_hash_changes_with_membership() {
        let a = vec!["31933:p:a".to_string()];
        let b = vec!["31933:p:a".to_string(), "31933:p:b".to_string()];
        assert_ne!(scope_hash(&a), scope_hash(&b));
    }
}
