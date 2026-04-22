use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use secp256k1::XOnlyPublicKey;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const AGENT_DEFINITIONS_FILE_NAME: &str = "agent-definitions.json";
pub const AGENT_DEFINITION_WATCHER_WRITER: &str = "rust-daemon";
pub const AGENT_DEFINITION_WATCHER_SCHEMA_VERSION: u32 = 1;
pub const AGENT_DEFINITION_WATCHER_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
pub const EVENT_ID_HEX_LENGTH: usize = 64;

#[derive(Debug, Error)]
pub enum AgentDefinitionWatcherError {
    #[error("agent definition watcher io error: {0}")]
    Io(#[from] io::Error),
    #[error("agent definition watcher json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error(
        "agent definition watcher snapshot schema version {found} is not supported (expected {expected})"
    )]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
    #[error("agent definition watcher entry has invalid eventId: {event_id:?}")]
    InvalidEventId { event_id: String },
    #[error(
        "agent definition watcher entry has invalid authorPubkey for eventId {event_id:?}: {pubkey:?}"
    )]
    InvalidAuthorPubkey { event_id: String, pubkey: String },
    #[error(
        "agent definition watcher entry has invalid agentPubkey for eventId {event_id:?}: {pubkey:?}"
    )]
    InvalidAgentPubkey { event_id: String, pubkey: String },
    #[error("agent definition watcher entry for eventId {event_id:?} has empty slug")]
    EmptySlug { event_id: String },
    #[error("agent definition watcher entry for eventId {event_id:?} has createdAt == 0")]
    InvalidCreatedAt { event_id: String },
    #[error("agent definition watcher entry for eventId {event_id:?} has lastObservedAt == 0")]
    InvalidLastObservedAt { event_id: String },
    #[error(
        "agent definition watcher snapshot contains duplicate (agentPubkey, slug) pair: ({agent_pubkey:?}, {slug:?})"
    )]
    DuplicateAgentSlug { agent_pubkey: String, slug: String },
    #[error("agent definition watcher snapshot contains duplicate eventId: {event_id:?}")]
    DuplicateEventId { event_id: String },
    #[error("agent definition watcher snapshot writer must not be empty")]
    MissingWriter,
    #[error("agent definition watcher snapshot writerVersion must not be empty")]
    MissingWriterVersion,
    #[error("agent definition watcher snapshot updatedAt must be non-zero")]
    InvalidUpdatedAt,
}

