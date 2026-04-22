use std::error::Error;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::worker_dispatch_execution::WorkerDispatchSession;
use crate::worker_frame_pump::WorkerFrameReceiver;
use crate::worker_message_flow::{
    WorkerMessageFlowError, WorkerMessageFlowInput, WorkerMessageFlowOutcome,
    WorkerMessagePublishContext, WorkerMessageTerminalContext, handle_worker_message_flow,
};
use crate::worker_protocol::{WorkerProtocolError, decode_agent_worker_protocol_frame};
use crate::worker_runtime_state::WorkerRuntimeState;

#[derive(Debug)]
pub struct WorkerSessionLoopInput<'a> {
    pub daemon_dir: &'a Path,
    pub runtime_state: &'a mut WorkerRuntimeState,
    pub worker_id: &'a str,
    pub observed_at: u64,
    pub publish: Option<WorkerMessagePublishContext>,
    pub terminal: Option<WorkerMessageTerminalContext<'a>>,
    pub max_frames: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerSessionLoopFinalReason {
    TerminalResultHandled,
    BootFailureCandidate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSessionLoopOutcome {
    pub frame_count: u64,
    pub final_reason: WorkerSessionLoopFinalReason,
}

#[derive(Debug, Error)]
pub enum WorkerSessionLoopError<E>
where
    E: Error + Send + Sync + 'static,
{
    #[error("worker frame receive failed: {source}")]
    Receive {
        #[source]
        source: E,
    },
    #[error("worker frame decode failed: {source}")]
    Decode {
        #[source]
        source: WorkerProtocolError,
    },
    #[error("worker message flow failed: {source}")]
    MessageFlow {
        #[source]
        source: WorkerMessageFlowError,
    },
    #[error("worker session loop exceeded max frame count {max_frames} after {frame_count} frames")]
    MaxFrameLimitExceeded { frame_count: u64, max_frames: u64 },
}

pub fn run_worker_session_loop<S>(
    worker: &mut S,
    mut input: WorkerSessionLoopInput<'_>,
) -> Result<WorkerSessionLoopOutcome, WorkerSessionLoopError<<S as WorkerFrameReceiver>::Error>>
where
    S: WorkerFrameReceiver + WorkerDispatchSession<Error = <S as WorkerFrameReceiver>::Error>,
{
    let mut frame_count = 0_u64;

    loop {
        if frame_count >= input.max_frames {
            return Err(WorkerSessionLoopError::MaxFrameLimitExceeded {
                frame_count,
                max_frames: input.max_frames,
            });
        }

        let frame = worker
            .receive_worker_frame()
            .map_err(|source| WorkerSessionLoopError::Receive { source })?;
        let decoded_message = decode_agent_worker_protocol_frame(&frame)
            .map_err(|source| WorkerSessionLoopError::Decode { source })?;
        let terminal = if is_terminal_message(&decoded_message) {
            input.terminal.take()
        } else {
            None
        };

        let outcome = handle_worker_message_flow(
            worker,
            input.runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: input.daemon_dir,
                worker_id: input.worker_id,
                message: &decoded_message,
                observed_at: input.observed_at,
                publish: input.publish,
                terminal,
            },
        )
        .map_err(|source| WorkerSessionLoopError::MessageFlow { source })?;

        frame_count += 1;

        match outcome {
            WorkerMessageFlowOutcome::TerminalResultHandled { .. } => {
                return Ok(WorkerSessionLoopOutcome {
                    frame_count,
                    final_reason: WorkerSessionLoopFinalReason::TerminalResultHandled,
                });
            }
            WorkerMessageFlowOutcome::BootFailureCandidate { .. } => {
                return Ok(WorkerSessionLoopOutcome {
                    frame_count,
                    final_reason: WorkerSessionLoopFinalReason::BootFailureCandidate,
                });
            }
            WorkerMessageFlowOutcome::HeartbeatUpdated { .. }
            | WorkerMessageFlowOutcome::PublishRequestHandled { .. }
            | WorkerMessageFlowOutcome::ControlTelemetry { .. }
            | WorkerMessageFlowOutcome::StreamTelemetry { .. }
            | WorkerMessageFlowOutcome::PublishedNotification { .. } => {}
        }
    }
}

