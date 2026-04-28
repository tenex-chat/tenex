//! Versioned schema and migration runner.
//!
//! One source of truth. Each migration is a string of DDL/DML run in a
//! transaction. `schema_version` is stored in the `meta` table; mismatch
//! between code's `EXPECTED_SCHEMA_VERSION` and DB's recorded version is a
//! startup error (forward-only migrations).

use rusqlite::Connection;

use crate::error::{IdentityError, Result};

pub const EXPECTED_SCHEMA_VERSION: i64 = 1;

const MIGRATION_V1: &str = r#"
CREATE TABLE identities (
    pubkey       TEXT PRIMARY KEY,
    display_name TEXT,
    name         TEXT,
    nip05        TEXT,
    picture      TEXT,
    banner       TEXT,
    about        TEXT,
    lud16        TEXT,
    event_id     TEXT,
    created_at   INTEGER,
    fetched_at   INTEGER NOT NULL
);
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
/// [`IdentityError::SchemaVersionMismatch`] — running with a forward
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
        return Err(IdentityError::SchemaVersionMismatch {
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
        tracing::info!(target_version, "applied identity-cache migration");
    }

    Ok(())
}
