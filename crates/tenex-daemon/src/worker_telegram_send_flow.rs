//! Worker-originated Telegram proactive-send handler.
//!
//! The worker's `send_message` tool emits a `telegram_send_request` frame
//! when an agent wants to proactively post into one of its remembered
//! channels. Unlike the `publish_request` path (which accepts a signed
//! Nostr event and forwards it to the publish outbox), this frame carries
//! only the raw channel id and content. The daemon:
//!
//! 1. validates the frame
//! 2. resolves the `(agent, channel, telegram)` binding from the shared
//!    `transport-bindings.json` file
//! 3. confirms the binding's project matches the worker's project
//! 4. parses the channel id into `(chat_id, message_thread_id?)`
//! 5. renders the raw content to Telegram HTML
//! 6. enqueues a `ProactiveSend` record onto the Telegram outbox
//! 7. replies with a `telegram_send_result` frame carrying `accepted` or
//!    `failed` + a structured `errorReason`
//!
//! The maintenance loop later drains the outbox through the publisher
//! registry — this flow is purely "validate + enqueue + reply."

use std::error::Error;
use std::path::Path;

use serde_json::Value;
use thiserror::Error as ThisError;

use crate::telegram::bindings::{
    RuntimeTransport as BindingRuntimeTransport, TransportBindingReadError, find_binding,
    read_transport_bindings,
};
use crate::telegram::channel_id::{TelegramChannelIdError, parse_telegram_channel_id};
use crate::telegram::renderer::render_telegram_message;
use crate::telegram_outbox::{
    TelegramChannelBinding, TelegramDeliveryPayload, TelegramDeliveryReason,
    TelegramDeliveryRequest, TelegramOutboxError, TelegramOutboxRecord, TelegramProjectBinding,
    TelegramSenderIdentity, accept_telegram_delivery_request,
};
use crate::worker_dispatch_execution::WorkerDispatchSession;
use crate::worker_message::{
    WorkerMessageAction, WorkerMessageError, WorkerMessagePlan, plan_worker_message_handling,
};
use crate::worker_protocol::{
    AgentWorkerTelegramSendResultMessageInput, AgentWorkerTelegramSendResultStatus,
    WorkerProtocolError, build_agent_worker_telegram_send_result_message,
};

/// Context required to turn a `telegram_send_request` frame into an outbox
/// record.
#[derive(Debug, Clone, Copy)]
pub struct WorkerTelegramSendContext<'a> {
    /// `$TENEX_BASE_DIR/<data>` — the directory that holds the TS-owned
    /// `transport-bindings.json` file read by [`read_transport_bindings`].
    pub data_dir: &'a Path,
    /// Daemon backend pubkey (used to stamp the project binding). Matches
    /// the TS `projectContext.project.pubkey` semantics on the reply path.
    pub backend_pubkey: &'a str,
    /// Writer version stamp for the outbox record.
    pub writer_version: &'a str,
}

/// Input for the flow.
#[derive(Debug, Clone, Copy)]
pub struct WorkerTelegramSendFlowInput<'a> {
    pub daemon_dir: &'a Path,
    pub message: &'a Value,
    pub context: WorkerTelegramSendContext<'a>,
    pub accepted_at: u64,
    pub result_sequence: u64,
    pub result_timestamp: u64,
}

/// Outcome of a successful flow run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerTelegramSendFlowOutcome {
    pub message_plan: WorkerMessagePlan,
    pub result: WorkerTelegramSendResultOutcome,
}

/// Accepted or failed result payload that was sent back to the worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerTelegramSendResultOutcome {
    Accepted {
        record: Box<TelegramOutboxRecord>,
        send_result: Value,
    },
    Failed {
        reason: WorkerTelegramSendFailureReason,
        detail: Option<String>,
        send_result: Value,
    },
}

/// Structured reasons reported on the `telegram_send_result` frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerTelegramSendFailureReason {
    UnboundChannel,
    InvalidChannelId,
    InvalidThreadTarget,
    MissingProjectId,
    ProjectIdMismatch,
    RenderFailed,
    OutboxError,
}

