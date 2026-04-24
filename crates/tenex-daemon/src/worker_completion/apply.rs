use std::path::PathBuf;

use thiserror::Error;

use crate::dispatch_queue::{
    DispatchQueueError, acquire_dispatch_queue_lock, append_dispatch_queue_record,
    replay_dispatch_queue,
};
use crate::ral_journal::{RalJournalError, append_ral_journal_record_with_resequence};
use crate::worker_completion::plan::WorkerCompletionPlan;
use crate::worker_lifecycle::launch_lock::{
    WorkerLaunchLockError, WorkerLaunchLocks, release_worker_launch_locks,
};

#[derive(Debug, PartialEq, Eq)]
pub struct WorkerCompletionApplyInput {
    pub daemon_dir: PathBuf,
    pub plan: WorkerCompletionPlan,
    pub locks: WorkerLaunchLocks,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedWorkerCompletion {
    pub plan: WorkerCompletionPlan,
}

#[derive(Debug, Error)]
pub enum WorkerCompletionApplyError {
    #[error("failed to append RAL journal completion record: {source}")]
    RalAppend {
        #[source]
        source: Box<RalJournalError>,
    },
    #[error("failed to append dispatch queue completion record: {source}")]
    DispatchAppend {
        #[source]
        source: Box<DispatchQueueError>,
    },
    #[error("failed to release worker launch locks after applying completion: {source}")]
    LockRelease {
        #[source]
        source: Box<WorkerLaunchLockError>,
    },
}

pub fn apply_worker_completion(
    input: WorkerCompletionApplyInput,
) -> Result<AppliedWorkerCompletion, WorkerCompletionApplyError> {
    let WorkerCompletionApplyInput {
        daemon_dir,
        mut plan,
        locks,
    } = input;

    append_ral_journal_record_with_resequence(&daemon_dir, &mut plan.ral_journal_record)
        .map_err(WorkerCompletionApplyError::from)?;

    if let Some(record) = &mut plan.dispatch_queue_record {
        // Acquire the lock and re-read the current queue tail so the terminal sequence
        // is computed against the actual last_sequence at write time, not the one that
        // was sampled before the worker session started (which may be stale if the
        // background subscription thread enqueued new dispatches during the session).
        let _dispatch_lock =
            acquire_dispatch_queue_lock(&daemon_dir).map_err(WorkerCompletionApplyError::from)?;
        let current_last = replay_dispatch_queue(&daemon_dir)
            .map_err(WorkerCompletionApplyError::from)?
            .last_sequence;
        record.sequence = current_last + 1;
        append_dispatch_queue_record(&daemon_dir, record)
            .map_err(WorkerCompletionApplyError::from)?;
    }

    release_worker_launch_locks(locks).map_err(WorkerCompletionApplyError::from)?;

    Ok(AppliedWorkerCompletion { plan })
}

impl From<RalJournalError> for WorkerCompletionApplyError {
    fn from(source: RalJournalError) -> Self {
        Self::RalAppend {
            source: Box::new(source),
        }
    }
}

impl From<DispatchQueueError> for WorkerCompletionApplyError {
    fn from(source: DispatchQueueError) -> Self {
        Self::DispatchAppend {
            source: Box::new(source),
        }
    }
}

impl From<WorkerLaunchLockError> for WorkerCompletionApplyError {
    fn from(source: WorkerLaunchLockError) -> Self {
        Self::LockRelease {
            source: Box::new(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecord, DispatchQueueRecordParams, DispatchQueueStatus,
        append_dispatch_queue_record, build_dispatch_queue_record, dispatch_queue_path,
        replay_dispatch_queue,
    };
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
        RalReplayStatus, RalTerminalSummary, append_ral_journal_record, ral_journal_path,
        replay_ral_journal,
    };
    use crate::ral_lock::{RalLockError, build_ral_lock_info, read_ral_lock_info};
    use crate::worker_lifecycle::launch::{RalAllocationLockScope, RalStateLockScope, WorkerLaunchPlan};
    use crate::worker_lifecycle::launch_lock::{WorkerLaunchLockError, acquire_worker_launch_locks};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn applies_worker_completion_records_and_releases_locks() {
        let daemon_dir = unique_temp_daemon_dir();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let launch_plan = launch_plan();
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan, &owner)
            .expect("launch locks must acquire");
        let allocation_lock_path = locks.allocation.path.clone();
        let state_lock_path = locks.state.path.clone();
        append_initial_ral_records(&daemon_dir);
        append_initial_dispatch_records(&daemon_dir);
        let plan = completion_plan(Some(dispatch_record(12, DispatchQueueStatus::Completed)));

        let receipt = apply_worker_completion(WorkerCompletionApplyInput {
            daemon_dir: daemon_dir.clone(),
            plan: plan.clone(),
            locks,
        })
        .expect("completion apply must succeed");

        assert_eq!(receipt.plan, plan);
        let replay = replay_ral_journal(&daemon_dir).expect("journal replay must succeed");
        let entry = replay
            .states
            .get(&identity())
            .expect("completion must replay to RAL state");
        assert_eq!(entry.status, RalReplayStatus::Completed);
        assert_eq!(entry.active_claim_token, None);
        assert_eq!(entry.final_event_ids, vec!["event-complete".to_string()]);

        let dispatch_state = replay_dispatch_queue(&daemon_dir).expect("queue replay must succeed");
        assert_eq!(dispatch_state.terminal.len(), 1);
        assert_eq!(
            dispatch_state.terminal[0].status,
            DispatchQueueStatus::Completed
        );
        assert_eq!(
            read_ral_lock_info(&allocation_lock_path).expect("allocation lock must be readable"),
            None
        );
        assert_eq!(
            read_ral_lock_info(&state_lock_path).expect("state lock must be readable"),
            None
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn applies_worker_completion_without_dispatch_record() {
        let daemon_dir = unique_temp_daemon_dir();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");
        let state_lock_path = locks.state.path.clone();
        append_initial_ral_records(&daemon_dir);

        apply_worker_completion(WorkerCompletionApplyInput {
            daemon_dir: daemon_dir.clone(),
            plan: completion_plan(None),
            locks,
        })
        .expect("completion apply without dispatch must succeed");

        let replay = replay_ral_journal(&daemon_dir).expect("journal replay must succeed");
        assert_eq!(replay.last_sequence, 3);
        assert_eq!(
            replay
                .states
                .get(&identity())
                .expect("completion must replay")
                .status,
            RalReplayStatus::Completed
        );
        let dispatch_state = replay_dispatch_queue(&daemon_dir).expect("queue replay must succeed");
        assert!(dispatch_state.terminal.is_empty());
        assert_eq!(
            read_ral_lock_info(&state_lock_path).expect("state lock must be readable"),
            None
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn leaves_locks_held_when_ral_append_fails() {
        let daemon_dir = unique_temp_daemon_dir();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");
        let allocation_lock_path = locks.allocation.path.clone();
        let state_lock_path = locks.state.path.clone();
        fs::create_dir_all(ral_journal_path(&daemon_dir)).expect("journal path directory builds");

        let error = apply_worker_completion(WorkerCompletionApplyInput {
            daemon_dir: daemon_dir.clone(),
            plan: completion_plan(Some(dispatch_record(12, DispatchQueueStatus::Completed))),
            locks,
        })
        .expect_err("journal append failure must be reported");

        assert!(matches!(
            error,
            WorkerCompletionApplyError::RalAppend { .. }
        ));
        assert_eq!(
            read_ral_lock_info(&allocation_lock_path).expect("allocation lock must be readable"),
            Some(owner.clone())
        );
        assert_eq!(
            read_ral_lock_info(&state_lock_path).expect("state lock must be readable"),
            Some(owner)
        );
        assert!(
            replay_dispatch_queue(&daemon_dir)
                .expect("queue replay must succeed")
                .terminal
                .is_empty()
        );

        let locks = acquire_worker_launch_locks(
            &daemon_dir,
            &launch_plan(),
            &build_ral_lock_info(100, "host-a", 1_000),
        )
        .expect_err("original locks are still held");
        assert!(matches!(
            locks,
            WorkerLaunchLockError::Lock(source)
                if matches!(source.as_ref(), RalLockError::AlreadyHeld { .. })
        ));

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn leaves_locks_held_when_dispatch_append_fails_after_ral_append() {
        let daemon_dir = unique_temp_daemon_dir();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");
        let allocation_lock_path = locks.allocation.path.clone();
        let state_lock_path = locks.state.path.clone();
        fs::create_dir_all(dispatch_queue_path(&daemon_dir)).expect("queue path directory builds");

        let error = apply_worker_completion(WorkerCompletionApplyInput {
            daemon_dir: daemon_dir.clone(),
            plan: completion_plan(Some(dispatch_record(12, DispatchQueueStatus::Completed))),
            locks,
        })
        .expect_err("dispatch append failure must be reported");

        assert!(matches!(
            error,
            WorkerCompletionApplyError::DispatchAppend { .. }
        ));
        let replay = replay_ral_journal(&daemon_dir).expect("journal replay must succeed");
        assert_eq!(replay.last_sequence, 1);
        assert_eq!(
            read_ral_lock_info(&allocation_lock_path).expect("allocation lock must be readable"),
            Some(owner.clone())
        );
        assert_eq!(
            read_ral_lock_info(&state_lock_path).expect("state lock must be readable"),
            Some(owner)
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn reports_lock_release_failure_after_records_are_applied() {
        let daemon_dir = unique_temp_daemon_dir();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");
        let state_lock_path = locks.state.path.clone();
        fs::remove_file(&state_lock_path).expect("state lock removal must succeed");
        append_initial_ral_records(&daemon_dir);
        append_initial_dispatch_records(&daemon_dir);

        let error = apply_worker_completion(WorkerCompletionApplyInput {
            daemon_dir: daemon_dir.clone(),
            plan: completion_plan(Some(dispatch_record(12, DispatchQueueStatus::Completed))),
            locks,
        })
        .expect_err("lock release failure must be reported");

        match error {
            WorkerCompletionApplyError::LockRelease { source } => {
                assert!(matches!(
                    source.as_ref(),
                    WorkerLaunchLockError::Lock(lock_source)
                        if matches!(lock_source.as_ref(), RalLockError::NotHeld { .. })
                ));
            }
            other => panic!("expected lock release error, got {other:?}"),
        }

        let replay = replay_ral_journal(&daemon_dir).expect("journal replay must succeed");
        assert_eq!(replay.last_sequence, 3);
        let dispatch_state = replay_dispatch_queue(&daemon_dir).expect("queue replay must succeed");
        assert_eq!(dispatch_state.terminal.len(), 1);

        cleanup_temp_dir(daemon_dir);
    }

    fn append_initial_ral_records(daemon_dir: &PathBuf) {
        append_ral_journal_record(
            daemon_dir,
            &journal_record(
                1,
                RalJournalEvent::Allocated {
                    identity: identity(),
                    triggering_event_id: Some("trigger-a".to_string()),
                },
            ),
        )
        .expect("allocated append must succeed");
        append_ral_journal_record(
            daemon_dir,
            &journal_record(
                2,
                RalJournalEvent::Claimed {
                    identity: identity(),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                },
            ),
        )
        .expect("claimed append must succeed");
    }

    fn append_initial_dispatch_records(daemon_dir: &PathBuf) {
        append_dispatch_queue_record(
            daemon_dir,
            &dispatch_record(10, DispatchQueueStatus::Queued),
        )
        .expect("queued dispatch append must succeed");
        append_dispatch_queue_record(
            daemon_dir,
            &dispatch_record(11, DispatchQueueStatus::Leased),
        )
        .expect("leased dispatch append must succeed");
    }

    fn completion_plan(dispatch_queue_record: Option<DispatchQueueRecord>) -> WorkerCompletionPlan {
        WorkerCompletionPlan {
            worker_sequence: 15,
            worker_timestamp: 1710000402400,
            ral_journal_record: journal_record(
                3,
                RalJournalEvent::Completed {
                    identity: identity(),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                    terminal: terminal(vec!["event-complete"]),
                },
            ),
            dispatch_queue_record,
        }
    }

    fn launch_plan() -> WorkerLaunchPlan {
        WorkerLaunchPlan {
            allocation_lock_scope: RalAllocationLockScope {
                project_id: "project-a".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-a".to_string(),
            },
            state_lock_scope: RalStateLockScope {
                project_id: "project-a".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-a".to_string(),
                ral_number: 1,
            },
            execute_message: json!({ "type": "execute" }),
        }
    }

    fn journal_record(sequence: u64, event: RalJournalEvent) -> RalJournalRecord {
        RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            "test-version",
            sequence,
            1710000400000 + sequence,
            format!("correlation-{sequence}"),
            event,
        )
    }

    fn dispatch_record(sequence: u64, status: DispatchQueueStatus) -> DispatchQueueRecord {
        build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence,
            timestamp: 1710000500000 + sequence,
            correlation_id: format!("correlation-dispatch-{sequence}"),
            dispatch_id: "dispatch-a".to_string(),
            ral: crate::dispatch_queue::DispatchRalIdentity {
                project_id: "project-a".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-a".to_string(),
                ral_number: 1,
            },
            triggering_event_id: "trigger-a".to_string(),
            claim_token: "claim-a".to_string(),
            status,
        })
    }

    fn identity() -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: "project-a".to_string(),
            agent_pubkey: "a".repeat(64),
            conversation_id: "conversation-a".to_string(),
            ral_number: 1,
        }
    }

    fn terminal(final_event_ids: Vec<&str>) -> RalTerminalSummary {
        RalTerminalSummary {
            published_user_visible_event: !final_event_ids.is_empty(),
            pending_delegations_remain: false,
            accumulated_runtime_ms: 2250,
            final_event_ids: final_event_ids
                .into_iter()
                .map(ToString::to_string)
                .collect(),
            keep_worker_warm: false,
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "tenex-worker-completion-apply-test-{nanos}-{counter}"
        ))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if let Err(error) = fs::remove_dir_all(path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            panic!("temp daemon dir cleanup must succeed: {error}");
        }
    }
}
