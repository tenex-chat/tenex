//! Durable interactive-config session store.
//!
//! The `/model` and `/config` (tools) commands open paged inline-keyboard
//! pickers. The user steps through pages and selections; every callback
//! query must know which menu page to render next and which session ids
//! are still live. The menu state is persisted so a daemon restart mid-
//! flow doesn't wedge the user on a now-orphan keyboard.
//!
//! Storage layout:
//!
//! ```text
//! $TENEX_BASE_DIR/daemon/telegram/config-sessions/<chat_id>.json
//! ```
//!
//! Keyed by chat id so at most one active session exists per chat. If a
//! user opens `/model` and then `/config` in the same chat, the second
//! command replaces the first — matching Telegram's single-active-keyboard
//! UX and avoiding a map file that can drift on crashes.
//!
//! Each file is a full [`ConfigSessionSnapshot`] with `schemaVersion`,
//! `writer`, `writerVersion`, `createdAt`/`updatedAt`. Atomic writes via
//! tempfile + rename + parent fsync. Loads fail closed on schema mismatch.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const TELEGRAM_CONFIG_SESSION_SCHEMA_VERSION: u32 = 1;
pub const TELEGRAM_CONFIG_SESSION_WRITER: &str = "tenex-daemon";
pub const DEFAULT_CONFIG_SESSION_TTL_MS: u64 = 15 * 60 * 1_000;

const DIR_NAME: &str = "telegram/config-sessions";
const TMP_SUBDIR: &str = "tmp";

/// Kind of config session — chooses which picker to render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigSessionKind {
    Model,
    Tools,
}

/// Persisted session state for an in-flight `/model` or `/config` picker.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSessionRecord {
    pub id: String,
    pub kind: ConfigSessionKind,
    pub chat_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_thread_id: Option<String>,
    pub channel_id: String,
    #[serde(default)]
    pub message_id: Option<i64>,
    pub agent_pubkey: String,
    pub agent_name: String,
    pub principal_id: String,
    pub project_id: String,
    pub project_title: String,
    pub project_binding: String,
    pub current_page: u32,
    pub available_models: Vec<String>,
    pub available_tools: Vec<String>,
    pub selected_model: String,
    pub selected_tools: Vec<String>,
}

/// On-disk snapshot wrapping the session record with standard daemon
/// stamps.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSessionSnapshot {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub session: ConfigSessionRecord,
}

#[derive(Debug, Error)]
pub enum ConfigSessionError {
    #[error("config session io error: {0}")]
    Io(#[from] io::Error),
    #[error("config session json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error(
        "config session schema version {found} is not supported (expected {expected})"
    )]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
    #[error("config session writer must not be empty")]
    MissingWriter,
    #[error("config session writerVersion must not be empty")]
    MissingWriterVersion,
    #[error("config session id must not be empty")]
    MissingSessionId,
    #[error("config session chat id must not be empty")]
    MissingChatId,
}

pub fn config_session_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(DIR_NAME)
}

fn tmp_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    config_session_dir(daemon_dir).join(TMP_SUBDIR)
}

/// Build the canonical snapshot file path for a given chat id, with the
/// same leading-dash encoding used for chat-context snapshots so file
/// names stay filesystem-safe.
pub fn config_session_path(daemon_dir: impl AsRef<Path>, chat_id: &str) -> PathBuf {
    config_session_dir(daemon_dir).join(format!("{}.json", encode_chat_id_segment(chat_id)))
}

