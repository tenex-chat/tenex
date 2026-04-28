//! Versioned schema and migration runner.
//!
//! One source of truth. Each migration is a string of DDL/DML run in a
//! transaction. `schema_version` is stored in the `meta` table; mismatch
//! between code's `EXPECTED_SCHEMA_VERSION` and DB's recorded version is a
//! startup error (forward-only migrations).
//!
//! Schema design notes:
//! - `conversations.runtime_state_json`: a single JSON blob for
//!   conversation-global runtime fields that don't merit columns
//!   (executionTime, injections, activeRal/nextRalNumber, todoNudgedAgents,
//!   blockedAgents, metaModelVariantOverride). These are bookkeeping for the
//!   live agent runner; they are not searchable and have no foreign-key needs.
//! - `agent_context_state` carries per-(agent, conversation) bookkeeping:
//!   prompt-history pointers (last seen sequence, cache-anchored flag),
//!   compaction state, reminder state, todos, self-applied skills, blocked
//!   flag, meta-model variant override. One JSON column per concern keeps the
//!   schema small while preserving structure that the runner already serializes.

use rusqlite::Connection;

use crate::error::{ConversationsError, Result};

pub const EXPECTED_SCHEMA_VERSION: i64 = 1;

const MIGRATION_V1: &str = r#"
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    summary TEXT,
    last_user_message TEXT,
    status_label TEXT,
    status_current_activity TEXT,
    owner_pubkey TEXT,
    created_at INTEGER,
    last_activity INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    runtime_state_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_conversations_last_activity
    ON conversations(last_activity DESC);

CREATE INDEX idx_conversations_owner_pubkey
    ON conversations(owner_pubkey);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    nostr_event_id TEXT,
    sequence INTEGER NOT NULL,
    author_pubkey TEXT NOT NULL,
    sender_pubkey TEXT,
    ral INTEGER,
    message_type TEXT NOT NULL,
    role TEXT,
    content TEXT NOT NULL,
    timestamp INTEGER,
    targeted_pubkeys_json TEXT,
    sender_principal_json TEXT,
    targeted_principals_json TEXT,
    tool_data_json TEXT,
    delegation_marker_json TEXT,
    human_readable TEXT,
    transcript_tool_attributes_json TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(conversation_id, record_id),
    FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_messages_conversation_seq
    ON messages(conversation_id, sequence);

CREATE INDEX idx_messages_conversation_author
    ON messages(conversation_id, author_pubkey, sequence);

CREATE UNIQUE INDEX idx_messages_nostr_event_id
    ON messages(nostr_event_id)
    WHERE nostr_event_id IS NOT NULL;

CREATE TABLE tool_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    parent_message_id INTEGER,
    agent_pubkey TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    call_input BLOB NOT NULL,
    result_output BLOB,
    is_error INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(conversation_id, tool_call_id),
    FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE,
    FOREIGN KEY (parent_message_id)
        REFERENCES messages(id)
        ON DELETE SET NULL
);

CREATE INDEX idx_tool_messages_conversation
    ON tool_messages(conversation_id);

CREATE TABLE agent_prompt_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    agent_pubkey TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    role TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_message_id TEXT,
    source_record_id TEXT,
    source_event_id TEXT,
    overlay_type TEXT,
    content_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(conversation_id, agent_pubkey, prompt_id),
    FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE
);

CREATE INDEX idx_agent_prompt_history_replay
    ON agent_prompt_history(conversation_id, agent_pubkey, sequence);

CREATE TABLE agent_context_state (
    conversation_id TEXT NOT NULL,
    agent_pubkey TEXT NOT NULL,
    next_prompt_sequence INTEGER NOT NULL DEFAULT 0,
    cache_anchored INTEGER NOT NULL DEFAULT 0,
    seen_message_ids_json TEXT NOT NULL DEFAULT '[]',
    compaction_state_json TEXT,
    reminder_state_json TEXT,
    reminder_delta_state_json TEXT,
    todos_json TEXT,
    self_applied_skills_json TEXT,
    meta_model_variant TEXT,
    is_blocked INTEGER NOT NULL DEFAULT 0,
    todo_nudged INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, agent_pubkey),
    FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE
);

CREATE TABLE completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    root_event_id TEXT,
    completed_by_pubkey TEXT NOT NULL,
    recipient_pubkey TEXT,
    status TEXT NOT NULL,
    abort_reason TEXT,
    nostr_event_id TEXT,
    completed_at INTEGER NOT NULL,
    metadata_json TEXT,
    UNIQUE(conversation_id, completed_by_pubkey, completed_at, status),
    FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE
);

CREATE INDEX idx_completions_conversation
    ON completions(conversation_id);

CREATE UNIQUE INDEX idx_completions_nostr_event_id
    ON completions(nostr_event_id)
    WHERE nostr_event_id IS NOT NULL;
"#;

/// Migrations indexed by target version. v1 is the initial schema.
fn migrations() -> &'static [(i64, &'static str)] {
    &[(1, MIGRATION_V1)]
}

/// Configure pragmas required by the crate. Must run on every connection.
pub fn configure_connection(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5_000)?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

/// Apply pending migrations up to [`EXPECTED_SCHEMA_VERSION`].
///
/// If the DB is at a *later* version than the library expects, returns
/// [`ConversationsError::SchemaVersionMismatch`] — running with a forward
/// version risks data corruption.
pub fn migrate(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );",
    )?;

    let current_version: i64 = conn
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if current_version > EXPECTED_SCHEMA_VERSION {
        return Err(ConversationsError::SchemaVersionMismatch {
            found: current_version,
            expected: EXPECTED_SCHEMA_VERSION,
        });
    }

    for (target_version, sql) in migrations() {
        if *target_version <= current_version {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [target_version.to_string()],
        )?;
        tx.commit()?;
        tracing::info!(target_version, "applied conversation-db migration");
    }

    Ok(())
}
