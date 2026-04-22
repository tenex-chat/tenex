use std::path::Path;

use serde_json::Value;
use thiserror::Error;

use crate::dispatch_queue::DispatchQueueState;
use crate::ral_journal::RalJournalIdentity;
use crate::ral_scheduler::RalScheduler;
use crate::worker_completion::WorkerCompletionDispatchInput;
use crate::worker_dispatch_execution::WorkerDispatchSession;
use crate::worker_heartbeat::{
    WorkerHeartbeatContext, WorkerHeartbeatError, WorkerHeartbeatSnapshot,
    plan_worker_heartbeat_snapshot,
};
use crate::worker_launch_lock::WorkerLaunchLocks;
use crate::worker_message::{
    WorkerControlTelemetryKind, WorkerMessageAction, WorkerMessageError, WorkerMessagePlan,
    WorkerPublishedMode, WorkerStreamTelemetryKind, plan_worker_message_handling,
};
use crate::worker_publish_flow::{
    WorkerPublishFlowError, WorkerPublishFlowInput, WorkerPublishFlowOutcome,
    handle_worker_publish_request,
};
use crate::worker_result::WorkerResultTransitionContext;
use crate::worker_runtime_state::{
    ActiveWorkerRuntimeSnapshot, WorkerRuntimeState, WorkerRuntimeStateError,
};
use crate::worker_terminal_flow::{
    AppliedWorkerTerminalFlow, WorkerTerminalFlowError, WorkerTerminalFlowInput,
    handle_worker_terminal_result,
};

#[derive(Debug)]
pub struct WorkerMessageFlowInput<'a> {
    pub daemon_dir: &'a Path,
    pub worker_id: &'a str,
    pub message: &'a Value,
    pub observed_at: u64,
    pub publish: Option<WorkerMessagePublishContext>,
    pub terminal: Option<WorkerMessageTerminalContext<'a>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerMessagePublishContext {
    pub accepted_at: u64,
    pub result_sequence: u64,
    pub result_timestamp: u64,
}

#[derive(Debug)]
pub struct WorkerMessageTerminalContext<'a> {
    pub scheduler: &'a RalScheduler,
    pub dispatch_state: &'a DispatchQueueState,
    pub result_context: WorkerResultTransitionContext,
    pub dispatch: Option<WorkerCompletionDispatchInput>,
    pub locks: WorkerLaunchLocks,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerMessageFlowOutcome {
    HeartbeatUpdated {
        message: WorkerMessagePlan,
        snapshot: WorkerHeartbeatSnapshot,
    },
    PublishRequestHandled {
        outcome: Box<WorkerPublishFlowOutcome>,
    },
    TerminalResultHandled {
        outcome: Box<AppliedWorkerTerminalFlow>,
        removed_worker: Box<ActiveWorkerRuntimeSnapshot>,
    },
    ControlTelemetry {
        message: WorkerMessagePlan,
        kind: WorkerControlTelemetryKind,
    },
    StreamTelemetry {
        message: WorkerMessagePlan,
        kind: WorkerStreamTelemetryKind,
    },
    PublishedNotification {
        message: WorkerMessagePlan,
        mode: WorkerPublishedMode,
    },
    BootFailureCandidate {
        message: WorkerMessagePlan,
        candidate: WorkerBootFailureCandidate,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerBootFailureCandidate {
    pub worker_id: String,
    pub correlation_id: String,
    pub sequence: u64,
    pub timestamp: u64,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Error)]
pub enum WorkerMessageFlowError {
    #[error("worker message classification failed: {source}")]
    Message {
        #[source]
        source: Box<WorkerMessageError>,
    },
    #[error("worker heartbeat planning failed: {source}")]
    Heartbeat {
        #[source]
        source: Box<WorkerHeartbeatError>,
    },
    #[error("worker runtime state rejected message handling: {source}")]
    Runtime {
        #[source]
        source: Box<WorkerRuntimeStateError>,
    },
    #[error("worker message field is missing or invalid: {0}")]
    InvalidField(&'static str),
    #[error("worker {worker_id} message identity does not match active runtime worker")]
    RuntimeIdentityMismatch {
        worker_id: String,
        expected: Box<RalJournalIdentity>,
        actual: Box<RalJournalIdentity>,
    },
    #[error(
        "terminal context worker {actual_worker_id} does not match active worker {expected_worker_id}"
    )]
    TerminalContextWorkerMismatch {
        expected_worker_id: String,
        actual_worker_id: String,
    },
    #[error("terminal context claim token does not match active worker {worker_id}")]
    TerminalContextClaimTokenMismatch {
        worker_id: String,
        expected: String,
        actual: String,
    },
    #[error("worker message type {message_type} needs publish context")]
    MissingPublishContext { message_type: String },
    #[error("worker message type {message_type} needs terminal context")]
    MissingTerminalContext { message_type: String },
    #[error("worker publish flow failed: {source}")]
    Publish {
        #[source]
        source: Box<WorkerPublishFlowError>,
    },
    #[error("worker terminal flow failed: {source}")]
    Terminal {
        #[source]
        source: Box<WorkerTerminalFlowError>,
    },
}

