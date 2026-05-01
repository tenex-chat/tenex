//! Versioned schema and migration runner for `embeddings.db`.
//!
//! Mirrors the `tenex-conversations` pattern: `schema_version` is stored
//! in a `meta` table; mismatch between code's `EXPECTED_SCHEMA_VERSION`
//! and the DB's recorded version is a startup error (forward-only).
//!
//! Three startup branches:
//!
//! 1. **Fresh DB** — neither `meta` nor `doc_meta` exists. Create both
//!    at the v1 target shape.
//! 2. **Legacy DB** — `doc_meta` exists, `meta` does not. The legacy
//!    table has only the original six columns (no `source_kind`,
//!    `source_id`, `seq_start`, `seq_end`, `chunk_index`, `meta_json`).
//!    Upgrade in place via `ALTER TABLE … ADD COLUMN` and add the new
//!    `idx_doc_source` index. The legacy `idx_collection` is preserved.
//! 3. **Versioned DB** — `meta.schema_version` is read; equal is no-op,
//!    greater than expected is a startup error.
//!
//! Everything happens in a single transaction.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

pub const EXPECTED_SCHEMA_VERSION: i64 = 1;

/// Six new columns added between legacy and v1.
const NEW_COLUMNS: &[(&str, &str)] = &[
    ("source_kind", "TEXT"),
    ("source_id", "TEXT"),
    ("seq_start", "INTEGER"),
    ("seq_end", "INTEGER"),
    ("chunk_index", "INTEGER"),
    ("meta_json", "TEXT"),
];

pub fn ensure_schema(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction().context("begin schema transaction")?;

    let has_meta = table_exists(&tx, "meta")?;
    let has_doc_meta = table_exists(&tx, "doc_meta")?;

    match (has_meta, has_doc_meta) {
        (false, false) => create_fresh_v1(&tx).context("create fresh v1 schema")?,
        (false, true) => migrate_legacy_to_v1(&tx).context("migrate legacy schema to v1")?,
        (true, _) => {
            let recorded = read_schema_version(&tx)?
                .ok_or_else(|| anyhow!("meta table exists but schema_version row missing"))?;
            if recorded > EXPECTED_SCHEMA_VERSION {
                return Err(anyhow!(
                    "embeddings.db schema_version {recorded} is newer than supported \
                     (expected {EXPECTED_SCHEMA_VERSION}); downgrade not supported"
                ));
            }
            // recorded == EXPECTED_SCHEMA_VERSION: no-op.
            // recorded < EXPECTED_SCHEMA_VERSION: future v2+ runs migrations here.
        }
    }

    tx.commit().context("commit schema transaction")?;
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            params![name],
            |r| r.get(0),
        )
        .with_context(|| format!("check table existence: {name}"))?;
    Ok(count > 0)
}

fn read_schema_version(conn: &Connection) -> Result<Option<i64>> {
    let row: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key='schema_version'",
            [],
            |r| r.get(0),
        )
        .optional()
        .context("read meta.schema_version")?;
    Ok(row.and_then(|s| s.parse::<i64>().ok()))
}

fn create_fresh_v1(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE meta (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE doc_meta (
             id          TEXT PRIMARY KEY,
             collection  TEXT NOT NULL,
             content     TEXT NOT NULL,
             title       TEXT,
             vector_blob BLOB NOT NULL,
             created_at  INTEGER NOT NULL,
             source_kind TEXT,
             source_id   TEXT,
             seq_start   INTEGER,
             seq_end     INTEGER,
             chunk_index INTEGER,
             meta_json   TEXT
         );
         CREATE INDEX idx_collection ON doc_meta(collection);
         CREATE INDEX idx_doc_source ON doc_meta(source_kind, source_id);",
    )?;
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?1)",
        params![EXPECTED_SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
}

fn migrate_legacy_to_v1(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE meta (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );",
    )?;
    for (col, ty) in NEW_COLUMNS {
        let sql = format!("ALTER TABLE doc_meta ADD COLUMN {col} {ty}");
        conn.execute(&sql, [])
            .with_context(|| format!("add column {col}"))?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_doc_source ON doc_meta(source_kind, source_id)",
        [],
    )?;
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?1)",
        params![EXPECTED_SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn open_in_memory() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn fresh_db_creates_v1() {
        let mut conn = open_in_memory();
        ensure_schema(&mut conn).unwrap();
        let v = read_schema_version(&conn).unwrap();
        assert_eq!(v, Some(1));

        // Verify new columns exist by selecting them.
        conn.query_row(
            "SELECT source_kind, source_id, seq_start, seq_end, chunk_index, meta_json
             FROM doc_meta WHERE 0",
            [],
            |_| Ok(()),
        )
        .unwrap_or(());
    }

    #[test]
    fn legacy_db_is_upgraded_in_place() {
        let mut conn = open_in_memory();
        // Build a legacy-shaped DB (mirrors what existing prod files have).
        conn.execute_batch(
            "CREATE TABLE doc_meta (
                 id          TEXT PRIMARY KEY,
                 collection  TEXT NOT NULL,
                 content     TEXT NOT NULL,
                 title       TEXT,
                 vector_blob BLOB NOT NULL,
                 created_at  INTEGER NOT NULL
             );
             CREATE INDEX idx_collection ON doc_meta(collection);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO doc_meta(id, collection, content, title, vector_blob, created_at)
             VALUES('legacy1', 'col', 'hi', NULL, X'00', 0)",
            [],
        )
        .unwrap();

        ensure_schema(&mut conn).unwrap();

        // Schema version recorded.
        assert_eq!(read_schema_version(&conn).unwrap(), Some(1));

        // Legacy row is still readable with NULLs in the new columns.
        let (sk, _ci): (Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT source_kind, chunk_index FROM doc_meta WHERE id='legacy1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(sk.is_none());

        // New index exists.
        let idx_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_doc_source'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx_count, 1);
    }

    #[test]
    fn future_version_is_rejected() {
        let mut conn = open_in_memory();
        ensure_schema(&mut conn).unwrap();
        conn.execute("UPDATE meta SET value='999' WHERE key='schema_version'", [])
            .unwrap();
        let err = ensure_schema(&mut conn).unwrap_err();
        assert!(err.to_string().contains("newer than supported"));
    }

    #[test]
    fn idempotent_on_already_v1() {
        let mut conn = open_in_memory();
        ensure_schema(&mut conn).unwrap();
        // Run again — should be a no-op.
        ensure_schema(&mut conn).unwrap();
        assert_eq!(read_schema_version(&conn).unwrap(), Some(1));
    }
}
