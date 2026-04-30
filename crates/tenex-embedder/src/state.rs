//! Per-conversation embedding bookkeeping.
//!
//! Walk-forward design: we always re-window the conversation's full
//! event set on each pass and rely on chunk content-hash diff to skip
//! unchanged chunks. State here is a small fingerprint to short-circuit
//! the no-op case and a rate-limit timestamp.

use std::path::Path;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};

pub struct StateStore {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Default)]
pub struct ConversationState {
    /// Highest `created_at` (seconds) of any event we've seen for this
    /// conversation. Used to short-circuit when no new events arrived.
    pub last_event_secs: i64,
    /// Number of events seen — second-axis change detector for the
    /// rare case where multiple events share `created_at`.
    pub event_count: i64,
    /// `MIN_INTERVAL_MS` rate limit anchor.
    pub visited_at_ms: i64,
}

impl StateStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create dir {}", parent.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("open state db {}", path.display()))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=5000;
             CREATE TABLE IF NOT EXISTS conversation_embed_state (
                 conversation_id  TEXT PRIMARY KEY,
                 last_event_secs  INTEGER NOT NULL DEFAULT 0,
                 event_count      INTEGER NOT NULL DEFAULT 0,
                 visited_at_ms    INTEGER NOT NULL DEFAULT 0
             );",
        )
        .context("init state schema")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get(&self, conversation_id: &str) -> Result<ConversationState> {
        let conn = self.conn.lock();
        let row = conn
            .query_row(
                "SELECT last_event_secs, event_count, visited_at_ms
                   FROM conversation_embed_state WHERE conversation_id = ?1",
                params![conversation_id],
                |r| {
                    Ok(ConversationState {
                        last_event_secs: r.get(0)?,
                        event_count: r.get(1)?,
                        visited_at_ms: r.get(2)?,
                    })
                },
            )
            .optional()
            .context("read conversation_embed_state")?;
        Ok(row.unwrap_or_default())
    }

    pub fn put(&self, conversation_id: &str, state: &ConversationState) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO conversation_embed_state(conversation_id, last_event_secs, event_count, visited_at_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(conversation_id) DO UPDATE SET
                 last_event_secs = excluded.last_event_secs,
                 event_count     = excluded.event_count,
                 visited_at_ms   = excluded.visited_at_ms",
            params![
                conversation_id,
                state.last_event_secs,
                state.event_count,
                state.visited_at_ms,
            ],
        )
        .context("upsert conversation_embed_state")?;
        Ok(())
    }

    pub fn delete(&self, conversation_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM conversation_embed_state WHERE conversation_id = ?1",
            params![conversation_id],
        )
        .context("delete conversation_embed_state")?;
        Ok(())
    }

    pub fn delete_all(&self) -> Result<usize> {
        let conn = self.conn.lock();
        let n = conn
            .execute("DELETE FROM conversation_embed_state", [])
            .context("delete all state")?;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp() -> (StateStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let s = StateStore::open(&dir.path().join("s.db")).unwrap();
        (s, dir)
    }

    #[test]
    fn missing_returns_default() {
        let (s, _d) = temp();
        let state = s.get("c").unwrap();
        assert_eq!(state.event_count, 0);
        assert_eq!(state.last_event_secs, 0);
    }

    #[test]
    fn put_then_get_round_trips() {
        let (s, _d) = temp();
        let written = ConversationState {
            last_event_secs: 100,
            event_count: 5,
            visited_at_ms: 1_700_000_000_000,
        };
        s.put("c", &written).unwrap();
        let read = s.get("c").unwrap();
        assert_eq!(read.last_event_secs, 100);
        assert_eq!(read.event_count, 5);
        assert_eq!(read.visited_at_ms, 1_700_000_000_000);
    }

    #[test]
    fn delete_all_wipes_table() {
        let (s, _d) = temp();
        s.put("a", &ConversationState::default()).unwrap();
        s.put("b", &ConversationState::default()).unwrap();
        let n = s.delete_all().unwrap();
        assert_eq!(n, 2);
    }
}