pub fn handle_worker_message_flow<S>(
    session: &mut S,
    runtime_state: &mut WorkerRuntimeState,
    input: WorkerMessageFlowInput<'_>,
) -> Result<WorkerMessageFlowOutcome, WorkerMessageFlowError>
where
    S: WorkerDispatchSession,
{
    let message_plan =
        plan_worker_message_handling(input.message).map_err(WorkerMessageFlowError::from)?;

    match message_plan.action.clone() {
        WorkerMessageAction::HeartbeatSnapshotCandidate => handle_heartbeat(
            runtime_state,
            input.worker_id,
            input.observed_at,
            message_plan,
        ),
        WorkerMessageAction::PublishRequestCandidate => {
            let publish =
                input
                    .publish
                    .ok_or_else(|| WorkerMessageFlowError::MissingPublishContext {
                        message_type: message_plan.metadata.message_type.clone(),
                    })?;
            ensure_active_worker_matches_message(runtime_state, input.worker_id, &message_plan)?;
            let outcome = handle_worker_publish_request(
                session,
                WorkerPublishFlowInput {
                    daemon_dir: input.daemon_dir,
                    message: &message_plan.message,
                    accepted_at: publish.accepted_at,
                    result_sequence: publish.result_sequence,
                    result_timestamp: publish.result_timestamp,
                },
            )
            .map_err(WorkerMessageFlowError::from)?;

            Ok(WorkerMessageFlowOutcome::PublishRequestHandled {
                outcome: Box::new(outcome),
            })
        }
        WorkerMessageAction::TerminalResultCandidate { .. } => {
            let terminal =
                input
                    .terminal
                    .ok_or_else(|| WorkerMessageFlowError::MissingTerminalContext {
                        message_type: message_plan.metadata.message_type.clone(),
                    })?;
            let active_worker = ensure_active_worker_matches_message(
                runtime_state,
                input.worker_id,
                &message_plan,
            )?;
            ensure_terminal_context_matches_worker(&active_worker, &terminal.result_context)?;

            let outcome = handle_worker_terminal_result(
                terminal.scheduler,
                terminal.dispatch_state,
                WorkerTerminalFlowInput {
                    daemon_dir: input.daemon_dir,
                    message: &message_plan.message,
                    result_context: terminal.result_context,
                    dispatch: terminal.dispatch,
                    locks: terminal.locks,
                },
            )
            .map_err(WorkerMessageFlowError::from)?;

            let removed_worker = runtime_state
                .remove_terminal_worker(input.worker_id)
                .map_err(WorkerMessageFlowError::from)?;

            Ok(WorkerMessageFlowOutcome::TerminalResultHandled {
                outcome: Box::new(outcome),
                removed_worker: Box::new(removed_worker),
            })
        }
        WorkerMessageAction::ControlTelemetry { kind } => {
            Ok(WorkerMessageFlowOutcome::ControlTelemetry {
                message: message_plan,
                kind,
            })
        }
        WorkerMessageAction::StreamTelemetry { kind } => {
            Ok(WorkerMessageFlowOutcome::StreamTelemetry {
                message: message_plan,
                kind,
            })
        }
        WorkerMessageAction::PublishedNotification { mode } => {
            Ok(WorkerMessageFlowOutcome::PublishedNotification {
                message: message_plan,
                mode,
            })
        }
        WorkerMessageAction::BootError => {
            let candidate = boot_failure_candidate(input.worker_id, &message_plan)?;
            Ok(WorkerMessageFlowOutcome::BootFailureCandidate {
                message: message_plan,
                candidate,
            })
        }
    }
}

