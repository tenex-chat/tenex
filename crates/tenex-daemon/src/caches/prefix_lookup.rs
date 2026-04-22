use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::trust_pubkeys::{PUBKEY_HEX_LENGTH, is_valid_xonly_pubkey};
use super::{CACHES_WRITER, caches_dir, caches_tmp_dir};

pub const PREFIX_LOOKUP_FILE_NAME: &str = "prefix-lookup.json";
pub const PREFIX_LOOKUP_WRITER: &str = CACHES_WRITER;
pub const PREFIX_LOOKUP_SCHEMA_VERSION: u32 = 1;
pub const PREFIX_LOOKUP_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
pub const MIN_PREFIX_LENGTH: usize = 6;

#[derive(Debug, Error)]
pub enum PrefixLookupError {
    #[error("prefix lookup io error: {0}")]
    Io(#[from] io::Error),
    #[error("prefix lookup json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("prefix lookup snapshot schema version {found} is not supported (expected {expected})")]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
    #[error("prefix lookup snapshot has prefix {prefix:?} shorter than minimum length {minimum}")]
    PrefixTooShort { prefix: String, minimum: usize },
    #[error(
        "prefix lookup snapshot has prefix {prefix:?} longer than the full pubkey length {maximum}"
    )]
    PrefixTooLong { prefix: String, maximum: usize },
    #[error("prefix lookup snapshot has invalid prefix {prefix:?}")]
    InvalidPrefix { prefix: String },
    #[error("prefix lookup snapshot has invalid pubkey {pubkey:?} for prefix {prefix:?}")]
    InvalidPubkey { prefix: String, pubkey: String },
    #[error("prefix lookup snapshot pubkey {pubkey:?} does not start with prefix {prefix:?}")]
    PrefixPubkeyMismatch { prefix: String, pubkey: String },
    #[error("prefix lookup snapshot writer must not be empty")]
    MissingWriter,
    #[error("prefix lookup snapshot writerVersion must not be empty")]
    MissingWriterVersion,
    #[error("prefix lookup snapshot updatedAt must be non-zero")]
    InvalidUpdatedAt,
}

pub type PrefixLookupResult<T> = Result<T, PrefixLookupError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefixLookupSnapshot {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub updated_at: u64,
    pub prefixes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefixLookupDiagnostics {
    pub schema_version: u32,
    pub inspected_at: u64,
    pub present: bool,
    pub prefix_count: usize,
    pub snapshot_schema_version: Option<u32>,
    pub writer: Option<String>,
    pub writer_version: Option<String>,
    pub updated_at: Option<u64>,
}

pub fn prefix_lookup_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    caches_dir(daemon_dir).join(PREFIX_LOOKUP_FILE_NAME)
}

