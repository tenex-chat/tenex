use std::path::Path;

use serde_json::Value;
use thiserror::Error;

use crate::dispatch_queue::DispatchQueueState;
use crate::ral_scheduler::RalScheduler;
use crate::worker_completion::apply::{
    AppliedWorkerCompletion, WorkerCompletionApplyError, WorkerCompletionApplyInput,
    apply_worker_completion,
};
use crate::worker_completion::plan::{
    WorkerCompletionDispatchInput, WorkerCompletionError, WorkerCompletionInput,
    WorkerCompletionPlan, plan_worker_completion,
};
use crate::worker_completion::result::{
    WorkerResultError, WorkerResultTransitionContext, WorkerResultTransitionPlan,
    plan_worker_result_transition,
};
use crate::worker_lifecycle::launch_lock::WorkerLaunchLocks;
use crate::worker_message::{
    WorkerMessageAction, WorkerMessageError, WorkerMessagePlan, WorkerTerminalResultKind,
    plan_worker_message_handling,
};

#[derive(Debug)]
pub struct WorkerTerminalFlowInput<'a> {
    pub daemon_dir: &'a Path,
    pub message: &'a Value,
    pub result_context: WorkerResultTransitionContext,
    pub dispatch: Option<WorkerCompletionDispatchInput>,
    pub locks: WorkerLaunchLocks,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerTerminalFlowPlan {
    pub message: WorkerMessagePlan,
    pub terminal_kind: WorkerTerminalResultKind,
    pub result: WorkerResultTransitionPlan,
    pub completion: WorkerCompletionPlan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedWorkerTerminalFlow {
    pub message: WorkerMessagePlan,
    pub terminal_kind: WorkerTerminalResultKind,
    pub result: WorkerResultTransitionPlan,
    pub completion: AppliedWorkerCompletion,
}

#[derive(Debug, Error)]
pub enum WorkerTerminalFlowPlanningError {
    #[error("worker message handling failed: {source}")]
    Message {
        #[from]
        source: WorkerMessageError,
    },
    #[error("worker message type {message_type} was routed as {action:?}, not a terminal result")]
    NonTerminalMessage {
        message_type: String,
        action: WorkerMessageAction,
    },
    #[error("worker result transition planning failed: {source}")]
    Result {
        #[from]
        source: WorkerResultError,
    },
    #[error("worker completion planning failed: {source}")]
    Completion {
        #[source]
        source: Box<WorkerCompletionError>,
    },
}

#[derive(Debug, Error)]
pub enum WorkerTerminalFlowError {
    #[error("worker terminal flow planning failed: {source}")]
    Planning {
        #[source]
        source: Box<WorkerTerminalFlowPlanningError>,
        locks: Box<WorkerLaunchLocks>,
    },
    #[error("worker terminal flow apply failed: {source}")]
    Apply {
        #[source]
        source: Box<WorkerCompletionApplyError>,
    },
}

pub fn plan_worker_terminal_flow(
    scheduler: &RalScheduler,
    dispatch_state: &DispatchQueueState,
    message: &Value,
    result_context: WorkerResultTransitionContext,
    dispatch: Option<WorkerCompletionDispatchInput>,
) -> Result<WorkerTerminalFlowPlan, WorkerTerminalFlowPlanningError> {
    let message = plan_worker_message_handling(message)?;
    let terminal_kind = match &message.action {
        WorkerMessageAction::TerminalResultCandidate { kind } => kind,
        action => {
            return Err(WorkerTerminalFlowPlanningError::NonTerminalMessage {
                message_type: message.metadata.message_type.clone(),
                action: action.clone(),
            });
        }
    };
    let terminal_kind = *terminal_kind;

    let result = plan_worker_result_transition(&message.message, result_context)?;
    let completion = plan_worker_completion(
        scheduler,
        dispatch_state,
        WorkerCompletionInput {
            result: result.clone(),
            dispatch,
        },
    )
    .map_err(|source| WorkerTerminalFlowPlanningError::Completion {
        source: Box::new(source),
    })?;

    Ok(WorkerTerminalFlowPlan {
        message,
        terminal_kind,
        result,
        completion,
    })
}

pub fn handle_worker_terminal_result(
    scheduler: &RalScheduler,
    dispatch_state: &DispatchQueueState,
    input: WorkerTerminalFlowInput<'_>,
) -> Result<AppliedWorkerTerminalFlow, WorkerTerminalFlowError> {
    let WorkerTerminalFlowInput {
        daemon_dir,
        message,
        result_context,
        dispatch,
        locks,
    } = input;

    let plan = match plan_worker_terminal_flow(
        scheduler,
        dispatch_state,
        message,
        result_context,
        dispatch,
    ) {
        Ok(plan) => plan,
        Err(source) => {
            return Err(WorkerTerminalFlowError::Planning {
                source: Box::new(source),
                locks: Box::new(locks),
            });
        }
    };

    let WorkerTerminalFlowPlan {
        message,
        terminal_kind,
        result,
        completion,
    } = plan;
    let completion = apply_worker_completion(WorkerCompletionApplyInput {
        daemon_dir: daemon_dir.to_path_buf(),
        plan: completion,
        locks,
    })
    .map_err(|source| WorkerTerminalFlowError::Apply {
        source: Box::new(source),
    })?;

    Ok(AppliedWorkerTerminalFlow {
        message,
        terminal_kind,
        result,
        completion,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecord, DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        append_dispatch_queue_record, build_dispatch_queue_record, replay_dispatch_queue,
        replay_dispatch_queue_records,
    };
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
        RalJournalReplay, RalPendingDelegation, RalReplayStatus, append_ral_journal_record,
        replay_ral_journal, replay_ral_journal_records,
    };
    use crate::ral_lock::{build_ral_lock_info, read_ral_lock_info};
    use crate::ral_scheduler::RalScheduler;
    use crate::worker_lifecycle::launch::{
        RalAllocationLockScope, RalStateLockScope, WorkerLaunchPlan,
    };
    use crate::worker_lifecycle::launch_lock::{
        acquire_worker_launch_locks, release_worker_launch_locks,
    };
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const WORKER_PROTOCOL_FIXTURE: &str = include_str!(
        "../../../../src/test-utils/fixtures/worker-protocol/agent-execution.compat.json"
    );

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn handles_terminal_result_by_applying_records_and_releasing_locks() {
        let daemon_dir = unique_temp_daemon_dir();
        append_initial_ral_records(&daemon_dir);
        append_initial_dispatch_records(&daemon_dir);
        let scheduler = scheduler_from_disk(&daemon_dir);
        let dispatch_state = replay_dispatch_queue(&daemon_dir).expect("queue replay must succeed");
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");
        let allocation_lock_path = locks.allocation.path.clone();
        let state_lock_path = locks.state.path.clone();

        let receipt = handle_worker_terminal_result(
            &scheduler,
            &dispatch_state,
            WorkerTerminalFlowInput {
                daemon_dir: &daemon_dir,
                message: &fixture_valid_message("complete"),
                result_context: result_context(Vec::new()),
                dispatch: Some(dispatch_input()),
                locks,
            },
        )
        .expect("terminal result handling must succeed");

        assert_eq!(receipt.terminal_kind, WorkerTerminalResultKind::Complete);
        assert_eq!(receipt.message.metadata.message_type, "complete");
        assert_eq!(receipt.result.worker_sequence, 15);
        match &receipt.completion.plan.ral_journal_record.event {
            RalJournalEvent::Completed {
                identity,
                worker_id,
                claim_token,
                terminal,
            } => {
                assert_eq!(identity, &self::identity());
                assert_eq!(worker_id, "worker-alpha");
                assert_eq!(claim_token, "claim-alpha");
                assert_eq!(terminal.final_event_ids, vec!["published-event-id"]);
            }
            other => panic!("expected completed RAL event, got {other:?}"),
        }

        let replay = replay_ral_journal(&daemon_dir).expect("journal replay must succeed");
        let entry = replay
            .states
            .get(&identity())
            .expect("completed RAL must replay");
        assert_eq!(entry.status, RalReplayStatus::Completed);
        assert_eq!(
            entry.final_event_ids,
            vec!["published-event-id".to_string()]
        );
        assert_eq!(entry.active_claim_token, None);

        let queue = replay_dispatch_queue(&daemon_dir).expect("queue replay must succeed");
        assert!(queue.queued.is_empty());
        assert!(queue.leased.is_empty());
        assert_eq!(queue.terminal.len(), 1);
        assert_eq!(queue.terminal[0].status, DispatchQueueStatus::Completed);
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
    fn returns_locks_without_side_effects_when_message_is_not_terminal() {
        let daemon_dir = unique_temp_daemon_dir();
        append_initial_ral_records(&daemon_dir);
        append_initial_dispatch_records(&daemon_dir);
        let scheduler = scheduler_from_disk(&daemon_dir);
        let dispatch_state = replay_dispatch_queue(&daemon_dir).expect("queue replay must succeed");
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");
        let allocation_lock_path = locks.allocation.path.clone();
        let state_lock_path = locks.state.path.clone();

        let error = handle_worker_terminal_result(
            &scheduler,
            &dispatch_state,
            WorkerTerminalFlowInput {
                daemon_dir: &daemon_dir,
                message: &fixture_valid_message("heartbeat"),
                result_context: result_context(Vec::new()),
                dispatch: Some(dispatch_input()),
                locks,
            },
        )
        .expect_err("non-terminal worker message must be rejected");

        let locks = match error {
            WorkerTerminalFlowError::Planning { source, locks } => {
                assert!(matches!(
                    *source,
                    WorkerTerminalFlowPlanningError::NonTerminalMessage { .. }
                ));
                *locks
            }
            other => panic!("expected planning error, got {other:?}"),
        };
        assert_eq!(
            read_ral_lock_info(&allocation_lock_path).expect("allocation lock must be readable"),
            Some(owner.clone())
        );
        assert_eq!(
            read_ral_lock_info(&state_lock_path).expect("state lock must be readable"),
            Some(owner)
        );
        assert_eq!(
            replay_ral_journal(&daemon_dir)
                .expect("journal replay must succeed")
                .last_sequence,
            199
        );
        assert!(
            replay_dispatch_queue(&daemon_dir)
                .expect("queue replay must succeed")
                .terminal
                .is_empty()
        );

        release_worker_launch_locks(locks).expect("locks must release");
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn returns_locks_without_side_effects_when_terminal_result_cannot_plan() {
        let daemon_dir = unique_temp_daemon_dir();
        append_initial_ral_records(&daemon_dir);
        append_initial_dispatch_records(&daemon_dir);
        let scheduler = scheduler_from_disk(&daemon_dir);
        let dispatch_state = replay_dispatch_queue(&daemon_dir).expect("queue replay must succeed");
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");
        let state_lock_path = locks.state.path.clone();

        let error = handle_worker_terminal_result(
            &scheduler,
            &dispatch_state,
            WorkerTerminalFlowInput {
                daemon_dir: &daemon_dir,
                message: &fixture_valid_message("waiting-for-delegation"),
                result_context: result_context(Vec::new()),
                dispatch: Some(dispatch_input()),
                locks,
            },
        )
        .expect_err("unresolved delegation must reject terminal result");

        let locks = match error {
            WorkerTerminalFlowError::Planning { source, locks } => {
                assert!(matches!(
                    *source,
                    WorkerTerminalFlowPlanningError::Result {
                        source: WorkerResultError::UnresolvedPendingDelegation { .. }
                    }
                ));
                *locks
            }
            other => panic!("expected planning error, got {other:?}"),
        };
        assert_eq!(
            read_ral_lock_info(&state_lock_path).expect("state lock must be readable"),
            Some(owner)
        );
        assert_eq!(
            replay_ral_journal(&daemon_dir)
                .expect("journal replay must succeed")
                .last_sequence,
            199
        );
        assert!(
            replay_dispatch_queue(&daemon_dir)
                .expect("queue replay must succeed")
                .terminal
                .is_empty()
        );

        release_worker_launch_locks(locks).expect("locks must release");
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn plans_terminal_flow_without_applying_filesystem_side_effects() {
        let scheduler = scheduler_from_records();
        let dispatch_state = dispatch_state_from_records();

        let plan = plan_worker_terminal_flow(
            &scheduler,
            &dispatch_state,
            &fixture_valid_message("complete"),
            result_context(Vec::new()),
            Some(dispatch_input()),
        )
        .expect("terminal flow must plan");

        assert_eq!(plan.terminal_kind, WorkerTerminalResultKind::Complete);
        assert_eq!(plan.completion.ral_journal_record.sequence, 200);
        assert_eq!(
            plan.completion
                .dispatch_queue_record
                .expect("dispatch completion must be planned")
                .sequence,
            302
        );
    }

    fn append_initial_ral_records(daemon_dir: &PathBuf) {
        for record in initial_ral_records() {
            append_ral_journal_record(daemon_dir, &record).expect("journal record must append");
        }
    }

    fn append_initial_dispatch_records(daemon_dir: &PathBuf) {
        for record in initial_dispatch_records() {
            append_dispatch_queue_record(daemon_dir, &record).expect("dispatch record must append");
        }
    }

    fn scheduler_from_disk(daemon_dir: &PathBuf) -> RalScheduler {
        let replay = replay_ral_journal(daemon_dir).expect("journal replay must succeed");
        RalScheduler::new(&RalJournalReplay {
            last_sequence: replay.last_sequence,
            states: replay.states,
        })
    }

    fn scheduler_from_records() -> RalScheduler {
        let replay =
            replay_ral_journal_records(initial_ral_records()).expect("journal replay must succeed");
        RalScheduler::new(&RalJournalReplay {
            last_sequence: replay.last_sequence,
            states: replay.states,
        })
    }

    fn dispatch_state_from_records() -> DispatchQueueState {
        replay_dispatch_queue_records(initial_dispatch_records())
            .expect("dispatch replay must succeed")
    }

    fn initial_ral_records() -> Vec<RalJournalRecord> {
        vec![
            journal_record(
                198,
                RalJournalEvent::Allocated {
                    identity: identity(),
                    triggering_event_id: Some("trigger-alpha".to_string()),
                },
            ),
            journal_record(
                199,
                RalJournalEvent::Claimed {
                    identity: identity(),
                    worker_id: "worker-alpha".to_string(),
                    claim_token: "claim-alpha".to_string(),
                },
            ),
        ]
    }

    fn initial_dispatch_records() -> Vec<DispatchQueueRecord> {
        vec![
            dispatch_record(300, DispatchQueueStatus::Queued),
            dispatch_record(301, DispatchQueueStatus::Leased),
        ]
    }

    fn result_context(
        resolved_pending_delegations: Vec<RalPendingDelegation>,
    ) -> WorkerResultTransitionContext {
        WorkerResultTransitionContext {
            worker_id: "worker-alpha".to_string(),
            claim_token: "claim-alpha".to_string(),
            journal_sequence: 200,
            journal_timestamp: 1_710_000_500_000,
            writer_version: "test-version".to_string(),
            resolved_pending_delegations,
            already_completed_delegation_ids: std::collections::HashSet::new(),
        }
    }

    fn dispatch_input() -> WorkerCompletionDispatchInput {
        WorkerCompletionDispatchInput {
            dispatch_id: "dispatch-alpha".to_string(),
            sequence: 302,
            timestamp: 1_710_000_500_302,
            correlation_id: "correlation-dispatch-complete".to_string(),
        }
    }

    fn launch_plan() -> WorkerLaunchPlan {
        WorkerLaunchPlan {
            allocation_lock_scope: RalAllocationLockScope {
                project_id: "project-alpha".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-alpha".to_string(),
            },
            state_lock_scope: RalStateLockScope {
                project_id: "project-alpha".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-alpha".to_string(),
                ral_number: 3,
            },
            execute_message: json!({ "type": "execute" }),
        }
    }

    fn journal_record(sequence: u64, event: RalJournalEvent) -> RalJournalRecord {
        RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            "test-version",
            sequence,
            1_710_000_400_000 + sequence,
            format!("correlation-journal-{sequence}"),
            event,
        )
    }

    fn dispatch_record(sequence: u64, status: DispatchQueueStatus) -> DispatchQueueRecord {
        build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence,
            timestamp: 1_710_000_450_000 + sequence,
            correlation_id: format!("correlation-dispatch-{sequence}"),
            dispatch_id: "dispatch-alpha".to_string(),
            ral: DispatchRalIdentity {
                project_id: "project-alpha".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-alpha".to_string(),
                ral_number: 3,
            },
            triggering_event_id: "trigger-alpha".to_string(),
            claim_token: "claim-alpha".to_string(),
            status,
        })
    }

    fn identity() -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: "project-alpha".to_string(),
            agent_pubkey: "a".repeat(64),
            conversation_id: "conversation-alpha".to_string(),
            ral_number: 3,
        }
    }

    fn fixture_valid_message(name: &str) -> Value {
        let fixture: Value =
            serde_json::from_str(WORKER_PROTOCOL_FIXTURE).expect("fixture must parse");
        fixture["validMessages"]
            .as_array()
            .expect("validMessages must be an array")
            .iter()
            .find(|message| message["name"] == name)
            .unwrap_or_else(|| panic!("fixture message {name} must exist"))["message"]
            .clone()
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tenex-worker-terminal-flow-test-{nanos}-{counter}"))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if let Err(error) = fs::remove_dir_all(path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            panic!("temp daemon dir cleanup must succeed: {error}");
        }
    }
}
