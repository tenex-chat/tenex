use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const WORKERS_DIR_NAME: &str = "workers";
pub const DISPATCH_QUEUE_FILE_NAME: &str = "dispatch-queue.jsonl";
pub const DISPATCH_QUEUE_RECORD_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum DispatchQueueError {
    #[error("dispatch queue io error: {0}")]
    Io(#[from] io::Error),
    #[error("dispatch queue json error on line {line}: {source}")]
    Json {
        line: usize,
        source: serde_json::Error,
    },
    #[error(
        "dispatch queue sequence {sequence} is not greater than previous sequence {previous_sequence}"
    )]
    NonIncreasingSequence {
        sequence: u64,
        previous_sequence: u64,
    },
    #[error("dispatch {dispatch_id} was not found")]
    DispatchNotFound { dispatch_id: String },
    #[error("dispatch {dispatch_id} is not queued; latest status is {status:?}")]
    DispatchNotQueued {
        dispatch_id: String,
        status: DispatchQueueStatus,
    },
    #[error("dispatch {dispatch_id} is not leased; latest status is {status:?}")]
    DispatchNotLeased {
        dispatch_id: String,
        status: DispatchQueueStatus,
    },
    #[error("dispatch terminal planner does not support status {status:?}")]
    InvalidTerminalStatus { status: DispatchQueueStatus },
}

