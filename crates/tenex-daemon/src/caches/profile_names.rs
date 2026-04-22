use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{CACHES_WRITER, caches_dir, caches_tmp_dir};
use super::trust_pubkeys::is_valid_xonly_pubkey;

pub const PROFILE_NAMES_FILE_NAME: &str = "profile-names.json";
pub const PROFILE_NAMES_WRITER: &str = CACHES_WRITER;
pub const PROFILE_NAMES_SCHEMA_VERSION: u32 = 1;
pub const PROFILE_NAMES_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum ProfileNamesError {
    #[error("profile names io error: {0}")]
    Io(#[from] io::Error),
    #[error("profile names json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error(
        "profile names snapshot schema version {found} is not supported (expected {expected})"
    )]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
    #[error("profile names snapshot has invalid pubkey key: {pubkey:?}")]
    InvalidPubkey { pubkey: String },
    #[error(
        "profile names snapshot entry for pubkey {pubkey:?} has neither displayName nor nip05"
    )]
    EmptyEntry { pubkey: String },
    #[error("profile names snapshot entry for pubkey {pubkey:?} has observedAt == 0")]
    InvalidObservedAt { pubkey: String },
    #[error("profile names snapshot writer must not be empty")]
    MissingWriter,
    #[error("profile names snapshot writerVersion must not be empty")]
    MissingWriterVersion,
    #[error("profile names snapshot updatedAt must be non-zero")]
    InvalidUpdatedAt,
}

pub type ProfileNamesResult<T> = Result<T, ProfileNamesError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileNameEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nip05: Option<String>,
    pub observed_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileNamesSnapshot {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub updated_at: u64,
    pub entries: BTreeMap<String, ProfileNameEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileNamesDiagnostics {
    pub schema_version: u32,
    pub inspected_at: u64,
    pub present: bool,
    pub entry_count: usize,
    pub display_name_count: usize,
    pub nip05_count: usize,
    pub snapshot_schema_version: Option<u32>,
    pub writer: Option<String>,
    pub writer_version: Option<String>,
    pub updated_at: Option<u64>,
}

pub fn profile_names_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    caches_dir(daemon_dir).join(PROFILE_NAMES_FILE_NAME)
}