fn handle_heartbeat(
    runtime_state: &mut WorkerRuntimeState,
    worker_id: &str,
    observed_at: u64,
    message_plan: WorkerMessagePlan,
) -> Result<WorkerMessageFlowOutcome, WorkerMessageFlowError> {
    let snapshot = plan_worker_heartbeat_snapshot(
        &message_plan.message,
        WorkerHeartbeatContext {
            worker_id: worker_id.to_string(),
            observed_at,
        },
    )
    .map_err(WorkerMessageFlowError::from)?;

    runtime_state
        .update_worker_heartbeat(worker_id, snapshot.clone())
        .map_err(WorkerMessageFlowError::from)?;

    Ok(WorkerMessageFlowOutcome::HeartbeatUpdated {
        message: message_plan,
        snapshot,
    })
}

fn ensure_active_worker_matches_message(
    runtime_state: &WorkerRuntimeState,
    worker_id: &str,
    message_plan: &WorkerMessagePlan,
) -> Result<ActiveWorkerRuntimeSnapshot, WorkerMessageFlowError> {
    let worker = runtime_state
        .get_worker(worker_id)
        .cloned()
        .ok_or_else(|| WorkerRuntimeStateError::UnknownWorker {
            worker_id: worker_id.to_string(),
        })
        .map_err(WorkerMessageFlowError::from)?;
    let actual_identity = ral_identity_from_message(&message_plan.message)?;

    if actual_identity != worker.identity {
        return Err(WorkerMessageFlowError::RuntimeIdentityMismatch {
            worker_id: worker.worker_id,
            expected: Box::new(worker.identity),
            actual: Box::new(actual_identity),
        });
    }

    Ok(worker)
}

fn ensure_terminal_context_matches_worker(
    worker: &ActiveWorkerRuntimeSnapshot,
    context: &WorkerResultTransitionContext,
) -> Result<(), WorkerMessageFlowError> {
    if context.worker_id != worker.worker_id {
        return Err(WorkerMessageFlowError::TerminalContextWorkerMismatch {
            expected_worker_id: worker.worker_id.clone(),
            actual_worker_id: context.worker_id.clone(),
        });
    }

    if context.claim_token != worker.claim_token {
        return Err(WorkerMessageFlowError::TerminalContextClaimTokenMismatch {
            worker_id: worker.worker_id.clone(),
            expected: worker.claim_token.clone(),
            actual: context.claim_token.clone(),
        });
    }

    Ok(())
}

fn ral_identity_from_message(
    message: &Value,
) -> Result<RalJournalIdentity, WorkerMessageFlowError> {
    Ok(RalJournalIdentity {
        project_id: required_string(message, "projectId")?.to_string(),
        agent_pubkey: required_string(message, "agentPubkey")?.to_string(),
        conversation_id: required_string(message, "conversationId")?.to_string(),
        ral_number: required_u64(message, "ralNumber")?,
    })
}

fn boot_failure_candidate(
    worker_id: &str,
    message_plan: &WorkerMessagePlan,
) -> Result<WorkerBootFailureCandidate, WorkerMessageFlowError> {
    let error = message_plan
        .message
        .get("error")
        .ok_or(WorkerMessageFlowError::InvalidField("error"))?;

    Ok(WorkerBootFailureCandidate {
        worker_id: worker_id.to_string(),
        correlation_id: message_plan.metadata.correlation_id.clone(),
        sequence: message_plan.metadata.sequence,
        timestamp: message_plan.metadata.timestamp,
        code: required_string(error, "code")?.to_string(),
        message: required_string(error, "message")?.to_string(),
        retryable: required_bool(error, "retryable")?,
    })
}

