//! View of the shared transport/identity binding files.
//!
//! Two JSON arrays live under `$TENEX_BASE_DIR/<data>/`:
//!
//! - `transport-bindings.json`: per-agent channel bindings
//!   (`{ transport, agentPubkey, channelId, projectId, createdAt, updatedAt }`).
//! - `identity-bindings.json`: per-principal identity bindings
//!   (`{ principalId, transport, linkedPubkey?, displayName?, username?, kind?, ... }`).
//!
//! Identity bindings stay TS-owned (the worker writes them). Transport
//! bindings are Rust-written (the `/start` command handler persists the
//! chat→project link) and TS-read (the worker's `send_message` tool and
//! the project-context system-prompt fragment read the file). The on-disk
//! shape must therefore stay byte-compatible with the TS writer: a plain
//! JSON array, no schema stamps.
//!
//! The path under the base directory is resolved by TypeScript's
//! `ConfigService.getConfigPath("data")`. We take the directory as an
//! explicit argument so callers can point us at it without re-implementing
//! the config resolver in Rust.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const TRANSPORT_BINDINGS_FILE_NAME: &str = "transport-bindings.json";
pub const IDENTITY_BINDINGS_FILE_NAME: &str = "identity-bindings.json";

#[derive(Debug, Error)]
pub enum TransportBindingReadError {
    #[error("transport bindings io error: {0}")]
    Io(#[from] io::Error),
    #[error("transport bindings json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Error)]
pub enum TransportBindingWriteError {
    #[error("transport bindings read failed: {0}")]
    Read(#[from] TransportBindingReadError),
    #[error("transport bindings io error: {0}")]
    Io(#[from] io::Error),
    #[error("transport bindings json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Subset of RuntimeTransport values Rust recognises. Matches the TS
/// `RuntimeTransport` type; records with any other value are skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeTransport {
    Local,
    Mcp,
    Nostr,
    Telegram,
}

impl RuntimeTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeTransport::Local => "local",
            RuntimeTransport::Mcp => "mcp",
            RuntimeTransport::Nostr => "nostr",
            RuntimeTransport::Telegram => "telegram",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportBindingRecord {
    pub transport: RuntimeTransport,
    pub agent_pubkey: String,
    pub channel_id: String,
    pub project_id: String,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Read the transport bindings file. Missing file returns an empty vector,
/// matching the TS reader. Malformed records are skipped.
pub fn read_transport_bindings(
    data_dir: &Path,
) -> Result<Vec<TransportBindingRecord>, TransportBindingReadError> {
    let path = transport_bindings_path(data_dir);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };

    let raw: serde_json::Value = serde_json::from_slice(&bytes)?;
    let array = match raw {
        serde_json::Value::Array(items) => items,
        _ => return Ok(Vec::new()),
    };

    let mut records = Vec::with_capacity(array.len());
    for entry in array {
        if let Ok(record) = serde_json::from_value::<TransportBindingRecord>(entry)
            && !record.agent_pubkey.is_empty()
            && !record.channel_id.is_empty()
            && !record.project_id.is_empty()
        {
            records.push(record);
        }
    }
    Ok(records)
}

/// Filter helper: find the record for a given agent + channel pair.
pub fn find_binding<'a>(
    bindings: &'a [TransportBindingRecord],
    agent_pubkey: &str,
    channel_id: &str,
    transport: RuntimeTransport,
) -> Option<&'a TransportBindingRecord> {
    bindings.iter().find(|record| {
        record.agent_pubkey == agent_pubkey
            && record.channel_id == channel_id
            && record.transport == transport
    })
}

pub fn transport_bindings_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TRANSPORT_BINDINGS_FILE_NAME)
}

