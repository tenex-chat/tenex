use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::dispatch_queue::workers_dir;
use crate::ral_journal::RalJournalIdentity;

pub const WORKER_INJECTION_QUEUE_FILE_NAME: &str = "injection-queue.jsonl";
pub const WORKER_INJECTION_QUEUE_RECORD_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum WorkerInjectionQueueError {
    #[error("worker injection queue io error: {0}")]
    Io(#[from] io::Error),
    #[error("worker injection queue json error on line {line}: {source}")]
    Json {
        line: usize,
        source: serde_json::Error,
    },
    #[error(
        "worker injection queue sequence {sequence} is not greater than previous sequence {previous_sequence}"
    )]
    NonIncreasingSequence {
        sequence: u64,
        previous_sequence: u64,
    },
    #[error("worker injection queue sequence exhausted after {last_sequence}")]
    SequenceExhausted { last_sequence: u64 },
}

pub type WorkerInjectionQueueResult<T> = Result<T, WorkerInjectionQueueError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerInjectionQueueStatus {
    Queued,
    Sent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerInjectionRole {
    User,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDelegationCompletionInjection {
    pub delegation_conversation_id: String,
    pub recipient_pubkey: String,
    pub completed_at: u64,
    pub completion_event_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerInjectionQueueRecord {
    pub schema_version: u32,
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    pub worker_id: String,
    pub identity: RalJournalIdentity,
    pub injection_id: String,
    pub lease_token: String,
    pub role: WorkerInjectionRole,
    pub content: String,
    pub status: WorkerInjectionQueueStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation_completion: Option<WorkerDelegationCompletionInjection>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerInjectionQueueRecordParams {
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    pub worker_id: String,
    pub identity: RalJournalIdentity,
    pub injection_id: String,
    pub lease_token: String,
    pub role: WorkerInjectionRole,
    pub content: String,
    pub status: WorkerInjectionQueueStatus,
    pub delegation_completion: Option<WorkerDelegationCompletionInjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkerInjectionQueueState {
    pub last_sequence: u64,
    pub queued: Vec<WorkerInjectionQueueRecord>,
    pub sent: Vec<WorkerInjectionQueueRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerInjectionEnqueueInput {
    pub daemon_dir: PathBuf,
    pub timestamp: u64,
    pub correlation_id: String,
    pub worker_id: String,
    pub identity: RalJournalIdentity,
    pub injection_id: String,
    pub lease_token: String,
    pub role: WorkerInjectionRole,
    pub content: String,
    pub delegation_completion: Option<WorkerDelegationCompletionInjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerInjectionEnqueueOutcome {
    pub injection_id: String,
    pub worker_id: String,
    pub queued: bool,
    pub already_existed: bool,
    pub record: WorkerInjectionQueueRecord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerInjectionMarkSentInput {
    pub daemon_dir: PathBuf,
    pub timestamp: u64,
    pub correlation_id: String,
    pub worker_id: String,
    pub injection_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerInjectionMarkSentOutcome {
    Marked { record: WorkerInjectionQueueRecord },
    AlreadySent { record: WorkerInjectionQueueRecord },
    Missing,
}

pub struct WorkerInjectionQueueLock {
    _lock_file: File,
}

pub fn worker_injection_queue_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    workers_dir(daemon_dir).join(WORKER_INJECTION_QUEUE_FILE_NAME)
}

fn worker_injection_queue_lock_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    workers_dir(daemon_dir).join("injection-queue.lock")
}

pub fn acquire_worker_injection_queue_lock(
    daemon_dir: impl AsRef<Path>,
) -> WorkerInjectionQueueResult<WorkerInjectionQueueLock> {
    let path = worker_injection_queue_lock_path(daemon_dir.as_ref());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&path)?;
    let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if ret != 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(WorkerInjectionQueueLock { _lock_file: file })
}

pub fn build_worker_injection_queue_record(
    params: WorkerInjectionQueueRecordParams,
) -> WorkerInjectionQueueRecord {
    WorkerInjectionQueueRecord {
        schema_version: WORKER_INJECTION_QUEUE_RECORD_SCHEMA_VERSION,
        sequence: params.sequence,
        timestamp: params.timestamp,
        correlation_id: params.correlation_id,
        worker_id: params.worker_id,
        identity: params.identity,
        injection_id: params.injection_id,
        lease_token: params.lease_token,
        role: params.role,
        content: params.content,
        status: params.status,
        delegation_completion: params.delegation_completion,
    }
}

pub fn enqueue_worker_injection(
    input: WorkerInjectionEnqueueInput,
) -> WorkerInjectionQueueResult<WorkerInjectionEnqueueOutcome> {
    let _lock = acquire_worker_injection_queue_lock(&input.daemon_dir)?;
    let state = replay_worker_injection_queue(&input.daemon_dir)?;
    if let Some(existing) = state.latest_record(&input.worker_id, &input.injection_id) {
        return Ok(WorkerInjectionEnqueueOutcome {
            injection_id: input.injection_id,
            worker_id: input.worker_id,
            queued: existing.status == WorkerInjectionQueueStatus::Queued,
            already_existed: true,
            record: existing.clone(),
        });
    }

    let sequence =
        next_sequence(state.last_sequence).ok_or(WorkerInjectionQueueError::SequenceExhausted {
            last_sequence: state.last_sequence,
        })?;
    let record = build_worker_injection_queue_record(WorkerInjectionQueueRecordParams {
        sequence,
        timestamp: input.timestamp,
        correlation_id: input.correlation_id,
        worker_id: input.worker_id.clone(),
        identity: input.identity,
        injection_id: input.injection_id.clone(),
        lease_token: input.lease_token,
        role: input.role,
        content: input.content,
        status: WorkerInjectionQueueStatus::Queued,
        delegation_completion: input.delegation_completion,
    });
    append_worker_injection_queue_record(&input.daemon_dir, &record)?;

    Ok(WorkerInjectionEnqueueOutcome {
        injection_id: input.injection_id,
        worker_id: input.worker_id,
        queued: true,
        already_existed: false,
        record,
    })
}

pub fn mark_worker_injection_sent(
    input: WorkerInjectionMarkSentInput,
) -> WorkerInjectionQueueResult<WorkerInjectionMarkSentOutcome> {
    let _lock = acquire_worker_injection_queue_lock(&input.daemon_dir)?;
    let state = replay_worker_injection_queue(&input.daemon_dir)?;
    let Some(existing) = state.latest_record(&input.worker_id, &input.injection_id) else {
        return Ok(WorkerInjectionMarkSentOutcome::Missing);
    };
    if existing.status == WorkerInjectionQueueStatus::Sent {
        return Ok(WorkerInjectionMarkSentOutcome::AlreadySent {
            record: existing.clone(),
        });
    }

    let sequence =
        next_sequence(state.last_sequence).ok_or(WorkerInjectionQueueError::SequenceExhausted {
            last_sequence: state.last_sequence,
        })?;
    let mut record = existing.clone();
    record.sequence = sequence;
    record.timestamp = input.timestamp;
    record.correlation_id = input.correlation_id;
    record.status = WorkerInjectionQueueStatus::Sent;
    append_worker_injection_queue_record(&input.daemon_dir, &record)?;

    Ok(WorkerInjectionMarkSentOutcome::Marked { record })
}

pub fn pending_worker_injections_for(
    daemon_dir: impl AsRef<Path>,
    worker_id: &str,
    identity: &RalJournalIdentity,
) -> WorkerInjectionQueueResult<Vec<WorkerInjectionQueueRecord>> {
    let state = replay_worker_injection_queue(daemon_dir)?;
    Ok(state
        .queued
        .into_iter()
        .filter(|record| record.worker_id == worker_id && record.identity == *identity)
        .collect())
}

pub fn append_worker_injection_queue_record(
    daemon_dir: impl AsRef<Path>,
    record: &WorkerInjectionQueueRecord,
) -> WorkerInjectionQueueResult<()> {
    let path = worker_injection_queue_path(daemon_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(record)
            .map_err(|source| WorkerInjectionQueueError::Json { line: 0, source })?
    )?;
    file.sync_all()?;
    sync_parent_dir(&path)?;
    Ok(())
}

pub fn read_worker_injection_queue_records(
    daemon_dir: impl AsRef<Path>,
) -> WorkerInjectionQueueResult<Vec<WorkerInjectionQueueRecord>> {
    read_worker_injection_queue_records_from_path(worker_injection_queue_path(daemon_dir))
}

pub fn read_worker_injection_queue_records_from_path(
    path: impl AsRef<Path>,
) -> WorkerInjectionQueueResult<Vec<WorkerInjectionQueueRecord>> {
    let path = path.as_ref();
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };

    let mut records = Vec::new();
    let content_has_complete_final_line = content.ends_with('\n');
    let line_count = content.lines().count();

    for (index, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<WorkerInjectionQueueRecord>(line) {
            Ok(record) => records.push(record),
            Err(source)
                if index + 1 == line_count
                    && !content_has_complete_final_line
                    && source.is_eof() =>
            {
                break;
            }
            Err(source) => {
                return Err(WorkerInjectionQueueError::Json {
                    line: index + 1,
                    source,
                });
            }
        }
    }

    Ok(records)
}

pub fn replay_worker_injection_queue(
    daemon_dir: impl AsRef<Path>,
) -> WorkerInjectionQueueResult<WorkerInjectionQueueState> {
    replay_worker_injection_queue_records(read_worker_injection_queue_records(daemon_dir)?)
}

pub fn replay_worker_injection_queue_records(
    records: Vec<WorkerInjectionQueueRecord>,
) -> WorkerInjectionQueueResult<WorkerInjectionQueueState> {
    let mut last_sequence = 0;
    let mut latest: BTreeMap<(String, String), WorkerInjectionQueueRecord> = BTreeMap::new();

    for record in records {
        if record.sequence <= last_sequence {
            return Err(WorkerInjectionQueueError::NonIncreasingSequence {
                sequence: record.sequence,
                previous_sequence: last_sequence,
            });
        }
        last_sequence = record.sequence;
        latest.insert(
            (record.worker_id.clone(), record.injection_id.clone()),
            record,
        );
    }

    let mut queued = Vec::new();
    let mut sent = Vec::new();
    for record in latest.into_values() {
        match record.status {
            WorkerInjectionQueueStatus::Queued => queued.push(record),
            WorkerInjectionQueueStatus::Sent => sent.push(record),
        }
    }
    queued.sort_by_key(|record| record.sequence);
    sent.sort_by_key(|record| record.sequence);

    Ok(WorkerInjectionQueueState {
        last_sequence,
        queued,
        sent,
    })
}

impl WorkerInjectionQueueState {
    pub fn latest_record(
        &self,
        worker_id: &str,
        injection_id: &str,
    ) -> Option<&WorkerInjectionQueueRecord> {
        self.queued
            .iter()
            .chain(self.sent.iter())
            .find(|record| record.worker_id == worker_id && record.injection_id == injection_id)
    }
}

fn next_sequence(sequence: u64) -> Option<u64> {
    sequence.checked_add(1)
}

fn sync_parent_dir(path: &Path) -> WorkerInjectionQueueResult<()> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn enqueue_and_mark_sent_round_trip() {
        let daemon_dir = unique_temp_daemon_dir();
        let input = WorkerInjectionEnqueueInput {
            daemon_dir: daemon_dir.clone(),
            timestamp: 1_710_000_100_000,
            correlation_id: "inject-a".to_string(),
            worker_id: "worker-a".to_string(),
            identity: identity(),
            injection_id: "delegation-completion:event-a".to_string(),
            lease_token: "claim-a".to_string(),
            role: WorkerInjectionRole::System,
            content: "delegation done".to_string(),
            delegation_completion: Some(WorkerDelegationCompletionInjection {
                delegation_conversation_id: "delegation-a".to_string(),
                recipient_pubkey: "recipient-a".to_string(),
                completed_at: 1_710_000_001,
                completion_event_id: "event-a".to_string(),
            }),
        };

        let queued = enqueue_worker_injection(input).expect("injection must queue");

        assert!(queued.queued);
        assert!(!queued.already_existed);
        assert_eq!(queued.record.sequence, 1);

        let pending = pending_worker_injections_for(&daemon_dir, "worker-a", &identity())
            .expect("pending injections must replay");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].injection_id, "delegation-completion:event-a");

        let sent = mark_worker_injection_sent(WorkerInjectionMarkSentInput {
            daemon_dir: daemon_dir.clone(),
            timestamp: 1_710_000_101_000,
            correlation_id: "inject-a:sent".to_string(),
            worker_id: "worker-a".to_string(),
            injection_id: "delegation-completion:event-a".to_string(),
        })
        .expect("injection must mark sent");

        let WorkerInjectionMarkSentOutcome::Marked { record } = sent else {
            panic!("expected mark-sent record");
        };
        assert_eq!(record.sequence, 2);
        assert_eq!(record.status, WorkerInjectionQueueStatus::Sent);

        let replayed = replay_worker_injection_queue(&daemon_dir).expect("queue must replay");
        assert!(replayed.queued.is_empty());
        assert_eq!(replayed.sent.len(), 1);

        cleanup_temp_dir(daemon_dir);
    }

    fn identity() -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: "project-a".to_string(),
            agent_pubkey: "agent-a".to_string(),
            conversation_id: "conversation-a".to_string(),
            ral_number: 1,
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after unix epoch")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("tenex-worker-injection-test-{nanos}-{counter}"))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        let _ = fs::remove_dir_all(path);
    }
}
