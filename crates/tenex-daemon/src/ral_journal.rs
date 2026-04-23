use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const RAL_DIR_NAME: &str = "ral";
pub const RAL_JOURNAL_FILE_NAME: &str = "journal.jsonl";
pub const RAL_JOURNAL_LOCK_FILE_NAME: &str = "journal.lock";
pub const RAL_SNAPSHOT_FILE_NAME: &str = "snapshot.json";
pub const RAL_JOURNAL_RECORD_SCHEMA_VERSION: u32 = 1;
pub const RAL_SNAPSHOT_SCHEMA_VERSION: u32 = 1;
pub const RAL_JOURNAL_WRITER_RUST_DAEMON: &str = "rust-daemon";

static RAL_JOURNAL_APPEND_MUTEX: Mutex<()> = Mutex::new(());

#[derive(Debug, Error)]
pub enum RalJournalError {
    #[error("RAL journal io error: {0}")]
    Io(#[from] io::Error),
    #[error("RAL journal json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("RAL journal json error at {path}:{line}: {source}")]
    JsonLine {
        path: PathBuf,
        line: usize,
        #[source]
        source: serde_json::Error,
    },
    #[error(
        "RAL journal sequence {sequence} is not greater than previous sequence {previous_sequence}"
    )]
    NonIncreasingSequence {
        sequence: u64,
        previous_sequence: u64,
    },
    #[error(
        "RAL snapshot schema version {schema_version} is unsupported; supported version is {supported_schema_version}"
    )]
    UnsupportedSnapshotSchema {
        schema_version: u32,
        supported_schema_version: u32,
    },
}

