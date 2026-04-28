//! Forward-only schema migrations.
//!
//! The current schema version is the contract. A DB whose `schema_version`
//! row is higher than [`CURRENT_SCHEMA_VERSION`] is rejected at open time:
//! a newer writer must not silently downgrade. A lower version is migrated
//! up by running each step in order.

use rusqlite::{params, Connection};

use crate::error::{Error, Result};

pub const CURRENT_SCHEMA_VERSION: i64 = 1;

/// Apply pragmas and run any pending migrations on `conn`.
pub fn initialize(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         PRAGMA busy_timeout=5000;",
    )?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
             version INTEGER PRIMARY KEY
         );",
    )?;

    let current: i64 = conn
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| r.get(0))?;

    if current > CURRENT_SCHEMA_VERSION {
        return Err(Error::SchemaVersionMismatch {
            found: current,
            expected: CURRENT_SCHEMA_VERSION,
        });
    }

    let steps: &[(i64, &str)] = &[(1, MIGRATION_V1)];

    for &(version, sql) in steps {
        if version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute("INSERT INTO schema_version (version) VALUES (?1)", params![version])?;
        tx.commit()?;
        tracing::info!(version, "tenex-project: applied schema migration");
    }

    Ok(())
}

const MIGRATION_V1: &str = r#"
CREATE TABLE project (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    d_tag TEXT NOT NULL,
    owner_pubkey TEXT,
    title TEXT,
    repo_url TEXT,
    working_directory TEXT,
    latest_event_id TEXT,
    ingested_at INTEGER
);

CREATE TABLE agents (
    pubkey TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    description TEXT,
    instructions TEXT,
    use_criteria TEXT,
    category TEXT,
    inferred_category TEXT,
    signer_ref TEXT,
    event_id TEXT,
    status TEXT,
    default_config_json TEXT,
    telegram_config_json TEXT,
    mcp_servers_json TEXT
);
CREATE INDEX agents_slug_idx ON agents(slug);
CREATE UNIQUE INDEX agents_event_id_idx ON agents(event_id) WHERE event_id IS NOT NULL;

CREATE TABLE project_agents (
    agent_pubkey TEXT PRIMARY KEY REFERENCES agents(pubkey) ON DELETE CASCADE,
    is_pm INTEGER NOT NULL DEFAULT 0,
    intervention_enabled INTEGER NOT NULL DEFAULT 0,
    escalation_target TEXT
);
"#;
