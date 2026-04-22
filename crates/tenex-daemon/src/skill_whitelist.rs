use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use secp256k1::XOnlyPublicKey;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SKILL_WHITELIST_FILE_NAME: &str = "skill-whitelist.json";
pub const SKILL_WHITELIST_TMP_DIR_NAME: &str = "tmp";
pub const SKILL_WHITELIST_WRITER: &str = "rust-daemon";
pub const SKILL_WHITELIST_SCHEMA_VERSION: u32 = 1;
pub const SKILL_WHITELIST_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
pub const SKILL_WHITELIST_KIND: u64 = 4202;
pub const EVENT_ID_HEX_LENGTH: usize = 64;

#[derive(Debug, Error)]
pub enum SkillWhitelistError {
    #[error("skill whitelist io error: {0}")]
    Io(#[from] io::Error),
    #[error("skill whitelist json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("skill whitelist snapshot schema version {found} is not supported (expected {expected})")]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
    #[error("skill whitelist entry has invalid eventId {event_id:?}")]
    InvalidEventId { event_id: String },
    #[error("skill whitelist entry {event_id:?} has unsupported kind {kind} (expected {expected})")]
    UnsupportedKind {
        event_id: String,
        kind: u64,
        expected: u64,
    },
    #[error("skill whitelist entry {event_id:?} has invalid whitelister pubkey {pubkey:?}")]
    InvalidWhitelister { event_id: String, pubkey: String },
    #[error("skill whitelist entry {event_id:?} has no whitelisters after dedupe")]
    EmptyWhitelisters { event_id: String },
    #[error("skill whitelist entry {event_id:?} has lastObservedAt == 0")]
    InvalidLastObservedAt { event_id: String },
    #[error("skill whitelist snapshot has duplicate entry eventId {event_id:?}")]
    DuplicateEntry { event_id: String },
    #[error("skill whitelist snapshot writer must not be empty")]
    MissingWriter,
    #[error("skill whitelist snapshot writerVersion must not be empty")]
    MissingWriterVersion,
    #[error("skill whitelist snapshot updatedAt must be non-zero")]
    InvalidUpdatedAt,
}

pub type SkillWhitelistResult<T> = Result<T, SkillWhitelistError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillWhitelistEntry {
    pub event_id: String,
    pub kind: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub whitelisted_by: Vec<String>,
    pub last_observed_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillWhitelistSnapshot {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub updated_at: u64,
    pub skills: Vec<SkillWhitelistEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillWhitelistDiagnostics {
    pub schema_version: u32,
    pub inspected_at: u64,
    pub present: bool,
    pub total_skills: usize,
    pub total_whitelisters: usize,
    pub oldest_observed_at: Option<u64>,
    pub latest_observed_at: Option<u64>,
    pub snapshot_schema_version: Option<u32>,
    pub writer: Option<String>,
    pub writer_version: Option<String>,
    pub updated_at: Option<u64>,
}

pub fn skill_whitelist_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(SKILL_WHITELIST_FILE_NAME)
}

pub fn skill_whitelist_tmp_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(SKILL_WHITELIST_TMP_DIR_NAME)
}

pub fn write_skill_whitelist(
    daemon_dir: impl AsRef<Path>,
    snapshot: &SkillWhitelistSnapshot,
) -> SkillWhitelistResult<SkillWhitelistSnapshot> {
    validate_writer_fields(snapshot)?;

    let mut normalized = snapshot.clone();
    normalized.schema_version = SKILL_WHITELIST_SCHEMA_VERSION;
    normalize_entries(&mut normalized.skills)?;

    let daemon_dir = daemon_dir.as_ref();
    let tmp_dir = skill_whitelist_tmp_dir(daemon_dir);
    fs::create_dir_all(daemon_dir)?;
    fs::create_dir_all(&tmp_dir)?;

    let target_path = skill_whitelist_path(daemon_dir);
    let tmp_path = tmp_dir.join(format!(
        "{}.{}.{}.tmp",
        SKILL_WHITELIST_FILE_NAME,
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

pub fn read_skill_whitelist(
    daemon_dir: impl AsRef<Path>,
) -> SkillWhitelistResult<Option<SkillWhitelistSnapshot>> {
    let path = skill_whitelist_path(daemon_dir);
    match fs::read_to_string(&path) {
        Ok(content) => {
            let snapshot: SkillWhitelistSnapshot = serde_json::from_str(&content)?;
            if snapshot.schema_version != SKILL_WHITELIST_SCHEMA_VERSION {
                return Err(SkillWhitelistError::UnsupportedSchemaVersion {
                    found: snapshot.schema_version,
                    expected: SKILL_WHITELIST_SCHEMA_VERSION,
                });
            }
            validate_persisted_entries(&snapshot.skills)?;
            Ok(Some(snapshot))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn inspect_skill_whitelist(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> SkillWhitelistResult<SkillWhitelistDiagnostics> {
    let snapshot = read_skill_whitelist(daemon_dir)?;
    Ok(match snapshot {
        Some(snapshot) => {
            let mut unique_whitelisters: BTreeSet<&String> = BTreeSet::new();
            let mut oldest: Option<u64> = None;
            let mut latest: Option<u64> = None;
            for entry in &snapshot.skills {
                for pubkey in &entry.whitelisted_by {
                    unique_whitelisters.insert(pubkey);
                }
                oldest = Some(match oldest {
                    Some(current) => current.min(entry.last_observed_at),
                    None => entry.last_observed_at,
                });
                latest = Some(match latest {
                    Some(current) => current.max(entry.last_observed_at),
                    None => entry.last_observed_at,
                });
            }
            SkillWhitelistDiagnostics {
                schema_version: SKILL_WHITELIST_DIAGNOSTICS_SCHEMA_VERSION,
                inspected_at: now,
                present: true,
                total_skills: snapshot.skills.len(),
                total_whitelisters: unique_whitelisters.len(),
                oldest_observed_at: oldest,
                latest_observed_at: latest,
                snapshot_schema_version: Some(snapshot.schema_version),
                writer: Some(snapshot.writer),
                writer_version: Some(snapshot.writer_version),
                updated_at: Some(snapshot.updated_at),
            }
        }
        None => SkillWhitelistDiagnostics {
            schema_version: SKILL_WHITELIST_DIAGNOSTICS_SCHEMA_VERSION,
            inspected_at: now,
            present: false,
            total_skills: 0,
            total_whitelisters: 0,
            oldest_observed_at: None,
            latest_observed_at: None,
            snapshot_schema_version: None,
            writer: None,
            writer_version: None,
            updated_at: None,
        },
    })
}

fn validate_writer_fields(snapshot: &SkillWhitelistSnapshot) -> SkillWhitelistResult<()> {
    if snapshot.writer.is_empty() {
        return Err(SkillWhitelistError::MissingWriter);
    }
    if snapshot.writer_version.is_empty() {
        return Err(SkillWhitelistError::MissingWriterVersion);
    }
    if snapshot.updated_at == 0 {
        return Err(SkillWhitelistError::InvalidUpdatedAt);
    }
    Ok(())
}

fn normalize_entries(entries: &mut [SkillWhitelistEntry]) -> SkillWhitelistResult<()> {
    let mut seen_event_ids: BTreeSet<String> = BTreeSet::new();
    for entry in entries.iter_mut() {
        if !is_valid_lowercase_hex_event_id(&entry.event_id) {
            return Err(SkillWhitelistError::InvalidEventId {
                event_id: entry.event_id.clone(),
            });
        }
        if entry.kind != SKILL_WHITELIST_KIND {
            return Err(SkillWhitelistError::UnsupportedKind {
                event_id: entry.event_id.clone(),
                kind: entry.kind,
                expected: SKILL_WHITELIST_KIND,
            });
        }
        if entry.last_observed_at == 0 {
            return Err(SkillWhitelistError::InvalidLastObservedAt {
                event_id: entry.event_id.clone(),
            });
        }
        for pubkey in &entry.whitelisted_by {
            if XOnlyPublicKey::from_str(pubkey).is_err() {
                return Err(SkillWhitelistError::InvalidWhitelister {
                    event_id: entry.event_id.clone(),
                    pubkey: pubkey.clone(),
                });
            }
        }
        entry.whitelisted_by.sort();
        entry.whitelisted_by.dedup();
        if entry.whitelisted_by.is_empty() {
            return Err(SkillWhitelistError::EmptyWhitelisters {
                event_id: entry.event_id.clone(),
            });
        }
        if !seen_event_ids.insert(entry.event_id.clone()) {
            return Err(SkillWhitelistError::DuplicateEntry {
                event_id: entry.event_id.clone(),
            });
        }
    }
    entries.sort_by(|left, right| left.event_id.cmp(&right.event_id));
    Ok(())
}

fn validate_persisted_entries(entries: &[SkillWhitelistEntry]) -> SkillWhitelistResult<()> {
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for entry in entries {
        if !is_valid_lowercase_hex_event_id(&entry.event_id) {
            return Err(SkillWhitelistError::InvalidEventId {
                event_id: entry.event_id.clone(),
            });
        }
        if entry.kind != SKILL_WHITELIST_KIND {
            return Err(SkillWhitelistError::UnsupportedKind {
                event_id: entry.event_id.clone(),
                kind: entry.kind,
                expected: SKILL_WHITELIST_KIND,
            });
        }
        if entry.last_observed_at == 0 {
            return Err(SkillWhitelistError::InvalidLastObservedAt {
                event_id: entry.event_id.clone(),
            });
        }
        if entry.whitelisted_by.is_empty() {
            return Err(SkillWhitelistError::EmptyWhitelisters {
                event_id: entry.event_id.clone(),
            });
        }
        for pubkey in &entry.whitelisted_by {
            if XOnlyPublicKey::from_str(pubkey).is_err() {
                return Err(SkillWhitelistError::InvalidWhitelister {
                    event_id: entry.event_id.clone(),
                    pubkey: pubkey.clone(),
                });
            }
        }
        if !seen.insert(entry.event_id.as_str()) {
            return Err(SkillWhitelistError::DuplicateEntry {
                event_id: entry.event_id.clone(),
            });
        }
    }
    Ok(())
}

fn is_valid_lowercase_hex_event_id(candidate: &str) -> bool {
    candidate.len() == EVENT_ID_HEX_LENGTH
        && candidate
            .chars()
            .all(|character| matches!(character, '0'..='9' | 'a'..='f'))
}

fn write_snapshot_file(
    path: &Path,
    snapshot: &SkillWhitelistSnapshot,
) -> SkillWhitelistResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer_pretty(&mut file, snapshot)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn sync_parent_dir(path: &Path) -> SkillWhitelistResult<()> {
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
    use secp256k1::{Keypair, Secp256k1, SecretKey};
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
            "tenex-skill-whitelist-{}-{counter}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }

    fn secp_pubkey(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn event_id_hex(fill_byte: u8) -> String {
        format!("{fill_byte:02x}").repeat(EVENT_ID_HEX_LENGTH / 2)
    }

    fn sample_entry(
        event_id: String,
        whitelisted_by: Vec<String>,
        last_observed_at: u64,
    ) -> SkillWhitelistEntry {
        SkillWhitelistEntry {
            event_id,
            kind: SKILL_WHITELIST_KIND,
            identifier: Some("sample-skill".to_string()),
            short_id: Some("sample-short".to_string()),
            name: Some("Sample Skill".to_string()),
            description: Some("A skill used in tests.".to_string()),
            whitelisted_by,
            last_observed_at,
        }
    }

    fn sample_snapshot(
        updated_at: u64,
        skills: Vec<SkillWhitelistEntry>,
    ) -> SkillWhitelistSnapshot {
        SkillWhitelistSnapshot {
            schema_version: SKILL_WHITELIST_SCHEMA_VERSION,
            writer: SKILL_WHITELIST_WRITER.to_string(),
            writer_version: "test-version".to_string(),
            updated_at,
            skills,
        }
    }

    #[test]
    fn write_sorts_skills_and_deduplicates_whitelisters() {
        let daemon_dir = unique_temp_daemon_dir();
        let entry_a = sample_entry(
            event_id_hex(0xbb),
            vec![secp_pubkey(0x01), secp_pubkey(0x02)],
            1_710_000_000_100,
        );
        let entry_b = sample_entry(
            event_id_hex(0xaa),
            vec![secp_pubkey(0x03), secp_pubkey(0x03), secp_pubkey(0x02)],
            1_710_000_000_200,
        );
        let snapshot = sample_snapshot(1_710_000_000_300, vec![entry_a, entry_b]);

        let written = write_skill_whitelist(&daemon_dir, &snapshot).expect("write must succeed");

        assert_eq!(written.skills.len(), 2);
        assert_eq!(written.skills[0].event_id, event_id_hex(0xaa));
        assert_eq!(written.skills[1].event_id, event_id_hex(0xbb));
        assert_eq!(
            written.skills[0].whitelisted_by,
            vec![secp_pubkey(0x02), secp_pubkey(0x03)]
        );

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_malformed_event_id_hex() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut bad = event_id_hex(0xaa);
        bad.replace_range(0..1, "Z");
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(bad.clone(), vec![secp_pubkey(0x01)], 1_710_000_000_050)],
        );

        let error = write_skill_whitelist(&daemon_dir, &snapshot).expect_err("bad hex must fail");

        assert!(matches!(
            error,
            SkillWhitelistError::InvalidEventId { event_id } if event_id == bad
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_unsupported_kind() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut entry = sample_entry(
            event_id_hex(0xaa),
            vec![secp_pubkey(0x01)],
            1_710_000_000_050,
        );
        entry.kind = 4201;
        let snapshot = sample_snapshot(1_710_000_000_100, vec![entry]);

        let error =
            write_skill_whitelist(&daemon_dir, &snapshot).expect_err("wrong kind must fail");

        assert!(matches!(
            error,
            SkillWhitelistError::UnsupportedKind { kind: 4201, expected: 4202, .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_malformed_whitelister_pubkey() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(
                event_id_hex(0xaa),
                vec!["not-a-valid-pubkey".to_string()],
                1_710_000_000_050,
            )],
        );

        let error =
            write_skill_whitelist(&daemon_dir, &snapshot).expect_err("bad pubkey must fail");

        assert!(matches!(
            error,
            SkillWhitelistError::InvalidWhitelister { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_empty_whitelisters_after_dedup() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(event_id_hex(0xaa), Vec::new(), 1_710_000_000_050)],
        );

        let error = write_skill_whitelist(&daemon_dir, &snapshot)
            .expect_err("empty whitelisters must fail");

        assert!(matches!(
            error,
            SkillWhitelistError::EmptyWhitelisters { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_zero_last_observed_at() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(event_id_hex(0xaa), vec![secp_pubkey(0x01)], 0)],
        );

        let error =
            write_skill_whitelist(&daemon_dir, &snapshot).expect_err("zero lastObservedAt fails");

        assert!(matches!(
            error,
            SkillWhitelistError::InvalidLastObservedAt { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_zero_updated_at() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            0,
            vec![sample_entry(
                event_id_hex(0xaa),
                vec![secp_pubkey(0x01)],
                1_710_000_000_050,
            )],
        );

        let error =
            write_skill_whitelist(&daemon_dir, &snapshot).expect_err("zero updatedAt must fail");

        assert!(matches!(error, SkillWhitelistError::InvalidUpdatedAt));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_missing_writer_version() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(
                event_id_hex(0xaa),
                vec![secp_pubkey(0x01)],
                1_710_000_000_050,
            )],
        );
        snapshot.writer_version.clear();

        let error = write_skill_whitelist(&daemon_dir, &snapshot)
            .expect_err("missing writerVersion must fail");

        assert!(matches!(error, SkillWhitelistError::MissingWriterVersion));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_duplicate_event_ids() {
        let daemon_dir = unique_temp_daemon_dir();
        let entry_a = sample_entry(
            event_id_hex(0xaa),
            vec![secp_pubkey(0x01)],
            1_710_000_000_050,
        );
        let entry_b = sample_entry(
            event_id_hex(0xaa),
            vec![secp_pubkey(0x02)],
            1_710_000_000_060,
        );
        let snapshot = sample_snapshot(1_710_000_000_100, vec![entry_a, entry_b]);

        let error = write_skill_whitelist(&daemon_dir, &snapshot)
            .expect_err("duplicate eventId must fail");

        assert!(matches!(error, SkillWhitelistError::DuplicateEntry { .. }));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn atomic_write_leaves_no_stray_tmp_file() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(
                event_id_hex(0xaa),
                vec![secp_pubkey(0x01)],
                1_710_000_000_050,
            )],
        );

        write_skill_whitelist(&daemon_dir, &snapshot).expect("write must succeed");

        let tmp_dir = skill_whitelist_tmp_dir(&daemon_dir);
        let remaining: Vec<_> = fs::read_dir(&tmp_dir)
            .expect("tmp dir must exist after write")
            .collect::<Result<_, _>>()
            .expect("tmp dir entries must iterate");
        assert!(remaining.is_empty(), "tmp dir must be empty after success");

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn written_snapshot_carries_required_fields() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(
                event_id_hex(0xaa),
                vec![secp_pubkey(0x01)],
                1_710_000_000_050,
            )],
        );

        write_skill_whitelist(&daemon_dir, &snapshot).expect("write must succeed");

        let raw =
            fs::read_to_string(skill_whitelist_path(&daemon_dir)).expect("read must succeed");
        let value: Value = serde_json::from_str(&raw).expect("JSON must parse");
        assert_eq!(value["schemaVersion"], json!(SKILL_WHITELIST_SCHEMA_VERSION));
        assert_eq!(value["writer"], json!(SKILL_WHITELIST_WRITER));
        assert_eq!(value["writerVersion"], json!("test-version"));
        assert_eq!(value["updatedAt"], json!(1_710_000_000_100u64));
        let skills = value["skills"].as_array().expect("skills must be array");
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0]["kind"], json!(SKILL_WHITELIST_KIND));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn round_trips_snapshot_canonically() {
        let daemon_dir = unique_temp_daemon_dir();
        let entry_a = sample_entry(
            event_id_hex(0xbb),
            vec![secp_pubkey(0x01), secp_pubkey(0x02)],
            1_710_000_000_100,
        );
        let entry_b = sample_entry(
            event_id_hex(0xaa),
            vec![secp_pubkey(0x03), secp_pubkey(0x02)],
            1_710_000_000_200,
        );
        let snapshot = sample_snapshot(1_710_000_000_300, vec![entry_a, entry_b]);

        let written = write_skill_whitelist(&daemon_dir, &snapshot).expect("write must succeed");
        let read_back = read_skill_whitelist(&daemon_dir)
            .expect("read must succeed")
            .expect("snapshot must exist");

        assert_eq!(read_back, written);

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn read_returns_none_when_file_missing() {
        let daemon_dir = unique_temp_daemon_dir();

        let result = read_skill_whitelist(&daemon_dir).expect("read must succeed");

        assert!(result.is_none());

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn schema_version_mismatch_fails_closed_on_read() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(
                event_id_hex(0xaa),
                vec![secp_pubkey(0x01)],
                1_710_000_000_050,
            )],
        );
        write_skill_whitelist(&daemon_dir, &snapshot).expect("initial write must succeed");

        let path = skill_whitelist_path(&daemon_dir);
        let mut value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        value["schemaVersion"] = json!(999);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        let error = read_skill_whitelist(&daemon_dir).expect_err("bad schema must fail read");

        assert!(matches!(
            error,
            SkillWhitelistError::UnsupportedSchemaVersion {
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
            vec![sample_entry(
                event_id_hex(0xaa),
                vec![secp_pubkey(0x01)],
                1_710_000_000_050,
            )],
        );
        write_skill_whitelist(&daemon_dir, &snapshot).expect("initial write must succeed");

        let path = skill_whitelist_path(&daemon_dir);
        fs::write(&path, b"{\"schemaVersion\":1,\"writer\":").unwrap();

        let error = read_skill_whitelist(&daemon_dir).expect_err("truncated JSON must fail read");

        assert!(matches!(error, SkillWhitelistError::Json(_)));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn sequential_writes_are_idempotent() {
        let daemon_dir = unique_temp_daemon_dir();
        let first = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(
                event_id_hex(0xaa),
                vec![secp_pubkey(0x01)],
                1_710_000_000_050,
            )],
        );
        let second = sample_snapshot(
            1_710_000_000_500,
            vec![
                sample_entry(
                    event_id_hex(0xbb),
                    vec![secp_pubkey(0x02)],
                    1_710_000_000_300,
                ),
                sample_entry(
                    event_id_hex(0xcc),
                    vec![secp_pubkey(0x03), secp_pubkey(0x04)],
                    1_710_000_000_400,
                ),
            ],
        );

        write_skill_whitelist(&daemon_dir, &first).expect("first write must succeed");
        let persisted =
            write_skill_whitelist(&daemon_dir, &second).expect("second write must succeed");

        assert_eq!(persisted.updated_at, 1_710_000_000_500);
        assert_eq!(persisted.skills.len(), 2);

        let read_back = read_skill_whitelist(&daemon_dir)
            .expect("read must succeed")
            .unwrap();
        assert_eq!(read_back, persisted);

        let tmp_dir = skill_whitelist_tmp_dir(&daemon_dir);
        let remaining: Vec<_> = fs::read_dir(&tmp_dir)
            .expect("tmp dir must exist")
            .collect::<Result<_, _>>()
            .expect("tmp dir entries must iterate");
        assert!(
            remaining.is_empty(),
            "tmp dir must be empty after second write"
        );

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn diagnostics_reflect_missing_file() {
        let daemon_dir = unique_temp_daemon_dir();

        let diagnostics =
            inspect_skill_whitelist(&daemon_dir, 1_710_000_000_900).expect("inspect must succeed");

        assert_eq!(
            diagnostics.schema_version,
            SKILL_WHITELIST_DIAGNOSTICS_SCHEMA_VERSION
        );
        assert_eq!(diagnostics.inspected_at, 1_710_000_000_900);
        assert!(!diagnostics.present);
        assert_eq!(diagnostics.total_skills, 0);
        assert_eq!(diagnostics.total_whitelisters, 0);
        assert_eq!(diagnostics.oldest_observed_at, None);
        assert_eq!(diagnostics.latest_observed_at, None);
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
                sample_entry(
                    event_id_hex(0xaa),
                    vec![secp_pubkey(0x01), secp_pubkey(0x02)],
                    1_710_000_000_500,
                ),
                sample_entry(
                    event_id_hex(0xbb),
                    vec![secp_pubkey(0x02), secp_pubkey(0x03)],
                    1_710_000_000_800,
                ),
            ],
        );
        write_skill_whitelist(&daemon_dir, &snapshot).expect("write must succeed");

        let diagnostics =
            inspect_skill_whitelist(&daemon_dir, 1_710_000_002_000).expect("inspect must succeed");

        assert!(diagnostics.present);
        assert_eq!(diagnostics.total_skills, 2);
        assert_eq!(diagnostics.total_whitelisters, 3);
        assert_eq!(diagnostics.oldest_observed_at, Some(1_710_000_000_500));
        assert_eq!(diagnostics.latest_observed_at, Some(1_710_000_000_800));
        assert_eq!(
            diagnostics.snapshot_schema_version,
            Some(SKILL_WHITELIST_SCHEMA_VERSION)
        );
        assert_eq!(diagnostics.writer.as_deref(), Some(SKILL_WHITELIST_WRITER));
        assert_eq!(diagnostics.writer_version.as_deref(), Some("test-version"));
        assert_eq!(diagnostics.updated_at, Some(1_710_000_001_000));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }
}
