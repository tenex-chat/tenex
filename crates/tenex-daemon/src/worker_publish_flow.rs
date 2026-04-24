use std::error::Error;
use std::path::Path;

use serde_json::Value;
use thiserror::Error;

use crate::worker_dispatch::execution::WorkerDispatchSession;
use crate::worker_message::{
    WorkerMessageAction, WorkerMessageError, WorkerMessagePlan, plan_worker_message_handling,
};
use crate::worker_publish::{
    WorkerPublishAcceptance, WorkerPublishAcceptanceInput, WorkerPublishError,
    accept_worker_publish_and_build_result,
};
use crate::worker_telegram_egress::WorkerTelegramEgressContext;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerPublishFlowInput<'a> {
    pub daemon_dir: &'a Path,
    pub message: &'a Value,
    pub accepted_at: u64,
    pub result_sequence: u64,
    pub result_timestamp: u64,
    pub telegram_egress: Option<WorkerTelegramEgressContext<'a>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerPublishFlowOutcome {
    pub message_plan: WorkerMessagePlan,
    pub acceptance: WorkerPublishAcceptance,
    pub result_delivery: WorkerPublishResultDelivery,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerPublishResultDelivery {
    Sent,
    WorkerPipeClosedAfterAcceptance { error: String },
}

impl WorkerPublishResultDelivery {
    pub fn worker_pipe_closed_after_acceptance(&self) -> Option<&str> {
        match self {
            Self::Sent => None,
            Self::WorkerPipeClosedAfterAcceptance { error } => Some(error),
        }
    }
}