fn required_string<'a>(
    value: &'a Value,
    field: &'static str,
) -> Result<&'a str, WorkerMessageFlowError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or(WorkerMessageFlowError::InvalidField(field))
}

fn required_u64(value: &Value, field: &'static str) -> Result<u64, WorkerMessageFlowError> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or(WorkerMessageFlowError::InvalidField(field))
}

fn required_bool(value: &Value, field: &'static str) -> Result<bool, WorkerMessageFlowError> {
    value
        .get(field)
        .and_then(Value::as_bool)
        .ok_or(WorkerMessageFlowError::InvalidField(field))
}

impl From<WorkerMessageError> for WorkerMessageFlowError {
    fn from(source: WorkerMessageError) -> Self {
        Self::Message {
            source: Box::new(source),
        }
    }
}

impl From<WorkerHeartbeatError> for WorkerMessageFlowError {
    fn from(source: WorkerHeartbeatError) -> Self {
        Self::Heartbeat {
            source: Box::new(source),
        }
    }
}

impl From<WorkerRuntimeStateError> for WorkerMessageFlowError {
    fn from(source: WorkerRuntimeStateError) -> Self {
        Self::Runtime {
            source: Box::new(source),
        }
    }
}

impl From<WorkerPublishFlowError> for WorkerMessageFlowError {
    fn from(source: WorkerPublishFlowError) -> Self {
        Self::Publish {
            source: Box::new(source),
        }
    }
}