pub fn write_profile_names(
    daemon_dir: impl AsRef<Path>,
    snapshot: &ProfileNamesSnapshot,
) -> ProfileNamesResult<ProfileNamesSnapshot> {
    validate_writer_fields(snapshot)?;
    validate_entries(&snapshot.entries)?;

    let mut normalized = snapshot.clone();
    normalized.schema_version = PROFILE_NAMES_SCHEMA_VERSION;

    let daemon_dir = daemon_dir.as_ref();
    let cache_dir = caches_dir(daemon_dir);
    let tmp_dir = caches_tmp_dir(daemon_dir);
    fs::create_dir_all(&cache_dir)?;
    fs::create_dir_all(&tmp_dir)?;

    let target_path = profile_names_path(daemon_dir);
    let tmp_path = tmp_dir.join(format!(
        "{}.{}.{}.tmp",
        PROFILE_NAMES_FILE_NAME,
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

pub fn read_profile_names(
    daemon_dir: impl AsRef<Path>,
) -> ProfileNamesResult<Option<ProfileNamesSnapshot>> {
    let path = profile_names_path(daemon_dir);
    match fs::read_to_string(&path) {
        Ok(content) => {
            let snapshot: ProfileNamesSnapshot = serde_json::from_str(&content)?;
            if snapshot.schema_version != PROFILE_NAMES_SCHEMA_VERSION {
                return Err(ProfileNamesError::UnsupportedSchemaVersion {
                    found: snapshot.schema_version,
                    expected: PROFILE_NAMES_SCHEMA_VERSION,
                });
            }
            validate_entries(&snapshot.entries)?;
            Ok(Some(snapshot))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn inspect_profile_names(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> ProfileNamesResult<ProfileNamesDiagnostics> {
    let snapshot = read_profile_names(daemon_dir)?;
    Ok(match snapshot {
        Some(snapshot) => {
            let display_name_count = snapshot
                .entries
                .values()
                .filter(|entry| entry.display_name.is_some())
                .count();
            let nip05_count = snapshot
                .entries
                .values()
                .filter(|entry| entry.nip05.is_some())
                .count();
            ProfileNamesDiagnostics {
                schema_version: PROFILE_NAMES_DIAGNOSTICS_SCHEMA_VERSION,
                inspected_at: now,
                present: true,
                entry_count: snapshot.entries.len(),
                display_name_count,
                nip05_count,
                snapshot_schema_version: Some(snapshot.schema_version),
                writer: Some(snapshot.writer),
                writer_version: Some(snapshot.writer_version),
                updated_at: Some(snapshot.updated_at),
            }
        }
        None => ProfileNamesDiagnostics {
            schema_version: PROFILE_NAMES_DIAGNOSTICS_SCHEMA_VERSION,
            inspected_at: now,
            present: false,
            entry_count: 0,
            display_name_count: 0,
            nip05_count: 0,
            snapshot_schema_version: None,
            writer: None,
            writer_version: None,
            updated_at: None,
        },
    })
}

fn validate_writer_fields(snapshot: &ProfileNamesSnapshot) -> ProfileNamesResult<()> {
    if snapshot.writer.is_empty() {
        return Err(ProfileNamesError::MissingWriter);
    }
    if snapshot.writer_version.is_empty() {
        return Err(ProfileNamesError::MissingWriterVersion);
    }
    if snapshot.updated_at == 0 {
        return Err(ProfileNamesError::InvalidUpdatedAt);
    }
    Ok(())
}

fn validate_entries(
    entries: &BTreeMap<String, ProfileNameEntry>,
) -> ProfileNamesResult<()> {
    for (pubkey, entry) in entries {
        if !is_valid_xonly_pubkey(pubkey) {
            return Err(ProfileNamesError::InvalidPubkey {
                pubkey: pubkey.clone(),
            });
        }
        if entry.display_name.is_none() && entry.nip05.is_none() {
            return Err(ProfileNamesError::EmptyEntry {
                pubkey: pubkey.clone(),
            });
        }
        if entry.observed_at == 0 {
            return Err(ProfileNamesError::InvalidObservedAt {
                pubkey: pubkey.clone(),
            });
        }
    }
    Ok(())
}

fn write_snapshot_file(path: &Path, snapshot: &ProfileNamesSnapshot) -> ProfileNamesResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer_pretty(&mut file, snapshot)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn sync_parent_dir(path: &Path) -> ProfileNamesResult<()> {
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
            "tenex-profile-names-{}-{counter}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }

    fn full_pubkey(byte: u8) -> String {
        format!("{byte:02x}").repeat(32)
    }

    fn sample_snapshot(
        updated_at: u64,
        entries: Vec<(String, ProfileNameEntry)>,
    ) -> ProfileNamesSnapshot {
        ProfileNamesSnapshot {
            schema_version: PROFILE_NAMES_SCHEMA_VERSION,
            writer: PROFILE_NAMES_WRITER.to_string(),
            writer_version: "test-version".to_string(),
            updated_at,
            entries: entries.into_iter().collect(),
        }
    }

    fn entry_with_both(byte: u8, observed_at: u64) -> ProfileNameEntry {
        ProfileNameEntry {
            display_name: Some(format!("Alice-{byte:02x}")),
            nip05: Some(format!("alice{byte:02x}@example.test")),
            observed_at,
        }
    }

    fn entry_display_only(observed_at: u64) -> ProfileNameEntry {
        ProfileNameEntry {
            display_name: Some("Bob".to_string()),
            nip05: None,
            observed_at,
        }
    }

    fn entry_nip05_only(observed_at: u64) -> ProfileNameEntry {
        ProfileNameEntry {
            display_name: None,
            nip05: Some("carol@example.test".to_string()),
            observed_at,
        }
    }

    #[test]
    fn round_trips_snapshot_with_mixed_entry_shapes() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![
                (full_pubkey(0x11), entry_with_both(0x11, 1_710_000_000_050)),
                (full_pubkey(0x22), entry_display_only(1_710_000_000_060)),
                (full_pubkey(0x33), entry_nip05_only(1_710_000_000_070)),
            ],
        );

        let written = write_profile_names(&daemon_dir, &snapshot).expect("write must succeed");

        let read_back = read_profile_names(&daemon_dir)
            .expect("read must succeed")
            .expect("snapshot must exist");
        assert_eq!(read_back, written);
        assert_eq!(read_back.entries.len(), 3);

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn read_returns_none_when_file_missing() {
        let daemon_dir = unique_temp_daemon_dir();

        let result = read_profile_names(&daemon_dir).expect("read must succeed");

        assert!(result.is_none());

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_invalid_pubkey_key_on_write() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![("not-a-hex-pubkey".to_string(), entry_display_only(1_710_000_000_000))],
        );

        let error =
            write_profile_names(&daemon_dir, &snapshot).expect_err("bad pubkey must fail");

        assert!(matches!(error, ProfileNamesError::InvalidPubkey { .. }));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_empty_entry_with_no_display_name_or_nip05() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![(
                full_pubkey(0x11),
                ProfileNameEntry {
                    display_name: None,
                    nip05: None,
                    observed_at: 1_710_000_000_000,
                },
            )],
        );

        let error =
            write_profile_names(&daemon_dir, &snapshot).expect_err("empty entry must fail");

        assert!(matches!(error, ProfileNamesError::EmptyEntry { .. }));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_entry_with_observed_at_zero() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![(full_pubkey(0x11), entry_display_only(0))],
        );

        let error = write_profile_names(&daemon_dir, &snapshot)
            .expect_err("observedAt == 0 must fail");

        assert!(matches!(error, ProfileNamesError::InvalidObservedAt { .. }));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_missing_writer_version() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![(full_pubkey(0x11), entry_display_only(1_710_000_000_000))],
        );
        snapshot.writer_version.clear();

        let error = write_profile_names(&daemon_dir, &snapshot)
            .expect_err("missing writerVersion must fail");

        assert!(matches!(error, ProfileNamesError::MissingWriterVersion));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_zero_updated_at() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            0,
            vec![(full_pubkey(0x11), entry_display_only(1_710_000_000_000))],
        );

        let error =
            write_profile_names(&daemon_dir, &snapshot).expect_err("zero updatedAt must fail");

        assert!(matches!(error, ProfileNamesError::InvalidUpdatedAt));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn schema_version_mismatch_fails_closed_on_read() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![(full_pubkey(0x11), entry_display_only(1_710_000_000_000))],
        );
        write_profile_names(&daemon_dir, &snapshot).expect("initial write must succeed");

        let path = profile_names_path(&daemon_dir);
        let mut value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        value["schemaVersion"] = json!(999);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        let error = read_profile_names(&daemon_dir).expect_err("bad schema must fail read");

        assert!(matches!(
            error,
            ProfileNamesError::UnsupportedSchemaVersion {
                found: 999,
                expected: 1
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn truncated_json_fails_closed_on_read() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![(full_pubkey(0x11), entry_display_only(1_710_000_000_000))],
        );
        write_profile_names(&daemon_dir, &snapshot).expect("initial write must succeed");

        let path = profile_names_path(&daemon_dir);
        fs::write(&path, b"{\"schemaVersion\":1,\"writer\":").unwrap();

        let error = read_profile_names(&daemon_dir).expect_err("truncated JSON must fail read");

        assert!(matches!(error, ProfileNamesError::Json(_)));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn atomic_write_leaves_no_stray_tmp_file() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![(full_pubkey(0x11), entry_display_only(1_710_000_000_000))],
        );

        write_profile_names(&daemon_dir, &snapshot).expect("write must succeed");

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
        let first = sample_snapshot(
            1_710_000_000_100,
            vec![(full_pubkey(0x11), entry_display_only(1_710_000_000_000))],
        );
        let second = sample_snapshot(
            1_710_000_000_500,
            vec![
                (full_pubkey(0x11), entry_nip05_only(1_710_000_000_100)),
                (full_pubkey(0x22), entry_with_both(0x22, 1_710_000_000_200)),
            ],
        );

        write_profile_names(&daemon_dir, &first).expect("first write must succeed");
        let persisted =
            write_profile_names(&daemon_dir, &second).expect("second write must succeed");

        assert_eq!(persisted.updated_at, 1_710_000_000_500);
        assert_eq!(persisted.entries.len(), 2);

        let read_back =
            read_profile_names(&daemon_dir).expect("read must succeed").unwrap();
        assert_eq!(read_back, persisted);
        assert!(read_back.entries[&full_pubkey(0x11)].nip05.is_some());
        assert!(read_back.entries[&full_pubkey(0x11)].display_name.is_none());

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn diagnostics_reflect_missing_file() {
        let daemon_dir = unique_temp_daemon_dir();

        let diagnostics =
            inspect_profile_names(&daemon_dir, 1_710_000_000_900).expect("inspect must succeed");

        assert_eq!(
            diagnostics.schema_version,
            PROFILE_NAMES_DIAGNOSTICS_SCHEMA_VERSION
        );
        assert_eq!(diagnostics.inspected_at, 1_710_000_000_900);
        assert!(!diagnostics.present);
        assert_eq!(diagnostics.entry_count, 0);
        assert_eq!(diagnostics.display_name_count, 0);
        assert_eq!(diagnostics.nip05_count, 0);
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
            vec![
                (full_pubkey(0x11), entry_with_both(0x11, 1_710_000_000_500)),
                (full_pubkey(0x22), entry_display_only(1_710_000_000_600)),
                (full_pubkey(0x33), entry_nip05_only(1_710_000_000_700)),
            ],
        );
        write_profile_names(&daemon_dir, &snapshot).expect("write must succeed");

        let diagnostics =
            inspect_profile_names(&daemon_dir, 1_710_000_002_000).expect("inspect must succeed");

        assert!(diagnostics.present);
        assert_eq!(diagnostics.entry_count, 3);
        assert_eq!(diagnostics.display_name_count, 2);
        assert_eq!(diagnostics.nip05_count, 2);
        assert_eq!(
            diagnostics.snapshot_schema_version,
            Some(PROFILE_NAMES_SCHEMA_VERSION)
        );
        assert_eq!(diagnostics.writer.as_deref(), Some(PROFILE_NAMES_WRITER));
        assert_eq!(diagnostics.writer_version.as_deref(), Some("test-version"));
        assert_eq!(diagnostics.updated_at, Some(1_710_000_001_000));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn written_snapshot_carries_required_fields() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![(full_pubkey(0x11), entry_display_only(1_710_000_000_000))],
        );

        write_profile_names(&daemon_dir, &snapshot).expect("write must succeed");

        let raw =
            fs::read_to_string(profile_names_path(&daemon_dir)).expect("read must succeed");
        let value: Value = serde_json::from_str(&raw).expect("JSON must parse");
        assert_eq!(value["schemaVersion"], json!(PROFILE_NAMES_SCHEMA_VERSION));
        assert_eq!(value["writer"], json!(PROFILE_NAMES_WRITER));
        assert_eq!(value["writerVersion"], json!("test-version"));
        assert_eq!(value["updatedAt"], json!(1_710_000_000_100u64));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }
}