#[derive(Debug, Error)]
pub enum WorkerPublishFlowError {
    #[error("worker publish message classification failed: {source}")]
    Message {
        #[source]
        source: Box<WorkerMessageError>,
    },
    #[error("worker message type {message_type} cannot be handled as publish_request: {action:?}")]
    UnexpectedAction {
        message_type: String,
        action: WorkerMessageAction,
    },
    #[error("worker publish request acceptance failed: {source}")]
    Publish {
        #[source]
        source: Box<WorkerPublishError>,
    },
    #[error("publish_result send failed after outbox acceptance: {source}")]
    SendPublishResult {
        acceptance: Box<WorkerPublishAcceptance>,
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
}

pub fn handle_worker_publish_request<S>(
    session: &mut S,
    input: WorkerPublishFlowInput<'_>,
) -> Result<WorkerPublishFlowOutcome, WorkerPublishFlowError>
where
    S: WorkerDispatchSession,
{
    let message_plan =
        plan_worker_message_handling(input.message).map_err(WorkerPublishFlowError::from)?;

    if message_plan.action != WorkerMessageAction::PublishRequestCandidate {
        return Err(WorkerPublishFlowError::UnexpectedAction {
            message_type: message_plan.metadata.message_type.clone(),
            action: message_plan.action,
        });
    }

    let acceptance = accept_worker_publish_and_build_result(WorkerPublishAcceptanceInput {
        daemon_dir: input.daemon_dir,
        message: &message_plan.message,
        accepted_at: input.accepted_at,
        result_sequence: input.result_sequence,
        result_timestamp: input.result_timestamp,
        telegram_egress: input.telegram_egress,
    })
    .map_err(WorkerPublishFlowError::from)?;

    let result_delivery = if let Err(source) =
        session.send_worker_message(&acceptance.publish_result)
    {
        if S::is_worker_pipe_closed_error(&source) {
            let error = source.to_string();
            tracing::warn!(
                event_id = %acceptance.egress.event_id(),
                error = %error,
                "publish_result could not be delivered because worker pipe closed after publish acceptance"
            );
            WorkerPublishResultDelivery::WorkerPipeClosedAfterAcceptance { error }
        } else {
            return Err(WorkerPublishFlowError::SendPublishResult {
                acceptance: Box::new(acceptance),
                source: Box::new(source),
            });
        }
    } else {
        WorkerPublishResultDelivery::Sent
    };

    Ok(WorkerPublishFlowOutcome {
        message_plan,
        acceptance,
        result_delivery,
    })
}

impl From<WorkerMessageError> for WorkerPublishFlowError {
    fn from(source: WorkerMessageError) -> Self {
        Self::Message {
            source: Box::new(source),
        }
    }
}

impl From<WorkerPublishError> for WorkerPublishFlowError {
    fn from(source: WorkerPublishError) -> Self {
        Self::Publish {
            source: Box::new(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr_event::Nip01EventFixture;
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use crate::worker_protocol::{
        AGENT_WORKER_PROTOCOL_VERSION, WorkerProtocolDirection,
        validate_agent_worker_protocol_message,
    };
    use serde_json::json;
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
        send_error: Option<FakeSendError>,
    }

    impl WorkerDispatchSession for RecordingSession {
        type Error = FakeSendError;

        fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error> {
            self.sent_messages.push(message.clone());

            if let Some(error) = self.send_error.clone() {
                return Err(error);
            }

            Ok(())
        }

        fn is_worker_pipe_closed_error(error: &Self::Error) -> bool {
            error.0 == "broken pipe"
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
    fn accepts_publish_request_persists_outbox_and_sends_result() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let message = publish_request_message(&fixture, 41, 1_710_001_000_000);
        let mut session = RecordingSession::default();

        let outcome = handle_worker_publish_request(
            &mut session,
            WorkerPublishFlowInput {
                daemon_dir: &daemon_dir,
                message: &message,
                accepted_at: 1_710_001_000_100,
                result_sequence: 900,
                result_timestamp: 1_710_001_000_200,
                telegram_egress: None,
            },
        )
        .expect("publish request flow must succeed");

        assert_eq!(
            outcome.message_plan.action,
            WorkerMessageAction::PublishRequestCandidate
        );
        assert_eq!(
            outcome
                .acceptance
                .egress
                .as_nostr()
                .expect("default worker publish must route to Nostr")
                .event
                .id,
            fixture.signed.id
        );
        assert_eq!(
            session.sent_messages,
            vec![outcome.acceptance.publish_result.clone()]
        );
        assert_eq!(outcome.result_delivery, WorkerPublishResultDelivery::Sent);
        assert_eq!(session.sent_messages[0]["type"], "publish_result");
        assert_eq!(session.sent_messages[0]["status"], "accepted");
        assert_eq!(session.sent_messages[0]["requestSequence"], 41);
        assert_eq!(session.sent_messages[0]["sequence"], 900);
        assert_eq!(
            validate_agent_worker_protocol_message(&session.sent_messages[0])
                .expect("publish_result must validate"),
            WorkerProtocolDirection::DaemonToWorker
        );
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_some()
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn rejects_non_publish_messages_before_outbox_or_send() {
        let daemon_dir = unique_temp_daemon_dir();
        let message = fixture_valid_message("heartbeat");
        let mut session = RecordingSession::default();

        let error = handle_worker_publish_request(
            &mut session,
            WorkerPublishFlowInput {
                daemon_dir: &daemon_dir,
                message: &message,
                accepted_at: 1_710_001_000_100,
                result_sequence: 900,
                result_timestamp: 1_710_001_000_200,
                telegram_egress: None,
            },
        )
        .expect_err("heartbeat must not run publish flow");

        match error {
            WorkerPublishFlowError::UnexpectedAction {
                message_type,
                action,
            } => {
                assert_eq!(message_type, "heartbeat");
                assert_eq!(action, WorkerMessageAction::HeartbeatSnapshotCandidate);
            }
            other => panic!("expected unexpected action, got {other:?}"),
        }
        assert!(session.sent_messages.is_empty());
        assert!(!daemon_dir.exists());
    }

    #[test]
    fn reports_send_failure_after_persisting_accepted_outbox_record() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let message = publish_request_message(&fixture, 41, 1_710_001_000_000);
        let mut session = RecordingSession {
            sent_messages: Vec::new(),
            send_error: Some(FakeSendError("send failed")),
        };

        let error = handle_worker_publish_request(
            &mut session,
            WorkerPublishFlowInput {
                daemon_dir: &daemon_dir,
                message: &message,
                accepted_at: 1_710_001_000_100,
                result_sequence: 900,
                result_timestamp: 1_710_001_000_200,
                telegram_egress: None,
            },
        )
        .expect_err("send failure must be reported");

        match error {
            WorkerPublishFlowError::SendPublishResult { acceptance, .. } => {
                assert_eq!(
                    acceptance
                        .egress
                        .as_nostr()
                        .expect("default worker publish must route to Nostr")
                        .event
                        .id,
                    fixture.signed.id
                );
                assert_eq!(acceptance.publish_result, session.sent_messages[0]);
            }
            other => panic!("expected send failure, got {other:?}"),
        }
        assert_eq!(session.sent_messages.len(), 1);
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_some()
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn treats_closed_worker_pipe_after_acceptance_as_delivered_terminal_diagnostic() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let message = publish_request_message(&fixture, 41, 1_710_001_000_000);
        let mut session = RecordingSession {
            sent_messages: Vec::new(),
            send_error: Some(FakeSendError("broken pipe")),
        };

        let outcome = handle_worker_publish_request(
            &mut session,
            WorkerPublishFlowInput {
                daemon_dir: &daemon_dir,
                message: &message,
                accepted_at: 1_710_001_000_100,
                result_sequence: 900,
                result_timestamp: 1_710_001_000_200,
                telegram_egress: None,
            },
        )
        .expect("closed worker pipe after acceptance must not fail publish flow");

        assert_eq!(
            outcome.result_delivery,
            WorkerPublishResultDelivery::WorkerPipeClosedAfterAcceptance {
                error: "broken pipe".to_string(),
            }
        );
        assert_eq!(session.sent_messages.len(), 1);
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending record read must succeed")
                .is_some()
        );

        cleanup_temp_dir(daemon_dir);
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
            "ralNumber": 7,
            "requestId": "publish-fixture-01",
            "waitForRelayOk": true,
            "timeoutMs": 30000,
            "runtimeEventClass": "complete",
            "event": fixture.signed,
        })
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

    fn signed_event_fixture() -> Nip01EventFixture {
        serde_json::from_str(STREAM_TEXT_DELTA_FIXTURE).expect("fixture must parse")
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tenex-worker-publish-flow-test-{nanos}-{counter}"))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if path.exists() {
            fs::remove_dir_all(path).expect("temp daemon dir cleanup must succeed");
        }
    }
}
