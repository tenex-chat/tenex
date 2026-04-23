use serde_json::Value;
use thiserror::Error;

use crate::worker_protocol::{
    WorkerProtocolDirection, WorkerProtocolError, validate_agent_worker_protocol_message,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerMessagePlan {
    pub metadata: WorkerMessageMetadata,
    pub action: WorkerMessageAction,
    pub message: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerMessageMetadata {
    pub message_type: String,
    pub correlation_id: String,
    pub sequence: u64,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerMessageAction {
    BootError,
    ControlTelemetry { kind: WorkerControlTelemetryKind },
    StreamTelemetry { kind: WorkerStreamTelemetryKind },
    HeartbeatSnapshotCandidate,
    TerminalResultCandidate { kind: WorkerTerminalResultKind },
    PublishRequestCandidate,
    PublishedNotification { mode: WorkerPublishedMode },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerControlTelemetryKind {
    Ready,
    Pong,
    ExecutionStarted,
    ToolCallStarted,
    ToolCallCompleted,
    ToolCallFailed,
    DelegationRegistered,
    DelegationKilled,
    SilentCompletionRequested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerStreamTelemetryKind {
    StreamDelta,
    ReasoningDelta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerTerminalResultKind {
    WaitingForDelegation,
    Complete,
    NoResponse,
    Aborted,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerPublishedMode {
    DirectWorkerPublish,
    RustPublishRequest,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkerMessageError {
    #[error("worker protocol error: {0}")]
    Protocol(#[from] WorkerProtocolError),
    #[error("worker message had invalid direction {0:?}")]
    InvalidDirection(WorkerProtocolDirection),
    #[error("worker message field is missing or invalid: {0}")]
    InvalidField(&'static str),
    #[error("worker message type {message_type} has no handling plan")]
    UnsupportedWorkerMessageType { message_type: String },
}

pub fn plan_worker_message_handling(
    message: &Value,
) -> Result<WorkerMessagePlan, WorkerMessageError> {
    let direction = validate_agent_worker_protocol_message(message)?;
    if direction != WorkerProtocolDirection::WorkerToDaemon {
        return Err(WorkerMessageError::InvalidDirection(direction));
    }

    let message_type = required_string(message, "type")?;
    let action = action_for_worker_message(message, message_type)?;

    Ok(WorkerMessagePlan {
        metadata: WorkerMessageMetadata {
            message_type: message_type.to_string(),
            correlation_id: required_string(message, "correlationId")?.to_string(),
            sequence: required_u64(message, "sequence")?,
            timestamp: required_u64(message, "timestamp")?,
        },
        action,
        message: message.clone(),
    })
}

fn action_for_worker_message(
    message: &Value,
    message_type: &str,
) -> Result<WorkerMessageAction, WorkerMessageError> {
    match message_type {
        "ready" => Ok(control(WorkerControlTelemetryKind::Ready)),
        "boot_error" => Ok(WorkerMessageAction::BootError),
        "pong" => Ok(control(WorkerControlTelemetryKind::Pong)),
        "execution_started" => Ok(control(WorkerControlTelemetryKind::ExecutionStarted)),
        "stream_delta" => Ok(stream(WorkerStreamTelemetryKind::StreamDelta)),
        "reasoning_delta" => Ok(stream(WorkerStreamTelemetryKind::ReasoningDelta)),
        "tool_call_started" => Ok(control(WorkerControlTelemetryKind::ToolCallStarted)),
        "tool_call_completed" => Ok(control(WorkerControlTelemetryKind::ToolCallCompleted)),
        "tool_call_failed" => Ok(control(WorkerControlTelemetryKind::ToolCallFailed)),
        "delegation_registered" => Ok(control(WorkerControlTelemetryKind::DelegationRegistered)),
        "delegation_killed" => Ok(control(WorkerControlTelemetryKind::DelegationKilled)),
        "waiting_for_delegation" => Ok(terminal(WorkerTerminalResultKind::WaitingForDelegation)),
        "publish_request" => Ok(WorkerMessageAction::PublishRequestCandidate),
        "published" => Ok(WorkerMessageAction::PublishedNotification {
            mode: published_mode(message)?,
        }),
        "complete" => Ok(terminal(WorkerTerminalResultKind::Complete)),
        "silent_completion_requested" => Ok(control(
            WorkerControlTelemetryKind::SilentCompletionRequested,
        )),
        "no_response" => Ok(terminal(WorkerTerminalResultKind::NoResponse)),
        "aborted" => Ok(terminal(WorkerTerminalResultKind::Aborted)),
        "error" => Ok(terminal(WorkerTerminalResultKind::Error)),
        "heartbeat" => Ok(WorkerMessageAction::HeartbeatSnapshotCandidate),
        _ => Err(WorkerMessageError::UnsupportedWorkerMessageType {
            message_type: message_type.to_string(),
        }),
    }
}

fn control(kind: WorkerControlTelemetryKind) -> WorkerMessageAction {
    WorkerMessageAction::ControlTelemetry { kind }
}

fn stream(kind: WorkerStreamTelemetryKind) -> WorkerMessageAction {
    WorkerMessageAction::StreamTelemetry { kind }
}

fn terminal(kind: WorkerTerminalResultKind) -> WorkerMessageAction {
    WorkerMessageAction::TerminalResultCandidate { kind }
}

fn published_mode(message: &Value) -> Result<WorkerPublishedMode, WorkerMessageError> {
    match required_string(message, "mode")? {
        "direct_worker_publish" => Ok(WorkerPublishedMode::DirectWorkerPublish),
        "rust_publish_request" => Ok(WorkerPublishedMode::RustPublishRequest),
        _ => Err(WorkerMessageError::InvalidField("mode")),
    }
}

fn required_string<'a>(
    message: &'a Value,
    field: &'static str,
) -> Result<&'a str, WorkerMessageError> {
    message
        .get(field)
        .and_then(Value::as_str)
        .ok_or(WorkerMessageError::InvalidField(field))
}

fn required_u64(message: &Value, field: &'static str) -> Result<u64, WorkerMessageError> {
    message
        .get(field)
        .and_then(Value::as_u64)
        .ok_or(WorkerMessageError::InvalidField(field))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKER_PROTOCOL_FIXTURE: &str = include_str!(
        "../../../src/test-utils/fixtures/worker-protocol/agent-execution.compat.json"
    );

    #[test]
    fn routes_heartbeat_as_snapshot_candidate_from_shared_fixture() {
        let message = fixture_valid_message("heartbeat");

        let plan = plan_worker_message_handling(&message).expect("heartbeat message must classify");

        assert_eq!(
            plan.metadata,
            WorkerMessageMetadata {
                message_type: "heartbeat".to_string(),
                correlation_id: "exec_01hzzzzzzzzzzzzzzzzzzzzzzz".to_string(),
                sequence: 20,
                timestamp: 1_710_000_402_900,
            }
        );
        assert_eq!(plan.action, WorkerMessageAction::HeartbeatSnapshotCandidate);
        assert_eq!(plan.message, message);
    }

    #[test]
    fn routes_terminal_results_without_building_ral_transitions() {
        assert_terminal(
            "waiting-for-delegation",
            WorkerTerminalResultKind::WaitingForDelegation,
        );
        assert_terminal("complete", WorkerTerminalResultKind::Complete);
        assert_terminal("no-response", WorkerTerminalResultKind::NoResponse);
        assert_terminal("aborted", WorkerTerminalResultKind::Aborted);
        assert_terminal("error", WorkerTerminalResultKind::Error);
    }

    #[test]
    fn routes_publish_request_and_published_notifications() {
        let publish_request =
            plan_worker_message_handling(&fixture_valid_message("publish-request"))
                .expect("publish_request message must classify");
        assert_eq!(
            publish_request.action,
            WorkerMessageAction::PublishRequestCandidate
        );
        assert_eq!(publish_request.metadata.sequence, 13);

        let published = plan_worker_message_handling(&fixture_valid_message("published"))
            .expect("published message must classify");
        assert_eq!(
            published.action,
            WorkerMessageAction::PublishedNotification {
                mode: WorkerPublishedMode::DirectWorkerPublish,
            }
        );
        assert_eq!(published.metadata.sequence, 14);
    }

    #[test]
    fn routes_boot_control_and_stream_telemetry_messages() {
        assert_action("boot-error", WorkerMessageAction::BootError);
        assert_action(
            "ready",
            WorkerMessageAction::ControlTelemetry {
                kind: WorkerControlTelemetryKind::Ready,
            },
        );
        assert_action(
            "pong",
            WorkerMessageAction::ControlTelemetry {
                kind: WorkerControlTelemetryKind::Pong,
            },
        );
        assert_action(
            "execution-started",
            WorkerMessageAction::ControlTelemetry {
                kind: WorkerControlTelemetryKind::ExecutionStarted,
            },
        );
        assert_action(
            "stream-delta",
            WorkerMessageAction::StreamTelemetry {
                kind: WorkerStreamTelemetryKind::StreamDelta,
            },
        );
        assert_action(
            "reasoning-delta",
            WorkerMessageAction::StreamTelemetry {
                kind: WorkerStreamTelemetryKind::ReasoningDelta,
            },
        );
        assert_action(
            "tool-call-started",
            WorkerMessageAction::ControlTelemetry {
                kind: WorkerControlTelemetryKind::ToolCallStarted,
            },
        );
        assert_action(
            "tool-call-completed",
            WorkerMessageAction::ControlTelemetry {
                kind: WorkerControlTelemetryKind::ToolCallCompleted,
            },
        );
        assert_action(
            "tool-call-failed",
            WorkerMessageAction::ControlTelemetry {
                kind: WorkerControlTelemetryKind::ToolCallFailed,
            },
        );
        assert_action(
            "delegation-registered",
            WorkerMessageAction::ControlTelemetry {
                kind: WorkerControlTelemetryKind::DelegationRegistered,
            },
        );
        assert_action(
            "silent-completion-requested",
            WorkerMessageAction::ControlTelemetry {
                kind: WorkerControlTelemetryKind::SilentCompletionRequested,
            },
        );
    }

    #[test]
    fn routes_rust_publish_request_published_mode() {
        let mut message = fixture_valid_message("published");
        message["mode"] = Value::String("rust_publish_request".to_string());

        let plan = plan_worker_message_handling(&message).expect("published message must classify");

        assert_eq!(
            plan.action,
            WorkerMessageAction::PublishedNotification {
                mode: WorkerPublishedMode::RustPublishRequest,
            }
        );
    }

    #[test]
    fn rejects_daemon_to_worker_messages() {
        assert_eq!(
            plan_worker_message_handling(&fixture_valid_message("execute")),
            Err(WorkerMessageError::InvalidDirection(
                WorkerProtocolDirection::DaemonToWorker
            ))
        );
        assert_eq!(
            plan_worker_message_handling(&fixture_valid_message("publish-result")),
            Err(WorkerMessageError::InvalidDirection(
                WorkerProtocolDirection::DaemonToWorker
            ))
        );
    }

    #[test]
    fn rejects_invalid_protocol_messages_before_routing() {
        assert_eq!(
            plan_worker_message_handling(&fixture_invalid_message("stream-delta-without-payload")),
            Err(WorkerMessageError::Protocol(
                WorkerProtocolError::MissingField("delta|contentRef")
            ))
        );
    }

    fn assert_terminal(name: &str, kind: WorkerTerminalResultKind) {
        let plan = plan_worker_message_handling(&fixture_valid_message(name))
            .expect("terminal message must classify");
        assert_eq!(
            plan.action,
            WorkerMessageAction::TerminalResultCandidate { kind }
        );
    }

    fn assert_action(name: &str, action: WorkerMessageAction) {
        let plan = plan_worker_message_handling(&fixture_valid_message(name))
            .expect("message must classify");
        assert_eq!(plan.action, action);
    }

    fn fixture_valid_message(name: &str) -> Value {
        fixture_message("validMessages", name)
    }

    fn fixture_invalid_message(name: &str) -> Value {
        fixture_message("invalidMessages", name)
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
}