/// Persist or update a single transport binding entry in
/// `transport-bindings.json`. Matches the TS
/// `TransportBindingStore.rememberBinding` semantics:
///
/// - entries are keyed by `(transport, agentPubkey, channelId)`
/// - an existing entry keeps its `createdAt` and has `updatedAt` bumped
/// - new entries stamp both timestamps with `now_ms`
///
/// The on-disk file is a plain JSON array (no schema stamps) so TS readers
/// consuming the same file stay compatible. The write is atomic via a
/// tempfile rename with fsync.
pub fn write_transport_binding(
    data_dir: &Path,
    transport: RuntimeTransport,
    agent_pubkey: &str,
    channel_id: &str,
    project_id: &str,
    now_ms: u64,
) -> Result<TransportBindingRecord, TransportBindingWriteError> {
    if agent_pubkey.is_empty() || channel_id.is_empty() || project_id.is_empty() {
        return Err(TransportBindingWriteError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "transport binding requires non-empty agentPubkey, channelId, projectId",
        )));
    }
    let mut records = read_transport_bindings(data_dir)?;
    let mut updated = false;
    for record in records.iter_mut() {
        if record.transport == transport
            && record.agent_pubkey == agent_pubkey
            && record.channel_id == channel_id
        {
            record.project_id = project_id.to_string();
            record.updated_at = now_ms;
            updated = true;
            break;
        }
    }
    if !updated {
        records.push(TransportBindingRecord {
            transport,
            agent_pubkey: agent_pubkey.to_string(),
            channel_id: channel_id.to_string(),
            project_id: project_id.to_string(),
            created_at: now_ms,
            updated_at: now_ms,
        });
    }
    atomic_write_array(data_dir, TRANSPORT_BINDINGS_FILE_NAME, &records)?;
    let written = records
        .into_iter()
        .find(|record| {
            record.transport == transport
                && record.agent_pubkey == agent_pubkey
                && record.channel_id == channel_id
        })
        .expect("just-written binding must be present");
    Ok(written)
}

fn atomic_write_array<T: Serialize>(
    data_dir: &Path,
    file_name: &str,
    records: &[T],
) -> Result<(), TransportBindingWriteError> {
    fs::create_dir_all(data_dir)?;
    let target = data_dir.join(file_name);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let tmp = data_dir.join(format!("{file_name}.{}.{}.tmp", std::process::id(), nanos));
    let write_result = (|| -> Result<(), TransportBindingWriteError> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        // TS writer uses `JSON.stringify(value, null, 2)` + trailing newline.
        // Match that exactly so file diffs stay noise-free across writers.
        let body = serde_json::to_string_pretty(records)?;
        file.write_all(body.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&tmp, &target)?;
        if let Some(parent) = target.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_result
}

pub fn identity_bindings_path(data_dir: &Path) -> PathBuf {
    data_dir.join(IDENTITY_BINDINGS_FILE_NAME)
}

/// Single record in `identity-bindings.json`. Mirrors TS `IdentityBinding`.
/// The `transport` column on the TS side is derived from the
/// `principalId` prefix (e.g. `telegram:user:123` → `telegram`). We keep it
/// as a raw string rather than coercing through [`RuntimeTransport`] to
/// tolerate future transports without Rust changes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityBindingRecord {
    pub principal_id: String,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub linked_pubkey: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub fallback_name: Option<String>,
    #[serde(default)]
    pub updated_at: Option<u64>,
}

/// Read the identity bindings file. Missing file returns an empty vector,
/// matching the TS reader. Malformed records are skipped.
pub fn read_identity_bindings(
    data_dir: &Path,
) -> Result<Vec<IdentityBindingRecord>, TransportBindingReadError> {
    let path = identity_bindings_path(data_dir);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };

    let raw: serde_json::Value = serde_json::from_slice(&bytes)?;
    let array = match raw {
        serde_json::Value::Array(items) => items,
        _ => return Ok(Vec::new()),
    };

    let mut records = Vec::with_capacity(array.len());
    for entry in array {
        if let Ok(record) = serde_json::from_value::<IdentityBindingRecord>(entry)
            && !record.principal_id.is_empty()
        {
            records.push(record);
        }
    }
    Ok(records)
}

/// Find the `linkedPubkey` for a given principal id across the stored
/// identity bindings. Returns `None` if the principal is unknown or has no
/// linked pubkey recorded yet.
pub fn find_linked_pubkey<'a>(
    bindings: &'a [IdentityBindingRecord],
    principal_id: &str,
) -> Option<&'a str> {
    bindings
        .iter()
        .find(|record| record.principal_id == principal_id)
        .and_then(|record| record.linked_pubkey.as_deref())
}

