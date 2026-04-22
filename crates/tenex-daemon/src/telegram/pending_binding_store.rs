//! Durable pending chat→project bindings for the `/start [token]` flow.
//!
//! When an operator generates a one-shot `/start` token (e.g. through the
//! TENEX CLI or a future admin UI), the backend writes a pending-binding
//! record keyed by that token. The Rust Telegram command handler consumes
//! the record when the user runs `/start <token>` in their chat, and
//! persists the resulting transport binding via
//! [`crate::telegram::bindings::write_transport_binding`].
//!
//! Storage layout:
//!
//! ```text
//! $TENEX_BASE_DIR/daemon/telegram/pending-bindings.json
//! ```
//!
//! The file is a stamped snapshot with `schemaVersion`, `writer`,
//! `writerVersion`, `createdAt`, `updatedAt`, plus the list of pending
//! entries. Atomic writes use a tempfile + rename + fsync on the parent.
//! Loading fails closed on schema mismatch — stale code with a newer-schema
//! file on disk refuses to silently eat records.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const TELEGRAM_PENDING_BINDING_SCHEMA_VERSION: u32 = 1;
pub const TELEGRAM_PENDING_BINDING_WRITER: &str = "tenex-daemon";
pub const DEFAULT_PENDING_BINDING_TTL_MS: u64 = 24 * 60 * 60 * 1_000;

const DIR_NAME: &str = "telegram";
const FILE_NAME: &str = "pending-bindings.json";
const TMP_SUBDIR: &str = "tmp";

/// A single pending-binding record. Keyed by `token`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingBindingRecord {
    pub token: String,
    pub agent_pubkey: String,
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_title: Option<String>,
    pub requested_at: u64,
}

/// Stamped on-disk snapshot of all pending bindings for the daemon.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingBindingSnapshot {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub bindings: Vec<PendingBindingRecord>,
}

#[derive(Debug, Error)]
pub enum PendingBindingError {
    #[error("pending binding io error: {0}")]
    Io(#[from] io::Error),
    #[error("pending binding json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("pending binding schema version {found} is not supported (expected {expected})")]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
    #[error("pending binding writer must not be empty")]
    MissingWriter,
    #[error("pending binding writerVersion must not be empty")]
    MissingWriterVersion,
}

pub fn pending_binding_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(DIR_NAME)
}

pub fn pending_binding_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    pending_binding_dir(daemon_dir).join(FILE_NAME)
}

fn tmp_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    pending_binding_dir(daemon_dir).join(TMP_SUBDIR)
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

fn validate(snapshot: &PendingBindingSnapshot) -> Result<(), PendingBindingError> {
    if snapshot.schema_version != TELEGRAM_PENDING_BINDING_SCHEMA_VERSION {
        return Err(PendingBindingError::UnsupportedSchemaVersion {
            found: snapshot.schema_version,
            expected: TELEGRAM_PENDING_BINDING_SCHEMA_VERSION,
        });
    }
    if snapshot.writer.is_empty() {
        return Err(PendingBindingError::MissingWriter);
    }
    if snapshot.writer_version.is_empty() {
        return Err(PendingBindingError::MissingWriterVersion);
    }
    Ok(())
}