pub type AgentDefinitionWatcherResult<T> = Result<T, AgentDefinitionWatcherError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinitionEntry {
    pub event_id: String,
    pub author_pubkey: String,
    pub agent_pubkey: String,
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    pub created_at: u64,
    pub last_observed_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinitionSnapshot {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub updated_at: u64,
    pub definitions: Vec<AgentDefinitionEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinitionWatcherDiagnostics {
    pub schema_version: u32,
    pub inspected_at: u64,
    pub present: bool,
    pub total_definitions: usize,
    pub total_agent_pubkeys: usize,
    pub total_author_pubkeys: usize,
    pub oldest_observed_at: Option<u64>,
    pub latest_observed_at: Option<u64>,
    pub oldest_created_at: Option<u64>,
    pub latest_created_at: Option<u64>,
    pub snapshot_schema_version: Option<u32>,
    pub writer: Option<String>,
    pub writer_version: Option<String>,
    pub updated_at: Option<u64>,
}

pub fn agent_definitions_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(AGENT_DEFINITIONS_FILE_NAME)
}

pub fn write_agent_definitions(
    daemon_dir: impl AsRef<Path>,
    snapshot: &AgentDefinitionSnapshot,
) -> AgentDefinitionWatcherResult<AgentDefinitionSnapshot> {
    validate_writer_fields(snapshot)?;

    let mut normalized = snapshot.clone();
    normalized.schema_version = AGENT_DEFINITION_WATCHER_SCHEMA_VERSION;
    normalize_entries(&mut normalized.definitions)?;

    let daemon_dir = daemon_dir.as_ref();
    fs::create_dir_all(daemon_dir)?;

    let target_path = agent_definitions_path(daemon_dir);
    let tmp_path = daemon_dir.join(format!(
        "{}.tmp.{}.{}",
        AGENT_DEFINITIONS_FILE_NAME,
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

pub fn read_agent_definitions(
    daemon_dir: impl AsRef<Path>,
) -> AgentDefinitionWatcherResult<Option<AgentDefinitionSnapshot>> {
    let path = agent_definitions_path(daemon_dir);
    match fs::read_to_string(&path) {
        Ok(content) => {
            let snapshot: AgentDefinitionSnapshot = serde_json::from_str(&content)?;
            if snapshot.schema_version != AGENT_DEFINITION_WATCHER_SCHEMA_VERSION {
                return Err(AgentDefinitionWatcherError::UnsupportedSchemaVersion {
                    found: snapshot.schema_version,
                    expected: AGENT_DEFINITION_WATCHER_SCHEMA_VERSION,
                });
            }
            for entry in &snapshot.definitions {
                validate_entry(entry)?;
            }
            Ok(Some(snapshot))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn inspect_agent_definitions(
    daemon_dir: impl AsRef<Path>,
    now: u64,
) -> AgentDefinitionWatcherResult<AgentDefinitionWatcherDiagnostics> {
    let snapshot = read_agent_definitions(daemon_dir)?;
    Ok(match snapshot {
        Some(snapshot) => {
            let total_agent_pubkeys = snapshot
                .definitions
                .iter()
                .map(|entry| entry.agent_pubkey.as_str())
                .collect::<HashSet<_>>()
                .len();
            let total_author_pubkeys = snapshot
                .definitions
                .iter()
                .map(|entry| entry.author_pubkey.as_str())
                .collect::<HashSet<_>>()
                .len();
            let oldest_observed_at = snapshot
                .definitions
                .iter()
                .map(|entry| entry.last_observed_at)
                .min();
            let latest_observed_at = snapshot
                .definitions
                .iter()
                .map(|entry| entry.last_observed_at)
                .max();
            let oldest_created_at = snapshot
                .definitions
                .iter()
                .map(|entry| entry.created_at)
                .min();
            let latest_created_at = snapshot
                .definitions
                .iter()
                .map(|entry| entry.created_at)
                .max();
            AgentDefinitionWatcherDiagnostics {
                schema_version: AGENT_DEFINITION_WATCHER_DIAGNOSTICS_SCHEMA_VERSION,
                inspected_at: now,
                present: true,
                total_definitions: snapshot.definitions.len(),
                total_agent_pubkeys,
                total_author_pubkeys,
                oldest_observed_at,
                latest_observed_at,
                oldest_created_at,
                latest_created_at,
                snapshot_schema_version: Some(snapshot.schema_version),
                writer: Some(snapshot.writer),
                writer_version: Some(snapshot.writer_version),
                updated_at: Some(snapshot.updated_at),
            }
        }
        None => AgentDefinitionWatcherDiagnostics {
            schema_version: AGENT_DEFINITION_WATCHER_DIAGNOSTICS_SCHEMA_VERSION,
            inspected_at: now,
            present: false,
            total_definitions: 0,
            total_agent_pubkeys: 0,
            total_author_pubkeys: 0,
            oldest_observed_at: None,
            latest_observed_at: None,
            oldest_created_at: None,
            latest_created_at: None,
            snapshot_schema_version: None,
            writer: None,
            writer_version: None,
            updated_at: None,
        },
    })
}

fn validate_writer_fields(
    snapshot: &AgentDefinitionSnapshot,
) -> AgentDefinitionWatcherResult<()> {
    if snapshot.writer.is_empty() {
        return Err(AgentDefinitionWatcherError::MissingWriter);
    }
    if snapshot.writer_version.is_empty() {
        return Err(AgentDefinitionWatcherError::MissingWriterVersion);
    }
    if snapshot.updated_at == 0 {
        return Err(AgentDefinitionWatcherError::InvalidUpdatedAt);
    }
    Ok(())
}

fn normalize_entries(
    entries: &mut [AgentDefinitionEntry],
) -> AgentDefinitionWatcherResult<()> {
    let mut seen_event_ids: HashSet<String> = HashSet::with_capacity(entries.len());
    let mut seen_agent_slugs: HashSet<(String, String)> = HashSet::with_capacity(entries.len());

    for entry in entries.iter_mut() {
        validate_entry(entry)?;

        if !seen_event_ids.insert(entry.event_id.clone()) {
            return Err(AgentDefinitionWatcherError::DuplicateEventId {
                event_id: entry.event_id.clone(),
            });
        }
        let key = (entry.agent_pubkey.clone(), entry.slug.clone());
        if !seen_agent_slugs.insert(key) {
            return Err(AgentDefinitionWatcherError::DuplicateAgentSlug {
                agent_pubkey: entry.agent_pubkey.clone(),
                slug: entry.slug.clone(),
            });
        }

        entry.tools.sort();
        entry.tools.dedup();
        entry.skills.sort();
        entry.skills.dedup();
        entry.mcp_servers.sort();
        entry.mcp_servers.dedup();
    }

    entries.sort_by(|left, right| {
        left.agent_pubkey
            .cmp(&right.agent_pubkey)
            .then_with(|| left.slug.cmp(&right.slug))
    });

    Ok(())
}

fn validate_entry(entry: &AgentDefinitionEntry) -> AgentDefinitionWatcherResult<()> {
    if !is_valid_event_id_hex(&entry.event_id) {
        return Err(AgentDefinitionWatcherError::InvalidEventId {
            event_id: entry.event_id.clone(),
        });
    }
    if XOnlyPublicKey::from_str(&entry.author_pubkey).is_err() {
        return Err(AgentDefinitionWatcherError::InvalidAuthorPubkey {
            event_id: entry.event_id.clone(),
            pubkey: entry.author_pubkey.clone(),
        });
    }
    if XOnlyPublicKey::from_str(&entry.agent_pubkey).is_err() {
        return Err(AgentDefinitionWatcherError::InvalidAgentPubkey {
            event_id: entry.event_id.clone(),
            pubkey: entry.agent_pubkey.clone(),
        });
    }
    if entry.slug.is_empty() {
        return Err(AgentDefinitionWatcherError::EmptySlug {
            event_id: entry.event_id.clone(),
        });
    }
    if entry.created_at == 0 {
        return Err(AgentDefinitionWatcherError::InvalidCreatedAt {
            event_id: entry.event_id.clone(),
        });
    }
    if entry.last_observed_at == 0 {
        return Err(AgentDefinitionWatcherError::InvalidLastObservedAt {
            event_id: entry.event_id.clone(),
        });
    }
    Ok(())
}

fn is_valid_event_id_hex(candidate: &str) -> bool {
    candidate.len() == EVENT_ID_HEX_LENGTH
        && candidate
            .chars()
            .all(|character| matches!(character, '0'..='9' | 'a'..='f'))
}

fn write_snapshot_file(
    path: &Path,
    snapshot: &AgentDefinitionSnapshot,
) -> AgentDefinitionWatcherResult<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer_pretty(&mut file, snapshot)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn sync_parent_dir(path: &Path) -> AgentDefinitionWatcherResult<()> {
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
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-agent-definition-watcher-{}-{counter}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }

    fn full_hex(byte: u8) -> String {
        format!("{byte:02x}").repeat(32)
    }

    fn xonly_hex_from_seed(fill_byte: u8) -> String {
        let secp = Secp256k1::new();
        let secret = SecretKey::from_byte_array([fill_byte; 32]).expect("valid secret");
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn sample_entry(agent_byte: u8, slug: &str, created_at: u64) -> AgentDefinitionEntry {
        AgentDefinitionEntry {
            event_id: full_hex(agent_byte ^ 0x01),
            author_pubkey: xonly_hex_from_seed(agent_byte ^ 0x40),
            agent_pubkey: xonly_hex_from_seed(agent_byte),
            slug: slug.to_string(),
            name: Some(format!("Agent {agent_byte:02x}")),
            description: Some("An agent".to_string()),
            instructions: Some("Be helpful".to_string()),
            tools: Vec::new(),
            skills: Vec::new(),
            mcp_servers: Vec::new(),
            created_at,
            last_observed_at: created_at + 10,
        }
    }

    fn sample_snapshot(
        updated_at: u64,
        definitions: Vec<AgentDefinitionEntry>,
    ) -> AgentDefinitionSnapshot {
        AgentDefinitionSnapshot {
            schema_version: AGENT_DEFINITION_WATCHER_SCHEMA_VERSION,
            writer: AGENT_DEFINITION_WATCHER_WRITER.to_string(),
            writer_version: "test-version".to_string(),
            updated_at,
            definitions,
        }
    }

    #[test]
    fn rejects_malformed_event_id_on_write() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut entry = sample_entry(0x11, "primary", 1_710_000_000_010);
        entry.event_id = "ZZ".to_string();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![entry.clone()]);

        let error = write_agent_definitions(&daemon_dir, &snapshot)
            .expect_err("invalid eventId must fail");

        assert!(matches!(
            error,
            AgentDefinitionWatcherError::InvalidEventId { event_id } if event_id == entry.event_id
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_malformed_author_pubkey_on_write() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut entry = sample_entry(0x11, "primary", 1_710_000_000_010);
        entry.author_pubkey = "not-a-pubkey".to_string();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![entry]);

        let error = write_agent_definitions(&daemon_dir, &snapshot)
            .expect_err("invalid authorPubkey must fail");

        assert!(matches!(
            error,
            AgentDefinitionWatcherError::InvalidAuthorPubkey { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_malformed_agent_pubkey_on_write() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut entry = sample_entry(0x11, "primary", 1_710_000_000_010);
        let base = xonly_hex_from_seed(0x11);
        entry.agent_pubkey = format!("{}ZZ", &base[..62]);
        let snapshot = sample_snapshot(1_710_000_000_100, vec![entry]);

        let error = write_agent_definitions(&daemon_dir, &snapshot)
            .expect_err("invalid agentPubkey must fail");

        assert!(matches!(
            error,
            AgentDefinitionWatcherError::InvalidAgentPubkey { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_empty_slug_on_write() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut entry = sample_entry(0x11, "primary", 1_710_000_000_010);
        entry.slug = String::new();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![entry]);

        let error = write_agent_definitions(&daemon_dir, &snapshot)
            .expect_err("empty slug must fail");

        assert!(matches!(error, AgentDefinitionWatcherError::EmptySlug { .. }));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_zero_created_at_on_write() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut entry = sample_entry(0x11, "primary", 1_710_000_000_010);
        entry.created_at = 0;
        let snapshot = sample_snapshot(1_710_000_000_100, vec![entry]);

        let error = write_agent_definitions(&daemon_dir, &snapshot)
            .expect_err("zero createdAt must fail");

        assert!(matches!(
            error,
            AgentDefinitionWatcherError::InvalidCreatedAt { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_zero_last_observed_at_on_write() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut entry = sample_entry(0x11, "primary", 1_710_000_000_010);
        entry.last_observed_at = 0;
        let snapshot = sample_snapshot(1_710_000_000_100, vec![entry]);

        let error = write_agent_definitions(&daemon_dir, &snapshot)
            .expect_err("zero lastObservedAt must fail");

        assert!(matches!(
            error,
            AgentDefinitionWatcherError::InvalidLastObservedAt { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_zero_updated_at_on_write() {
        let daemon_dir = unique_temp_daemon_dir();
        let entry = sample_entry(0x11, "primary", 1_710_000_000_010);
        let snapshot = sample_snapshot(0, vec![entry]);

        let error =
            write_agent_definitions(&daemon_dir, &snapshot).expect_err("zero updatedAt must fail");

        assert!(matches!(error, AgentDefinitionWatcherError::InvalidUpdatedAt));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_missing_writer() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(0x11, "primary", 1_710_000_000_010)],
        );
        snapshot.writer.clear();

        let error =
            write_agent_definitions(&daemon_dir, &snapshot).expect_err("missing writer must fail");

        assert!(matches!(error, AgentDefinitionWatcherError::MissingWriter));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_missing_writer_version() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(0x11, "primary", 1_710_000_000_010)],
        );
        snapshot.writer_version.clear();

        let error = write_agent_definitions(&daemon_dir, &snapshot)
            .expect_err("missing writerVersion must fail");

        assert!(matches!(
            error,
            AgentDefinitionWatcherError::MissingWriterVersion
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_duplicate_agent_slug_pair() {
        let daemon_dir = unique_temp_daemon_dir();
        let first = sample_entry(0x11, "primary", 1_710_000_000_010);
        let mut second = sample_entry(0x11, "primary", 1_710_000_000_020);
        second.event_id = full_hex(0x99);
        let snapshot = sample_snapshot(1_710_000_000_100, vec![first, second]);

        let error = write_agent_definitions(&daemon_dir, &snapshot)
            .expect_err("duplicate (agentPubkey, slug) must fail");

        assert!(matches!(
            error,
            AgentDefinitionWatcherError::DuplicateAgentSlug { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn rejects_duplicate_event_id() {
        let daemon_dir = unique_temp_daemon_dir();
        let first = sample_entry(0x11, "primary", 1_710_000_000_010);
        let mut second = sample_entry(0x22, "secondary", 1_710_000_000_020);
        second.event_id = first.event_id.clone();
        let snapshot = sample_snapshot(1_710_000_000_100, vec![first, second]);

        let error = write_agent_definitions(&daemon_dir, &snapshot)
            .expect_err("duplicate eventId must fail");

        assert!(matches!(
            error,
            AgentDefinitionWatcherError::DuplicateEventId { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn write_sorts_entry_sublists_and_dedupes() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut entry = sample_entry(0x11, "primary", 1_710_000_000_010);
        entry.tools = vec![
            "zeta".to_string(),
            "alpha".to_string(),
            "alpha".to_string(),
        ];
        entry.skills = vec![full_hex(0xbb), full_hex(0xaa), full_hex(0xbb)];
        entry.mcp_servers = vec!["mcp-b".to_string(), "mcp-a".to_string()];
        let snapshot = sample_snapshot(1_710_000_000_100, vec![entry]);

        let written =
            write_agent_definitions(&daemon_dir, &snapshot).expect("write must succeed");

        assert_eq!(written.definitions[0].tools, vec!["alpha", "zeta"]);
        assert_eq!(
            written.definitions[0].skills,
            vec![full_hex(0xaa), full_hex(0xbb)]
        );
        assert_eq!(
            written.definitions[0].mcp_servers,
            vec!["mcp-a".to_string(), "mcp-b".to_string()]
        );

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn write_sorts_definitions_by_agent_pubkey_then_slug() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut left = sample_entry(0x33, "beta", 1_710_000_000_010);
        let mut middle = sample_entry(0x33, "alpha", 1_710_000_000_020);
        let right = sample_entry(0x22, "omega", 1_710_000_000_030);
        left.event_id = full_hex(0xaa);
        middle.event_id = full_hex(0xbb);
        let snapshot = sample_snapshot(1_710_000_000_100, vec![left, middle, right]);

        let written =
            write_agent_definitions(&daemon_dir, &snapshot).expect("write must succeed");

        let observed: Vec<(String, String)> = written
            .definitions
            .iter()
            .map(|entry| (entry.agent_pubkey.clone(), entry.slug.clone()))
            .collect();

        let mut expected = observed.clone();
        expected.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));

        assert_eq!(observed, expected);
        assert_eq!(observed.len(), 3);
        assert!(
            observed
                .iter()
                .any(|(pubkey, slug)| pubkey == &xonly_hex_from_seed(0x33) && slug == "alpha")
        );

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn atomic_write_leaves_no_stray_tmp_file() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(0x11, "primary", 1_710_000_000_010)],
        );

        write_agent_definitions(&daemon_dir, &snapshot).expect("write must succeed");

        let remaining: Vec<_> = fs::read_dir(&daemon_dir)
            .expect("daemon dir must exist after write")
            .collect::<Result<_, _>>()
            .expect("entries must iterate");
        for entry in &remaining {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            assert!(
                !name_str.starts_with(&format!("{AGENT_DEFINITIONS_FILE_NAME}.tmp.")),
                "stray tmp file present: {name_str}"
            );
        }

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn round_trip_returns_identical_snapshot_after_canonical_sort() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut entry_alpha = sample_entry(0x11, "alpha", 1_710_000_000_010);
        entry_alpha.tools = vec!["zeta".to_string(), "alpha".to_string()];
        let mut entry_beta = sample_entry(0x22, "beta", 1_710_000_000_020);
        entry_beta.skills = vec![full_hex(0xbb), full_hex(0xaa)];
        let snapshot = sample_snapshot(1_710_000_000_100, vec![entry_alpha, entry_beta]);

        let written =
            write_agent_definitions(&daemon_dir, &snapshot).expect("write must succeed");
        let read_back = read_agent_definitions(&daemon_dir)
            .expect("read must succeed")
            .expect("snapshot must exist");

        assert_eq!(read_back, written);

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn read_returns_none_when_file_missing() {
        let daemon_dir = unique_temp_daemon_dir();

        let result = read_agent_definitions(&daemon_dir).expect("read must succeed");

        assert!(result.is_none());

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn schema_version_mismatch_fails_closed_on_read() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(0x11, "primary", 1_710_000_000_010)],
        );
        write_agent_definitions(&daemon_dir, &snapshot).expect("initial write must succeed");

        let path = agent_definitions_path(&daemon_dir);
        let mut value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        value["schemaVersion"] = serde_json::json!(999);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        let error =
            read_agent_definitions(&daemon_dir).expect_err("bad schema must fail read");

        assert!(matches!(
            error,
            AgentDefinitionWatcherError::UnsupportedSchemaVersion {
                found: 999,
                expected: AGENT_DEFINITION_WATCHER_SCHEMA_VERSION
            }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn truncated_json_fails_closed_on_read() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(0x11, "primary", 1_710_000_000_010)],
        );
        write_agent_definitions(&daemon_dir, &snapshot).expect("initial write must succeed");

        let path = agent_definitions_path(&daemon_dir);
        fs::write(&path, b"{\"schemaVersion\":1,\"writer\":").unwrap();

        let error = read_agent_definitions(&daemon_dir)
            .expect_err("truncated JSON must fail read");

        assert!(matches!(error, AgentDefinitionWatcherError::Json(_)));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn read_rejects_corrupt_entry_in_persisted_snapshot() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(0x11, "primary", 1_710_000_000_010)],
        );
        write_agent_definitions(&daemon_dir, &snapshot).expect("initial write must succeed");

        let path = agent_definitions_path(&daemon_dir);
        let mut value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        value["definitions"][0]["eventId"] = serde_json::json!("not-hex");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        let error =
            read_agent_definitions(&daemon_dir).expect_err("corrupt eventId must fail read");

        assert!(matches!(
            error,
            AgentDefinitionWatcherError::InvalidEventId { .. }
        ));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn two_sequential_writes_are_idempotent() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(0x11, "primary", 1_710_000_000_010)],
        );

        let first_write =
            write_agent_definitions(&daemon_dir, &snapshot).expect("first write must succeed");
        let second_write =
            write_agent_definitions(&daemon_dir, &snapshot).expect("second write must succeed");

        assert_eq!(first_write, second_write);

        let read_back = read_agent_definitions(&daemon_dir)
            .expect("read must succeed")
            .expect("snapshot must exist");
        assert_eq!(read_back, second_write);

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn diagnostics_reflect_missing_file() {
        let daemon_dir = unique_temp_daemon_dir();

        let diagnostics = inspect_agent_definitions(&daemon_dir, 1_710_000_000_900)
            .expect("inspect must succeed");

        assert_eq!(
            diagnostics.schema_version,
            AGENT_DEFINITION_WATCHER_DIAGNOSTICS_SCHEMA_VERSION
        );
        assert_eq!(diagnostics.inspected_at, 1_710_000_000_900);
        assert!(!diagnostics.present);
        assert_eq!(diagnostics.total_definitions, 0);
        assert_eq!(diagnostics.total_agent_pubkeys, 0);
        assert_eq!(diagnostics.total_author_pubkeys, 0);
        assert_eq!(diagnostics.oldest_observed_at, None);
        assert_eq!(diagnostics.latest_observed_at, None);
        assert_eq!(diagnostics.oldest_created_at, None);
        assert_eq!(diagnostics.latest_created_at, None);
        assert_eq!(diagnostics.snapshot_schema_version, None);
        assert_eq!(diagnostics.writer, None);
        assert_eq!(diagnostics.writer_version, None);
        assert_eq!(diagnostics.updated_at, None);

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn diagnostics_count_unique_pubkeys_and_observed_ranges() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut shared_author = sample_entry(0x11, "primary", 1_710_000_000_010);
        let mut other_author = sample_entry(0x22, "secondary", 1_710_000_000_050);
        shared_author.author_pubkey = xonly_hex_from_seed(0xcc);
        other_author.author_pubkey = xonly_hex_from_seed(0xcc);
        shared_author.last_observed_at = 1_710_000_000_020;
        other_author.last_observed_at = 1_710_000_000_060;
        let snapshot = sample_snapshot(
            1_710_000_000_500,
            vec![shared_author, other_author],
        );
        write_agent_definitions(&daemon_dir, &snapshot).expect("write must succeed");

        let diagnostics = inspect_agent_definitions(&daemon_dir, 1_710_000_001_000)
            .expect("inspect must succeed");

        assert!(diagnostics.present);
        assert_eq!(diagnostics.total_definitions, 2);
        assert_eq!(diagnostics.total_agent_pubkeys, 2);
        assert_eq!(diagnostics.total_author_pubkeys, 1);
        assert_eq!(diagnostics.oldest_observed_at, Some(1_710_000_000_020));
        assert_eq!(diagnostics.latest_observed_at, Some(1_710_000_000_060));
        assert_eq!(diagnostics.oldest_created_at, Some(1_710_000_000_010));
        assert_eq!(diagnostics.latest_created_at, Some(1_710_000_000_050));
        assert_eq!(
            diagnostics.snapshot_schema_version,
            Some(AGENT_DEFINITION_WATCHER_SCHEMA_VERSION)
        );
        assert_eq!(
            diagnostics.writer.as_deref(),
            Some(AGENT_DEFINITION_WATCHER_WRITER)
        );
        assert_eq!(diagnostics.writer_version.as_deref(), Some("test-version"));
        assert_eq!(diagnostics.updated_at, Some(1_710_000_000_500));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }

    #[test]
    fn written_snapshot_carries_required_fields() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot = sample_snapshot(
            1_710_000_000_100,
            vec![sample_entry(0x11, "primary", 1_710_000_000_010)],
        );

        write_agent_definitions(&daemon_dir, &snapshot).expect("write must succeed");

        let raw = fs::read_to_string(agent_definitions_path(&daemon_dir))
            .expect("read must succeed");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("JSON must parse");
        assert_eq!(
            value["schemaVersion"],
            serde_json::json!(AGENT_DEFINITION_WATCHER_SCHEMA_VERSION)
        );
        assert_eq!(
            value["writer"],
            serde_json::json!(AGENT_DEFINITION_WATCHER_WRITER)
        );
        assert_eq!(value["writerVersion"], serde_json::json!("test-version"));
        assert_eq!(value["updatedAt"], serde_json::json!(1_710_000_000_100u64));

        fs::remove_dir_all(daemon_dir).expect("cleanup must succeed");
    }
}
