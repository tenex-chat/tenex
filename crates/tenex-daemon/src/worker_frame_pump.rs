use std::error::Error;

use serde_json::Value;
use thiserror::Error;

use crate::worker_dispatch_execution::WorkerDispatchSession;
use crate::worker_message_flow::{
    WorkerMessageFlowError, WorkerMessageFlowInput, WorkerMessageFlowOutcome,
    handle_worker_message_flow,
};
use crate::worker_protocol::{WorkerProtocolError, decode_agent_worker_protocol_frame};
use crate::worker_runtime_state::WorkerRuntimeState;

pub trait WorkerFrameReceiver {
    type Error: Error + Send + Sync + 'static;

    fn receive_worker_frame(&mut self) -> Result<Vec<u8>, Self::Error>;
}

#[derive(Debug)]
pub struct WorkerFramePumpInput<'a> {
    pub runtime_state: &'a mut WorkerRuntimeState,
    pub message_flow: WorkerMessageFlowInput<'a>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerFramePumpOutcome {
    pub decoded_message: Value,
    pub message_flow: WorkerMessageFlowOutcome,
}

#[derive(Debug, Error)]
pub enum WorkerFramePumpError<E>
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
}

pub fn pump_worker_frame<S>(
    worker: &mut S,
    input: WorkerFramePumpInput<'_>,
) -> Result<WorkerFramePumpOutcome, WorkerFramePumpError<<S as WorkerFrameReceiver>::Error>>
where
    S: WorkerFrameReceiver + WorkerDispatchSession<Error = <S as WorkerFrameReceiver>::Error>,
{
    let frame = worker
        .receive_worker_frame()
        .map_err(|source| WorkerFramePumpError::Receive { source })?;
    let decoded_message = decode_agent_worker_protocol_frame(&frame)
        .map_err(|source| WorkerFramePumpError::Decode { source })?;

    let WorkerFramePumpInput {
        runtime_state,
        message_flow,
    } = input;
    let WorkerMessageFlowInput {
        daemon_dir,
        worker_id,
        observed_at,
        publish,
        terminal,
        message: _,
    } = message_flow;

    let message_flow = handle_worker_message_flow(
        worker,
        runtime_state,
        WorkerMessageFlowInput {
            daemon_dir,
            worker_id,
            message: &decoded_message,
            observed_at,
            publish,
            terminal,
        },
    )
    .map_err(|source| WorkerFramePumpError::MessageFlow { source })?;

    Ok(WorkerFramePumpOutcome {
        decoded_message,
        message_flow,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr_event::CompatibilityEventFixture;
    use crate::worker_dispatch_execution::WorkerDispatchSession;
    use crate::worker_message_flow::{
        WorkerMessageFlowInput, WorkerMessageFlowOutcome, WorkerMessagePublishContext,
    };
    use crate::worker_protocol::encode_agent_worker_protocol_frame;
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::error::Error;
    use std::fmt;
    use std::fs;
    use std::path::{Path, PathBuf};

    const WORKER_PROTOCOL_FIXTURE: &str = include_str!(
        "../../../src/test-utils/fixtures/worker-protocol/agent-execution.compat.json"
    );
    const STREAM_TEXT_DELTA_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json");

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
    fn pumps_a_single_heartbeat_frame_into_worker_message_flow() {
        let message = fixture_valid_message("heartbeat");
        let identity = identity_from_message(&message);
        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([frame_for(&message)]),
            ..Default::default()
        };
        let mut runtime_state = runtime_state_for("worker-alpha", identity);

        let outcome = pump_worker_frame(
            &mut worker,
            WorkerFramePumpInput {
                runtime_state: &mut runtime_state,
                message_flow: message_flow_input(&message, "worker-alpha", None),
            },
        )
        .expect("heartbeat frame must pump");

        assert_eq!(outcome.decoded_message, message);
        assert!(matches!(
            outcome.message_flow,
            WorkerMessageFlowOutcome::HeartbeatUpdated { .. }
        ));
        assert!(worker.sent_messages.is_empty());
        assert_eq!(
            runtime_state
                .get_worker("worker-alpha")
                .expect("worker must stay active")
                .worker_id,
            "worker-alpha"
        );
    }

    #[test]
    fn pumps_publish_request_frames_and_sends_the_publish_result() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let message = publish_request_message(&fixture, 41, 1_710_001_000_000);
        let identity = identity_from_message(&message);
        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([frame_for(&message)]),
            ..Default::default()
        };
        let mut runtime_state = runtime_state_for("worker-alpha", identity);

        let outcome = pump_worker_frame(
            &mut worker,
            WorkerFramePumpInput {
                runtime_state: &mut runtime_state,
                message_flow: message_flow_input_at(
                    &daemon_dir,
                    &message,
                    "worker-alpha",
                    Some(WorkerMessagePublishContext {
                        accepted_at: 1_710_001_000_100,
                        result_sequence: 900,
                        result_timestamp: 1_710_001_000_200,
                    }),
                ),
            },
        )
        .expect("publish request frame must pump");

        assert_eq!(outcome.decoded_message, message);
        assert!(matches!(
            outcome.message_flow,
            WorkerMessageFlowOutcome::PublishRequestHandled { .. }
        ));
        assert_eq!(worker.sent_messages.len(), 1);
        assert_eq!(worker.sent_messages[0]["type"], "publish_result");
        assert_eq!(worker.sent_messages[0]["status"], "accepted");

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn rejects_malformed_frames_before_message_flow() {
        let message = fixture_valid_message("heartbeat");
        let identity = identity_from_message(&message);
        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([vec![0, 1, 2]]),
            ..Default::default()
        };
        let mut runtime_state = runtime_state_for("worker-alpha", identity);

        let error = pump_worker_frame(
            &mut worker,
            WorkerFramePumpInput {
                runtime_state: &mut runtime_state,
                message_flow: message_flow_input(&message, "worker-alpha", None),
            },
        )
        .expect_err("malformed frame must fail");

        assert!(matches!(
            error,
            WorkerFramePumpError::Decode {
                source: WorkerProtocolError::FrameTooShort { .. }
            }
        ));
        assert!(worker.sent_messages.is_empty());
    }

    fn frame_for(message: &Value) -> Vec<u8> {
        encode_agent_worker_protocol_frame(message).expect("fixture message must encode")
    }

    fn fixture_valid_message(name: &str) -> Value {
        fixture_message("validMessages", name)
    }

    fn fixture_message(section: &str, name: &str) -> Value {
        let fixture: Value =
            serde_json::from_str(WORKER_PROTOCOL_FIXTURE).expect("fixture must parse");
        fixture[section]
            .as_array()
            .unwrap_or_else(|| panic!("{section} must be an array"))
            .iter()
            .find(|message| message["name"] == name)
            .unwrap_or_else(|| panic!("fixture message {name} must exist"))["message"]
            .clone()
    }

    fn identity_from_message(message: &Value) -> crate::ral_journal::RalJournalIdentity {
        crate::ral_journal::RalJournalIdentity {
            project_id: message["projectId"]
                .as_str()
                .expect("projectId")
                .to_string(),
            agent_pubkey: message["agentPubkey"]
                .as_str()
                .expect("agentPubkey")
                .to_string(),
            conversation_id: message["conversationId"]
                .as_str()
                .expect("conversationId")
                .to_string(),
            ral_number: message["ralNumber"].as_u64().expect("ralNumber"),
        }
    }

    fn publish_request_message(
        fixture: &CompatibilityEventFixture,
        sequence: u64,
        timestamp: u64,
    ) -> Value {
        json!({
            "version": crate::worker_protocol::AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_request",
            "correlationId": "rust_worker_frame_pump",
            "sequence": sequence,
            "timestamp": timestamp,
            "projectId": "project-alpha",
            "agentPubkey": fixture.pubkey,
            "conversationId": "conversation-alpha",
            "ralNumber": 7,
            "requestId": "publish-fixture-01",
            "requiresEventId": true,
            "timeoutMs": 30_000,
            "event": fixture.signed,
        })
    }

    fn signed_event_fixture() -> CompatibilityEventFixture {
        serde_json::from_str(STREAM_TEXT_DELTA_FIXTURE).expect("fixture must parse")
    }

    fn runtime_state_for(
        worker_id: &str,
        identity: crate::ral_journal::RalJournalIdentity,
    ) -> WorkerRuntimeState {
        let mut state = WorkerRuntimeState::default();
        state
            .register_started_dispatch(crate::worker_runtime_state::WorkerRuntimeStartedDispatch {
                worker_id: worker_id.to_string(),
                pid: 1234,
                dispatch_id: "dispatch-a".to_string(),
                identity,
                claim_token: "claim-a".to_string(),
                started_at: 1_710_000_402_000,
            })
            .expect("runtime state must register");
        state
    }

    fn message_flow_input<'a>(
        message: &'a Value,
        worker_id: &'a str,
        publish: Option<WorkerMessagePublishContext>,
    ) -> WorkerMessageFlowInput<'a> {
        message_flow_input_at(
            Path::new("/tmp/tenex-worker-frame-pump"),
            message,
            worker_id,
            publish,
        )
    }

    fn message_flow_input_at<'a>(
        daemon_dir: &'a Path,
        message: &'a Value,
        worker_id: &'a str,
        publish: Option<WorkerMessagePublishContext>,
    ) -> WorkerMessageFlowInput<'a> {
        WorkerMessageFlowInput {
            daemon_dir,
            worker_id,
            message,
            observed_at: 1_710_000_403_000,
            publish,
            terminal: None,
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let daemon_dir =
            std::env::temp_dir().join(format!("tenex-worker-frame-pump-{}", std::process::id()));
        let _ = fs::remove_dir_all(&daemon_dir);
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }

    fn cleanup_temp_dir(path: PathBuf) {
        let _ = fs::remove_dir_all(path);
    }
}