pub fn write_prefix_lookup(
    daemon_dir: impl AsRef<Path>,
    snapshot: &PrefixLookupSnapshot,
) -> PrefixLookupResult<PrefixLookupSnapshot> {
    validate_writer_fields(snapshot)?;
    validate_prefix_entries(&snapshot.prefixes)?;

    let mut normalized = snapshot.clone();
    normalized.schema_version = PREFIX_LOOKUP_SCHEMA_VERSION;

    let daemon_dir = daemon_dir.as_ref();
    let cache_dir = caches_dir(daemon_dir);
    let tmp_dir = caches_tmp_dir(daemon_dir);
    fs::create_dir_all(&cache_dir)?;
    fs::create_dir_all(&tmp_dir)?;

    let target_path = prefix_lookup_path(daemon_dir);
    let tmp_path = tmp_dir.join(format!(
        "{}.{}.{}.tmp",
        PREFIX_LOOKUP_FILE_NAME,
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

pub fn read_prefix_lookup(
    daemon_dir: impl AsRef<Path>,
) -> PrefixLookupResult<Option<PrefixLookupSnapshot>> {
    let path = prefix_lookup_path(daemon_dir);
    match fs::read_to_string(&path) {
        Ok(content) => {
            let snapshot: PrefixLookupSnapshot = serde_json::from_str(&content)?;
            if snapshot.schema_version != PREFIX_LOOKUP_SCHEMA_VERSION {
                return Err(PrefixLookupError::UnsupportedSchemaVersion {
                    found: snapshot.schema_version,
                    expected: PREFIX_LOOKUP_SCHEMA_VERSION,
                });
            }
            validate_prefix_entries(&snapshot.prefixes)?;
            Ok(Some(snapshot))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn inspect_prefix_lookup(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> PrefixLookupResult<PrefixLookupDiagnostics> {
    let snapshot = read_prefix_lookup(daemon_dir)?;
    Ok(match snapshot {
        Some(snapshot) => PrefixLookupDiagnostics {
            schema_version: PREFIX_LOOKUP_DIAGNOSTICS_SCHEMA_VERSION,
            inspected_at: now,
            present: true,
            prefix_count: snapshot.prefixes.len(),
            snapshot_schema_version: Some(snapshot.schema_version),
            writer: Some(snapshot.writer),
            writer_version: Some(snapshot.writer_version),
            updated_at: Some(snapshot.updated_at),
        },
        None => PrefixLookupDiagnostics {
            schema_version: PREFIX_LOOKUP_DIAGNOSTICS_SCHEMA_VERSION,
            inspected_at: now,
            present: false,
            prefix_count: 0,
            snapshot_schema_version: None,
            writer: None,
            writer_version: None,
            updated_at: None,
        },
    })
}

fn validate_writer_fields(snapshot: &PrefixLookupSnapshot) -> PrefixLookupResult<()> {
    if snapshot.writer.is_empty() {
        return Err(PrefixLookupError::MissingWriter);
    }
    if snapshot.writer_version.is_empty() {
        return Err(PrefixLookupError::MissingWriterVersion);
    }
    if snapshot.updated_at == 0 {
        return Err(PrefixLookupError::InvalidUpdatedAt);
    }
    Ok(())
}

fn validate_prefix_entries(prefixes: &BTreeMap<String, String>) -> PrefixLookupResult<()> {
    for (prefix, pubkey) in prefixes {
        if prefix.len() < MIN_PREFIX_LENGTH {
            return Err(PrefixLookupError::PrefixTooShort {
                prefix: prefix.clone(),
                minimum: MIN_PREFIX_LENGTH,
            });
        }
        if prefix.len() > PUBKEY_HEX_LENGTH {
            return Err(PrefixLookupError::PrefixTooLong {
                prefix: prefix.clone(),
                maximum: PUBKEY_HEX_LENGTH,
            });
        }
        if !is_lowercase_hex(prefix) {
            return Err(PrefixLookupError::InvalidPrefix {
                prefix: prefix.clone(),
            });
        }
        if !is_valid_xonly_pubkey(pubkey) {
            return Err(PrefixLookupError::InvalidPubkey {
                prefix: prefix.clone(),
                pubkey: pubkey.clone(),
            });
        }
        if !pubkey.starts_with(prefix.as_str()) {
            return Err(PrefixLookupError::PrefixPubkeyMismatch {
                prefix: prefix.clone(),
                pubkey: pubkey.clone(),
            });
        }
    }
    Ok(())
}

fn is_lowercase_hex(candidate: &str) -> bool {
    !candidate.is_empty()
        && candidate
            .chars()
            .all(|character| matches!(character, '0'..='9' | 'a'..='f'))
}

fn write_snapshot_file(path: &Path, snapshot: &PrefixLookupSnapshot) -> PrefixLookupResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer_pretty(&mut file, snapshot)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn sync_parent_dir(path: &Path) -> PrefixLookupResult<()> {
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
            "tenex-prefix-lookup-{}-{counter}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }

    fn full_pubkey(byte: u8) -> String {
        format!("{byte:02x}").repeat(PUBKEY_HEX_LENGTH / 2)
    }

    fn sample_snapshot(updated_at: u64, prefixes: Vec<(&str, String)>) -> PrefixLookupSnapshot {
        PrefixLookupSnapshot {
            schema_version: PREFIX_LOOKUP_SCHEMA_VERSION,
            writer: PREFIX_LOOKUP_WRITER.to_string(),
            writer_version: "test-version".to_string(),
            updated_at,
            prefixes: prefixes
                .into_iter()
                .map(|(prefix, pubkey)| (prefix.to_string(), pubkey))
                .collect(),
        }
    }

    #[test]
    fn round_trips_snapshot_with_sorted_map() {
        let daemon_dir = unique_temp_daemon_dir();
        let pubkey_aa = full_pubkey(0xaa);
        let pubkey_bb = full_pubkey(0xbb);
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![
                (&pubkey_bb[..8], pubkey_bb.clone()),
                (&pubkey_aa[..8], pubkey_aa.clone()),
            ],
        );

        let written = write_prefix_lookup(&daemon_dir, &snapshot).expect("write must succeed");

        let read_back = read_prefix_lookup(&daemon_dir)
            .expect("read must succeed")
            .expect("snapshot must exist");
        assert_eq!(read_back, written);
        assert_eq!(read_back.prefixes.len(), 2);

        let keys: Vec<&String> = read_back.prefixes.keys().collect();
        assert!(keys[0] < keys[1], "BTreeMap must keep sorted prefix order");

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn read_returns_none_when_file_missing() {
        let daemon_dir = unique_temp_daemon_dir();

        let result = read_prefix_lookup(&daemon_dir).expect("read must succeed");

        assert!(result.is_none());

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_prefix_shorter_than_minimum() {
        let daemon_dir = unique_temp_daemon_dir();
        let pubkey = full_pubkey(0xaa);
        let snapshot = sample_snapshot(1_710_000_000_100, vec![("aaa", pubkey)]);

        let error =
            write_prefix_lookup(&daemon_dir, &snapshot).expect_err("short prefix must fail");

        assert!(matches!(
            error,
            PrefixLookupError::PrefixTooShort {
                minimum: MIN_PREFIX_LENGTH,
                ..
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_prefix_not_hex_prefix_of_value() {
        let daemon_dir = unique_temp_daemon_dir();
        let pubkey = full_pubkey(0xaa);
        let snapshot = sample_snapshot(1_710_000_000_100, vec![("bbbbbb", pubkey)]);

        let error = write_prefix_lookup(&daemon_dir, &snapshot)
            .expect_err("mismatched prefix/pubkey must fail");

        assert!(matches!(
            error,
            PrefixLookupError::PrefixPubkeyMismatch { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_malformed_hex_pubkey_value() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut pubkey = full_pubkey(0xaa);
        pubkey.replace_range(0..1, "Z");
        let snapshot = sample_snapshot(1_710_000_000_100, vec![("aaaaaa", pubkey)]);

        let error =
            write_prefix_lookup(&daemon_dir, &snapshot).expect_err("non-hex pubkey must fail");

        assert!(matches!(error, PrefixLookupError::InvalidPubkey { .. }));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_non_hex_prefix() {
        let daemon_dir = unique_temp_daemon_dir();
        let pubkey = full_pubkey(0xaa);
        let snapshot = sample_snapshot(1_710_000_000_100, vec![("ZZaaaa", pubkey)]);

        let error =
            write_prefix_lookup(&daemon_dir, &snapshot).expect_err("non-hex prefix must fail");

        assert!(matches!(error, PrefixLookupError::InvalidPrefix { .. }));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_missing_writer_version() {
        let daemon_dir = unique_temp_daemon_dir();
        let pubkey = full_pubkey(0xaa);
        let prefix = pubkey[..8].to_string();
        let mut snapshot = sample_snapshot(1_710_000_000_100, vec![(&prefix, pubkey)]);
        snapshot.writer_version.clear();

        let error = write_prefix_lookup(&daemon_dir, &snapshot)
            .expect_err("missing writerVersion must fail");

        assert!(matches!(error, PrefixLookupError::MissingWriterVersion));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_zero_updated_at() {
        let daemon_dir = unique_temp_daemon_dir();
        let pubkey = full_pubkey(0xaa);
        let prefix = pubkey[..8].to_string();
        let snapshot = sample_snapshot(0, vec![(&prefix, pubkey)]);

        let error =
            write_prefix_lookup(&daemon_dir, &snapshot).expect_err("zero updatedAt must fail");

        assert!(matches!(error, PrefixLookupError::InvalidUpdatedAt));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn schema_version_mismatch_fails_closed_on_read() {
        let daemon_dir = unique_temp_daemon_dir();
        let pubkey = full_pubkey(0xaa);
        let prefix = pubkey[..8].to_string();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![(&prefix, pubkey.clone())]);
        write_prefix_lookup(&daemon_dir, &snapshot).expect("initial write must succeed");

        let path = prefix_lookup_path(&daemon_dir);
        let mut value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        value["schemaVersion"] = json!(999);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        let error = read_prefix_lookup(&daemon_dir).expect_err("bad schema must fail read");

        assert!(matches!(
            error,
            PrefixLookupError::UnsupportedSchemaVersion {
                found: 999,
                expected: 1
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn truncated_json_fails_closed_on_read() {
        let daemon_dir = unique_temp_daemon_dir();
        let pubkey = full_pubkey(0xaa);
        let prefix = pubkey[..8].to_string();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![(&prefix, pubkey)]);
        write_prefix_lookup(&daemon_dir, &snapshot).expect("initial write must succeed");

        let path = prefix_lookup_path(&daemon_dir);
        fs::write(&path, b"{\"schemaVersion\":1,\"writer\":").unwrap();

        let error = read_prefix_lookup(&daemon_dir).expect_err("truncated JSON must fail read");

        assert!(matches!(error, PrefixLookupError::Json(_)));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn atomic_write_leaves_no_stray_tmp_file() {
        let daemon_dir = unique_temp_daemon_dir();
        let pubkey = full_pubkey(0xaa);
        let prefix = pubkey[..8].to_string();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![(&prefix, pubkey)]);

        write_prefix_lookup(&daemon_dir, &snapshot).expect("write must succeed");

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
        let pubkey_one = full_pubkey(0xaa);
        let pubkey_two = full_pubkey(0xbb);
        let prefix_one = pubkey_one[..8].to_string();
        let prefix_two = pubkey_two[..8].to_string();
        let first = sample_snapshot(1_710_000_000_100, vec![(&prefix_one, pubkey_one.clone())]);
        let second = sample_snapshot(
            1_710_000_000_500,
            vec![
                (&prefix_one, pubkey_one.clone()),
                (&prefix_two, pubkey_two.clone()),
            ],
        );

        write_prefix_lookup(&daemon_dir, &first).expect("first write must succeed");
        let persisted =
            write_prefix_lookup(&daemon_dir, &second).expect("second write must succeed");

        assert_eq!(persisted.updated_at, 1_710_000_000_500);
        assert_eq!(persisted.prefixes.len(), 2);

        let read_back = read_prefix_lookup(&daemon_dir)
            .expect("read must succeed")
            .unwrap();
        assert_eq!(read_back, persisted);

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn diagnostics_reflect_missing_file() {
        let daemon_dir = unique_temp_daemon_dir();

        let diagnostics =
            inspect_prefix_lookup(&daemon_dir, 1_710_000_000_900).expect("inspect must succeed");

        assert_eq!(
            diagnostics.schema_version,
            PREFIX_LOOKUP_DIAGNOSTICS_SCHEMA_VERSION
        );
        assert_eq!(diagnostics.inspected_at, 1_710_000_000_900);
        assert!(!diagnostics.present);
        assert_eq!(diagnostics.prefix_count, 0);
        assert_eq!(diagnostics.snapshot_schema_version, None);
        assert_eq!(diagnostics.writer, None);
        assert_eq!(diagnostics.writer_version, None);
        assert_eq!(diagnostics.updated_at, None);

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn diagnostics_match_persisted_snapshot() {
        let daemon_dir = unique_temp_daemon_dir();
        let pubkey = full_pubkey(0xaa);
        let prefix = pubkey[..8].to_string();
        let snapshot = sample_snapshot(1_710_000_001_000, vec![(&prefix, pubkey)]);
        write_prefix_lookup(&daemon_dir, &snapshot).expect("write must succeed");

        let diagnostics =
            inspect_prefix_lookup(&daemon_dir, 1_710_000_002_000).expect("inspect must succeed");

        assert!(diagnostics.present);
        assert_eq!(diagnostics.prefix_count, 1);
        assert_eq!(
            diagnostics.snapshot_schema_version,
            Some(PREFIX_LOOKUP_SCHEMA_VERSION)
        );
        assert_eq!(diagnostics.writer.as_deref(), Some(PREFIX_LOOKUP_WRITER));
        assert_eq!(diagnostics.writer_version.as_deref(), Some("test-version"));
        assert_eq!(diagnostics.updated_at, Some(1_710_000_001_000));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn written_snapshot_carries_required_fields() {
        let daemon_dir = unique_temp_daemon_dir();
        let pubkey = full_pubkey(0xaa);
        let prefix = pubkey[..8].to_string();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![(&prefix, pubkey)]);

        write_prefix_lookup(&daemon_dir, &snapshot).expect("write must succeed");

        let raw = fs::read_to_string(prefix_lookup_path(&daemon_dir)).expect("read must succeed");
        let value: Value = serde_json::from_str(&raw).expect("JSON must parse");
        assert_eq!(value["schemaVersion"], json!(PREFIX_LOOKUP_SCHEMA_VERSION));
        assert_eq!(value["writer"], json!(PREFIX_LOOKUP_WRITER));
        assert_eq!(value["writerVersion"], json!("test-version"));
        assert_eq!(value["updatedAt"], json!(1_710_000_000_100u64));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }
}
