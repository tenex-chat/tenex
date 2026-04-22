use std::io;
use std::path::{Path, PathBuf};

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