fn encode_chat_id_segment(chat_id: &str) -> String {
    let mut buf = String::with_capacity(chat_id.len());
    for (index, ch) in chat_id.chars().enumerate() {
        if index == 0 && ch == '-' {
            buf.push('n');
            continue;
        }
        if ch.is_ascii_alphanumeric() || ch == '_' {
            buf.push(ch);
        } else {
            buf.push('_');
        }
    }
    buf
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

fn validate(snapshot: &ConfigSessionSnapshot) -> Result<(), ConfigSessionError> {
    if snapshot.schema_version != TELEGRAM_CONFIG_SESSION_SCHEMA_VERSION {
        return Err(ConfigSessionError::UnsupportedSchemaVersion {
            found: snapshot.schema_version,
            expected: TELEGRAM_CONFIG_SESSION_SCHEMA_VERSION,
        });
    }
    if snapshot.writer.is_empty() {
        return Err(ConfigSessionError::MissingWriter);
    }
    if snapshot.writer_version.is_empty() {
        return Err(ConfigSessionError::MissingWriterVersion);
    }
    if snapshot.session.id.is_empty() {
        return Err(ConfigSessionError::MissingSessionId);
    }
    if snapshot.session.chat_id.is_empty() {
        return Err(ConfigSessionError::MissingChatId);
    }
    Ok(())
}

/// Load an active session for a given chat. Returns `Ok(None)` when no
/// file exists or the stored session is past its TTL. Expired files are
/// removed in the same call. Fails closed on schema mismatch / malformed
/// content.
pub fn load_session(
    daemon_dir: impl AsRef<Path>,
    chat_id: &str,
    ttl_ms: u64,
    now_ms: u64,
) -> Result<Option<ConfigSessionRecord>, ConfigSessionError> {
    let path = config_session_path(&daemon_dir, chat_id);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    check_schema_version(&content)?;
    let snapshot: ConfigSessionSnapshot = serde_json::from_str(&content)?;
    validate(&snapshot)?;
    if is_expired(&snapshot, now_ms, ttl_ms) {
        let _ = fs::remove_file(&path);
        return Ok(None);
    }
    Ok(Some(snapshot.session))
}

/// Parse just enough of the snapshot header to reject incompatible
/// schema versions before any field-level deserialization runs. A file
/// written by a newer schema version would otherwise produce an opaque
/// "missing field" error if the new schema renamed/added required
/// fields — the daemon must fail closed with an actionable error instead.
fn check_schema_version(content: &str) -> Result<(), ConfigSessionError> {
    #[derive(Deserialize)]
    struct VersionHeader {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
    }
    let header: VersionHeader = serde_json::from_str(content)?;
    if header.schema_version != TELEGRAM_CONFIG_SESSION_SCHEMA_VERSION {
        return Err(ConfigSessionError::UnsupportedSchemaVersion {
            found: header.schema_version,
            expected: TELEGRAM_CONFIG_SESSION_SCHEMA_VERSION,
        });
    }
    Ok(())
}

/// Look up a session across the whole chat-sessions directory by session
/// id (as encoded into callback_data). Returns `None` if no file matches.
/// Expired matches are pruned.
pub fn find_session_by_id(
    daemon_dir: impl AsRef<Path>,
    session_id: &str,
    ttl_ms: u64,
    now_ms: u64,
) -> Result<Option<ConfigSessionRecord>, ConfigSessionError> {
    let dir = config_session_dir(&daemon_dir);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        if check_schema_version(&content).is_err() {
            continue;
        }
        let Ok(snapshot) = serde_json::from_str::<ConfigSessionSnapshot>(&content) else {
            continue;
        };
        if validate(&snapshot).is_err() {
            continue;
        }
        if snapshot.session.id != session_id {
            continue;
        }
        if is_expired(&snapshot, now_ms, ttl_ms) {
            let _ = fs::remove_file(&path);
            return Ok(None);
        }
        return Ok(Some(snapshot.session));
    }
    Ok(None)
}

fn is_expired(snapshot: &ConfigSessionSnapshot, now_ms: u64, ttl_ms: u64) -> bool {
    now_ms.saturating_sub(snapshot.updated_at) > ttl_ms
}

