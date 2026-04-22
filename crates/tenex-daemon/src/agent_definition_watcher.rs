use std::io;
use std::path::{Path, PathBuf};

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