/// Load the pending-binding snapshot. `Ok(None)` on missing file, fail
/// closed on schema mismatch or malformed content.
pub fn load_snapshot(
    daemon_dir: impl AsRef<Path>,
) -> Result<Option<PendingBindingSnapshot>, PendingBindingError> {
    let path = pending_binding_path(&daemon_dir);
    match fs::read_to_string(&path) {
        Ok(content) => {
            check_schema_version(&content)?;
            let snapshot: PendingBindingSnapshot = serde_json::from_str(&content)?;
            validate(&snapshot)?;
            Ok(Some(snapshot))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Parse just the schema-version header so we can reject incompatible
/// files before descending into the full struct (whose shape may have
/// changed between versions).
fn check_schema_version(content: &str) -> Result<(), PendingBindingError> {
    #[derive(Deserialize)]
    struct VersionHeader {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
    }
    let header: VersionHeader = serde_json::from_str(content)?;
    if header.schema_version != TELEGRAM_PENDING_BINDING_SCHEMA_VERSION {
        return Err(PendingBindingError::UnsupportedSchemaVersion {
            found: header.schema_version,
            expected: TELEGRAM_PENDING_BINDING_SCHEMA_VERSION,
        });
    }
    Ok(())
}

fn write_snapshot(
    daemon_dir: impl AsRef<Path>,
    snapshot: &PendingBindingSnapshot,
) -> Result<(), PendingBindingError> {
    validate(snapshot)?;
    let daemon_dir = daemon_dir.as_ref();
    let dir = pending_binding_dir(daemon_dir);
    let tmp = tmp_dir(daemon_dir);
    fs::create_dir_all(&dir)?;
    fs::create_dir_all(&tmp)?;
    let tmp_path = tmp.join(format!(
        "{FILE_NAME}.{}.{}.tmp",
        std::process::id(),
        now_nanos()
    ));
    let target = dir.join(FILE_NAME);
    let outcome = (|| -> Result<(), PendingBindingError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        serde_json::to_writer_pretty(&mut file, snapshot)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&tmp_path, &target)?;
        if let Some(parent) = target.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if outcome.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    outcome
}

fn new_snapshot(now_ms: u64, writer_version: &str) -> PendingBindingSnapshot {
    PendingBindingSnapshot {
        schema_version: TELEGRAM_PENDING_BINDING_SCHEMA_VERSION,
        writer: TELEGRAM_PENDING_BINDING_WRITER.to_string(),
        writer_version: writer_version.to_string(),
        created_at: now_ms,
        updated_at: now_ms,
        bindings: Vec::new(),
    }
}

fn is_expired(record: &PendingBindingRecord, now_ms: u64, ttl_ms: u64) -> bool {
    now_ms.saturating_sub(record.requested_at) > ttl_ms
}

/// Persist a pending binding record. Overwrites any existing entry with the
/// same token. Expired entries are pruned in the same write.
pub fn remember_pending(
    daemon_dir: impl AsRef<Path>,
    writer_version: &str,
    ttl_ms: u64,
    now_ms: u64,
    record: PendingBindingRecord,
) -> Result<PendingBindingRecord, PendingBindingError> {
    let daemon_dir = daemon_dir.as_ref();
    let mut snapshot =
        load_snapshot(daemon_dir)?.unwrap_or_else(|| new_snapshot(now_ms, writer_version));
    snapshot
        .bindings
        .retain(|existing| existing.token != record.token && !is_expired(existing, now_ms, ttl_ms));
    snapshot.bindings.push(record.clone());
    snapshot.writer = TELEGRAM_PENDING_BINDING_WRITER.to_string();
    snapshot.writer_version = writer_version.to_string();
    snapshot.updated_at = now_ms;
    write_snapshot(daemon_dir, &snapshot)?;
    Ok(record)
}

/// Look up a pending binding by token. Returns `Ok(None)` when the token is
/// unknown or expired. Expired entries are pruned on the way out.
pub fn take_pending(
    daemon_dir: impl AsRef<Path>,
    writer_version: &str,
    ttl_ms: u64,
    now_ms: u64,
    token: &str,
) -> Result<Option<PendingBindingRecord>, PendingBindingError> {
    let daemon_dir = daemon_dir.as_ref();
    let Some(mut snapshot) = load_snapshot(daemon_dir)? else {
        return Ok(None);
    };
    let mut taken: Option<PendingBindingRecord> = None;
    let mut remaining: Vec<PendingBindingRecord> = Vec::with_capacity(snapshot.bindings.len());
    for record in snapshot.bindings.drain(..) {
        if taken.is_none() && record.token == token {
            if is_expired(&record, now_ms, ttl_ms) {
                // Drop expired match without returning it.
                continue;
            }
            taken = Some(record);
            continue;
        }
        if is_expired(&record, now_ms, ttl_ms) {
            continue;
        }
        remaining.push(record);
    }
    snapshot.bindings = remaining;
    snapshot.writer = TELEGRAM_PENDING_BINDING_WRITER.to_string();
    snapshot.writer_version = writer_version.to_string();
    snapshot.updated_at = now_ms;
    write_snapshot(daemon_dir, &snapshot)?;
    Ok(taken)
}

/// Non-destructive lookup. Does not mutate the store or prune expired
/// entries. Useful for read-only diagnostics.
pub fn peek_pending(
    daemon_dir: impl AsRef<Path>,
    ttl_ms: u64,
    now_ms: u64,
    token: &str,
) -> Result<Option<PendingBindingRecord>, PendingBindingError> {
    let Some(snapshot) = load_snapshot(daemon_dir)? else {
        return Ok(None);
    };
    Ok(snapshot
        .bindings
        .into_iter()
        .find(|record| record.token == token && !is_expired(record, now_ms, ttl_ms)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn seed(dir: &Path, now_ms: u64) -> PendingBindingRecord {
        let record = PendingBindingRecord {
            token: "abc".to_string(),
            agent_pubkey: "a".repeat(64),
            project_id: "project-alpha".to_string(),
            project_title: Some("Project Alpha".to_string()),
            requested_at: now_ms,
        };
        remember_pending(
            dir,
            "test@0.1.0",
            DEFAULT_PENDING_BINDING_TTL_MS,
            now_ms,
            record.clone(),
        )
        .expect("seed");
        record
    }

    #[test]
    fn round_trip_through_atomic_write() {
        let tmp = tempdir().expect("tempdir");
        let now = 1_700_000_000_000;
        let record = seed(tmp.path(), now);

        let snapshot = load_snapshot(tmp.path()).expect("load").expect("present");
        assert_eq!(
            snapshot.schema_version,
            TELEGRAM_PENDING_BINDING_SCHEMA_VERSION
        );
        assert_eq!(snapshot.writer, TELEGRAM_PENDING_BINDING_WRITER);
        assert_eq!(snapshot.bindings.len(), 1);
        assert_eq!(snapshot.bindings[0], record);
    }

    #[test]
    fn take_pending_returns_and_removes_record() {
        let tmp = tempdir().expect("tempdir");
        let now = 1_700_000_000_000;
        seed(tmp.path(), now);
        let taken = take_pending(
            tmp.path(),
            "test@0.1.0",
            DEFAULT_PENDING_BINDING_TTL_MS,
            now + 1_000,
            "abc",
        )
        .expect("take")
        .expect("taken present");
        assert_eq!(taken.token, "abc");
        // Second call returns None because the record was consumed.
        let second = take_pending(
            tmp.path(),
            "test@0.1.0",
            DEFAULT_PENDING_BINDING_TTL_MS,
            now + 2_000,
            "abc",
        )
        .expect("second take");
        assert!(second.is_none());
    }

    #[test]
    fn take_pending_returns_none_for_expired_entries() {
        let tmp = tempdir().expect("tempdir");
        let now = 1_700_000_000_000;
        seed(tmp.path(), now);
        let expired_now = now + DEFAULT_PENDING_BINDING_TTL_MS + 1;
        let taken = take_pending(
            tmp.path(),
            "test@0.1.0",
            DEFAULT_PENDING_BINDING_TTL_MS,
            expired_now,
            "abc",
        )
        .expect("take");
        assert!(taken.is_none());
        // And the expired record is pruned from disk.
        let snapshot = load_snapshot(tmp.path()).expect("load").expect("snapshot");
        assert!(snapshot.bindings.is_empty());
    }

    #[test]
    fn remember_pending_overwrites_existing_token() {
        let tmp = tempdir().expect("tempdir");
        let now = 1_700_000_000_000;
        seed(tmp.path(), now);
        let updated = PendingBindingRecord {
            token: "abc".to_string(),
            agent_pubkey: "b".repeat(64),
            project_id: "project-beta".to_string(),
            project_title: None,
            requested_at: now + 500,
        };
        remember_pending(
            tmp.path(),
            "test@0.1.0",
            DEFAULT_PENDING_BINDING_TTL_MS,
            now + 500,
            updated.clone(),
        )
        .expect("remember updated");
        let snapshot = load_snapshot(tmp.path()).expect("load").expect("present");
        assert_eq!(snapshot.bindings.len(), 1);
        assert_eq!(snapshot.bindings[0], updated);
    }

    #[test]
    fn load_fails_closed_on_schema_mismatch() {
        let tmp = tempdir().expect("tempdir");
        let dir = pending_binding_dir(tmp.path());
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            pending_binding_path(tmp.path()),
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": 99,
                "writer": "tenex-daemon",
                "writerVersion": "test",
                "createdAt": 1,
                "updatedAt": 1,
                "bindings": []
            }))
            .unwrap(),
        )
        .unwrap();
        let err = load_snapshot(tmp.path()).expect_err("schema");
        assert!(matches!(
            err,
            PendingBindingError::UnsupportedSchemaVersion { found: 99, .. }
        ));
    }

    #[test]
    fn missing_file_returns_none() {
        let tmp = tempdir().expect("tempdir");
        let out = load_snapshot(tmp.path()).expect("load");
        assert!(out.is_none());
    }

    #[test]
    fn peek_pending_ignores_expired_entries() {
        let tmp = tempdir().expect("tempdir");
        let now = 1_700_000_000_000;
        seed(tmp.path(), now);
        let expired_now = now + DEFAULT_PENDING_BINDING_TTL_MS + 1;
        let out = peek_pending(
            tmp.path(),
            DEFAULT_PENDING_BINDING_TTL_MS,
            expired_now,
            "abc",
        )
        .expect("peek");
        assert!(out.is_none());
    }

    #[test]
    fn write_leaves_no_stray_tmp_files() {
        let tmp = tempdir().expect("tempdir");
        seed(tmp.path(), 1_700_000_000_000);
        let tmp_entries: Vec<_> = fs::read_dir(tmp_dir(tmp.path()))
            .expect("tmp dir")
            .filter_map(|e| e.ok())
            .collect();
        assert!(
            tmp_entries.is_empty(),
            "leftover tmp files: {tmp_entries:?}"
        );
    }
}