/// Convenience: look up the linked pubkey for a Telegram user by numeric id.
/// Uses the `telegram:user:<id>` principal id scheme shared with the
/// inbound normalizer.
pub fn find_linked_pubkey_for_telegram_user(
    bindings: &[IdentityBindingRecord],
    telegram_user_id: i64,
) -> Option<&str> {
    let principal_id = format!("telegram:user:{telegram_user_id}");
    find_linked_pubkey(bindings, &principal_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tenex-telegram-{prefix}-{unique}-{counter}"));
        fs::create_dir_all(&dir).expect("temp dir must create");
        dir
    }

    #[test]
    fn missing_file_returns_empty() {
        let dir = unique_temp_dir("bindings-missing");
        let records = read_transport_bindings(&dir).expect("missing file must read as empty");
        assert!(records.is_empty());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reads_known_records_and_drops_unknown_transport() {
        let dir = unique_temp_dir("bindings-filter");
        let path = transport_bindings_path(&dir);
        let agent_a = "a".repeat(64);
        let agent_b = "b".repeat(64);
        let body = format!(
            r#"[
              {{
                "transport": "telegram",
                "agentPubkey": "{agent_a}",
                "channelId": "telegram:123:456",
                "projectId": "demo",
                "createdAt": 1,
                "updatedAt": 2
              }},
              {{
                "transport": "slack",
                "agentPubkey": "{agent_b}",
                "channelId": "slack:abc",
                "projectId": "demo",
                "createdAt": 1,
                "updatedAt": 2
              }}
            ]"#
        );
        fs::write(&path, body).expect("write");

        let records = read_transport_bindings(&dir).expect("must read");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].transport, RuntimeTransport::Telegram);
        assert_eq!(records[0].project_id, "demo");

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn drops_records_missing_required_fields() {
        let dir = unique_temp_dir("bindings-incomplete");
        let path = transport_bindings_path(&dir);
        fs::write(
            &path,
            r#"[
              {
                "transport": "telegram",
                "agentPubkey": "",
                "channelId": "telegram:123:456",
                "projectId": "demo",
                "createdAt": 1,
                "updatedAt": 2
              }
            ]"#,
        )
        .expect("write");

        let records = read_transport_bindings(&dir).expect("must read");
        assert!(records.is_empty());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn malformed_json_returns_error() {
        let dir = unique_temp_dir("bindings-malformed");
        let path = transport_bindings_path(&dir);
        fs::write(&path, "not json").expect("write");
        let err = read_transport_bindings(&dir).expect_err("must error on malformed json");
        assert!(matches!(err, TransportBindingReadError::Json(_)));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn non_array_top_level_returns_empty() {
        let dir = unique_temp_dir("bindings-object");
        let path = transport_bindings_path(&dir);
        fs::write(&path, "{}").expect("write");
        let records = read_transport_bindings(&dir).expect("must read");
        assert!(records.is_empty());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn identity_bindings_missing_file_returns_empty() {
        let dir = unique_temp_dir("identity-missing");
        let records = read_identity_bindings(&dir).expect("missing file must read as empty");
        assert!(records.is_empty());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn identity_bindings_read_round_trip_and_lookup_by_telegram_user() {
        let dir = unique_temp_dir("identity-lookup");
        let path = identity_bindings_path(&dir);
        let pubkey = "a".repeat(64);
        let body = format!(
            r#"[
              {{
                "principalId": "telegram:user:12345",
                "transport": "telegram",
                "linkedPubkey": "{pubkey}",
                "displayName": "Ada",
                "username": "ada_admin",
                "kind": "human",
                "updatedAt": 1700000000
              }},
              {{
                "principalId": "telegram:user:42",
                "transport": "telegram",
                "displayName": "Unlinked"
              }}
            ]"#
        );
        fs::write(&path, body).expect("write");

        let records = read_identity_bindings(&dir).expect("must read");
        assert_eq!(records.len(), 2);
        assert_eq!(
            find_linked_pubkey_for_telegram_user(&records, 12345),
            Some(pubkey.as_str()),
        );
        // Record exists but has no linkedPubkey → None.
        assert!(find_linked_pubkey_for_telegram_user(&records, 42).is_none());
        // Unknown principal → None.
        assert!(find_linked_pubkey_for_telegram_user(&records, 7).is_none());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn identity_bindings_skips_entries_missing_principal_id() {
        let dir = unique_temp_dir("identity-empty-principal");
        let path = identity_bindings_path(&dir);
        fs::write(
            &path,
            r#"[
              { "principalId": "" },
              { "principalId": "telegram:user:5", "linkedPubkey": "ok" }
            ]"#,
        )
        .expect("write");
        let records = read_identity_bindings(&dir).expect("read");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].principal_id, "telegram:user:5");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn identity_bindings_non_array_returns_empty() {
        let dir = unique_temp_dir("identity-object");
        let path = identity_bindings_path(&dir);
        fs::write(&path, "{}").expect("write");
        let records = read_identity_bindings(&dir).expect("must read");
        assert!(records.is_empty());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn find_binding_matches_only_exact_triple() {
        let records = vec![
            TransportBindingRecord {
                transport: RuntimeTransport::Telegram,
                agent_pubkey: "a".repeat(64),
                channel_id: "telegram:1:2".to_string(),
                project_id: "p".to_string(),
                created_at: 0,
                updated_at: 0,
            },
            TransportBindingRecord {
                transport: RuntimeTransport::Nostr,
                agent_pubkey: "a".repeat(64),
                channel_id: "telegram:1:2".to_string(),
                project_id: "p".to_string(),
                created_at: 0,
                updated_at: 0,
            },
        ];
        let found = find_binding(
            &records,
            &"a".repeat(64),
            "telegram:1:2",
            RuntimeTransport::Telegram,
        );
        assert!(found.is_some());
        assert_eq!(found.unwrap().transport, RuntimeTransport::Telegram);
    }

    #[test]
    fn write_transport_binding_creates_file_with_plain_array_shape() {
        let dir = unique_temp_dir("bindings-write");
        let agent = "a".repeat(64);
        let record = write_transport_binding(
            &dir,
            RuntimeTransport::Telegram,
            &agent,
            "telegram:chat:100",
            "project-alpha",
            1_700_000_000_000,
        )
        .expect("write");
        assert_eq!(record.created_at, 1_700_000_000_000);
        assert_eq!(record.updated_at, 1_700_000_000_000);

        // Confirm the on-disk format is a plain JSON array (no stamp
        // wrapper). This is critical: the TS worker reads the same file.
        let raw = fs::read_to_string(transport_bindings_path(&dir)).expect("read");
        assert!(raw.starts_with('['), "expected leading '[' in {raw:?}");
        assert!(raw.trim_end().ends_with(']'));
        assert!(raw.ends_with('\n'));

        let round = read_transport_bindings(&dir).expect("read");
        assert_eq!(round.len(), 1);
        assert_eq!(round[0].project_id, "project-alpha");
        assert_eq!(round[0].transport, RuntimeTransport::Telegram);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn write_transport_binding_updates_existing_entry_in_place() {
        let dir = unique_temp_dir("bindings-write-update");
        let agent = "a".repeat(64);
        write_transport_binding(
            &dir,
            RuntimeTransport::Telegram,
            &agent,
            "telegram:chat:100",
            "project-alpha",
            1_700_000_000_000,
        )
        .expect("first write");
        let second = write_transport_binding(
            &dir,
            RuntimeTransport::Telegram,
            &agent,
            "telegram:chat:100",
            "project-beta",
            1_700_000_005_000,
        )
        .expect("second write");
        assert_eq!(second.created_at, 1_700_000_000_000);
        assert_eq!(second.updated_at, 1_700_000_005_000);
        assert_eq!(second.project_id, "project-beta");

        let round = read_transport_bindings(&dir).expect("read");
        assert_eq!(round.len(), 1, "update must not duplicate");
        assert_eq!(round[0].project_id, "project-beta");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn write_transport_binding_preserves_other_entries() {
        let dir = unique_temp_dir("bindings-write-preserve");
        let agent_a = "a".repeat(64);
        let agent_b = "b".repeat(64);
        write_transport_binding(
            &dir,
            RuntimeTransport::Telegram,
            &agent_a,
            "telegram:chat:100",
            "project-alpha",
            1_700_000_000_000,
        )
        .expect("a write");
        write_transport_binding(
            &dir,
            RuntimeTransport::Telegram,
            &agent_b,
            "telegram:chat:200",
            "project-beta",
            1_700_000_000_500,
        )
        .expect("b write");

        let round = read_transport_bindings(&dir).expect("read");
        assert_eq!(round.len(), 2);
        let by_agent: std::collections::HashMap<_, _> = round
            .iter()
            .map(|record| (record.agent_pubkey.clone(), record.project_id.clone()))
            .collect();
        assert_eq!(by_agent.get(&agent_a).map(String::as_str), Some("project-alpha"));
        assert_eq!(by_agent.get(&agent_b).map(String::as_str), Some("project-beta"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn write_transport_binding_rejects_empty_fields() {
        let dir = unique_temp_dir("bindings-write-empty");
        let agent = "a".repeat(64);
        let err = write_transport_binding(
            &dir,
            RuntimeTransport::Telegram,
            &agent,
            "",
            "project-alpha",
            1_700_000_000_000,
        )
        .expect_err("empty channel id must error");
        assert!(matches!(err, TransportBindingWriteError::Io(_)));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn write_leaves_no_stray_tmp_file_on_success() {
        let dir = unique_temp_dir("bindings-write-tmp");
        let agent = "a".repeat(64);
        write_transport_binding(
            &dir,
            RuntimeTransport::Telegram,
            &agent,
            "telegram:chat:100",
            "project-alpha",
            1_700_000_000_000,
        )
        .expect("write");
        let leftover: Vec<_> = fs::read_dir(&dir)
            .expect("read_dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|name| name.ends_with(".tmp"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(leftover.is_empty(), "tmp files must not leak: {leftover:?}");
        fs::remove_dir_all(dir).ok();
    }
}
