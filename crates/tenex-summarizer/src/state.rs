//! Per-conversation summarization state. The catalog DB has no
//! `last_summarized_at` column and the conversation JSON's metadata block
//! holds the *result* but not the bookkeeping we need to enforce the policy
//! (only summarize when activity has advanced; cap at one summarize per
//! 5 minutes per conversation).
//!
//! This is durable in `~/.tenex/summarizer/state.db` so a restart does not
//! re-summarize the entire host.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

pub struct SummaryStateStore {
    conn: Connection,
}

#[derive(Debug, Clone, Copy)]
pub struct SummaryState {
    pub last_activity_summarized: i64,
    pub last_summarized_at_ms: i64,
}

impl SummaryStateStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let conn =
            Connection::open(path).with_context(|| format!("open state db {}", path.display()))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS conversation_summary_state (
                 conversation_id TEXT PRIMARY KEY,
                 last_activity_summarized INTEGER NOT NULL,
                 last_summarized_at_ms INTEGER NOT NULL
             );",
        )?;
        Ok(Self { conn })
    }

    pub fn get(&self, conversation_id: &str) -> Result<Option<SummaryState>> {
        let row = self
            .conn
            .query_row(
                "SELECT last_activity_summarized, last_summarized_at_ms
                   FROM conversation_summary_state
                  WHERE conversation_id = ?",
                params![conversation_id],
                |r| {
                    Ok(SummaryState {
                        last_activity_summarized: r.get(0)?,
                        last_summarized_at_ms: r.get(1)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn record(&self, conversation_id: &str, last_activity: i64, now_ms: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO conversation_summary_state
                 (conversation_id, last_activity_summarized, last_summarized_at_ms)
             VALUES (?, ?, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET
                 last_activity_summarized = excluded.last_activity_summarized,
                 last_summarized_at_ms     = excluded.last_summarized_at_ms",
            params![conversation_id, last_activity, now_ms],
        )?;
        Ok(())
    }
}