/// Persist a session record. Replaces any prior session for the same
/// chat. `created_at`/`updated_at` are both stamped on new sessions;
/// `updated_at` alone is refreshed when the record already existed.
pub fn save_session(
    daemon_dir: impl AsRef<Path>,
    writer_version: &str,
    now_ms: u64,
    session: ConfigSessionRecord,
) -> Result<ConfigSessionRecord, ConfigSessionError> {
    let daemon_dir = daemon_dir.as_ref();
    let dir = config_session_dir(daemon_dir);
    let tmp = tmp_dir(daemon_dir);
    fs::create_dir_all(&dir)?;
    fs::create_dir_all(&tmp)?;
    // Preserve `created_at` if a prior session exists for this chat.
    let target = config_session_path(daemon_dir, &session.chat_id);
    let created_at = match fs::read_to_string(&target) {
        Ok(content) => serde_json::from_str::<ConfigSessionSnapshot>(&content)
            .map(|prior| prior.created_at)
            .unwrap_or(now_ms),
        Err(_) => now_ms,
    };
    let snapshot = ConfigSessionSnapshot {
        schema_version: TELEGRAM_CONFIG_SESSION_SCHEMA_VERSION,
        writer: TELEGRAM_CONFIG_SESSION_WRITER.to_string(),
        writer_version: writer_version.to_string(),
        created_at,
        updated_at: now_ms,
        session: session.clone(),
    };
    validate(&snapshot)?;

    let tmp_path = tmp.join(format!(
        "{}.json.{}.{}.tmp",
        encode_chat_id_segment(&session.chat_id),
        std::process::id(),
        now_nanos()
    ));
    let outcome = (|| -> Result<(), ConfigSessionError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        serde_json::to_writer_pretty(&mut file, &snapshot)?;
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
    outcome?;
    Ok(session)
}

/// Delete a session for a given chat (if one exists). Missing files are
/// silently accepted.
pub fn clear_session(
    daemon_dir: impl AsRef<Path>,
    chat_id: &str,
) -> Result<(), ConfigSessionError> {
    let path = config_session_path(&daemon_dir, chat_id);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_session(chat_id: &str, id: &str) -> ConfigSessionRecord {
        ConfigSessionRecord {
            id: id.to_string(),
            kind: ConfigSessionKind::Model,
            chat_id: chat_id.to_string(),
            message_thread_id: None,
            channel_id: format!("telegram:chat:{chat_id}"),
            message_id: Some(200),
            agent_pubkey: "a".repeat(64),
            agent_name: "Alpha Agent".to_string(),
            principal_id: "telegram:user:42".to_string(),
            project_id: "project-alpha".to_string(),
            project_title: "Project Alpha".to_string(),
            project_binding: "31933:owner:project-alpha".to_string(),
            current_page: 0,
            available_models: vec!["model-a".to_string(), "model-b".to_string()],
            available_tools: vec!["fs_read".to_string()],
            selected_model: "model-a".to_string(),
            selected_tools: vec!["fs_read".to_string()],
        }
    }

    #[test]
    fn save_and_reload_round_trip() {
        let tmp = tempdir().expect("tempdir");
        let session = sample_session("1001", "abc");
        save_session(tmp.path(), "test@0.1.0", 1_000, session.clone()).expect("save");
        let loaded = load_session(
            tmp.path(),
            "1001",
            DEFAULT_CONFIG_SESSION_TTL_MS,
            1_000,
        )
        .expect("load")
        .expect("present");
        assert_eq!(loaded, session);

        let path = config_session_path(tmp.path(), "1001");
        assert!(path.exists());
    }

    #[test]
    fn leading_dash_chat_ids_are_encoded_for_filename_safety() {
        let tmp = tempdir().expect("tempdir");
        let session = sample_session("-1002", "abc");
        save_session(tmp.path(), "t@0", 1_000, session.clone()).expect("save");
        let path = config_session_path(tmp.path(), "-1002");
        assert!(path.ends_with("telegram/config-sessions/n1002.json"));
        assert!(path.exists());
    }

    #[test]
    fn load_returns_none_and_prunes_expired_session() {
        let tmp = tempdir().expect("tempdir");
        let session = sample_session("1001", "abc");
        save_session(tmp.path(), "t@0", 1_000, session).expect("save");
        let expired_now = 1_000 + DEFAULT_CONFIG_SESSION_TTL_MS + 1;
        let loaded = load_session(
            tmp.path(),
            "1001",
            DEFAULT_CONFIG_SESSION_TTL_MS,
            expired_now,
        )
        .expect("load");
        assert!(loaded.is_none());
        let path = config_session_path(tmp.path(), "1001");
        assert!(!path.exists(), "expired file must be removed");
    }

    #[test]
    fn find_session_by_id_iterates_directory() {
        let tmp = tempdir().expect("tempdir");
        save_session(tmp.path(), "t@0", 1_000, sample_session("1001", "alpha"))
            .expect("first");
        save_session(tmp.path(), "t@0", 1_000, sample_session("-2002", "beta"))
            .expect("second");
        let hit = find_session_by_id(tmp.path(), "beta", DEFAULT_CONFIG_SESSION_TTL_MS, 1_500)
            .expect("find")
            .expect("hit");
        assert_eq!(hit.id, "beta");
        assert_eq!(hit.chat_id, "-2002");

        let miss = find_session_by_id(
            tmp.path(),
            "gamma",
            DEFAULT_CONFIG_SESSION_TTL_MS,
            1_500,
        )
        .expect("miss");
        assert!(miss.is_none());
    }

    #[test]
    fn clear_session_removes_file() {
        let tmp = tempdir().expect("tempdir");
        save_session(tmp.path(), "t@0", 1_000, sample_session("1001", "abc"))
            .expect("save");
        clear_session(tmp.path(), "1001").expect("clear");
        let path = config_session_path(tmp.path(), "1001");
        assert!(!path.exists());
    }

    #[test]
    fn save_preserves_created_at_and_refreshes_updated_at() {
        let tmp = tempdir().expect("tempdir");
        save_session(tmp.path(), "t@0", 1_000, sample_session("1001", "abc"))
            .expect("first");
        save_session(tmp.path(), "t@0", 2_500, sample_session("1001", "abc"))
            .expect("second");
        let raw = fs::read_to_string(config_session_path(tmp.path(), "1001")).unwrap();
        let snapshot: ConfigSessionSnapshot = serde_json::from_str(&raw).unwrap();
        assert_eq!(snapshot.created_at, 1_000);
        assert_eq!(snapshot.updated_at, 2_500);
    }

    #[test]
    fn load_fails_closed_on_schema_mismatch() {
        let tmp = tempdir().expect("tempdir");
        fs::create_dir_all(config_session_dir(tmp.path())).unwrap();
        fs::write(
            config_session_path(tmp.path(), "1001"),
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": 99,
                "writer": "tenex-daemon",
                "writerVersion": "t@0",
                "createdAt": 1,
                "updatedAt": 1,
                "session": { "id": "abc", "chatId": "1001" }
            }))
            .unwrap(),
        )
        .unwrap();
        let err = load_session(tmp.path(), "1001", DEFAULT_CONFIG_SESSION_TTL_MS, 1_000)
            .expect_err("schema");
        assert!(matches!(
            err,
            ConfigSessionError::UnsupportedSchemaVersion { found: 99, .. }
        ));
    }

    #[test]
    fn missing_file_returns_none() {
        let tmp = tempdir().expect("tempdir");
        let loaded = load_session(tmp.path(), "1001", DEFAULT_CONFIG_SESSION_TTL_MS, 1_000)
            .expect("load");
        assert!(loaded.is_none());
    }

    #[test]
    fn save_leaves_no_stray_tmp_files() {
        let tmp = tempdir().expect("tempdir");
        save_session(tmp.path(), "t@0", 1_000, sample_session("1001", "abc"))
            .expect("save");
        let tmp_entries: Vec<_> = fs::read_dir(tmp_dir(tmp.path()))
            .expect("tmp dir")
            .filter_map(|entry| entry.ok())
            .collect();
        assert!(tmp_entries.is_empty(), "tmp must be empty: {tmp_entries:?}");
    }
}
