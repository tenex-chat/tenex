use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{CACHES_WRITER, caches_dir, caches_tmp_dir};

pub const TRUST_PUBKEYS_FILE_NAME: &str = "trust-pubkeys.json";
pub const TRUST_PUBKEYS_WRITER: &str = CACHES_WRITER;
pub const TRUST_PUBKEYS_SCHEMA_VERSION: u32 = 1;
pub const TRUST_PUBKEYS_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
pub const PUBKEY_HEX_LENGTH: usize = 64;

#[derive(Debug, Error)]
pub enum TrustPubkeysError {
    #[error("trust pubkeys io error: {0}")]
    Io(#[from] io::Error),
    #[error("trust pubkeys json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error(
        "trust pubkeys snapshot schema version {found} is not supported (expected {expected})"
    )]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
    #[error("trust pubkeys snapshot has invalid pubkey: {pubkey:?}")]
    InvalidPubkey { pubkey: String },
    #[error("trust pubkeys snapshot writer must not be empty")]
    MissingWriter,
    #[error("trust pubkeys snapshot writerVersion must not be empty")]
    MissingWriterVersion,
    #[error("trust pubkeys snapshot updatedAt must be non-zero")]
    InvalidUpdatedAt,
}

pub type TrustPubkeysResult<T> = Result<T, TrustPubkeysError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustPubkeysSnapshot {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub updated_at: u64,
    pub pubkeys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustPubkeysDiagnostics {
    pub schema_version: u32,
    pub inspected_at: u64,
    pub present: bool,
    pub pubkey_count: usize,
    pub snapshot_schema_version: Option<u32>,
    pub writer: Option<String>,
    pub writer_version: Option<String>,
    pub updated_at: Option<u64>,
}

pub fn trust_pubkeys_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    caches_dir(daemon_dir).join(TRUST_PUBKEYS_FILE_NAME)
}

pub fn write_trust_pubkeys(
    daemon_dir: impl AsRef<Path>,
    snapshot: &TrustPubkeysSnapshot,
) -> TrustPubkeysResult<TrustPubkeysSnapshot> {
    validate_writer_fields(snapshot)?;

    let mut normalized = snapshot.clone();
    normalized.schema_version = TRUST_PUBKEYS_SCHEMA_VERSION;
    normalize_pubkeys(&mut normalized.pubkeys)?;

    let daemon_dir = daemon_dir.as_ref();
    let cache_dir = caches_dir(daemon_dir);
    let tmp_dir = caches_tmp_dir(daemon_dir);
    fs::create_dir_all(&cache_dir)?;
    fs::create_dir_all(&tmp_dir)?;

    let target_path = trust_pubkeys_path(daemon_dir);
    let tmp_path = tmp_dir.join(format!(
        "{}.{}.{}.tmp",
        TRUST_PUBKEYS_FILE_NAME,
        std::process::id(),
        now_nanos()
    ));

    let outcome = (|| {
        write_snapshot_file(&tmp_path, &normalized)?;
        fs::rename(&tmp_path, &target_path)?;
        sync_parent_dir(&target_path)?;
        Ok(normalized.clone())
    })();

    if outcome.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }

    outcome
}