impl From<WorkerTerminalFlowError> for WorkerMessageFlowError {
    fn from(source: WorkerTerminalFlowError) -> Self {
        Self::Terminal {
            source: Box::new(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecord, DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        append_dispatch_queue_record, build_dispatch_queue_record, replay_dispatch_queue,
    };
    use crate::nostr_event::Nip01EventFixture;
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
        append_ral_journal_record,
    };
    use crate::ral_lock::{build_ral_lock_info, read_ral_lock_info};
    use crate::ral_scheduler::RalScheduler;
    use crate::worker_launch::{RalAllocationLockScope, RalStateLockScope, WorkerLaunchPlan};
    use crate::worker_launch_lock::acquire_worker_launch_locks;
    use crate::worker_protocol::AGENT_WORKER_PROTOCOL_VERSION;
    use crate::worker_runtime_state::{WorkerRuntimeStartedDispatch, WorkerRuntimeState};
    use serde_json::json;
    use std::error::Error;
    use std::fmt;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const STREAM_TEXT_DELTA_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json");
    const WORKER_PROTOCOL_FIXTURE: &str = include_str!(
        "../../../src/test-utils/fixtures/worker-protocol/agent-execution.compat.json"
    );

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug, Default)]
    struct RecordingSession {
        sent_messages: Vec<Value>,
    }

    impl WorkerDispatchSession for RecordingSession {
        type Error = FakeSendError;

        fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error> {
            self.sent_messages.push(message.clone());
            Ok(())
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct FakeSendError(&'static str);

    impl fmt::Display for FakeSendError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    impl Error for FakeSendError {}

    #[test]
    fn handles_heartbeat_by_updating_runtime_state() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut runtime_state = runtime_state_for(identity());
        let mut session = RecordingSession::default();

        let outcome = handle_worker_message_flow(
            &mut session,
            &mut runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-alpha",
                message: &fixture_valid_message("heartbeat"),
                observed_at: 1_710_000_403_000,
                publish: None,
                terminal: None,
            },
        )
        .expect("heartbeat message flow must succeed");

        match outcome {
            WorkerMessageFlowOutcome::HeartbeatUpdated { message, snapshot } => {
                assert_eq!(message.metadata.message_type, "heartbeat");
                assert_eq!(snapshot.worker_id, "worker-alpha");
                assert_eq!(snapshot.observed_at, 1_710_000_403_000);
                assert_eq!(
                    runtime_state
                        .get_worker("worker-alpha")
                        .expect("worker must remain active")
                        .last_heartbeat,
                    Some(snapshot)
                );
            }
            other => panic!("expected heartbeat outcome, got {other:?}"),
        }
        assert!(session.sent_messages.is_empty());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn handles_publish_request_through_publish_flow() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let mut runtime_state = runtime_state_for(identity_with_agent(&fixture.pubkey));
        let mut session = RecordingSession::default();
        let message = publish_request_message(&fixture, 41, 1_710_001_000_000);

        let outcome = handle_worker_message_flow(
            &mut session,
            &mut runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-alpha",
                message: &message,
                observed_at: 1_710_001_000_050,
                publish: Some(WorkerMessagePublishContext {
                    accepted_at: 1_710_001_000_100,
                    result_sequence: 900,
                    result_timestamp: 1_710_001_000_200,
                }),
                terminal: None,
            },
        )
        .expect("publish request message flow must succeed");

        match outcome {
            WorkerMessageFlowOutcome::PublishRequestHandled { outcome } => {
                assert_eq!(outcome.acceptance.record.event.id, fixture.signed.id);
                assert_eq!(
                    session.sent_messages,
                    vec![outcome.acceptance.publish_result]
                );
            }
            other => panic!("expected publish outcome, got {other:?}"),
        }
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending publish record must read")
                .is_some()
        );
        assert!(runtime_state.get_worker("worker-alpha").is_some());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn handles_terminal_result_through_terminal_flow_and_removes_runtime_worker() {
        let daemon_dir = unique_temp_daemon_dir();
        append_initial_ral_records(&daemon_dir);
        append_initial_dispatch_records(&daemon_dir);
        let scheduler = RalScheduler::from_daemon_dir(&daemon_dir).expect("scheduler must replay");
        let dispatch_state = replay_dispatch_queue(&daemon_dir).expect("queue must replay");
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");
        let allocation_lock_path = locks.allocation.path.clone();
        let state_lock_path = locks.state.path.clone();
        let mut runtime_state = runtime_state_for(identity());
        let mut session = RecordingSession::default();

        let outcome = handle_worker_message_flow(
            &mut session,
            &mut runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-alpha",
                message: &fixture_valid_message("complete"),
                observed_at: 1_710_000_500_050,
                publish: None,
                terminal: Some(WorkerMessageTerminalContext {
                    scheduler: &scheduler,
                    dispatch_state: &dispatch_state,
                    result_context: result_context(),
                    dispatch: Some(dispatch_input()),
                    locks,
                }),
            },
        )
        .expect("terminal message flow must succeed");

        match outcome {
            WorkerMessageFlowOutcome::TerminalResultHandled {
                outcome,
                removed_worker,
            } => {
                assert_eq!(outcome.message.metadata.message_type, "complete");
                assert_eq!(removed_worker.worker_id, "worker-alpha");
            }
            other => panic!("expected terminal outcome, got {other:?}"),
        }
        assert!(runtime_state.is_empty());
        assert!(session.sent_messages.is_empty());
        assert_eq!(
            read_ral_lock_info(&allocation_lock_path).expect("allocation lock must read"),
            None
        );
        assert_eq!(
            read_ral_lock_info(&state_lock_path).expect("state lock must read"),
            None
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn returns_telemetry_without_runtime_or_filesystem_side_effects() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut runtime_state = WorkerRuntimeState::default();
        let mut session = RecordingSession::default();

        let outcome = handle_worker_message_flow(
            &mut session,
            &mut runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-alpha",
                message: &fixture_valid_message("stream-delta"),
                observed_at: 1_710_000_401_500,
                publish: None,
                terminal: None,
            },
        )
        .expect("stream telemetry message flow must succeed");

        match outcome {
            WorkerMessageFlowOutcome::StreamTelemetry { message, kind } => {
                assert_eq!(message.metadata.message_type, "stream_delta");
                assert_eq!(kind, WorkerStreamTelemetryKind::StreamDelta);
            }
            other => panic!("expected telemetry outcome, got {other:?}"),
        }
        assert!(runtime_state.is_empty());
        assert!(session.sent_messages.is_empty());
        assert!(!daemon_dir.exists());
    }

    #[test]
    fn returns_boot_error_as_reconciliation_candidate() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut runtime_state = WorkerRuntimeState::default();
        let mut session = RecordingSession::default();

        let outcome = handle_worker_message_flow(
            &mut session,
            &mut runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-boot",
                message: &fixture_valid_message("boot-error"),
                observed_at: 1_710_000_401_150,
                publish: None,
                terminal: None,
            },
        )
        .expect("boot error message flow must classify");

        match outcome {
            WorkerMessageFlowOutcome::BootFailureCandidate { message, candidate } => {
                assert_eq!(message.metadata.message_type, "boot_error");
                assert_eq!(candidate.worker_id, "worker-boot");
                assert_eq!(candidate.code, "missing_agent");
                assert_eq!(
                    candidate.message,
                    "agent was not found in shared filesystem state"
                );
                assert!(!candidate.retryable);
            }
            other => panic!("expected boot failure candidate, got {other:?}"),
        }
        assert!(runtime_state.is_empty());
        assert!(session.sent_messages.is_empty());
        assert!(!daemon_dir.exists());
    }

    #[test]
    fn rejects_terminal_message_without_terminal_context_before_side_effects() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut runtime_state = runtime_state_for(identity());
        let mut session = RecordingSession::default();

        let error = handle_worker_message_flow(
            &mut session,
            &mut runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-alpha",
                message: &fixture_valid_message("complete"),
                observed_at: 1_710_000_500_050,
                publish: None,
                terminal: None,
            },
        )
        .expect_err("terminal message needs terminal context");

        assert!(matches!(
            error,
            WorkerMessageFlowError::MissingTerminalContext { .. }
        ));
        assert!(runtime_state.get_worker("worker-alpha").is_some());
        assert!(session.sent_messages.is_empty());
        assert!(!daemon_dir.exists());
    }

    fn runtime_state_for(identity: RalJournalIdentity) -> WorkerRuntimeState {
        let mut state = WorkerRuntimeState::default();
        state
            .register_started_dispatch(WorkerRuntimeStartedDispatch {
                worker_id: "worker-alpha".to_string(),
                pid: 4242,
                dispatch_id: "dispatch-alpha".to_string(),
                identity,
                claim_token: "claim-alpha".to_string(),
                started_at: 1_710_000_400_500,
            })
            .expect("runtime worker must register");
        state
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

    fn result_context() -> WorkerResultTransitionContext {
        WorkerResultTransitionContext {
            worker_id: "worker-alpha".to_string(),
            claim_token: "claim-alpha".to_string(),
            journal_sequence: 200,
            journal_timestamp: 1_710_000_500_000,
            writer_version: "test-version".to_string(),
            resolved_pending_delegations: Vec::new(),
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

    fn publish_request_message(
        fixture: &Nip01EventFixture,
        sequence: u64,
        timestamp: u64,
    ) -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_request",
            "correlationId": "rust_worker_publish",
            "sequence": sequence,
            "timestamp": timestamp,
            "projectId": "project-alpha",
            "agentPubkey": fixture.pubkey,
            "conversationId": "conversation-alpha",
            "ralNumber": 3,
            "requestId": "publish-fixture-01",
            "requiresEventId": true,
            "timeoutMs": 30000,
            "runtimeEventClass": "complete",
            "event": fixture.signed,
        })
    }

    fn identity() -> RalJournalIdentity {
        identity_with_agent(&"a".repeat(64))
    }

    fn identity_with_agent(agent_pubkey: &str) -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: "project-alpha".to_string(),
            agent_pubkey: agent_pubkey.to_string(),
            conversation_id: "conversation-alpha".to_string(),
            ral_number: 3,
        }
    }

    fn signed_event_fixture() -> Nip01EventFixture {
        serde_json::from_str(STREAM_TEXT_DELTA_FIXTURE).expect("fixture must parse")
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
        std::env::temp_dir().join(format!("tenex-worker-message-flow-test-{nanos}-{counter}"))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if let Err(error) = fs::remove_dir_all(path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            panic!("temp daemon dir cleanup must succeed: {error}");
        }
    }
}