impl WorkerTelegramSendFailureReason {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            WorkerTelegramSendFailureReason::UnboundChannel => "unbound_channel",
            WorkerTelegramSendFailureReason::InvalidChannelId => "invalid_channel_id",
            WorkerTelegramSendFailureReason::InvalidThreadTarget => "invalid_thread_target",
            WorkerTelegramSendFailureReason::MissingProjectId => "missing_project_id",
            WorkerTelegramSendFailureReason::ProjectIdMismatch => "project_id_mismatch",
            WorkerTelegramSendFailureReason::RenderFailed => "render_failed",
            WorkerTelegramSendFailureReason::OutboxError => "outbox_error",
        }
    }
}

#[derive(Debug, ThisError)]
pub enum WorkerTelegramSendFlowError {
    #[error("worker telegram message classification failed: {source}")]
    Message {
        #[source]
        source: Box<WorkerMessageError>,
    },
    #[error(
        "worker message type {message_type} cannot be handled as telegram_send_request: {action:?}"
    )]
    UnexpectedAction {
        message_type: String,
        action: WorkerMessageAction,
    },
    #[error("worker telegram send request frame is missing or invalid field: {0}")]
    InvalidField(&'static str),
    #[error("worker telegram send reply build failed: {source}")]
    BuildReply {
        #[source]
        source: WorkerProtocolError,
    },
    #[error("worker telegram send bindings read failed: {source}")]
    BindingsRead {
        #[source]
        source: TransportBindingReadError,
    },
    #[error("telegram_send_result send failed after classification: {source}")]
    SendResult {
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
}

pub fn handle_worker_telegram_send_request<S>(
    session: &mut S,
    input: WorkerTelegramSendFlowInput<'_>,
) -> Result<WorkerTelegramSendFlowOutcome, WorkerTelegramSendFlowError>
where
    S: WorkerDispatchSession,
{
    let message_plan =
        plan_worker_message_handling(input.message).map_err(WorkerTelegramSendFlowError::from)?;

    if message_plan.action != WorkerMessageAction::TelegramSendRequestCandidate {
        return Err(WorkerTelegramSendFlowError::UnexpectedAction {
            message_type: message_plan.metadata.message_type.clone(),
            action: message_plan.action,
        });
    }

    let request = extract_request_fields(&message_plan.message)?;
    let correlation_id = message_plan.metadata.correlation_id.clone();

    let result = classify_and_enqueue(&request, &input);

    let send_result_message = match &result {
        Ok(record) => build_accepted_result(&correlation_id, input, record)?,
        Err((reason, detail)) => {
            build_failed_result(&correlation_id, input, *reason, detail.as_deref())?
        }
    };

    if let Err(source) = session.send_worker_message(&send_result_message) {
        return Err(WorkerTelegramSendFlowError::SendResult {
            source: Box::new(source),
        });
    }

    let outcome = match result {
        Ok(record) => WorkerTelegramSendResultOutcome::Accepted {
            record: Box::new(record),
            send_result: send_result_message,
        },
        Err((reason, detail)) => WorkerTelegramSendResultOutcome::Failed {
            reason,
            detail,
            send_result: send_result_message,
        },
    };

    Ok(WorkerTelegramSendFlowOutcome {
        message_plan,
        result: outcome,
    })
}

#[derive(Debug, Clone)]
struct RequestFields {
    project_id: String,
    sender_agent_pubkey: String,
    channel_id: String,
    content: String,
    correlation_id: String,
}

fn extract_request_fields(message: &Value) -> Result<RequestFields, WorkerTelegramSendFlowError> {
    Ok(RequestFields {
        // The worker execute frame seeds these on every outbound message so
        // the worker's execution identity is always carried on the request.
        // `projectId` is stamped on the enclosing execute frame and we
        // require it on the send_request payload too so no extra joins are
        // needed to classify the binding.
        project_id: required_string(message, "projectId").unwrap_or_default(),
        sender_agent_pubkey: required_string(message, "senderAgentPubkey").ok_or(
            WorkerTelegramSendFlowError::InvalidField("senderAgentPubkey"),
        )?,
        channel_id: required_string(message, "channelId")
            .ok_or(WorkerTelegramSendFlowError::InvalidField("channelId"))?,
        content: required_string(message, "content")
            .ok_or(WorkerTelegramSendFlowError::InvalidField("content"))?,
        correlation_id: required_string(message, "correlationId")
            .ok_or(WorkerTelegramSendFlowError::InvalidField("correlationId"))?,
    })
}

fn required_string(message: &Value, key: &str) -> Option<String> {
    message
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn classify_and_enqueue(
    request: &RequestFields,
    input: &WorkerTelegramSendFlowInput<'_>,
) -> Result<TelegramOutboxRecord, (WorkerTelegramSendFailureReason, Option<String>)> {
    let parts = parse_telegram_channel_id(&request.channel_id).map_err(|error| match error {
        TelegramChannelIdError::Malformed
        | TelegramChannelIdError::MissingChatId
        | TelegramChannelIdError::InvalidChatId { .. } => (
            WorkerTelegramSendFailureReason::InvalidChannelId,
            Some(error.to_string()),
        ),
        TelegramChannelIdError::InvalidMessageThreadId { .. }
        | TelegramChannelIdError::ThreadTargetRequiresGroup { .. } => (
            WorkerTelegramSendFailureReason::InvalidThreadTarget,
            Some(error.to_string()),
        ),
    })?;

    let bindings = read_transport_bindings(input.context.data_dir).map_err(|error| {
        (
            WorkerTelegramSendFailureReason::OutboxError,
            Some(format!("transport bindings read failed: {error}")),
        )
    })?;

    let binding = find_binding(
        &bindings,
        &request.sender_agent_pubkey,
        &request.channel_id,
        BindingRuntimeTransport::Telegram,
    )
    .ok_or((
        WorkerTelegramSendFailureReason::UnboundChannel,
        Some(format!(
            "channel {} is not remembered for agent {}",
            request.channel_id, request.sender_agent_pubkey
        )),
    ))?;

    if request.project_id.is_empty() {
        return Err((
            WorkerTelegramSendFailureReason::MissingProjectId,
            Some(
                "telegram_send_request frame is missing projectId; the worker execute frame must stamp it"
                    .to_string(),
            ),
        ));
    }

    if binding.project_id != request.project_id {
        return Err((
            WorkerTelegramSendFailureReason::ProjectIdMismatch,
            Some(format!(
                "channel {} is bound to project {} but send request targets project {}",
                request.channel_id, binding.project_id, request.project_id
            )),
        ));
    }

    let rendered = render_telegram_message(&request.content);
    if rendered.text.is_empty() {
        return Err((
            WorkerTelegramSendFailureReason::RenderFailed,
            Some("rendered telegram message text is empty".to_string()),
        ));
    }

    let outbox_request = TelegramDeliveryRequest {
        nostr_event_id: derive_nostr_event_id(&request.correlation_id, &request.channel_id),
        correlation_id: request.correlation_id.clone(),
        project_binding: TelegramProjectBinding {
            project_d_tag: binding.project_id.clone(),
            backend_pubkey: input.context.backend_pubkey.to_string(),
        },
        channel_binding: TelegramChannelBinding {
            chat_id: parts.chat_id,
            message_thread_id: parts.message_thread_id,
            channel_label: None,
        },
        sender_identity: TelegramSenderIdentity {
            agent_pubkey: request.sender_agent_pubkey.clone(),
            display_name: None,
        },
        delivery_reason: TelegramDeliveryReason::ProactiveSend,
        reply_to_telegram_message_id: None,
        payload: TelegramDeliveryPayload::HtmlText {
            html: rendered.text,
        },
        writer_version: input.context.writer_version.to_string(),
    };

    accept_telegram_delivery_request(input.daemon_dir, outbox_request, input.accepted_at).map_err(
        |error| match error {
            TelegramOutboxError::MissingField { field } => (
                WorkerTelegramSendFailureReason::OutboxError,
                Some(format!("outbox rejected missing field: {field}")),
            ),
            other => (
                WorkerTelegramSendFailureReason::OutboxError,
                Some(other.to_string()),
            ),
        },
    )
}

/// A proactive send is not tied to an incoming Nostr event, but the outbox
/// keys records by `nostr_event_id`. Synthesize a stable id from the
/// worker correlation id + channel so retries for the same `(correlation,
/// channel)` converge onto the same outbox record and avoid duplicate
/// deliveries.
fn derive_nostr_event_id(correlation_id: &str, channel_id: &str) -> String {
    format!("worker-send:{correlation_id}:{channel_id}")
}

fn build_accepted_result(
    correlation_id: &str,
    input: WorkerTelegramSendFlowInput<'_>,
    _record: &TelegramOutboxRecord,
) -> Result<Value, WorkerTelegramSendFlowError> {
    build_agent_worker_telegram_send_result_message(AgentWorkerTelegramSendResultMessageInput {
        correlation_id: correlation_id.to_string(),
        sequence: input.result_sequence,
        timestamp: input.result_timestamp,
        status: AgentWorkerTelegramSendResultStatus::Accepted,
        error_reason: None,
        error_detail: None,
    })
    .map_err(|source| WorkerTelegramSendFlowError::BuildReply { source })
}

fn build_failed_result(
    correlation_id: &str,
    input: WorkerTelegramSendFlowInput<'_>,
    reason: WorkerTelegramSendFailureReason,
    detail: Option<&str>,
) -> Result<Value, WorkerTelegramSendFlowError> {
    build_agent_worker_telegram_send_result_message(AgentWorkerTelegramSendResultMessageInput {
        correlation_id: correlation_id.to_string(),
        sequence: input.result_sequence,
        timestamp: input.result_timestamp,
        status: AgentWorkerTelegramSendResultStatus::Failed,
        error_reason: Some(reason.as_wire_str().to_string()),
        error_detail: detail.map(str::to_string),
    })
    .map_err(|source| WorkerTelegramSendFlowError::BuildReply { source })
}

impl From<WorkerMessageError> for WorkerTelegramSendFlowError {
    fn from(source: WorkerMessageError) -> Self {
        Self::Message {
            source: Box::new(source),
        }
    }
}

impl From<TransportBindingReadError> for WorkerTelegramSendFlowError {
    fn from(source: TransportBindingReadError) -> Self {
        Self::BindingsRead { source }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telegram::bindings::{RuntimeTransport, write_transport_binding};
    use crate::telegram_outbox::{
        TELEGRAM_OUTBOX_RECORD_SCHEMA_VERSION, TelegramOutboxStatus,
        read_pending_telegram_outbox_record,
    };
    use crate::worker_protocol::{
        AGENT_WORKER_PROTOCOL_VERSION, validate_agent_worker_protocol_message,
    };
    use serde_json::json;
    use std::fmt;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const AGENT_PUBKEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BACKEND_PUBKEY: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const PROJECT_ID: &str = "project-alpha";
    const CORRELATION_ID: &str = "exec_01hzzzzzzzzzzzzzzzzzzzzzzz";
    const CHANNEL_ID: &str = "telegram:group:-1001:topic:77";
    const WRITER_VERSION: &str = "test-version";
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug, Default)]
    struct RecordingSession {
        sent_messages: Vec<Value>,
        fail_send: bool,
    }

    impl WorkerDispatchSession for RecordingSession {
        type Error = FakeSendError;

        fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error> {
            self.sent_messages.push(message.clone());
            if self.fail_send {
                return Err(FakeSendError("send failed"));
            }
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

    fn unique_temp_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tenex-worker-telegram-send-flow-{nanos}-{counter}"))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    fn send_request_message(channel_id: &str, content: &str, project_id: &str) -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "telegram_send_request",
            "correlationId": CORRELATION_ID,
            "sequence": 21,
            "timestamp": 1_710_000_403_000_u64,
            "projectId": project_id,
            "senderAgentPubkey": AGENT_PUBKEY,
            "channelId": channel_id,
            "content": content,
        })
    }

    fn seed_binding(data_dir: &Path, project_id: &str, channel_id: &str) {
        fs::create_dir_all(data_dir).expect("data dir must create");
        write_transport_binding(
            data_dir,
            RuntimeTransport::Telegram,
            AGENT_PUBKEY,
            channel_id,
            project_id,
            1_710_000_402_000,
        )
        .expect("binding must seed");
    }

    #[test]
    fn accepts_bound_channel_and_persists_outbox_record() {
        let daemon_dir = unique_temp_dir();
        let data_dir = daemon_dir.join("data");
        seed_binding(&data_dir, PROJECT_ID, CHANNEL_ID);

        let mut session = RecordingSession::default();
        let message = send_request_message(CHANNEL_ID, "hello there", PROJECT_ID);

        let outcome = handle_worker_telegram_send_request(
            &mut session,
            WorkerTelegramSendFlowInput {
                daemon_dir: &daemon_dir,
                message: &message,
                context: WorkerTelegramSendContext {
                    data_dir: &data_dir,
                    backend_pubkey: BACKEND_PUBKEY,
                    writer_version: WRITER_VERSION,
                },
                accepted_at: 1_710_000_403_100,
                result_sequence: 22,
                result_timestamp: 1_710_000_403_200,
            },
        )
        .expect("send request must succeed");

        let record = match &outcome.result {
            WorkerTelegramSendResultOutcome::Accepted { record, .. } => record,
            other => panic!("expected accepted, got {other:?}"),
        };
        assert_eq!(record.schema_version, TELEGRAM_OUTBOX_RECORD_SCHEMA_VERSION);
        assert_eq!(record.status, TelegramOutboxStatus::Pending);
        assert_eq!(
            record.delivery_reason,
            TelegramDeliveryReason::ProactiveSend
        );
        assert_eq!(record.channel_binding.chat_id, -1001);
        assert_eq!(record.channel_binding.message_thread_id, Some(77));
        assert_eq!(record.project_binding.project_d_tag, PROJECT_ID);
        assert_eq!(record.project_binding.backend_pubkey, BACKEND_PUBKEY);
        assert_eq!(record.sender_identity.agent_pubkey, AGENT_PUBKEY);

        let persisted = read_pending_telegram_outbox_record(&daemon_dir, &record.record_id)
            .expect("persisted read")
            .expect("persisted record must exist");
        assert_eq!(persisted.record_id, record.record_id);

        assert_eq!(session.sent_messages.len(), 1);
        let reply = &session.sent_messages[0];
        assert_eq!(reply["type"], "telegram_send_result");
        assert_eq!(reply["status"], "accepted");
        validate_agent_worker_protocol_message(reply).expect("reply must validate");

        cleanup(&daemon_dir);
    }

    #[test]
    fn rejects_invalid_channel_id_with_structured_reason() {
        let daemon_dir = unique_temp_dir();
        let data_dir = daemon_dir.join("data");
        fs::create_dir_all(&data_dir).expect("data dir must create");

        let mut session = RecordingSession::default();
        let message = send_request_message("1001", "hi", PROJECT_ID);

        let outcome = handle_worker_telegram_send_request(
            &mut session,
            WorkerTelegramSendFlowInput {
                daemon_dir: &daemon_dir,
                message: &message,
                context: WorkerTelegramSendContext {
                    data_dir: &data_dir,
                    backend_pubkey: BACKEND_PUBKEY,
                    writer_version: WRITER_VERSION,
                },
                accepted_at: 1_710_000_403_100,
                result_sequence: 22,
                result_timestamp: 1_710_000_403_200,
            },
        )
        .expect("flow must classify");

        match outcome.result {
            WorkerTelegramSendResultOutcome::Failed { reason, .. } => {
                assert_eq!(reason, WorkerTelegramSendFailureReason::InvalidChannelId);
            }
            other => panic!("expected failed, got {other:?}"),
        }
        assert_eq!(session.sent_messages[0]["status"], "failed");
        assert_eq!(
            session.sent_messages[0]["errorReason"],
            "invalid_channel_id"
        );

        cleanup(&daemon_dir);
    }

    #[test]
    fn rejects_unbound_channel() {
        let daemon_dir = unique_temp_dir();
        let data_dir = daemon_dir.join("data");
        fs::create_dir_all(&data_dir).expect("data dir must create");

        let mut session = RecordingSession::default();
        let message = send_request_message(CHANNEL_ID, "hi", PROJECT_ID);

        let outcome = handle_worker_telegram_send_request(
            &mut session,
            WorkerTelegramSendFlowInput {
                daemon_dir: &daemon_dir,
                message: &message,
                context: WorkerTelegramSendContext {
                    data_dir: &data_dir,
                    backend_pubkey: BACKEND_PUBKEY,
                    writer_version: WRITER_VERSION,
                },
                accepted_at: 1_710_000_403_100,
                result_sequence: 22,
                result_timestamp: 1_710_000_403_200,
            },
        )
        .expect("flow must classify");

        match outcome.result {
            WorkerTelegramSendResultOutcome::Failed { reason, .. } => {
                assert_eq!(reason, WorkerTelegramSendFailureReason::UnboundChannel);
            }
            other => panic!("expected failed, got {other:?}"),
        }
        assert_eq!(session.sent_messages[0]["errorReason"], "unbound_channel");

        cleanup(&daemon_dir);
    }

    #[test]
    fn rejects_thread_target_on_non_group_chat() {
        let daemon_dir = unique_temp_dir();
        let data_dir = daemon_dir.join("data");
        seed_binding(&data_dir, PROJECT_ID, "telegram:group:5104033799:topic:77");

        let mut session = RecordingSession::default();
        let message = send_request_message("telegram:group:5104033799:topic:77", "hi", PROJECT_ID);

        let outcome = handle_worker_telegram_send_request(
            &mut session,
            WorkerTelegramSendFlowInput {
                daemon_dir: &daemon_dir,
                message: &message,
                context: WorkerTelegramSendContext {
                    data_dir: &data_dir,
                    backend_pubkey: BACKEND_PUBKEY,
                    writer_version: WRITER_VERSION,
                },
                accepted_at: 1_710_000_403_100,
                result_sequence: 22,
                result_timestamp: 1_710_000_403_200,
            },
        )
        .expect("flow must classify");

        match outcome.result {
            WorkerTelegramSendResultOutcome::Failed { reason, .. } => {
                assert_eq!(reason, WorkerTelegramSendFailureReason::InvalidThreadTarget);
            }
            other => panic!("expected failed, got {other:?}"),
        }
        assert_eq!(
            session.sent_messages[0]["errorReason"],
            "invalid_thread_target"
        );

        cleanup(&daemon_dir);
    }

    #[test]
    fn rejects_project_id_mismatch() {
        let daemon_dir = unique_temp_dir();
        let data_dir = daemon_dir.join("data");
        seed_binding(&data_dir, "project-other", CHANNEL_ID);

        let mut session = RecordingSession::default();
        let message = send_request_message(CHANNEL_ID, "hi", PROJECT_ID);

        let outcome = handle_worker_telegram_send_request(
            &mut session,
            WorkerTelegramSendFlowInput {
                daemon_dir: &daemon_dir,
                message: &message,
                context: WorkerTelegramSendContext {
                    data_dir: &data_dir,
                    backend_pubkey: BACKEND_PUBKEY,
                    writer_version: WRITER_VERSION,
                },
                accepted_at: 1_710_000_403_100,
                result_sequence: 22,
                result_timestamp: 1_710_000_403_200,
            },
        )
        .expect("flow must classify");

        match outcome.result {
            WorkerTelegramSendResultOutcome::Failed { reason, .. } => {
                assert_eq!(reason, WorkerTelegramSendFailureReason::ProjectIdMismatch);
            }
            other => panic!("expected failed, got {other:?}"),
        }
        assert_eq!(
            session.sent_messages[0]["errorReason"],
            "project_id_mismatch"
        );

        cleanup(&daemon_dir);
    }

    #[test]
    fn rejects_non_telegram_send_messages() {
        let daemon_dir = unique_temp_dir();
        let data_dir = daemon_dir.join("data");
        fs::create_dir_all(&data_dir).expect("data dir must create");

        let mut session = RecordingSession::default();
        let heartbeat = json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "heartbeat",
            "correlationId": CORRELATION_ID,
            "sequence": 20,
            "timestamp": 1_710_000_402_900_u64,
            "projectId": PROJECT_ID,
            "agentPubkey": AGENT_PUBKEY,
            "conversationId": "conversation-alpha",
            "ralNumber": 3,
            "state": "streaming",
            "activeToolCount": 0,
            "accumulatedRuntimeMs": 700,
        });

        let error = handle_worker_telegram_send_request(
            &mut session,
            WorkerTelegramSendFlowInput {
                daemon_dir: &daemon_dir,
                message: &heartbeat,
                context: WorkerTelegramSendContext {
                    data_dir: &data_dir,
                    backend_pubkey: BACKEND_PUBKEY,
                    writer_version: WRITER_VERSION,
                },
                accepted_at: 1_710_000_403_100,
                result_sequence: 22,
                result_timestamp: 1_710_000_403_200,
            },
        )
        .expect_err("non-send message must not reach outbox");

        match error {
            WorkerTelegramSendFlowError::UnexpectedAction { message_type, .. } => {
                assert_eq!(message_type, "heartbeat");
            }
            other => panic!("expected unexpected action, got {other:?}"),
        }
        assert!(session.sent_messages.is_empty());

        cleanup(&daemon_dir);
    }
}
