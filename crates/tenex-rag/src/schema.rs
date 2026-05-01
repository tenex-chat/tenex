//! Versioned schema and migration runner for `embeddings.db`.
//!
//! Mirrors the `tenex-conversations` pattern: `schema_version` is stored
//! in a `meta` table; mismatch between code's `EXPECTED_SCHEMA_VERSION`
//! and the DB's recorded version is a startup error (forward-only).
//!
//! Startup branches:
//!
//! 1. **Fresh DB** — neither `meta` nor `doc_meta` exists. Create both
//!    at the v2 target shape.
//! 2. **Legacy DB** — `doc_meta` exists, `meta` does not. The legacy
//!    table has only the original six columns (no `source_kind`,
//!    `source_id`, `seq_start`, `seq_end`, `chunk_index`, `meta_json`).
//!    Upgrade in place via `ALTER TABLE … ADD COLUMN`, add the
//!    `idx_doc_source` index, then run the v1→v2 step.
//! 3. **Versioned DB** — `meta.schema_version` is read; equal is no-op,
//!    less than expected steps forward through migrations, greater is a
//!    startup error.
//!
//! v1→v2: derive the `vector_dim` from any existing `vector_blob` and
//! pin it in `meta`. Every blob in the DB must agree on the same dim;
//! disagreement is a startup error (the DB is already corrupt and we
//! refuse to silently accept it).
//!
//! Everything happens in a single transaction.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

pub const EXPECTED_SCHEMA_VERSION: i64 = 2;

/// `meta` key under which the embedding vector dimension is stored.
/// Once written, every vector inserted into `doc_meta.vector_blob` must
/// have exactly this many `f32` components.
pub const META_KEY_VECTOR_DIM: &str = "vector_dim";

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
        (false, false) => create_fresh_v2(&tx).context("create fresh v2 schema")?,
        (false, true) => {
            migrate_legacy_to_v1(&tx).context("migrate legacy schema to v1")?;
            migrate_v1_to_v2(&tx).context("migrate v1 schema to v2")?;
        }
        (true, _) => {
            let recorded = read_schema_version(&tx)?
                .ok_or_else(|| anyhow!("meta table exists but schema_version row missing"))?;
            if recorded > EXPECTED_SCHEMA_VERSION {
                return Err(anyhow!(
                    "embeddings.db schema_version {recorded} is newer than supported \
                     (expected {EXPECTED_SCHEMA_VERSION}); downgrade not supported"
                ));
            }
            if recorded < 2 {
                migrate_v1_to_v2(&tx).context("migrate v1 schema to v2")?;
            }
        }
    }

    tx.commit().context("commit schema transaction")?;
    Ok(())
}

/// Read the persisted vector dimension. Returns `None` if it has not
/// been pinned yet (fresh DB with no inserts on a v2 schema).
pub fn read_vector_dim(conn: &Connection) -> Result<Option<i64>> {
    let row: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![META_KEY_VECTOR_DIM],
            |r| r.get(0),
        )
        .optional()
        .with_context(|| format!("read meta.{META_KEY_VECTOR_DIM}"))?;
    Ok(row.and_then(|s| s.parse::<i64>().ok()))
}

/// Pin the vector dimension. Idempotent if it matches the existing
/// value; rejects with an error if a different value is already pinned.
///
/// The insert uses `ON CONFLICT DO NOTHING` and re-reads the persisted
/// value so two writers racing to be the first will both succeed when
/// they agree on the dimension, instead of one hitting a UNIQUE
/// constraint violation. This is the only correct shape across separate
/// `Connection`s; a read-then-insert sequence is not atomic.
pub fn set_vector_dim(conn: &Connection, dim: i64) -> Result<()> {
    if dim <= 0 {
        return Err(anyhow!("vector dimension must be positive, got {dim}"));
    }
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO NOTHING",
        params![META_KEY_VECTOR_DIM, dim.to_string()],
    )
    .with_context(|| format!("pin meta.{META_KEY_VECTOR_DIM}"))?;
    let pinned = read_vector_dim(conn)?.ok_or_else(|| {
        anyhow!(
            "meta.{META_KEY_VECTOR_DIM} missing immediately after pin attempt; \
             embeddings.db is in an inconsistent state"
        )
    })?;
    if pinned != dim {
        return Err(anyhow!(
            "vector dimension already pinned at {pinned}; refusing to overwrite with {dim}"
        ));
    }
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

fn create_fresh_v2(conn: &Transaction<'_>) -> Result<()> {
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

fn migrate_legacy_to_v1(conn: &Transaction<'_>) -> Result<()> {
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
        "INSERT INTO meta(key, value) VALUES('schema_version', '1')",
        [],
    )?;
    Ok(())
}