fn is_terminal_message(message: &Value) -> bool {
    matches!(
        message.get("type").and_then(Value::as_str),
        Some("waiting_for_delegation" | "complete" | "no_response" | "aborted" | "error")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecord, DispatchQueueRecordParams, DispatchQueueState, DispatchQueueStatus,
        DispatchRalIdentity, build_dispatch_queue_record, replay_dispatch_queue_records,
    };
    use crate::nostr_event::Nip01EventFixture;
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
        RalJournalReplay, replay_ral_journal_records,
    };
    use crate::ral_lock::build_ral_lock_info;
    use crate::ral_scheduler::RalScheduler;
    use crate::worker_completion::WorkerCompletionDispatchInput;
    use crate::worker_launch::{RalAllocationLockScope, RalStateLockScope, WorkerLaunchPlan};
    use crate::worker_launch_lock::acquire_worker_launch_locks;
    use crate::worker_process::{
        AgentWorkerProcess, AgentWorkerProcessConfig, bun_agent_worker_command,
    };
    use crate::worker_protocol::{WorkerProtocolFixture, encode_agent_worker_protocol_frame};
    use crate::worker_runtime_state::{WorkerRuntimeStartedDispatch, WorkerRuntimeState};
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::error::Error;
    use std::fmt;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const WORKER_PROTOCOL_FIXTURE: &str = include_str!(
        "../../../src/test-utils/fixtures/worker-protocol/agent-execution.compat.json"
    );
    const STREAM_TEXT_DELTA_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json");

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("crate must live under repo_root/crates/tenex-daemon")
            .to_path_buf()
    }

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug, Default)]
    struct RecordingWorker {
        incoming_frames: VecDeque<Vec<u8>>,
        sent_messages: Vec<Value>,
        receive_error: Option<FakeWorkerError>,
        send_error: Option<FakeWorkerError>,
    }

    impl WorkerFrameReceiver for RecordingWorker {
        type Error = FakeWorkerError;

        fn receive_worker_frame(&mut self) -> Result<Vec<u8>, Self::Error> {
            if let Some(error) = self.receive_error.clone() {
                return Err(error);
            }

            self.incoming_frames
                .pop_front()
                .ok_or(FakeWorkerError("missing frame"))
        }
    }

    impl WorkerDispatchSession for RecordingWorker {
        type Error = FakeWorkerError;

        fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error> {
            self.sent_messages.push(message.clone());

            if let Some(error) = self.send_error.clone() {
                return Err(error);
            }

            Ok(())
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct FakeWorkerError(&'static str);

    impl fmt::Display for FakeWorkerError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    impl Error for FakeWorkerError {}

    #[test]
    fn heartbeat_then_terminal_result_stops_the_session_loop() {
        let daemon_dir = unique_temp_daemon_dir();
        let scheduler = scheduler_from_records();
        let dispatch_state = dispatch_state_from_records();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");

        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([
                frame_for(&fixture_valid_message("heartbeat")),
                frame_for(&fixture_valid_message("complete")),
            ]),
            ..Default::default()
        };
        let mut runtime_state = runtime_state_for("worker-alpha", identity());

        let outcome = run_worker_session_loop(
            &mut worker,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &mut runtime_state,
                worker_id: "worker-alpha",
                observed_at: 1_710_000_403_000,
                publish: None,
                terminal: Some(WorkerMessageTerminalContext {
                    scheduler: &scheduler,
                    dispatch_state: &dispatch_state,
                    result_context: result_context(),
                    dispatch: Some(dispatch_input()),
                    locks,
                }),
                max_frames: 4,
            },
        )
        .expect("session loop must stop on terminal frame");

        assert_eq!(outcome.frame_count, 2);
        assert_eq!(
            outcome.final_reason,
            WorkerSessionLoopFinalReason::TerminalResultHandled
        );
        assert!(runtime_state.get_worker("worker-alpha").is_none());
        assert!(worker.sent_messages.is_empty());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn publish_request_then_continuation_keeps_running_until_boot_failure_candidate() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let publish_request = publish_request_message(&fixture, 41, 1_710_001_000_000);

        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([
                frame_for(&publish_request),
                frame_for(&fixture_valid_message("boot-error")),
            ]),
            ..Default::default()
        };
        let mut runtime_state =
            runtime_state_for("worker-alpha", identity_with_agent(&fixture.pubkey));

        let outcome = run_worker_session_loop(
            &mut worker,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &mut runtime_state,
                worker_id: "worker-alpha",
                observed_at: 1_710_000_403_000,
                publish: Some(WorkerMessagePublishContext {
                    accepted_at: 1_710_001_000_100,
                    result_sequence: 900,
                    result_timestamp: 1_710_001_000_200,
                }),
                terminal: None,
                max_frames: 4,
            },
        )
        .expect("publish request must continue into the next frame");

        assert_eq!(outcome.frame_count, 2);
        assert_eq!(
            outcome.final_reason,
            WorkerSessionLoopFinalReason::BootFailureCandidate
        );
        assert_eq!(worker.sent_messages.len(), 1);
        assert_eq!(worker.sent_messages[0]["type"], "publish_result");
        assert_eq!(worker.sent_messages[0]["status"], "accepted");
        assert!(runtime_state.get_worker("worker-alpha").is_some());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn boot_failure_candidate_stops_the_session_loop() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([frame_for(&fixture_valid_message("boot-error"))]),
            ..Default::default()
        };
        let mut runtime_state = runtime_state_for("worker-alpha", identity());

        let outcome = run_worker_session_loop(
            &mut worker,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &mut runtime_state,
                worker_id: "worker-alpha",
                observed_at: 1_710_000_403_000,
                publish: None,
                terminal: None,
                max_frames: 4,
            },
        )
        .expect("boot error must stop the loop");

        assert_eq!(outcome.frame_count, 1);
        assert_eq!(
            outcome.final_reason,
            WorkerSessionLoopFinalReason::BootFailureCandidate
        );
        assert!(worker.sent_messages.is_empty());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn malformed_frame_returns_decode_error() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([vec![0, 1, 2]]),
            ..Default::default()
        };
        let mut runtime_state = runtime_state_for("worker-alpha", identity());

        let error = run_worker_session_loop(
            &mut worker,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &mut runtime_state,
                worker_id: "worker-alpha",
                observed_at: 1_710_000_403_000,
                publish: None,
                terminal: None,
                max_frames: 4,
            },
        )
        .expect_err("malformed frame must be rejected");

        assert!(matches!(error, WorkerSessionLoopError::Decode { .. }));

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn max_frame_limit_is_enforced_before_a_second_iteration() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([frame_for(&fixture_valid_message("heartbeat"))]),
            ..Default::default()
        };
        let mut runtime_state = runtime_state_for("worker-alpha", identity());

        let error = run_worker_session_loop(
            &mut worker,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &mut runtime_state,
                worker_id: "worker-alpha",
                observed_at: 1_710_000_403_000,
                publish: None,
                terminal: None,
                max_frames: 1,
            },
        )
        .expect_err("loop must stop when the frame cap is reached");

        assert!(matches!(
            error,
            WorkerSessionLoopError::MaxFrameLimitExceeded {
                frame_count: 1,
                max_frames: 1,
            }
        ));

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    #[ignore = "requires Bun and repo TypeScript dependencies"]
    fn bun_agent_worker_session_loop_handles_real_process_to_completion() {
        let daemon_dir = unique_temp_daemon_dir();
        let scheduler = scheduler_from_records();
        let dispatch_state = dispatch_state_from_records();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");
        let execute_message = fixture_valid_message("execute");
        let identity = identity_from_message(&execute_message);

        let bun = std::env::var("BUN_BIN").unwrap_or_else(|_| "bun".to_string());
        let command = bun_agent_worker_command(&repo_root(), bun)
            .env("TENEX_AGENT_WORKER_ENGINE", "mock")
            .env("LOG_LEVEL", "silent");
        let mut worker = AgentWorkerProcess::spawn(
            &command,
            &AgentWorkerProcessConfig {
                boot_timeout: Duration::from_secs(5),
            },
        )
        .expect("agent worker must boot");
        let worker_id = worker.ready.worker_id.clone();
        let mut runtime_state = runtime_state_for(&worker_id, identity);

        worker
            .process
            .send_message(&execute_message)
            .expect("execute must send");

        let outcome = run_worker_session_loop(
            &mut worker.process,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &mut runtime_state,
                worker_id: &worker_id,
                observed_at: 1_710_000_403_000,
                publish: None,
                terminal: Some(WorkerMessageTerminalContext {
                    scheduler: &scheduler,
                    dispatch_state: &dispatch_state,
                    result_context: result_context(),
                    dispatch: Some(dispatch_input()),
                    locks,
                }),
                max_frames: 8,
            },
        )
        .expect("session loop must stop on terminal frame");

        assert_eq!(outcome.frame_count, 3);
        assert_eq!(
            outcome.final_reason,
            WorkerSessionLoopFinalReason::TerminalResultHandled
        );
        assert!(runtime_state.get_worker(&worker_id).is_none());

        let status = worker
            .process
            .wait_for_exit(Duration::from_secs(5))
            .expect("worker must exit");
        assert!(status.success(), "worker exited with {status}");

        cleanup_temp_dir(daemon_dir);
    }

    fn frame_for(message: &Value) -> Vec<u8> {
        encode_agent_worker_protocol_frame(message).expect("frame must encode")
    }

    fn identity_from_message(message: &Value) -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: message
                .get("projectId")
                .and_then(Value::as_str)
                .expect("message must include projectId")
                .to_string(),
            agent_pubkey: message
                .get("agentPubkey")
                .and_then(Value::as_str)
                .expect("message must include agentPubkey")
                .to_string(),
            conversation_id: message
                .get("conversationId")
                .and_then(Value::as_str)
                .expect("message must include conversationId")
                .to_string(),
            ral_number: message
                .get("ralNumber")
                .and_then(Value::as_u64)
                .expect("message must include ralNumber"),
        }
    }

    fn runtime_state_for(worker_id: &str, identity: RalJournalIdentity) -> WorkerRuntimeState {
        let mut state = WorkerRuntimeState::default();
        state
            .register_started_dispatch(WorkerRuntimeStartedDispatch {
                worker_id: worker_id.to_string(),
                pid: 4242,
                dispatch_id: "dispatch-alpha".to_string(),
                identity,
                claim_token: "claim-alpha".to_string(),
                started_at: 1_710_000_400_500,
            })
            .expect("worker runtime must register");
        state
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

    fn result_context() -> crate::worker_result::WorkerResultTransitionContext {
        crate::worker_result::WorkerResultTransitionContext {
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
            "version": crate::worker_protocol::AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_request",
            "correlationId": "rust_worker_session_loop",
            "sequence": sequence,
            "timestamp": timestamp,
            "projectId": "project-alpha",
            "agentPubkey": fixture.pubkey,
            "conversationId": "conversation-alpha",
            "ralNumber": 3,
            "requestId": "publish-fixture-01",
            "requiresEventId": true,
            "timeoutMs": 30_000,
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
        let fixture: WorkerProtocolFixture =
            serde_json::from_str(WORKER_PROTOCOL_FIXTURE).expect("fixture must parse");
        fixture
            .valid_messages
            .iter()
            .find(|message| message.name == name)
            .unwrap_or_else(|| panic!("fixture message {name} must exist"))
            .message
            .clone()
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tenex-worker-session-loop-test-{nanos}-{counter}"))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if let Err(error) = fs::remove_dir_all(path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            panic!("temp daemon dir cleanup must succeed: {error}");
        }
    }
}