pub type RalJournalResult<T> = Result<T, RalJournalError>;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RalJournalIdentity {
    pub project_id: String,
    pub agent_pubkey: String,
    pub conversation_id: String,
    pub ral_number: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RalDelegationType {
    Standard,
    Followup,
    External,
    Ask,
}

fn default_delegation_type() -> RalDelegationType {
    RalDelegationType::Standard
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RalPendingSubDelegationRef {
    pub delegation_conversation_id: String,
    #[serde(rename = "type", default = "default_delegation_type")]
    pub delegation_type: RalDelegationType,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RalDelegationMessage {
    pub sender_pubkey: String,
    pub recipient_pubkey: String,
    pub content: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RalDeferredCompletion {
    pub recipient_pubkey: String,
    pub response: String,
    pub completed_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_transcript: Option<Vec<RalDelegationMessage>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RalCompletedDelegation {
    pub delegation_conversation_id: String,
    pub sender_pubkey: String,
    pub recipient_pubkey: String,
    pub response: String,
    pub completed_at: u64,
    pub completion_event_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_transcript: Option<Vec<RalDelegationMessage>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RalPendingDelegation {
    pub delegation_conversation_id: String,
    pub recipient_pubkey: String,
    pub sender_pubkey: String,
    pub prompt: String,
    #[serde(rename = "type", default = "default_delegation_type")]
    pub delegation_type: RalDelegationType,
    pub ral_number: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_delegation_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_sub_delegations: Option<Vec<RalPendingSubDelegationRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred_completion: Option<RalDeferredCompletion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub followup_event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub killed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub killed_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RalWorkerError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RalTerminalSummary {
    pub published_user_visible_event: bool,
    pub pending_delegations_remain: bool,
    pub accumulated_runtime_ms: u64,
    pub final_event_ids: Vec<String>,
    pub keep_worker_warm: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum RalJournalEvent {
    Allocated {
        #[serde(flatten)]
        identity: RalJournalIdentity,
        #[serde(
            rename = "triggeringEventId",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        triggering_event_id: Option<String>,
    },
    Claimed {
        #[serde(flatten)]
        identity: RalJournalIdentity,
        #[serde(rename = "workerId")]
        worker_id: String,
        #[serde(rename = "claimToken")]
        claim_token: String,
    },
    DelegationRegistered {
        #[serde(flatten)]
        identity: RalJournalIdentity,
        #[serde(rename = "workerId")]
        worker_id: String,
        #[serde(rename = "claimToken")]
        claim_token: String,
        #[serde(rename = "pendingDelegation")]
        pending_delegation: RalPendingDelegation,
    },
    WaitingForDelegation {
        #[serde(flatten)]
        identity: RalJournalIdentity,
        #[serde(rename = "workerId")]
        worker_id: String,
        #[serde(rename = "claimToken")]
        claim_token: String,
        #[serde(rename = "pendingDelegations")]
        pending_delegations: Vec<RalPendingDelegation>,
        #[serde(flatten)]
        terminal: RalTerminalSummary,
    },
    DelegationCompleted {
        #[serde(flatten)]
        identity: RalJournalIdentity,
        completion: RalCompletedDelegation,
    },
    Completed {
        #[serde(flatten)]
        identity: RalJournalIdentity,
        #[serde(rename = "workerId")]
        worker_id: String,
        #[serde(rename = "claimToken")]
        claim_token: String,
        #[serde(flatten)]
        terminal: RalTerminalSummary,
    },
    NoResponse {
        #[serde(flatten)]
        identity: RalJournalIdentity,
        #[serde(rename = "workerId")]
        worker_id: String,
        #[serde(rename = "claimToken")]
        claim_token: String,
        #[serde(flatten)]
        terminal: RalTerminalSummary,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(flatten)]
        identity: RalJournalIdentity,
        #[serde(rename = "workerId")]
        worker_id: String,
        #[serde(rename = "claimToken")]
        claim_token: String,
        error: RalWorkerError,
        #[serde(flatten)]
        terminal: RalTerminalSummary,
    },
    Aborted {
        #[serde(flatten)]
        identity: RalJournalIdentity,
        #[serde(rename = "workerId", default, skip_serializing_if = "Option::is_none")]
        worker_id: Option<String>,
        #[serde(
            rename = "claimToken",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        claim_token: Option<String>,
        #[serde(rename = "abortReason")]
        abort_reason: String,
        #[serde(flatten)]
        terminal: RalTerminalSummary,
    },
    Crashed {
        #[serde(flatten)]
        identity: RalJournalIdentity,
        #[serde(rename = "workerId")]
        worker_id: String,
        #[serde(
            rename = "claimToken",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        claim_token: Option<String>,
        #[serde(rename = "crashReason")]
        crash_reason: String,
        #[serde(
            rename = "lastHeartbeatAt",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        last_heartbeat_at: Option<u64>,
    },
}

impl RalJournalEvent {
    pub fn identity(&self) -> &RalJournalIdentity {
        match self {
            Self::Allocated { identity, .. }
            | Self::Claimed { identity, .. }
            | Self::DelegationRegistered { identity, .. }
            | Self::WaitingForDelegation { identity, .. }
            | Self::DelegationCompleted { identity, .. }
            | Self::Completed { identity, .. }
            | Self::NoResponse { identity, .. }
            | Self::Error { identity, .. }
            | Self::Aborted { identity, .. }
            | Self::Crashed { identity, .. } => identity,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RalJournalRecord {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    #[serde(flatten)]
    pub event: RalJournalEvent,
}

impl RalJournalRecord {
    pub fn new(
        writer: impl Into<String>,
        writer_version: impl Into<String>,
        sequence: u64,
        timestamp: u64,
        correlation_id: impl Into<String>,
        event: RalJournalEvent,
    ) -> Self {
        Self {
            schema_version: RAL_JOURNAL_RECORD_SCHEMA_VERSION,
            writer: writer.into(),
            writer_version: writer_version.into(),
            sequence,
            timestamp,
            correlation_id: correlation_id.into(),
            event,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RalReplayStatus {
    Allocated,
    Claimed,
    WaitingForDelegation,
    Completed,
    NoResponse,
    Error,
    Aborted,
    Crashed,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct RalReplayEntry {
    pub identity: RalJournalIdentity,
    pub status: RalReplayStatus,
    pub last_sequence: u64,
    pub updated_at: u64,
    pub last_correlation_id: String,
    pub worker_id: Option<String>,
    pub active_claim_token: Option<String>,
    #[serde(default)]
    pub pending_delegations: Vec<RalPendingDelegation>,
    #[serde(default)]
    pub completed_delegations: Vec<RalCompletedDelegation>,
    pub triggering_event_id: Option<String>,
    pub final_event_ids: Vec<String>,
    pub accumulated_runtime_ms: u64,
    pub error: Option<RalWorkerError>,
    pub abort_reason: Option<String>,
    pub crash_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalJournalReplay {
    pub last_sequence: u64,
    pub states: HashMap<RalJournalIdentity, RalReplayEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RalDelegationSnapshot {
    #[serde(default)]
    pub pending_delegations: Vec<RalPendingDelegation>,
    #[serde(default)]
    pub completed_delegations: Vec<RalCompletedDelegation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RalJournalSnapshot {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub created_at: u64,
    pub last_sequence: u64,
    pub states: Vec<RalReplayEntry>,
}

impl RalJournalSnapshot {
    pub fn from_replay(
        writer: impl Into<String>,
        writer_version: impl Into<String>,
        created_at: u64,
        replay: &RalJournalReplay,
    ) -> Self {
        let mut states = replay.states.values().cloned().collect::<Vec<_>>();
        states.sort_by(|left, right| {
            left.identity
                .project_id
                .cmp(&right.identity.project_id)
                .then_with(|| left.identity.agent_pubkey.cmp(&right.identity.agent_pubkey))
                .then_with(|| {
                    left.identity
                        .conversation_id
                        .cmp(&right.identity.conversation_id)
                })
                .then_with(|| left.identity.ral_number.cmp(&right.identity.ral_number))
        });

        Self {
            schema_version: RAL_SNAPSHOT_SCHEMA_VERSION,
            writer: writer.into(),
            writer_version: writer_version.into(),
            created_at,
            last_sequence: replay.last_sequence,
            states,
        }
    }

    pub fn into_replay(self) -> RalJournalReplay {
        RalJournalReplay {
            last_sequence: self.last_sequence,
            states: self
                .states
                .into_iter()
                .map(|entry| (entry.identity.clone(), entry))
                .collect(),
        }
    }
}

pub fn ral_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(RAL_DIR_NAME)
}

pub fn ral_journal_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    ral_dir(daemon_dir).join(RAL_JOURNAL_FILE_NAME)
}

fn ral_journal_lock_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    ral_dir(daemon_dir).join(RAL_JOURNAL_LOCK_FILE_NAME)
}

pub fn ral_snapshot_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    ral_dir(daemon_dir).join(RAL_SNAPSHOT_FILE_NAME)
}

struct RalJournalAppendLock {
    _process_guard: MutexGuard<'static, ()>,
    _lock_file: File,
}

fn acquire_ral_journal_append_lock(
    daemon_dir: impl AsRef<Path>,
) -> RalJournalResult<RalJournalAppendLock> {
    let process_guard = RAL_JOURNAL_APPEND_MUTEX
        .lock()
        .map_err(|_| io::Error::other("RAL journal append mutex poisoned"))?;

    let lock_path = ral_journal_lock_path(daemon_dir);
    let lock_dir = lock_path
        .parent()
        .expect("RAL journal lock path must have a parent directory");
    fs::create_dir_all(lock_dir)?;

    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)?;
    let ret = unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX) };
    if ret != 0 {
        return Err(io::Error::last_os_error().into());
    }

    Ok(RalJournalAppendLock {
        _process_guard: process_guard,
        _lock_file: lock_file,
    })
}

pub fn append_ral_journal_record(
    daemon_dir: impl AsRef<Path>,
    record: &RalJournalRecord,
) -> RalJournalResult<()> {
    let daemon_dir = daemon_dir.as_ref();
    let _append_lock = acquire_ral_journal_append_lock(daemon_dir)?;
    let journal_path = ral_journal_path(daemon_dir);
    let journal_dir = journal_path
        .parent()
        .expect("RAL journal path must have a parent directory");
    fs::create_dir_all(journal_dir)?;

    let mut line = serde_json::to_vec(record)?;
    line.push(b'\n');

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&journal_path)?;
    file.write_all(&line)?;
    file.sync_all()?;
    sync_parent_dir(&journal_path)?;

    Ok(())
}

pub fn read_ral_journal_records(
    daemon_dir: impl AsRef<Path>,
) -> RalJournalResult<Vec<RalJournalRecord>> {
    read_ral_journal_records_from_path(ral_journal_path(daemon_dir))
}

pub fn read_ral_journal_records_from_path(
    path: impl AsRef<Path>,
) -> RalJournalResult<Vec<RalJournalRecord>> {
    let path = path.as_ref();
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };

    let ends_with_newline = content.ends_with('\n');
    let line_count = content.lines().count();
    let mut records = Vec::with_capacity(line_count);

    for (line_index, line) in content.lines().enumerate() {
        let line_number = line_index + 1;
        let is_final_unterminated_line = !ends_with_newline && line_number == line_count;
        match serde_json::from_str::<RalJournalRecord>(line) {
            Ok(record) => records.push(record),
            Err(source) if is_final_unterminated_line && source.is_eof() => break,
            Err(source) => {
                return Err(RalJournalError::JsonLine {
                    path: path.to_path_buf(),
                    line: line_number,
                    source,
                });
            }
        }
    }

    Ok(records)
}

pub fn replay_ral_journal(daemon_dir: impl AsRef<Path>) -> RalJournalResult<RalJournalReplay> {
    replay_ral_journal_records(read_ral_journal_records(daemon_dir)?)
}

pub fn read_ral_snapshot(
    daemon_dir: impl AsRef<Path>,
) -> RalJournalResult<Option<RalJournalSnapshot>> {
    let path = ral_snapshot_path(daemon_dir);
    match fs::read_to_string(&path) {
        Ok(content) => {
            let snapshot = serde_json::from_str::<RalJournalSnapshot>(&content)?;
            if snapshot.schema_version != RAL_SNAPSHOT_SCHEMA_VERSION {
                return Err(RalJournalError::UnsupportedSnapshotSchema {
                    schema_version: snapshot.schema_version,
                    supported_schema_version: RAL_SNAPSHOT_SCHEMA_VERSION,
                });
            }
            Ok(Some(snapshot))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn write_ral_snapshot(
    daemon_dir: impl AsRef<Path>,
    snapshot: &RalJournalSnapshot,
) -> RalJournalResult<()> {
    let snapshot_path = ral_snapshot_path(daemon_dir);
    let snapshot_dir = snapshot_path
        .parent()
        .expect("RAL snapshot path must have a parent directory");
    fs::create_dir_all(snapshot_dir)?;

    let tmp_path = snapshot_path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        snapshot.last_sequence
    ));
    {
        let mut tmp_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        serde_json::to_writer_pretty(&mut tmp_file, snapshot)?;
        tmp_file.write_all(b"\n")?;
        tmp_file.sync_all()?;
    }

    fs::rename(&tmp_path, &snapshot_path)?;
    sync_parent_dir(&snapshot_path)?;
    Ok(())
}

pub fn replay_ral_journal_records<I>(records: I) -> RalJournalResult<RalJournalReplay>
where
    I: IntoIterator<Item = RalJournalRecord>,
{
    let mut last_sequence = 0;
    let mut states = HashMap::new();

    for record in records {
        apply_record(&mut states, &record);
        last_sequence = last_sequence.max(record.sequence);
    }

    Ok(RalJournalReplay {
        last_sequence,
        states,
    })
}

pub fn next_ral_journal_sequence(daemon_dir: impl AsRef<Path>) -> RalJournalResult<u64> {
    Ok(replay_ral_journal(daemon_dir)?
        .last_sequence
        .saturating_add(1))
}

fn apply_record(
    states: &mut HashMap<RalJournalIdentity, RalReplayEntry>,
    record: &RalJournalRecord,
) {
    let identity = record.event.identity().clone();
    let entry = states
        .entry(identity.clone())
        .or_insert_with(|| empty_replay_entry(identity.clone(), record));

    entry.identity = identity;
    entry.last_sequence = record.sequence;
    entry.updated_at = record.timestamp;
    entry.last_correlation_id = record.correlation_id.clone();

    match &record.event {
        RalJournalEvent::Allocated {
            triggering_event_id,
            ..
        } => {
            entry.status = RalReplayStatus::Allocated;
            entry.worker_id = None;
            entry.active_claim_token = None;
            entry.pending_delegations.clear();
            entry.triggering_event_id = triggering_event_id.clone();
            entry.final_event_ids.clear();
            entry.accumulated_runtime_ms = 0;
            entry.error = None;
            entry.abort_reason = None;
            entry.crash_reason = None;
        }
        RalJournalEvent::Claimed {
            worker_id,
            claim_token,
            ..
        } => {
            entry.status = RalReplayStatus::Claimed;
            entry.worker_id = Some(worker_id.clone());
            entry.active_claim_token = Some(claim_token.clone());
            entry.final_event_ids.clear();
            entry.error = None;
            entry.abort_reason = None;
            entry.crash_reason = None;
        }
        RalJournalEvent::DelegationRegistered {
            worker_id,
            claim_token,
            pending_delegation,
            ..
        } => {
            entry.worker_id = Some(worker_id.clone());
            entry.active_claim_token = Some(claim_token.clone());
            upsert_pending_delegation(entry, pending_delegation.clone());
            entry.error = None;
            entry.abort_reason = None;
            entry.crash_reason = None;
        }
        RalJournalEvent::WaitingForDelegation {
            worker_id,
            pending_delegations,
            terminal,
            ..
        } => {
            entry.status = RalReplayStatus::WaitingForDelegation;
            entry.worker_id = Some(worker_id.clone());
            entry.active_claim_token = None;
            entry.pending_delegations = pending_delegations.clone();
            entry.completed_delegations.clear();
            apply_terminal_summary(entry, terminal);
            entry.error = None;
            entry.abort_reason = None;
            entry.crash_reason = None;
        }
        RalJournalEvent::DelegationCompleted { completion, .. } => {
            apply_delegation_completion(entry, completion);
            entry.error = None;
            entry.abort_reason = None;
            entry.crash_reason = None;
        }
        RalJournalEvent::Completed {
            worker_id,
            terminal,
            ..
        } => {
            entry.status = RalReplayStatus::Completed;
            entry.worker_id = Some(worker_id.clone());
            entry.active_claim_token = None;
            entry.pending_delegations.clear();
            entry.completed_delegations.clear();
            apply_terminal_summary(entry, terminal);
            entry.error = None;
            entry.abort_reason = None;
            entry.crash_reason = None;
        }
        RalJournalEvent::NoResponse {
            worker_id,
            terminal,
            ..
        } => {
            entry.status = RalReplayStatus::NoResponse;
            entry.worker_id = Some(worker_id.clone());
            entry.active_claim_token = None;
            entry.pending_delegations.clear();
            entry.completed_delegations.clear();
            apply_terminal_summary(entry, terminal);
            entry.error = None;
            entry.abort_reason = None;
            entry.crash_reason = None;
        }
        RalJournalEvent::Error {
            worker_id,
            error,
            terminal,
            ..
        } => {
            entry.status = RalReplayStatus::Error;
            entry.worker_id = Some(worker_id.clone());
            entry.active_claim_token = None;
            entry.pending_delegations.clear();
            entry.completed_delegations.clear();
            apply_terminal_summary(entry, terminal);
            entry.error = Some(error.clone());
            entry.abort_reason = None;
            entry.crash_reason = None;
        }
        RalJournalEvent::Aborted {
            worker_id,
            abort_reason,
            terminal,
            ..
        } => {
            entry.status = RalReplayStatus::Aborted;
            entry.worker_id = worker_id.clone();
            entry.active_claim_token = None;
            entry.pending_delegations.clear();
            entry.completed_delegations.clear();
            apply_terminal_summary(entry, terminal);
            entry.error = None;
            entry.abort_reason = Some(abort_reason.clone());
            entry.crash_reason = None;
        }
        RalJournalEvent::Crashed {
            worker_id,
            crash_reason,
            ..
        } => {
            entry.status = RalReplayStatus::Crashed;
            entry.worker_id = Some(worker_id.clone());
            entry.active_claim_token = None;
            entry.pending_delegations.clear();
            entry.completed_delegations.clear();
            entry.final_event_ids.clear();
            entry.error = None;
            entry.abort_reason = None;
            entry.crash_reason = Some(crash_reason.clone());
        }
    }
}

fn empty_replay_entry(identity: RalJournalIdentity, record: &RalJournalRecord) -> RalReplayEntry {
    RalReplayEntry {
        identity,
        status: RalReplayStatus::Allocated,
        last_sequence: record.sequence,
        updated_at: record.timestamp,
        last_correlation_id: record.correlation_id.clone(),
        worker_id: None,
        active_claim_token: None,
        pending_delegations: Vec::new(),
        completed_delegations: Vec::new(),
        triggering_event_id: None,
        final_event_ids: Vec::new(),
        accumulated_runtime_ms: 0,
        error: None,
        abort_reason: None,
        crash_reason: None,
    }
}

fn apply_delegation_completion(entry: &mut RalReplayEntry, completion: &RalCompletedDelegation) {
    if entry
        .completed_delegations
        .iter()
        .any(|existing| existing.completion_event_id == completion.completion_event_id)
    {
        return;
    }

    let Some(index) = entry.pending_delegations.iter().position(|pending| {
        pending.delegation_conversation_id == completion.delegation_conversation_id
            && pending.recipient_pubkey == completion.sender_pubkey
            && pending.sender_pubkey == completion.recipient_pubkey
    }) else {
        return;
    };

    let has_pending_sub_delegations = entry.pending_delegations[index]
        .pending_sub_delegations
        .as_ref()
        .is_some_and(|pending| !pending.is_empty());
    if has_pending_sub_delegations {
        entry.pending_delegations[index].deferred_completion = Some(RalDeferredCompletion {
            recipient_pubkey: completion.sender_pubkey.clone(),
            response: completion.response.clone(),
            completed_at: completion.completed_at,
            full_transcript: completion.full_transcript.clone(),
        });
        return;
    }

    entry.pending_delegations.remove(index);
    entry.completed_delegations.push(completion.clone());
}

fn upsert_pending_delegation(entry: &mut RalReplayEntry, pending_delegation: RalPendingDelegation) {
    if let Some(existing) = entry.pending_delegations.iter_mut().find(|existing| {
        existing.delegation_conversation_id == pending_delegation.delegation_conversation_id
    }) {
        *existing = pending_delegation;
        return;
    }

    entry.pending_delegations.push(pending_delegation);
}

fn apply_terminal_summary(entry: &mut RalReplayEntry, terminal: &RalTerminalSummary) {
    entry.final_event_ids = terminal.final_event_ids.clone();
    entry.accumulated_runtime_ms = terminal.accumulated_runtime_ms;
}

fn sync_parent_dir(path: &Path) -> RalJournalResult<()> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    const RAL_LIFECYCLE_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/daemon/ral-lifecycle.compat.json");

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn ral_journal_paths_match_filesystem_contract() {
        let daemon_dir = Path::new("/tmp/tenex-daemon");

        assert_eq!(ral_dir(daemon_dir), daemon_dir.join(RAL_DIR_NAME));
        assert_eq!(
            ral_journal_path(daemon_dir),
            daemon_dir.join(RAL_DIR_NAME).join(RAL_JOURNAL_FILE_NAME)
        );
        assert_eq!(
            ral_snapshot_path(daemon_dir),
            daemon_dir.join(RAL_DIR_NAME).join(RAL_SNAPSHOT_FILE_NAME)
        );
    }

    #[test]
    fn record_schema_round_trips_required_event_variants() {
        let identity = sample_identity();
        let variants = vec![
            (
                "allocated",
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some("trigger-event-1".to_string()),
                },
            ),
            (
                "claimed",
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-1".to_string(),
                    claim_token: "claim-1".to_string(),
                },
            ),
            (
                "waiting_for_delegation",
                RalJournalEvent::WaitingForDelegation {
                    identity: identity.clone(),
                    worker_id: "worker-1".to_string(),
                    claim_token: "claim-1".to_string(),
                    pending_delegations: vec![test_pending_delegation(
                        "delegation-1",
                        RalDelegationType::Ask,
                    )],
                    terminal: terminal(Vec::new(), 10),
                },
            ),
            (
                "delegation_completed",
                RalJournalEvent::DelegationCompleted {
                    identity: identity.clone(),
                    completion: test_completed_delegation("delegation-1", "completion-event-1"),
                },
            ),
            (
                "completed",
                RalJournalEvent::Completed {
                    identity: identity.clone(),
                    worker_id: "worker-2".to_string(),
                    claim_token: "claim-2".to_string(),
                    terminal: terminal(vec!["event-complete".to_string()], 20),
                },
            ),
            (
                "no_response",
                RalJournalEvent::NoResponse {
                    identity: identity.clone(),
                    worker_id: "worker-3".to_string(),
                    claim_token: "claim-3".to_string(),
                    terminal: terminal(Vec::new(), 30),
                },
            ),
            (
                "error",
                RalJournalEvent::Error {
                    identity: identity.clone(),
                    worker_id: "worker-3".to_string(),
                    claim_token: "claim-3".to_string(),
                    error: RalWorkerError {
                        code: "execution_failed".to_string(),
                        message: "execution failed".to_string(),
                        retryable: false,
                    },
                    terminal: terminal(Vec::new(), 35),
                },
            ),
            (
                "aborted",
                RalJournalEvent::Aborted {
                    identity: identity.clone(),
                    worker_id: Some("worker-4".to_string()),
                    claim_token: Some("claim-4".to_string()),
                    abort_reason: "stop requested".to_string(),
                    terminal: terminal(Vec::new(), 40),
                },
            ),
            (
                "crashed",
                RalJournalEvent::Crashed {
                    identity,
                    worker_id: "worker-5".to_string(),
                    claim_token: Some("claim-5".to_string()),
                    crash_reason: "worker process exited".to_string(),
                    last_heartbeat_at: Some(50),
                },
            ),
        ];

        for (sequence, (event_name, event)) in variants.into_iter().enumerate() {
            let journal_record = record((sequence + 1) as u64, "corr-schema", event);
            let value =
                serde_json::to_value(&journal_record).expect("journal record must serialize");
            assert_eq!(value["schemaVersion"], RAL_JOURNAL_RECORD_SCHEMA_VERSION);
            assert_eq!(value["writer"], RAL_JOURNAL_WRITER_RUST_DAEMON);
            assert_eq!(value["writerVersion"], "test-version");
            assert_eq!(value["correlationId"], "corr-schema");
            assert_eq!(value["event"], event_name);

            let round_tripped: RalJournalRecord =
                serde_json::from_value(value).expect("journal record must deserialize");
            assert_eq!(round_tripped, journal_record);
        }
    }

    #[test]
    fn append_read_and_replay_ral_journal_records() {
        let daemon_dir = unique_temp_daemon_dir();
        let identity = sample_identity();
        let allocated = record(
            1,
            "corr-1",
            RalJournalEvent::Allocated {
                identity: identity.clone(),
                triggering_event_id: Some("trigger-event-1".to_string()),
            },
        );
        let claimed = record(
            2,
            "corr-2",
            RalJournalEvent::Claimed {
                identity: identity.clone(),
                worker_id: "worker-1".to_string(),
                claim_token: "claim-1".to_string(),
            },
        );
        let waiting = record(
            3,
            "corr-3",
            RalJournalEvent::WaitingForDelegation {
                identity: identity.clone(),
                worker_id: "worker-1".to_string(),
                claim_token: "claim-1".to_string(),
                pending_delegations: vec![test_pending_delegation(
                    "delegation-1",
                    RalDelegationType::Standard,
                )],
                terminal: terminal(vec!["event-waiting".to_string()], 25),
            },
        );
        let resumed_claim = record(
            4,
            "corr-4",
            RalJournalEvent::Claimed {
                identity: identity.clone(),
                worker_id: "worker-2".to_string(),
                claim_token: "claim-2".to_string(),
            },
        );
        let completed = record(
            5,
            "corr-5",
            RalJournalEvent::Completed {
                identity: identity.clone(),
                worker_id: "worker-2".to_string(),
                claim_token: "claim-2".to_string(),
                terminal: terminal(vec!["event-complete".to_string()], 42),
            },
        );

        for journal_record in [&allocated, &claimed, &waiting, &resumed_claim, &completed] {
            append_ral_journal_record(&daemon_dir, journal_record)
                .expect("journal append must succeed");
        }

        let records = read_ral_journal_records(&daemon_dir).expect("journal read must succeed");
        assert_eq!(
            records,
            vec![
                allocated.clone(),
                claimed.clone(),
                waiting.clone(),
                resumed_claim.clone(),
                completed.clone()
            ]
        );

        let journal_content =
            fs::read_to_string(ral_journal_path(&daemon_dir)).expect("journal file must read");
        let first_line: serde_json::Value = serde_json::from_str(
            journal_content
                .lines()
                .next()
                .expect("journal must contain a first line"),
        )
        .expect("journal line must parse");
        assert_eq!(
            first_line["schemaVersion"],
            RAL_JOURNAL_RECORD_SCHEMA_VERSION
        );
        assert_eq!(first_line["writer"], RAL_JOURNAL_WRITER_RUST_DAEMON);
        assert_eq!(first_line["writerVersion"], "test-version");
        assert_eq!(first_line["correlationId"], "corr-1");
        assert_eq!(first_line["event"], "allocated");

        let replay = replay_ral_journal(&daemon_dir).expect("journal replay must succeed");
        assert_eq!(replay.last_sequence, 5);
        assert_eq!(
            next_ral_journal_sequence(&daemon_dir).expect("next sequence must be computed"),
            6
        );

        let replay_entry = replay
            .states
            .get(&identity)
            .expect("identity must replay to a current state");
        assert_eq!(replay_entry.status, RalReplayStatus::Completed);
        assert_eq!(replay_entry.worker_id, Some("worker-2".to_string()));
        assert_eq!(replay_entry.active_claim_token, None);
        assert_eq!(replay_entry.pending_delegations, Vec::new());
        assert_eq!(
            replay_entry.triggering_event_id,
            Some("trigger-event-1".to_string())
        );
        assert_eq!(
            replay_entry.final_event_ids,
            vec!["event-complete".to_string()]
        );
        assert_eq!(replay_entry.accumulated_runtime_ms, 42);
        assert_eq!(replay_entry.last_correlation_id, "corr-5");

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn concurrent_appends_do_not_interleave_jsonl_records() {
        let daemon_dir = unique_temp_daemon_dir();
        let thread_count = 6;
        let records_per_thread = 8;
        let barrier = Arc::new(Barrier::new(thread_count));
        let mut handles = Vec::new();

        for thread_index in 0..thread_count {
            let daemon_dir = daemon_dir.clone();
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier.wait();
                for record_index in 0..records_per_thread {
                    let sequence = (thread_index * records_per_thread + record_index + 1) as u64;
                    let identity = RalJournalIdentity {
                        project_id: format!("project-{thread_index}"),
                        agent_pubkey: format!("{:064x}", thread_index + 1),
                        conversation_id: format!("conversation-{record_index}"),
                        ral_number: 1,
                    };
                    let record = RalJournalRecord::new(
                        RAL_JOURNAL_WRITER_RUST_DAEMON,
                        "test-version",
                        sequence,
                        sequence * 1_000,
                        format!("corr-{thread_index}-{record_index}-{}", "x".repeat(16_384)),
                        RalJournalEvent::Allocated {
                            identity,
                            triggering_event_id: None,
                        },
                    );

                    append_ral_journal_record(&daemon_dir, &record)
                        .expect("concurrent journal append must succeed");
                }
            }));
        }

        for handle in handles {
            handle.join().expect("append thread must not panic");
        }

        let content =
            fs::read_to_string(ral_journal_path(&daemon_dir)).expect("journal file must read");
        assert!(content.ends_with('\n'));
        assert_eq!(content.lines().count(), thread_count * records_per_thread);
        for line in content.lines() {
            serde_json::from_str::<RalJournalRecord>(line)
                .expect("each journal line must remain a complete JSON record");
        }

        let records = read_ral_journal_records(&daemon_dir).expect("journal read must succeed");
        assert_eq!(records.len(), thread_count * records_per_thread);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn delegation_completion_removes_matching_pending_and_resume_claim_preserves_remaining() {
        let identity = sample_identity();
        let first_pending = test_pending_delegation("delegation-1", RalDelegationType::Standard);
        let second_pending = test_pending_delegation("delegation-2", RalDelegationType::Ask);
        let completion = test_completed_delegation("delegation-1", "completion-event-1");
        let replay = replay_ral_journal_records(vec![
            record(
                1,
                "corr-1",
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some("trigger-event-1".to_string()),
                },
            ),
            record(
                2,
                "corr-2",
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-1".to_string(),
                    claim_token: "claim-1".to_string(),
                },
            ),
            record(
                3,
                "corr-3",
                RalJournalEvent::WaitingForDelegation {
                    identity: identity.clone(),
                    worker_id: "worker-1".to_string(),
                    claim_token: "claim-1".to_string(),
                    pending_delegations: vec![first_pending, second_pending.clone()],
                    terminal: terminal(Vec::new(), 10),
                },
            ),
            record(
                4,
                "corr-4",
                RalJournalEvent::DelegationCompleted {
                    identity: identity.clone(),
                    completion: completion.clone(),
                },
            ),
            record(
                5,
                "corr-5",
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-2".to_string(),
                    claim_token: "claim-2".to_string(),
                },
            ),
        ])
        .expect("journal replay must succeed");

        let entry = replay
            .states
            .get(&identity)
            .expect("identity must replay to current state");
        assert_eq!(entry.status, RalReplayStatus::Claimed);
        assert_eq!(entry.worker_id.as_deref(), Some("worker-2"));
        assert_eq!(entry.active_claim_token.as_deref(), Some("claim-2"));
        assert_eq!(entry.pending_delegations, vec![second_pending]);
        assert_eq!(entry.completed_delegations, vec![completion]);
    }

    #[test]
    fn snapshot_round_trips_replayed_ral_state_without_becoming_journal_authority() {
        let daemon_dir = unique_temp_daemon_dir();
        let first = sample_identity();
        let mut second = sample_identity();
        second.project_id = "project-b".to_string();
        second.ral_number = 2;

        let replay = replay_ral_journal_records(vec![
            record(
                1,
                "corr-1",
                RalJournalEvent::Allocated {
                    identity: first.clone(),
                    triggering_event_id: Some("trigger-a".to_string()),
                },
            ),
            record(
                2,
                "corr-2",
                RalJournalEvent::Claimed {
                    identity: first,
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                },
            ),
            record(
                3,
                "corr-3",
                RalJournalEvent::Completed {
                    identity: second,
                    worker_id: "worker-b".to_string(),
                    claim_token: "claim-b".to_string(),
                    terminal: terminal(vec!["event-b".to_string()], 17),
                },
            ),
        ])
        .expect("replay must build");
        let snapshot =
            RalJournalSnapshot::from_replay("rust-daemon", "test-version", 1710000000000, &replay);

        assert_eq!(snapshot.schema_version, RAL_SNAPSHOT_SCHEMA_VERSION);
        assert_eq!(snapshot.last_sequence, 3);
        assert_eq!(
            snapshot
                .states
                .iter()
                .map(|entry| entry.identity.project_id.as_str())
                .collect::<Vec<_>>(),
            vec!["project-b", "project-d-tag"]
        );

        write_ral_snapshot(&daemon_dir, &snapshot).expect("snapshot write must succeed");
        let read = read_ral_snapshot(&daemon_dir)
            .expect("snapshot read must succeed")
            .expect("snapshot must exist");

        assert_eq!(read, snapshot);
        assert_eq!(read.into_replay(), replay);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn snapshot_read_rejects_unsupported_schema_version() {
        let daemon_dir = unique_temp_daemon_dir();
        let snapshot_path = ral_snapshot_path(&daemon_dir);
        fs::create_dir_all(
            snapshot_path
                .parent()
                .expect("snapshot path must have parent directory"),
        )
        .expect("snapshot directory must be created");
        fs::write(
            &snapshot_path,
            serde_json::json!({
                "schemaVersion": RAL_SNAPSHOT_SCHEMA_VERSION + 1,
                "writer": "rust-daemon",
                "writerVersion": "future-version",
                "createdAt": 1710000000000_u64,
                "lastSequence": 0,
                "states": []
            })
            .to_string(),
        )
        .expect("snapshot write must succeed");

        match read_ral_snapshot(&daemon_dir) {
            Err(RalJournalError::UnsupportedSnapshotSchema {
                schema_version,
                supported_schema_version,
            }) => {
                assert_eq!(schema_version, RAL_SNAPSHOT_SCHEMA_VERSION + 1);
                assert_eq!(supported_schema_version, RAL_SNAPSHOT_SCHEMA_VERSION);
            }
            other => panic!("expected unsupported snapshot schema error, got {other:?}"),
        }

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn ral_lifecycle_fixture_replays_waiting_completed_and_no_response_states() {
        let fixture: serde_json::Value =
            serde_json::from_str(RAL_LIFECYCLE_FIXTURE).expect("fixture must parse");
        let identity = fixture_identity(&fixture);
        let waiting_message = &fixture["workerTerminalMessages"]["waitingForDelegation"];
        let completed_message = &fixture["workerTerminalMessages"]["complete"];
        let no_response_message = &fixture["workerTerminalMessages"]["noResponse"];

        let waiting_replay = replay_ral_journal_records(vec![
            record(
                1,
                string_value(&waiting_message["correlationId"]),
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some(string_value(
                        &fixture["identity"]["triggeringEventId"],
                    )),
                },
            ),
            record(
                2,
                string_value(&waiting_message["correlationId"]),
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-fixture-1".to_string(),
                    claim_token: "claim-fixture-1".to_string(),
                },
            ),
            record(
                3,
                string_value(&waiting_message["correlationId"]),
                RalJournalEvent::WaitingForDelegation {
                    identity: identity.clone(),
                    worker_id: "worker-fixture-1".to_string(),
                    claim_token: "claim-fixture-1".to_string(),
                    pending_delegations: vec![fixture_pending_delegation(&fixture)],
                    terminal: terminal_from_worker_message(waiting_message),
                },
            ),
        ])
        .expect("waiting fixture replay must succeed");
        let waiting_entry = waiting_replay
            .states
            .get(&identity)
            .expect("waiting state must exist");
        assert_eq!(waiting_entry.status, RalReplayStatus::WaitingForDelegation);
        assert_eq!(waiting_entry.active_claim_token, None);
        assert_eq!(
            waiting_entry.triggering_event_id,
            Some(string_value(&fixture["identity"]["triggeringEventId"]))
        );
        assert_eq!(
            waiting_entry.pending_delegations,
            vec![fixture_pending_delegation(&fixture)]
        );
        assert_eq!(
            waiting_entry.final_event_ids,
            string_array(&waiting_message["finalEventIds"])
        );
        assert_eq!(
            waiting_entry.accumulated_runtime_ms,
            u64_value(&waiting_message["accumulatedRuntimeMs"])
        );

        let completed_replay = replay_ral_journal_records(vec![
            record(
                1,
                string_value(&completed_message["correlationId"]),
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some(string_value(
                        &fixture["identity"]["triggeringEventId"],
                    )),
                },
            ),
            record(
                2,
                string_value(&completed_message["correlationId"]),
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-fixture-2".to_string(),
                    claim_token: "claim-fixture-2".to_string(),
                },
            ),
            record(
                3,
                string_value(&completed_message["correlationId"]),
                RalJournalEvent::Completed {
                    identity: identity.clone(),
                    worker_id: "worker-fixture-2".to_string(),
                    claim_token: "claim-fixture-2".to_string(),
                    terminal: terminal_from_worker_message(completed_message),
                },
            ),
        ])
        .expect("completed fixture replay must succeed");
        let completed_entry = completed_replay
            .states
            .get(&identity)
            .expect("completed state must exist");
        assert_eq!(completed_entry.status, RalReplayStatus::Completed);
        assert!(completed_entry.pending_delegations.is_empty());
        assert_eq!(
            completed_entry.final_event_ids,
            string_array(&completed_message["finalEventIds"])
        );
        assert_eq!(
            completed_entry.accumulated_runtime_ms,
            u64_value(&completed_message["accumulatedRuntimeMs"])
        );

        let no_response_replay = replay_ral_journal_records(vec![
            record(
                1,
                string_value(&no_response_message["correlationId"]),
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some(string_value(
                        &fixture["identity"]["triggeringEventId"],
                    )),
                },
            ),
            record(
                2,
                string_value(&no_response_message["correlationId"]),
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-fixture-3".to_string(),
                    claim_token: "claim-fixture-3".to_string(),
                },
            ),
            record(
                3,
                string_value(&no_response_message["correlationId"]),
                RalJournalEvent::NoResponse {
                    identity: identity.clone(),
                    worker_id: "worker-fixture-3".to_string(),
                    claim_token: "claim-fixture-3".to_string(),
                    terminal: terminal_from_worker_message(no_response_message),
                },
            ),
        ])
        .expect("no-response fixture replay must succeed");
        let no_response_entry = no_response_replay
            .states
            .get(&identity)
            .expect("no-response state must exist");
        assert_eq!(no_response_entry.status, RalReplayStatus::NoResponse);
        assert!(no_response_entry.final_event_ids.is_empty());
        assert_eq!(
            no_response_entry.accumulated_runtime_ms,
            u64_value(&no_response_message["accumulatedRuntimeMs"])
        );
    }

    #[test]
    fn replay_ignores_truncated_final_jsonl_line() {
        let daemon_dir = unique_temp_daemon_dir();
        let valid = record(
            1,
            "corr-1",
            RalJournalEvent::Allocated {
                identity: sample_identity(),
                triggering_event_id: None,
            },
        );
        append_ral_journal_record(&daemon_dir, &valid).expect("journal append must succeed");

        let mut file = OpenOptions::new()
            .append(true)
            .open(ral_journal_path(&daemon_dir))
            .expect("journal file must open");
        file.write_all(b"{\"schemaVersion\":1,\"writer\"")
            .expect("truncated line write must succeed");
        file.sync_all().expect("journal sync must succeed");

        let records = read_ral_journal_records(&daemon_dir).expect("journal read must succeed");
        assert_eq!(records, vec![valid]);

        let replay = replay_ral_journal(&daemon_dir).expect("journal replay must succeed");
        assert_eq!(replay.last_sequence, 1);
        assert_eq!(replay.states.len(), 1);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn replay_fails_on_corrupt_non_final_jsonl_line() {
        let daemon_dir = unique_temp_daemon_dir();
        let journal_path = ral_journal_path(&daemon_dir);
        fs::create_dir_all(
            journal_path
                .parent()
                .expect("journal path must have parent directory"),
        )
        .expect("journal directory must be created");

        let valid_first = serde_json::to_string(&record(
            1,
            "corr-1",
            RalJournalEvent::Allocated {
                identity: sample_identity(),
                triggering_event_id: None,
            },
        ))
        .expect("record must serialize");
        let valid_third = serde_json::to_string(&record(
            2,
            "corr-2",
            RalJournalEvent::Crashed {
                identity: sample_identity(),
                worker_id: "worker-1".to_string(),
                claim_token: Some("claim-1".to_string()),
                crash_reason: "worker process exited".to_string(),
                last_heartbeat_at: Some(12_345),
            },
        ))
        .expect("record must serialize");
        fs::write(
            &journal_path,
            format!("{valid_first}\n{{\"schemaVersion\":\n{valid_third}\n"),
        )
        .expect("corrupt journal must be written");

        match replay_ral_journal(&daemon_dir) {
            Err(RalJournalError::JsonLine { line, source, .. }) => {
                assert_eq!(line, 2);
                assert!(source.is_eof());
            }
            other => panic!("expected corrupt non-final JSONL error, got {other:?}"),
        }

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn replay_tolerates_non_increasing_sequences() {
        let identity = sample_identity();
        let records = vec![
            record(
                2,
                "corr-2",
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: None,
                },
            ),
            record(
                2,
                "corr-2-duplicate",
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-1".to_string(),
                    claim_token: "claim-1".to_string(),
                },
            ),
        ];

        let replay = replay_ral_journal_records(records).expect("replay must recover");
        let entry = replay
            .states
            .get(&identity)
            .expect("identity must remain in replay state");

        assert_eq!(replay.last_sequence, 2);
        assert_eq!(entry.status, RalReplayStatus::Claimed);
        assert_eq!(entry.worker_id.as_deref(), Some("worker-1"));
        assert_eq!(entry.active_claim_token.as_deref(), Some("claim-1"));
    }

    fn sample_identity() -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: "project-d-tag".to_string(),
            agent_pubkey: "a".repeat(64),
            conversation_id: "conversation-1".to_string(),
            ral_number: 3,
        }
    }

    fn test_pending_delegation(
        delegation_conversation_id: &str,
        delegation_type: RalDelegationType,
    ) -> RalPendingDelegation {
        RalPendingDelegation {
            delegation_conversation_id: delegation_conversation_id.to_string(),
            recipient_pubkey: "b".repeat(64),
            sender_pubkey: "a".repeat(64),
            prompt: "Delegated prompt".to_string(),
            delegation_type,
            ral_number: 3,
            parent_delegation_conversation_id: None,
            pending_sub_delegations: None,
            deferred_completion: None,
            followup_event_id: None,
            project_id: None,
            suggestions: None,
            killed: None,
            killed_at: None,
        }
    }

    fn test_completed_delegation(
        delegation_conversation_id: &str,
        completion_event_id: &str,
    ) -> RalCompletedDelegation {
        RalCompletedDelegation {
            delegation_conversation_id: delegation_conversation_id.to_string(),
            sender_pubkey: "b".repeat(64),
            recipient_pubkey: "a".repeat(64),
            response: "done".to_string(),
            completed_at: 1_710_000_900,
            completion_event_id: completion_event_id.to_string(),
            full_transcript: None,
        }
    }

    fn fixture_identity(fixture: &serde_json::Value) -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: string_value(&fixture["identity"]["projectId"]),
            agent_pubkey: string_value(&fixture["identity"]["agentPubkey"]),
            conversation_id: string_value(&fixture["identity"]["conversationId"]),
            ral_number: u64_value(&fixture["freshTurn"]["expected"]["ralNumber"]),
        }
    }

    fn fixture_pending_delegation(fixture: &serde_json::Value) -> RalPendingDelegation {
        let pending = &fixture["waitingForDelegation"]["pendingDelegation"];
        RalPendingDelegation {
            delegation_conversation_id: string_value(&pending["delegationConversationId"]),
            recipient_pubkey: string_value(&pending["recipientPubkey"]),
            sender_pubkey: string_value(&pending["senderPubkey"]),
            prompt: string_value(&pending["prompt"]),
            delegation_type: delegation_type_value(&pending["type"]),
            ral_number: u64_value(&pending["ralNumber"]),
            parent_delegation_conversation_id: optional_string_value(
                &pending["parentDelegationConversationId"],
            ),
            pending_sub_delegations: None,
            deferred_completion: None,
            followup_event_id: optional_string_value(&pending["followupEventId"]),
            project_id: optional_string_value(&pending["projectId"]),
            suggestions: optional_string_array(&pending["suggestions"]),
            killed: pending["killed"].as_bool(),
            killed_at: pending["killedAt"].as_u64(),
        }
    }

    fn terminal(final_event_ids: Vec<String>, accumulated_runtime_ms: u64) -> RalTerminalSummary {
        RalTerminalSummary {
            published_user_visible_event: !final_event_ids.is_empty(),
            pending_delegations_remain: false,
            accumulated_runtime_ms,
            final_event_ids,
            keep_worker_warm: false,
        }
    }

    fn terminal_from_worker_message(message: &serde_json::Value) -> RalTerminalSummary {
        RalTerminalSummary {
            published_user_visible_event: bool_value(&message["publishedUserVisibleEvent"]),
            pending_delegations_remain: bool_value(&message["pendingDelegationsRemain"]),
            accumulated_runtime_ms: u64_value(&message["accumulatedRuntimeMs"]),
            final_event_ids: string_array(&message["finalEventIds"]),
            keep_worker_warm: bool_value(&message["keepWorkerWarm"]),
        }
    }

    fn record(
        sequence: u64,
        correlation_id: impl Into<String>,
        event: RalJournalEvent,
    ) -> RalJournalRecord {
        RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            "test-version",
            sequence,
            sequence * 1_000,
            correlation_id,
            event,
        )
    }

    fn string_value(value: &serde_json::Value) -> String {
        value
            .as_str()
            .expect("fixture value must be a string")
            .to_string()
    }

    fn string_array(value: &serde_json::Value) -> Vec<String> {
        value
            .as_array()
            .expect("fixture value must be an array")
            .iter()
            .map(string_value)
            .collect()
    }

    fn optional_string_value(value: &serde_json::Value) -> Option<String> {
        value.as_str().map(ToString::to_string)
    }

    fn optional_string_array(value: &serde_json::Value) -> Option<Vec<String>> {
        value
            .as_array()
            .map(|values| values.iter().map(string_value).collect())
    }

    fn delegation_type_value(value: &serde_json::Value) -> RalDelegationType {
        match value.as_str().unwrap_or("standard") {
            "standard" => RalDelegationType::Standard,
            "followup" => RalDelegationType::Followup,
            "external" => RalDelegationType::External,
            "ask" => RalDelegationType::Ask,
            other => panic!("unknown fixture delegation type {other}"),
        }
    }

    fn bool_value(value: &serde_json::Value) -> bool {
        value.as_bool().expect("fixture value must be a bool")
    }

    fn u64_value(value: &serde_json::Value) -> u64 {
        value.as_u64().expect("fixture value must be a u64")
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-ral-journal-{}-{unique}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }
}