pub type DispatchQueueResult<T> = Result<T, DispatchQueueError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRalIdentity {
    pub project_id: String,
    pub agent_pubkey: String,
    pub conversation_id: String,
    pub ral_number: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchQueueStatus {
    Queued,
    Leased,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchQueueRecord {
    pub schema_version: u32,
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    pub dispatch_id: String,
    pub ral: DispatchRalIdentity,
    pub triggering_event_id: String,
    pub claim_token: String,
    pub status: DispatchQueueStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchQueueRecordParams {
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
    pub dispatch_id: String,
    pub ral: DispatchRalIdentity,
    pub triggering_event_id: String,
    pub claim_token: String,
    pub status: DispatchQueueStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DispatchQueueState {
    pub last_sequence: u64,
    pub queued: Vec<DispatchQueueRecord>,
    pub leased: Vec<DispatchQueueRecord>,
    pub terminal: Vec<DispatchQueueRecord>,
}

impl DispatchQueueState {
    pub fn latest_record(&self, dispatch_id: &str) -> Option<&DispatchQueueRecord> {
        self.queued
            .iter()
            .chain(self.leased.iter())
            .chain(self.terminal.iter())
            .find(|record| record.dispatch_id == dispatch_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchQueueLifecycleInput {
    pub dispatch_id: String,
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
}

pub fn workers_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(WORKERS_DIR_NAME)
}

pub fn dispatch_queue_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    workers_dir(daemon_dir).join(DISPATCH_QUEUE_FILE_NAME)
}

fn dispatch_queue_lock_path(daemon_dir: impl AsRef<Path>) -> PathBuf {
    workers_dir(daemon_dir).join("dispatch-queue.lock")
}

/// RAII guard for the dispatch queue exclusive lock.
/// The lock is released when this value is dropped (the file handle closes).
pub struct DispatchQueueLock {
    _lock_file: File,
}

/// Acquire an exclusive advisory lock on the dispatch queue.
/// Blocks until no other writer holds the lock.
/// All callers that perform a read-compute-write cycle on the dispatch queue
/// must hold this lock for the duration of the critical section.
pub fn acquire_dispatch_queue_lock(
    daemon_dir: impl AsRef<Path>,
) -> DispatchQueueResult<DispatchQueueLock> {
    let path = dispatch_queue_lock_path(daemon_dir.as_ref());
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
    Ok(DispatchQueueLock { _lock_file: file })
}

pub fn build_dispatch_queue_record(params: DispatchQueueRecordParams) -> DispatchQueueRecord {
    DispatchQueueRecord {
        schema_version: DISPATCH_QUEUE_RECORD_SCHEMA_VERSION,
        sequence: params.sequence,
        timestamp: params.timestamp,
        correlation_id: params.correlation_id,
        dispatch_id: params.dispatch_id,
        ral: params.ral,
        triggering_event_id: params.triggering_event_id,
        claim_token: params.claim_token,
        status: params.status,
    }
}

pub fn append_dispatch_queue_record(
    daemon_dir: impl AsRef<Path>,
    record: &DispatchQueueRecord,
) -> DispatchQueueResult<()> {
    let path = dispatch_queue_path(daemon_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(record)
            .map_err(|source| { DispatchQueueError::Json { line: 0, source } })?
    )?;
    file.sync_all()?;
    sync_parent_dir(&path)?;
    Ok(())
}

pub fn read_dispatch_queue_records(
    daemon_dir: impl AsRef<Path>,
) -> DispatchQueueResult<Vec<DispatchQueueRecord>> {
    read_dispatch_queue_records_from_path(dispatch_queue_path(daemon_dir))
}

pub fn read_dispatch_queue_records_from_path(
    path: impl AsRef<Path>,
) -> DispatchQueueResult<Vec<DispatchQueueRecord>> {
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

        match serde_json::from_str::<DispatchQueueRecord>(line) {
            Ok(record) => records.push(record),
            Err(source)
                if index + 1 == line_count
                    && !content_has_complete_final_line
                    && source.is_eof() =>
            {
                break;
            }
            Err(source) => {
                return Err(DispatchQueueError::Json {
                    line: index + 1,
                    source,
                });
            }
        }
    }

    Ok(records)
}

pub fn replay_dispatch_queue(
    daemon_dir: impl AsRef<Path>,
) -> DispatchQueueResult<DispatchQueueState> {
    replay_dispatch_queue_records(read_dispatch_queue_records(daemon_dir)?)
}

pub fn replay_dispatch_queue_records(
    records: Vec<DispatchQueueRecord>,
) -> DispatchQueueResult<DispatchQueueState> {
    let mut latest_by_dispatch_id: BTreeMap<String, DispatchQueueRecord> = BTreeMap::new();
    let mut last_sequence: Option<u64> = None;

    for record in records {
        if let Some(previous_sequence) = last_sequence
            && record.sequence <= previous_sequence
        {
            return Err(DispatchQueueError::NonIncreasingSequence {
                sequence: record.sequence,
                previous_sequence,
            });
        }

        last_sequence = Some(record.sequence);
        latest_by_dispatch_id.insert(record.dispatch_id.clone(), record);
    }

    let mut state = DispatchQueueState::default();
    for record in latest_by_dispatch_id.into_values() {
        match record.status {
            DispatchQueueStatus::Queued => state.queued.push(record),
            DispatchQueueStatus::Leased => state.leased.push(record),
            DispatchQueueStatus::Completed | DispatchQueueStatus::Cancelled => {
                state.terminal.push(record);
            }
        }
    }
    state.last_sequence = last_sequence.unwrap_or(0);

    Ok(state)
}

pub fn plan_dispatch_queue_lease(
    state: &DispatchQueueState,
    input: DispatchQueueLifecycleInput,
) -> DispatchQueueResult<DispatchQueueRecord> {
    ensure_next_sequence(state, input.sequence)?;
    let latest = latest_record_or_error(state, &input.dispatch_id)?;

    if latest.status != DispatchQueueStatus::Queued {
        return Err(DispatchQueueError::DispatchNotQueued {
            dispatch_id: input.dispatch_id,
            status: latest.status,
        });
    }

    Ok(build_lifecycle_record(
        latest,
        input,
        DispatchQueueStatus::Leased,
    ))
}

pub fn plan_dispatch_queue_terminal(
    state: &DispatchQueueState,
    input: DispatchQueueLifecycleInput,
    status: DispatchQueueStatus,
) -> DispatchQueueResult<DispatchQueueRecord> {
    ensure_next_sequence(state, input.sequence)?;
    if !matches!(
        status,
        DispatchQueueStatus::Completed | DispatchQueueStatus::Cancelled
    ) {
        return Err(DispatchQueueError::InvalidTerminalStatus { status });
    }

    let latest = latest_record_or_error(state, &input.dispatch_id)?;
    match status {
        DispatchQueueStatus::Completed if latest.status != DispatchQueueStatus::Leased => {
            Err(DispatchQueueError::DispatchNotLeased {
                dispatch_id: input.dispatch_id,
                status: latest.status,
            })
        }
        DispatchQueueStatus::Cancelled
            if !matches!(
                latest.status,
                DispatchQueueStatus::Queued | DispatchQueueStatus::Leased
            ) =>
        {
            Err(DispatchQueueError::DispatchNotQueued {
                dispatch_id: input.dispatch_id,
                status: latest.status,
            })
        }
        DispatchQueueStatus::Completed | DispatchQueueStatus::Cancelled => {
            Ok(build_lifecycle_record(latest, input, status))
        }
        DispatchQueueStatus::Queued | DispatchQueueStatus::Leased => {
            Err(DispatchQueueError::InvalidTerminalStatus { status })
        }
    }
}

fn ensure_next_sequence(state: &DispatchQueueState, sequence: u64) -> DispatchQueueResult<()> {
    if sequence <= state.last_sequence {
        return Err(DispatchQueueError::NonIncreasingSequence {
            sequence,
            previous_sequence: state.last_sequence,
        });
    }
    Ok(())
}

fn latest_record_or_error<'a>(
    state: &'a DispatchQueueState,
    dispatch_id: &str,
) -> DispatchQueueResult<&'a DispatchQueueRecord> {
    state
        .latest_record(dispatch_id)
        .ok_or_else(|| DispatchQueueError::DispatchNotFound {
            dispatch_id: dispatch_id.to_string(),
        })
}

fn build_lifecycle_record(
    previous: &DispatchQueueRecord,
    input: DispatchQueueLifecycleInput,
    status: DispatchQueueStatus,
) -> DispatchQueueRecord {
    build_dispatch_queue_record(DispatchQueueRecordParams {
        sequence: input.sequence,
        timestamp: input.timestamp,
        correlation_id: input.correlation_id,
        dispatch_id: previous.dispatch_id.clone(),
        ral: previous.ral.clone(),
        triggering_event_id: previous.triggering_event_id.clone(),
        claim_token: previous.claim_token.clone(),
        status,
    })
}

fn sync_parent_dir(path: &Path) -> DispatchQueueResult<()> {
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
    fn dispatch_queue_appends_and_reads_jsonl_records() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = build_record(1, "dispatch-1", DispatchQueueStatus::Queued);

        append_dispatch_queue_record(&daemon_dir, &record).expect("append must succeed");

        assert_eq!(
            read_dispatch_queue_records(&daemon_dir).expect("read must succeed"),
            vec![record]
        );
    }

    #[test]
    fn dispatch_queue_replay_keeps_latest_record_per_dispatch() {
        let identity = build_identity();
        let records = vec![
            build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 1,
                timestamp: 1000,
                correlation_id: "correlation-1".to_string(),
                dispatch_id: "dispatch-1".to_string(),
                ral: identity.clone(),
                triggering_event_id: "event-1".to_string(),
                claim_token: "claim-1".to_string(),
                status: DispatchQueueStatus::Queued,
            }),
            build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 2,
                timestamp: 1001,
                correlation_id: "correlation-1".to_string(),
                dispatch_id: "dispatch-1".to_string(),
                ral: identity.clone(),
                triggering_event_id: "event-1".to_string(),
                claim_token: "claim-1".to_string(),
                status: DispatchQueueStatus::Leased,
            }),
            build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 3,
                timestamp: 1002,
                correlation_id: "correlation-2".to_string(),
                dispatch_id: "dispatch-2".to_string(),
                ral: identity,
                triggering_event_id: "event-2".to_string(),
                claim_token: "claim-2".to_string(),
                status: DispatchQueueStatus::Queued,
            }),
        ];

        let state = replay_dispatch_queue_records(records).expect("replay must succeed");

        assert_eq!(state.last_sequence, 3);
        assert_eq!(state.queued.len(), 1);
        assert_eq!(state.queued[0].dispatch_id, "dispatch-2");
        assert_eq!(state.leased.len(), 1);
        assert_eq!(state.leased[0].dispatch_id, "dispatch-1");
        assert!(state.terminal.is_empty());
    }

    #[test]
    fn dispatch_queue_replay_separates_terminal_records() {
        let records = vec![
            build_record(1, "dispatch-1", DispatchQueueStatus::Queued),
            build_record(2, "dispatch-1", DispatchQueueStatus::Completed),
            build_record(3, "dispatch-2", DispatchQueueStatus::Cancelled),
        ];

        let state = replay_dispatch_queue_records(records).expect("replay must succeed");

        assert_eq!(state.last_sequence, 3);
        assert!(state.queued.is_empty());
        assert!(state.leased.is_empty());
        assert_eq!(
            state
                .terminal
                .iter()
                .map(|record| record.dispatch_id.as_str())
                .collect::<Vec<_>>(),
            vec!["dispatch-1", "dispatch-2"]
        );
    }

    #[test]
    fn dispatch_queue_read_ignores_truncated_final_record() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = build_record(1, "dispatch-1", DispatchQueueStatus::Queued);
        let path = dispatch_queue_path(&daemon_dir);
        fs::create_dir_all(path.parent().expect("queue file must have parent"))
            .expect("workers dir must be created");
        fs::write(
            &path,
            format!(
                "{}\n{{\"schemaVersion\":1,\"dispatchId\"",
                serde_json::to_string(&record).expect("record must serialize")
            ),
        )
        .expect("queue file write must succeed");

        assert_eq!(
            read_dispatch_queue_records(&daemon_dir).expect("read must succeed"),
            vec![record]
        );
    }

    #[test]
    fn dispatch_queue_read_rejects_corrupt_non_final_record() {
        let daemon_dir = unique_temp_daemon_dir();
        let record = build_record(1, "dispatch-1", DispatchQueueStatus::Queued);
        let path = dispatch_queue_path(&daemon_dir);
        fs::create_dir_all(path.parent().expect("queue file must have parent"))
            .expect("workers dir must be created");
        fs::write(
            &path,
            format!(
                "{{\"schemaVersion\":1,\"dispatchId\"\n{}\n",
                serde_json::to_string(&record).expect("record must serialize")
            ),
        )
        .expect("queue file write must succeed");

        let error =
            read_dispatch_queue_records(&daemon_dir).expect_err("corrupt middle line must fail");

        assert!(matches!(error, DispatchQueueError::Json { line: 1, .. }));
    }

    #[test]
    fn dispatch_queue_read_rejects_complete_malformed_final_record() {
        let daemon_dir = unique_temp_daemon_dir();
        let path = dispatch_queue_path(&daemon_dir);
        fs::create_dir_all(path.parent().expect("queue file must have parent"))
            .expect("workers dir must be created");
        fs::write(
            &path,
            "{\"schemaVersion\":1,\"sequence\":1,\"timestamp\":1,\"correlationId\":\"correlation-1\",\"dispatchId\":\"dispatch-1\",\"ral\":{\"projectId\":\"project-1\",\"agentPubkey\":\"agent-pubkey-1\",\"conversationId\":\"conversation-1\",\"ralNumber\":1},\"triggeringEventId\":\"event-1\",\"claimToken\":\"claim-1\",\"status\":\"not_a_status\"}"
        )
        .expect("queue file write must succeed");

        let error = read_dispatch_queue_records(&daemon_dir)
            .expect_err("malformed final record must fail closed");

        assert!(matches!(error, DispatchQueueError::Json { line: 1, .. }));
    }

    #[test]
    fn dispatch_queue_replay_rejects_non_increasing_sequences() {
        let records = vec![
            build_record(2, "dispatch-1", DispatchQueueStatus::Queued),
            build_record(2, "dispatch-1", DispatchQueueStatus::Completed),
        ];

        match replay_dispatch_queue_records(records) {
            Err(DispatchQueueError::NonIncreasingSequence {
                sequence,
                previous_sequence,
            }) => {
                assert_eq!(sequence, 2);
                assert_eq!(previous_sequence, 2);
            }
            other => panic!("expected non-increasing sequence error, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_queue_plans_lease_from_queued_record() {
        let queued = build_record(1, "dispatch-1", DispatchQueueStatus::Queued);
        let state = replay_dispatch_queue_records(vec![queued.clone()]).expect("replay succeeds");

        let leased = plan_dispatch_queue_lease(
            &state,
            lifecycle_input("dispatch-1", 2, "lease-correlation"),
        )
        .expect("lease must plan");

        assert_eq!(leased.sequence, 2);
        assert_eq!(leased.timestamp, 1710001000002);
        assert_eq!(leased.correlation_id, "lease-correlation");
        assert_eq!(leased.dispatch_id, queued.dispatch_id);
        assert_eq!(leased.ral, queued.ral);
        assert_eq!(leased.triggering_event_id, queued.triggering_event_id);
        assert_eq!(leased.claim_token, queued.claim_token);
        assert_eq!(leased.status, DispatchQueueStatus::Leased);

        let leased_state =
            replay_dispatch_queue_records(vec![queued, leased]).expect("replay succeeds");
        assert_eq!(leased_state.last_sequence, 2);
        assert!(leased_state.queued.is_empty());
        assert_eq!(leased_state.leased.len(), 1);
        assert_eq!(leased_state.leased[0].status, DispatchQueueStatus::Leased);
    }

    #[test]
    fn dispatch_queue_plans_completed_terminal_from_leased_record() {
        let queued = build_record(1, "dispatch-1", DispatchQueueStatus::Queued);
        let leased = build_record(2, "dispatch-1", DispatchQueueStatus::Leased);
        let state =
            replay_dispatch_queue_records(vec![queued.clone(), leased.clone()]).expect("replay");

        let completed = plan_dispatch_queue_terminal(
            &state,
            lifecycle_input("dispatch-1", 3, "complete-correlation"),
            DispatchQueueStatus::Completed,
        )
        .expect("completed terminal must plan");

        assert_eq!(completed.sequence, 3);
        assert_eq!(completed.dispatch_id, leased.dispatch_id);
        assert_eq!(completed.claim_token, leased.claim_token);
        assert_eq!(completed.status, DispatchQueueStatus::Completed);

        let terminal_state =
            replay_dispatch_queue_records(vec![queued, leased, completed]).expect("replay");
        assert!(terminal_state.queued.is_empty());
        assert!(terminal_state.leased.is_empty());
        assert_eq!(terminal_state.terminal.len(), 1);
        assert_eq!(
            terminal_state.terminal[0].status,
            DispatchQueueStatus::Completed
        );
    }

    #[test]
    fn dispatch_queue_plans_cancelled_terminal_from_queued_or_leased_record() {
        let queued = build_record(1, "dispatch-1", DispatchQueueStatus::Queued);
        let queued_state = replay_dispatch_queue_records(vec![queued.clone()]).expect("replay");
        let cancelled_queued = plan_dispatch_queue_terminal(
            &queued_state,
            lifecycle_input("dispatch-1", 2, "cancel-correlation"),
            DispatchQueueStatus::Cancelled,
        )
        .expect("queued dispatch cancellation must plan");
        assert_eq!(cancelled_queued.status, DispatchQueueStatus::Cancelled);

        let leased = build_record(3, "dispatch-2", DispatchQueueStatus::Leased);
        let leased_state = replay_dispatch_queue_records(vec![leased.clone()]).expect("replay");
        let cancelled_leased = plan_dispatch_queue_terminal(
            &leased_state,
            lifecycle_input("dispatch-2", 4, "cancel-correlation"),
            DispatchQueueStatus::Cancelled,
        )
        .expect("leased dispatch cancellation must plan");
        assert_eq!(cancelled_leased.status, DispatchQueueStatus::Cancelled);
        assert_eq!(cancelled_leased.dispatch_id, leased.dispatch_id);
    }

    #[test]
    fn dispatch_queue_lifecycle_planners_reject_invalid_state_and_sequence() {
        let queued = build_record(2, "dispatch-1", DispatchQueueStatus::Queued);
        let leased = build_record(3, "dispatch-2", DispatchQueueStatus::Leased);
        let completed = build_record(4, "dispatch-3", DispatchQueueStatus::Completed);
        let state =
            replay_dispatch_queue_records(vec![queued.clone(), leased.clone(), completed.clone()])
                .expect("replay");

        match plan_dispatch_queue_lease(&state, lifecycle_input("dispatch-1", 4, "stale")) {
            Err(DispatchQueueError::NonIncreasingSequence {
                sequence,
                previous_sequence,
            }) => {
                assert_eq!(sequence, 4);
                assert_eq!(previous_sequence, 4);
            }
            other => panic!("expected stale sequence rejection, got {other:?}"),
        }

        match plan_dispatch_queue_lease(&state, lifecycle_input("missing", 5, "missing")) {
            Err(DispatchQueueError::DispatchNotFound { dispatch_id }) => {
                assert_eq!(dispatch_id, "missing");
            }
            other => panic!("expected missing dispatch rejection, got {other:?}"),
        }

        match plan_dispatch_queue_lease(&state, lifecycle_input("dispatch-2", 5, "leased")) {
            Err(DispatchQueueError::DispatchNotQueued {
                dispatch_id,
                status,
            }) => {
                assert_eq!(dispatch_id, "dispatch-2");
                assert_eq!(status, DispatchQueueStatus::Leased);
            }
            other => panic!("expected non-queued rejection, got {other:?}"),
        }

        match plan_dispatch_queue_terminal(
            &state,
            lifecycle_input("dispatch-1", 5, "complete"),
            DispatchQueueStatus::Completed,
        ) {
            Err(DispatchQueueError::DispatchNotLeased {
                dispatch_id,
                status,
            }) => {
                assert_eq!(dispatch_id, "dispatch-1");
                assert_eq!(status, DispatchQueueStatus::Queued);
            }
            other => panic!("expected non-leased completion rejection, got {other:?}"),
        }

        match plan_dispatch_queue_terminal(
            &state,
            lifecycle_input("dispatch-2", 5, "invalid"),
            DispatchQueueStatus::Leased,
        ) {
            Err(DispatchQueueError::InvalidTerminalStatus { status }) => {
                assert_eq!(status, DispatchQueueStatus::Leased);
            }
            other => panic!("expected invalid terminal status rejection, got {other:?}"),
        }

        match plan_dispatch_queue_terminal(
            &state,
            lifecycle_input("dispatch-3", 5, "cancel-terminal"),
            DispatchQueueStatus::Cancelled,
        ) {
            Err(DispatchQueueError::DispatchNotQueued {
                dispatch_id,
                status,
            }) => {
                assert_eq!(dispatch_id, "dispatch-3");
                assert_eq!(status, DispatchQueueStatus::Completed);
            }
            other => panic!("expected terminal cancellation rejection, got {other:?}"),
        }
    }

    fn build_record(
        sequence: u64,
        dispatch_id: &str,
        status: DispatchQueueStatus,
    ) -> DispatchQueueRecord {
        build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence,
            timestamp: 1710000000000 + sequence,
            correlation_id: format!("correlation-{sequence}"),
            dispatch_id: dispatch_id.to_string(),
            ral: build_identity(),
            triggering_event_id: format!("event-{sequence}"),
            claim_token: format!("claim-{sequence}"),
            status,
        })
    }

    fn build_identity() -> DispatchRalIdentity {
        DispatchRalIdentity {
            project_id: "project-1".to_string(),
            agent_pubkey: "agent-pubkey-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            ral_number: 1,
        }
    }

    fn lifecycle_input(
        dispatch_id: &str,
        sequence: u64,
        correlation_id: &str,
    ) -> DispatchQueueLifecycleInput {
        DispatchQueueLifecycleInput {
            dispatch_id: dispatch_id.to_string(),
            sequence,
            timestamp: 1710001000000 + sequence,
            correlation_id: correlation_id.to_string(),
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "tenex-daemon-dispatch-queue-test-{}-{nanos}-{counter}",
            std::process::id()
        ))
    }
}