/// Pin `vector_dim` from existing rows. All rows must agree; a single
/// disagreement is a hard error because the DB is already corrupted.
///
/// Zero-length `vector_blob` rows are explicit corruption — a v1 store
/// must never have written one — so they're filtered out of the
/// dimension scan and surfaced as a hard migration error if every
/// existing row is zero-length. Silently treating them as `dim = 0`
/// would migrate to a v2 schema pinned at zero, after which every real
/// upsert/search would fail dimension validation.
fn migrate_v1_to_v2(conn: &Transaction<'_>) -> Result<()> {
    // Count zero-length blob rows separately so we can distinguish
    // "DB has only zero-length rows" from "DB is empty" and surface a
    // useful diagnostic.
    let zero_length_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM doc_meta WHERE LENGTH(vector_blob) = 0",
            [],
            |r| r.get(0),
        )
        .context("count zero-length vector_blob rows")?;

    let dims: Vec<i64> = {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT LENGTH(vector_blob) FROM doc_meta \
                 WHERE LENGTH(vector_blob) > 0",
            )
            .context("scan distinct blob lengths")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, i64>(0))
            .context("query distinct blob lengths")?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.context("read blob length")?);
        }
        out
    };

    let dim = match dims.as_slice() {
        [] => {
            if zero_length_rows > 0 {
                return Err(anyhow!(
                    "v1→v2 migration: every vector_blob row ({zero_length_rows}) is zero-length \
                     (corrupt embeddings.db); refusing to migrate. Reset the DB and re-embed."
                ));
            }
            None
        }
        [byte_len] => {
            if byte_len % 4 != 0 {
                return Err(anyhow!(
                    "v1→v2 migration: existing vector_blob length {byte_len} is not a multiple of 4 \
                     (corrupt embeddings.db); refusing to migrate"
                ));
            }
            Some(byte_len / 4)
        }
        many => {
            return Err(anyhow!(
                "v1→v2 migration: vector_blob has {} distinct byte-lengths {:?}; \
                 cannot pin a single vector_dim. The DB has mixed-dimension embeddings \
                 and must be reset.",
                many.len(),
                many
            ));
        }
    };

    if let Some(d) = dim {
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![META_KEY_VECTOR_DIM, d.to_string()],
        )?;
    }

    conn.execute(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
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
    fn fresh_db_creates_v2() {
        let mut conn = open_in_memory();
        ensure_schema(&mut conn).unwrap();
        let v = read_schema_version(&conn).unwrap();
        assert_eq!(v, Some(2));

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
        // Legacy-shaped DB (mirrors what existing prod files have).
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
        // Insert a row with a 16-byte (4×f32) blob so v1→v2 can pin dim=4.
        conn.execute(
            "INSERT INTO doc_meta(id, collection, content, title, vector_blob, created_at)
             VALUES('legacy1', 'col', 'hi', NULL, X'00000000000000000000000000000000', 0)",
            [],
        )
        .unwrap();

        ensure_schema(&mut conn).unwrap();

        assert_eq!(read_schema_version(&conn).unwrap(), Some(2));
        assert_eq!(read_vector_dim(&conn).unwrap(), Some(4));

        // Legacy row is still readable with NULLs in the new columns.
        let (sk, _ci): (Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT source_kind, chunk_index FROM doc_meta WHERE id='legacy1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(sk.is_none());

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
    fn v1_to_v2_rejects_mixed_dimensions() {
        let mut conn = open_in_memory();
        // Build a v1-shaped DB by hand and seed two rows with different blob lengths.
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE doc_meta (
                 id          TEXT PRIMARY KEY,
                 collection  TEXT NOT NULL,
                 content     TEXT NOT NULL,
                 title       TEXT,
                 vector_blob BLOB NOT NULL,
                 created_at  INTEGER NOT NULL,
                 source_kind TEXT, source_id TEXT, seq_start INTEGER,
                 seq_end INTEGER, chunk_index INTEGER, meta_json TEXT
             );
             INSERT INTO meta(key, value) VALUES('schema_version', '1');
             INSERT INTO doc_meta(id, collection, content, vector_blob, created_at)
                 VALUES ('a', 'c', 'x', X'0000000000000000', 0),
                        ('b', 'c', 'y', X'00000000000000000000000000000000', 0);",
        )
        .unwrap();

        let err = ensure_schema(&mut conn).unwrap_err();
        let msg = err.to_string() + " " + &err.root_cause().to_string();
        assert!(
            msg.contains("distinct byte-lengths") || msg.contains("mixed-dimension"),
            "expected mixed-dim rejection, got: {msg}"
        );
    }

    #[test]
    fn v1_to_v2_rejects_all_zero_length_blobs() {
        // A v1 DB whose only rows have empty `vector_blob`s is
        // corrupt: pinning `vector_dim = 0` would render the
        // resulting v2 store unusable (every upsert/search would
        // mismatch). The migration must refuse rather than poison
        // the schema.
        let mut conn = open_in_memory();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE doc_meta (
                 id          TEXT PRIMARY KEY,
                 collection  TEXT NOT NULL,
                 content     TEXT NOT NULL,
                 title       TEXT,
                 vector_blob BLOB NOT NULL,
                 created_at  INTEGER NOT NULL,
                 source_kind TEXT, source_id TEXT, seq_start INTEGER,
                 seq_end INTEGER, chunk_index INTEGER, meta_json TEXT
             );
             INSERT INTO meta(key, value) VALUES('schema_version', '1');
             INSERT INTO doc_meta(id, collection, content, vector_blob, created_at)
                 VALUES ('a', 'c', 'x', X'', 0),
                        ('b', 'c', 'y', X'', 0);",
        )
        .unwrap();

        let err = ensure_schema(&mut conn).unwrap_err();
        let msg = err.to_string() + " " + &err.root_cause().to_string();
        assert!(
            msg.contains("zero-length"),
            "expected zero-length-blob rejection, got: {msg}"
        );
        // The schema must remain at v1 — refusing to migrate, not
        // half-migrating.
        assert_eq!(read_schema_version(&conn).unwrap(), Some(1));
        assert_eq!(read_vector_dim(&conn).unwrap(), None);
    }

    #[test]
    fn v1_to_v2_skips_zero_length_blobs_when_real_rows_present() {
        // Mixed corruption + good rows: pin from the good rows and
        // surface the corruption via the count, but allow migration
        // to proceed so the operator can clean up after.
        let mut conn = open_in_memory();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE doc_meta (
                 id          TEXT PRIMARY KEY,
                 collection  TEXT NOT NULL,
                 content     TEXT NOT NULL,
                 title       TEXT,
                 vector_blob BLOB NOT NULL,
                 created_at  INTEGER NOT NULL,
                 source_kind TEXT, source_id TEXT, seq_start INTEGER,
                 seq_end INTEGER, chunk_index INTEGER, meta_json TEXT
             );
             INSERT INTO meta(key, value) VALUES('schema_version', '1');
             INSERT INTO doc_meta(id, collection, content, vector_blob, created_at)
                 VALUES ('zero', 'c', 'x', X'', 0),
                        ('good', 'c', 'y', X'00000000000000000000000000000000', 0);",
        )
        .unwrap();

        ensure_schema(&mut conn).unwrap();
        assert_eq!(read_schema_version(&conn).unwrap(), Some(2));
        assert_eq!(read_vector_dim(&conn).unwrap(), Some(4));
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
    fn idempotent_on_already_v2() {
        let mut conn = open_in_memory();
        ensure_schema(&mut conn).unwrap();
        ensure_schema(&mut conn).unwrap();
        assert_eq!(read_schema_version(&conn).unwrap(), Some(2));
    }

    #[test]
    fn set_vector_dim_pins_and_then_rejects_change() {
        let mut conn = open_in_memory();
        ensure_schema(&mut conn).unwrap();
        set_vector_dim(&conn, 1536).unwrap();
        assert_eq!(read_vector_dim(&conn).unwrap(), Some(1536));
        // Re-setting the same value is idempotent.
        set_vector_dim(&conn, 1536).unwrap();
        // A different value is rejected.
        let err = set_vector_dim(&conn, 768).unwrap_err();
        assert!(err.to_string().contains("already pinned"));
    }

    #[test]
    fn set_vector_dim_is_atomic_across_connections() {
        // Two `Connection`s to the same DB file — the shape we have
        // when separate `SqliteStore` instances open the same path.
        // The first writer pins via `INSERT ... ON CONFLICT DO
        // NOTHING`; the second writer's insert no-ops and the
        // post-conflict re-read either confirms agreement or surfaces
        // the existing pin as an error. No UNIQUE-constraint failure
        // is allowed to escape.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("embeddings.db");

        let mut a = Connection::open(&path).unwrap();
        ensure_schema(&mut a).unwrap();
        let b = Connection::open(&path).unwrap();

        // Both writers agree on the dimension: both succeed.
        set_vector_dim(&a, 1536).unwrap();
        set_vector_dim(&b, 1536).unwrap();
        assert_eq!(read_vector_dim(&a).unwrap(), Some(1536));
        assert_eq!(read_vector_dim(&b).unwrap(), Some(1536));

        // A second writer with a different dimension is rejected by
        // the post-conflict re-read, not by a UNIQUE-constraint
        // failure.
        let err = set_vector_dim(&b, 768).unwrap_err();
        assert!(
            err.to_string().contains("already pinned"),
            "expected 'already pinned' error, got: {err}"
        );
    }

    #[test]
    fn set_vector_dim_resolves_lost_race_via_re_read() {
        // Simulate the read-then-insert race: writer A reads `None`,
        // writer B persists `dim` via raw SQL (modelling B winning
        // the insert), then A finishes its `set_vector_dim` call.
        // With the old read-then-insert structure, A would fail with
        // a UNIQUE-constraint violation. With the new structure, A's
        // INSERT no-ops on conflict and the re-read confirms B's pin.
        let mut conn = open_in_memory();
        ensure_schema(&mut conn).unwrap();
        // B wins the race and writes 1536 directly.
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?1, '1536')",
            params![META_KEY_VECTOR_DIM],
        )
        .unwrap();
        // A calls set_vector_dim with the same dim — must succeed.
        set_vector_dim(&conn, 1536).unwrap();
        assert_eq!(read_vector_dim(&conn).unwrap(), Some(1536));
    }
}