pub fn read_trust_pubkeys(
    daemon_dir: impl AsRef<Path>,
) -> TrustPubkeysResult<Option<TrustPubkeysSnapshot>> {
    let path = trust_pubkeys_path(daemon_dir);
    match fs::read_to_string(&path) {
        Ok(content) => {
            let snapshot: TrustPubkeysSnapshot = serde_json::from_str(&content)?;
            if snapshot.schema_version != TRUST_PUBKEYS_SCHEMA_VERSION {
                return Err(TrustPubkeysError::UnsupportedSchemaVersion {
                    found: snapshot.schema_version,
                    expected: TRUST_PUBKEYS_SCHEMA_VERSION,
                });
            }
            for pubkey in &snapshot.pubkeys {
                if !is_valid_xonly_pubkey(pubkey) {
                    return Err(TrustPubkeysError::InvalidPubkey {
                        pubkey: pubkey.clone(),
                    });
                }
            }
            Ok(Some(snapshot))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn inspect_trust_pubkeys(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> TrustPubkeysResult<TrustPubkeysDiagnostics> {
    let snapshot = read_trust_pubkeys(daemon_dir)?;
    Ok(match snapshot {
        Some(snapshot) => TrustPubkeysDiagnostics {
            schema_version: TRUST_PUBKEYS_DIAGNOSTICS_SCHEMA_VERSION,
            inspected_at: now,
            present: true,
            pubkey_count: snapshot.pubkeys.len(),
            snapshot_schema_version: Some(snapshot.schema_version),
            writer: Some(snapshot.writer),
            writer_version: Some(snapshot.writer_version),
            updated_at: Some(snapshot.updated_at),
        },
        None => TrustPubkeysDiagnostics {
            schema_version: TRUST_PUBKEYS_DIAGNOSTICS_SCHEMA_VERSION,
            inspected_at: now,
            present: false,
            pubkey_count: 0,
            snapshot_schema_version: None,
            writer: None,
            writer_version: None,
            updated_at: None,
        },
    })
}

fn validate_writer_fields(snapshot: &TrustPubkeysSnapshot) -> TrustPubkeysResult<()> {
    if snapshot.writer.is_empty() {
        return Err(TrustPubkeysError::MissingWriter);
    }
    if snapshot.writer_version.is_empty() {
        return Err(TrustPubkeysError::MissingWriterVersion);
    }
    if snapshot.updated_at == 0 {
        return Err(TrustPubkeysError::InvalidUpdatedAt);
    }
    Ok(())
}

fn normalize_pubkeys(pubkeys: &mut Vec<String>) -> TrustPubkeysResult<()> {
    for pubkey in pubkeys.iter() {
        if !is_valid_xonly_pubkey(pubkey) {
            return Err(TrustPubkeysError::InvalidPubkey {
                pubkey: pubkey.clone(),
            });
        }
    }
    pubkeys.sort();
    pubkeys.dedup();
    Ok(())
}

pub fn is_valid_xonly_pubkey(candidate: &str) -> bool {
    candidate.len() == PUBKEY_HEX_LENGTH
        && candidate
            .chars()
            .all(|character| matches!(character, '0'..='9' | 'a'..='f'))
}

fn write_snapshot_file(path: &Path, snapshot: &TrustPubkeysSnapshot) -> TrustPubkeysResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer_pretty(&mut file, snapshot)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn sync_parent_dir(path: &Path) -> TrustPubkeysResult<()> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-trust-pubkeys-{}-{counter}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }

    fn sample_pubkey(byte: u8) -> String {
        let hex = format!("{byte:02x}");
        hex.repeat(PUBKEY_HEX_LENGTH / 2)
    }

    fn sample_snapshot(updated_at: u64, pubkeys: Vec<String>) -> TrustPubkeysSnapshot {
        TrustPubkeysSnapshot {
            schema_version: TRUST_PUBKEYS_SCHEMA_VERSION,
            writer: TRUST_PUBKEYS_WRITER.to_string(),
            writer_version: "test-version".to_string(),
            updated_at,
            pubkeys,
        }
    }

    #[test]
    fn round_trips_sorted_deduplicated_snapshot() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![
                sample_pubkey(0x22),
                sample_pubkey(0x11),
                sample_pubkey(0x22),
            ],
        );

        let written =
            write_trust_pubkeys(&daemon_dir, &snapshot).expect("write must succeed");

        assert_eq!(written.pubkeys, vec![sample_pubkey(0x11), sample_pubkey(0x22)]);
        assert_eq!(written.schema_version, TRUST_PUBKEYS_SCHEMA_VERSION);
        assert_eq!(written.writer, TRUST_PUBKEYS_WRITER);

        let read_back =
            read_trust_pubkeys(&daemon_dir).expect("read must succeed");
        assert_eq!(read_back, Some(written));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn read_returns_none_when_file_missing() {
        let daemon_dir = unique_temp_daemon_dir();

        let result = read_trust_pubkeys(&daemon_dir).expect("read must succeed");

        assert!(result.is_none());

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_malformed_hex_pubkey_on_write() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut bad_hex = sample_pubkey(0xaa);
        bad_hex.replace_range(0..1, "Z");
        let snapshot = sample_snapshot(1_710_000_000_100, vec![bad_hex.clone()]);

        let error =
            write_trust_pubkeys(&daemon_dir, &snapshot).expect_err("invalid hex must fail");

        assert!(matches!(
            error,
            TrustPubkeysError::InvalidPubkey { pubkey } if pubkey == bad_hex
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_short_pubkey_on_write() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(1_710_000_000_100, vec!["ab".to_string()]);

        let error =
            write_trust_pubkeys(&daemon_dir, &snapshot).expect_err("short hex must fail");

        assert!(matches!(error, TrustPubkeysError::InvalidPubkey { .. }));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_missing_writer_version() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut snapshot = sample_snapshot(1_710_000_000_100, vec![sample_pubkey(0x11)]);
        snapshot.writer_version.clear();

        let error = write_trust_pubkeys(&daemon_dir, &snapshot)
            .expect_err("missing writerVersion must fail");

        assert!(matches!(error, TrustPubkeysError::MissingWriterVersion));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_zero_updated_at() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(0, vec![sample_pubkey(0x11)]);

        let error =
            write_trust_pubkeys(&daemon_dir, &snapshot).expect_err("zero updatedAt must fail");

        assert!(matches!(error, TrustPubkeysError::InvalidUpdatedAt));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn schema_version_mismatch_fails_closed_on_read() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![sample_pubkey(0x11)]);
        write_trust_pubkeys(&daemon_dir, &snapshot).expect("initial write must succeed");

        let path = trust_pubkeys_path(&daemon_dir);
        let mut value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        value["schemaVersion"] = json!(999);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        let error = read_trust_pubkeys(&daemon_dir).expect_err("bad schema must fail read");

        assert!(matches!(
            error,
            TrustPubkeysError::UnsupportedSchemaVersion {
                found: 999,
                expected: 1
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn truncated_json_fails_closed_on_read() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![sample_pubkey(0x11)]);
        write_trust_pubkeys(&daemon_dir, &snapshot).expect("initial write must succeed");

        let path = trust_pubkeys_path(&daemon_dir);
        fs::write(&path, b"{\"schemaVersion\":1,\"writer\":").unwrap();

        let error = read_trust_pubkeys(&daemon_dir).expect_err("truncated JSON must fail read");

        assert!(matches!(error, TrustPubkeysError::Json(_)));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn read_rejects_corrupt_pubkey_in_persisted_snapshot() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![sample_pubkey(0x11)]);
        write_trust_pubkeys(&daemon_dir, &snapshot).expect("initial write must succeed");

        let path = trust_pubkeys_path(&daemon_dir);
        let mut value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        value["pubkeys"] = json!(["not-a-hex-pubkey"]);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        let error = read_trust_pubkeys(&daemon_dir).expect_err("corrupt pubkey must fail read");

        assert!(matches!(error, TrustPubkeysError::InvalidPubkey { .. }));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn atomic_write_leaves_no_stray_tmp_file() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![sample_pubkey(0x11)]);

        write_trust_pubkeys(&daemon_dir, &snapshot).expect("write must succeed");

        let tmp_dir = caches_tmp_dir(&daemon_dir);
        let remaining: Vec<_> = fs::read_dir(&tmp_dir)
            .expect("tmp dir must exist after write")
            .collect::<Result<_, _>>()
            .expect("tmp dir entries must iterate");
        assert!(remaining.is_empty(), "tmp dir must be empty after success");

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn second_write_overwrites_first_snapshot() {
        let daemon_dir = unique_temp_daemon_dir();
        let first = sample_snapshot(1_710_000_000_100, vec![sample_pubkey(0x11)]);
        let second = sample_snapshot(
            1_710_000_000_500,
            vec![sample_pubkey(0x22), sample_pubkey(0x33)],
        );

        write_trust_pubkeys(&daemon_dir, &first).expect("first write must succeed");
        let persisted = write_trust_pubkeys(&daemon_dir, &second).expect("second write must succeed");

        assert_eq!(persisted.updated_at, 1_710_000_000_500);
        assert_eq!(
            persisted.pubkeys,
            vec![sample_pubkey(0x22), sample_pubkey(0x33)]
        );

        let read_back =
            read_trust_pubkeys(&daemon_dir).expect("read must succeed").unwrap();
        assert_eq!(read_back, persisted);

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn diagnostics_reflect_missing_file() {
        let daemon_dir = unique_temp_daemon_dir();

        let diagnostics =
            inspect_trust_pubkeys(&daemon_dir, 1_710_000_000_900).expect("inspect must succeed");

        assert_eq!(
            diagnostics.schema_version,
            TRUST_PUBKEYS_DIAGNOSTICS_SCHEMA_VERSION
        );
        assert_eq!(diagnostics.inspected_at, 1_710_000_000_900);
        assert!(!diagnostics.present);
        assert_eq!(diagnostics.pubkey_count, 0);
        assert_eq!(diagnostics.snapshot_schema_version, None);
        assert_eq!(diagnostics.writer, None);
        assert_eq!(diagnostics.writer_version, None);
        assert_eq!(diagnostics.updated_at, None);

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn diagnostics_match_persisted_snapshot() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_001_000,
            vec![sample_pubkey(0x11), sample_pubkey(0x22)],
        );
        write_trust_pubkeys(&daemon_dir, &snapshot).expect("write must succeed");

        let diagnostics =
            inspect_trust_pubkeys(&daemon_dir, 1_710_000_002_000).expect("inspect must succeed");

        assert!(diagnostics.present);
        assert_eq!(diagnostics.pubkey_count, 2);
        assert_eq!(
            diagnostics.snapshot_schema_version,
            Some(TRUST_PUBKEYS_SCHEMA_VERSION)
        );
        assert_eq!(diagnostics.writer.as_deref(), Some(TRUST_PUBKEYS_WRITER));
        assert_eq!(diagnostics.writer_version.as_deref(), Some("test-version"));
        assert_eq!(diagnostics.updated_at, Some(1_710_000_001_000));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn written_snapshot_carries_required_fields() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![sample_pubkey(0x11)]);

        write_trust_pubkeys(&daemon_dir, &snapshot).expect("write must succeed");

        let raw = fs::read_to_string(trust_pubkeys_path(&daemon_dir)).expect("read must succeed");
        let value: Value = serde_json::from_str(&raw).expect("JSON must parse");
        assert_eq!(value["schemaVersion"], json!(TRUST_PUBKEYS_SCHEMA_VERSION));
        assert_eq!(value["writer"], json!(TRUST_PUBKEYS_WRITER));
        assert_eq!(value["writerVersion"], json!("test-version"));
        assert_eq!(value["updatedAt"], json!(1_710_000_000_100u64));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }
}
