use crate::dispatch_queue::{DispatchQueueRecord, DispatchQueueStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use thiserror::Error;

pub const AGENT_WORKER_PROTOCOL_VERSION: u64 = 1;
pub const AGENT_WORKER_PROTOCOL_ENCODING: &str = "length-prefixed-json";
pub const AGENT_WORKER_MAX_FRAME_BYTES: u64 = 1_048_576;
pub const AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES: usize = 4;
pub const AGENT_WORKER_STREAM_BATCH_MS: u64 = 250;
pub const AGENT_WORKER_STREAM_BATCH_MAX_BYTES: u64 = 8_192;

const AGENT_WORKER_MAX_PAYLOAD_BYTES: usize =
    AGENT_WORKER_MAX_FRAME_BYTES as usize - AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES;

const DAEMON_TO_WORKER_MESSAGE_TYPES: &[&str] = &[
    "execute",
    "abort",
    "inject",
    "shutdown",
    "ping",
    "publish_result",
    "ack",
];

const WORKER_TO_DAEMON_MESSAGE_TYPES: &[&str] = &[
    "ready",
    "boot_error",
    "pong",
    "execution_started",
    "stream_delta",
    "reasoning_delta",
    "tool_call_started",
    "tool_call_completed",
    "tool_call_failed",
    "delegation_registered",
    "waiting_for_delegation",
    "publish_request",
    "published",
    "complete",
    "silent_completion_requested",
    "no_response",
    "aborted",
    "error",
    "heartbeat",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerProtocolDirection {
    DaemonToWorker,
    WorkerToDaemon,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkerProtocolError {
    #[error("message must be a JSON object")]
    ExpectedObject,
    #[error("missing required field: {0}")]
    MissingField(&'static str),
    #[error("invalid field: {0}")]
    InvalidField(&'static str),
    #[error("unsupported protocol version: {0}")]
    UnsupportedVersion(u64),
    #[error("unknown message type: {0}")]
    UnknownMessageType(String),
    #[error(
        "dispatch {dispatch_id} is not leased for worker execution; latest status is {status:?}"
    )]
    DispatchNotLeasedForExecute {
        dispatch_id: String,
        status: DispatchQueueStatus,
    },
    #[error(
        "triggering envelope native id {native_id} does not match dispatch triggering event {triggering_event_id}"
    )]
    TriggeringEnvelopeMismatch {
        triggering_event_id: String,
        native_id: String,
    },
    #[error("frame is missing length prefix: {actual} bytes")]
    FrameTooShort { actual: usize },
    #[error("frame payload exceeds maximum: {payload_bytes} > {max_payload_bytes}")]
    FramePayloadTooLarge {
        payload_bytes: usize,
        max_payload_bytes: usize,
    },
    #[error("frame length mismatch: expected {expected} bytes, got {actual} bytes")]
    FrameLengthMismatch { expected: usize, actual: usize },
    #[error("failed to encode canonical JSON: {0}")]
    JsonEncodeFailed(String),
    #[error("failed to decode JSON payload: {0}")]
    JsonDecodeFailed(String),
}

type WorkerProtocolResult<T> = Result<T, WorkerProtocolError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerProtocolFixture {
    pub name: String,
    pub description: String,
    pub protocol: WorkerProtocolConfig,
    pub valid_messages: Vec<WorkerProtocolFixtureMessage>,
    pub invalid_messages: Vec<InvalidWorkerProtocolFixtureMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerProtocolConfig {
    pub version: u64,
    pub encoding: String,
    pub max_frame_bytes: u64,
    pub stream_batch_ms: u64,
    pub stream_batch_max_bytes: u64,
    pub heartbeat_interval_ms: Option<u64>,
    pub missed_heartbeat_threshold: Option<u64>,
    pub worker_boot_timeout_ms: Option<u64>,
    pub graceful_abort_timeout_ms: Option<u64>,
    pub force_kill_timeout_ms: Option<u64>,
    pub idle_ttl_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct WorkerProtocolFixtureMessage {
    pub name: String,
    pub direction: WorkerProtocolDirection,
    pub message: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct InvalidWorkerProtocolFixtureMessage {
    pub name: String,
    pub message: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerFrameCodecFixture {
    pub name: String,
    pub description: String,
    pub format: WorkerFrameFormat,
    pub frames: Vec<WorkerFrameFixture>,
    pub invalid_frames: Vec<InvalidWorkerFrameFixture>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerFrameFormat {
    pub length_prefix_bytes: usize,
    pub length_endian: String,
    pub payload_encoding: String,
    pub json_canonicalization: String,
    pub max_frame_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerFrameFixture {
    pub name: String,
    pub message: Value,
    pub canonical_json: String,
    pub payload_byte_length: usize,
    pub frame_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidWorkerFrameFixture {
    pub name: String,
    pub frame_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkerExecutionFlags {
    pub is_delegation_completion: bool,
    pub has_pending_delegations: bool,
    pub debug: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentWorkerExecuteMessageInput<'a> {
    pub dispatch: &'a DispatchQueueRecord,
    pub sequence: u64,
    pub timestamp: u64,
    pub project_base_path: String,
    pub metadata_path: String,
    pub triggering_envelope: Value,
    pub execution_flags: AgentWorkerExecutionFlags,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentWorkerShutdownMessageInput {
    pub correlation_id: String,
    pub sequence: u64,
    pub timestamp: u64,
    pub reason: String,
    pub force_kill_timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentWorkerPublishResultStatus {
    Accepted,
    Published,
    Failed,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkerErrorObject {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentWorkerPublishResultMessageInput {
    pub correlation_id: String,
    pub sequence: u64,
    pub timestamp: u64,
    pub request_id: String,
    pub request_sequence: u64,
    pub status: AgentWorkerPublishResultStatus,
    pub event_ids: Vec<String>,
    pub error: Option<AgentWorkerErrorObject>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentWorkerAckMessageInput {
    pub correlation_id: String,
    pub sequence: u64,
    pub timestamp: u64,
    pub acknowledged_sequence: u64,
    pub durable: bool,
}

pub fn validate_worker_protocol_config(config: &WorkerProtocolConfig) -> WorkerProtocolResult<()> {
    if config.version != AGENT_WORKER_PROTOCOL_VERSION {
        return Err(WorkerProtocolError::UnsupportedVersion(config.version));
    }
    if config.encoding != AGENT_WORKER_PROTOCOL_ENCODING {
        return Err(WorkerProtocolError::InvalidField("encoding"));
    }
    if config.max_frame_bytes != AGENT_WORKER_MAX_FRAME_BYTES {
        return Err(WorkerProtocolError::InvalidField("maxFrameBytes"));
    }
    if config.stream_batch_ms != AGENT_WORKER_STREAM_BATCH_MS {
        return Err(WorkerProtocolError::InvalidField("streamBatchMs"));
    }
    if config.stream_batch_max_bytes != AGENT_WORKER_STREAM_BATCH_MAX_BYTES {
        return Err(WorkerProtocolError::InvalidField("streamBatchMaxBytes"));
    }

    Ok(())
}

pub fn validate_agent_worker_protocol_message(
    value: &Value,
) -> WorkerProtocolResult<WorkerProtocolDirection> {
    let object = as_object(value)?;
    validate_common_frame(object)?;

    let message_type = require_string(object, "type")?;
    let direction = message_direction(message_type)?;

    match message_type {
        "execute" => validate_execute(object)?,
        "ping" => {
            require_positive_u64(object, "timeoutMs")?;
        }
        "inject" => validate_inject(object)?,
        "abort" => validate_abort(object)?,
        "shutdown" => validate_shutdown(object)?,
        "publish_result" => validate_publish_result(object)?,
        "ack" => validate_ack(object)?,
        "ready" => validate_ready(object)?,
        "boot_error" => {
            validate_error_object(object, "error")?;
        }
        "pong" => {
            require_u64(object, "replyingToSequence")?;
        }
        "execution_started" => validate_execution_identity(object)?,
        "stream_delta" => validate_stream_delta(object)?,
        "reasoning_delta" => validate_reasoning_delta(object)?,
        "tool_call_started" => validate_tool_call_started(object)?,
        "tool_call_completed" => validate_tool_call_completed(object)?,
        "tool_call_failed" => validate_tool_call_failed(object)?,
        "delegation_registered" => validate_delegation_registered(object)?,
        "waiting_for_delegation" => validate_waiting_for_delegation(object)?,
        "publish_request" => validate_publish_request(object)?,
        "published" => validate_published(object)?,
        "complete" => validate_complete(object)?,
        "silent_completion_requested" => validate_silent_completion_requested(object)?,
        "no_response" => validate_no_response(object)?,
        "aborted" => validate_aborted(object)?,
        "error" => validate_error_message(object)?,
        "heartbeat" => validate_heartbeat(object)?,
        _ => {
            return Err(WorkerProtocolError::UnknownMessageType(
                message_type.to_string(),
            ));
        }
    }

    Ok(direction)
}

pub fn build_agent_worker_execute_message(
    input: AgentWorkerExecuteMessageInput<'_>,
) -> WorkerProtocolResult<Value> {
    if input.dispatch.status != DispatchQueueStatus::Leased {
        return Err(WorkerProtocolError::DispatchNotLeasedForExecute {
            dispatch_id: input.dispatch.dispatch_id.clone(),
            status: input.dispatch.status,
        });
    }

    let envelope_native_id = triggering_envelope_native_id(&input.triggering_envelope)?;
    if envelope_native_id != input.dispatch.triggering_event_id {
        return Err(WorkerProtocolError::TriggeringEnvelopeMismatch {
            triggering_event_id: input.dispatch.triggering_event_id.clone(),
            native_id: envelope_native_id.to_string(),
        });
    }

    let message = json!({
        "version": AGENT_WORKER_PROTOCOL_VERSION,
        "type": "execute",
        "correlationId": &input.dispatch.correlation_id,
        "sequence": input.sequence,
        "timestamp": input.timestamp,
        "projectId": &input.dispatch.ral.project_id,
        "projectBasePath": input.project_base_path,
        "metadataPath": input.metadata_path,
        "agentPubkey": &input.dispatch.ral.agent_pubkey,
        "conversationId": &input.dispatch.ral.conversation_id,
        "ralNumber": input.dispatch.ral.ral_number,
        "ralClaimToken": &input.dispatch.claim_token,
        "triggeringEnvelope": input.triggering_envelope,
        "executionFlags": input.execution_flags,
    });

    validate_agent_worker_protocol_message(&message)?;
    Ok(message)
}

pub fn build_agent_worker_shutdown_message(
    input: AgentWorkerShutdownMessageInput,
) -> WorkerProtocolResult<Value> {
    let message = json!({
        "version": AGENT_WORKER_PROTOCOL_VERSION,
        "type": "shutdown",
        "correlationId": input.correlation_id,
        "sequence": input.sequence,
        "timestamp": input.timestamp,
        "reason": input.reason,
        "forceKillTimeoutMs": input.force_kill_timeout_ms,
    });

    validate_agent_worker_protocol_message(&message)?;
    Ok(message)
}

pub fn build_agent_worker_publish_result_message(
    input: AgentWorkerPublishResultMessageInput,
) -> WorkerProtocolResult<Value> {
    let mut message = json!({
        "version": AGENT_WORKER_PROTOCOL_VERSION,
        "type": "publish_result",
        "correlationId": input.correlation_id,
        "sequence": input.sequence,
        "timestamp": input.timestamp,
        "requestId": input.request_id,
        "requestSequence": input.request_sequence,
        "status": input.status,
        "eventIds": input.event_ids,
    });

    if let Some(error) = input.error {
        let error = serde_json::to_value(error)
            .map_err(|error| WorkerProtocolError::JsonEncodeFailed(error.to_string()))?;
        message
            .as_object_mut()
            .expect("publish_result message must be a JSON object")
            .insert("error".to_string(), error);
    }

    validate_agent_worker_protocol_message(&message)?;
    Ok(message)
}

pub fn build_agent_worker_ack_message(
    input: AgentWorkerAckMessageInput,
) -> WorkerProtocolResult<Value> {
    let message = json!({
        "version": AGENT_WORKER_PROTOCOL_VERSION,
        "type": "ack",
        "correlationId": input.correlation_id,
        "sequence": input.sequence,
        "timestamp": input.timestamp,
        "acknowledgedSequence": input.acknowledged_sequence,
        "durable": input.durable,
    });

    validate_agent_worker_protocol_message(&message)?;
    Ok(message)
}

pub fn canonical_agent_worker_protocol_json(value: &Value) -> WorkerProtocolResult<String> {
    canonical_json_stringify(value)
}

pub fn encode_agent_worker_protocol_frame(value: &Value) -> WorkerProtocolResult<Vec<u8>> {
    validate_agent_worker_protocol_message(value)?;

    let canonical_json = canonical_agent_worker_protocol_json(value)?;
    let payload = canonical_json.as_bytes();
    if payload.len() > AGENT_WORKER_MAX_PAYLOAD_BYTES {
        return Err(WorkerProtocolError::FramePayloadTooLarge {
            payload_bytes: payload.len(),
            max_payload_bytes: AGENT_WORKER_MAX_PAYLOAD_BYTES,
        });
    }

    let mut frame = Vec::with_capacity(AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn decode_agent_worker_protocol_frame(frame: &[u8]) -> WorkerProtocolResult<Value> {
    if frame.len() < AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES {
        return Err(WorkerProtocolError::FrameTooShort {
            actual: frame.len(),
        });
    }

    let payload_byte_length = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if payload_byte_length > AGENT_WORKER_MAX_PAYLOAD_BYTES {
        return Err(WorkerProtocolError::FramePayloadTooLarge {
            payload_bytes: payload_byte_length,
            max_payload_bytes: AGENT_WORKER_MAX_PAYLOAD_BYTES,
        });
    }

    let expected_frame_length = AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES + payload_byte_length;
    if frame.len() != expected_frame_length {
        return Err(WorkerProtocolError::FrameLengthMismatch {
            expected: expected_frame_length,
            actual: frame.len(),
        });
    }

    let payload = &frame[AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES..];
    let value: Value = serde_json::from_slice(payload)
        .map_err(|error| WorkerProtocolError::JsonDecodeFailed(error.to_string()))?;
    validate_agent_worker_protocol_message(&value)?;
    Ok(value)
}

pub fn message_direction(message_type: &str) -> WorkerProtocolResult<WorkerProtocolDirection> {
    if DAEMON_TO_WORKER_MESSAGE_TYPES.contains(&message_type) {
        return Ok(WorkerProtocolDirection::DaemonToWorker);
    }
    if WORKER_TO_DAEMON_MESSAGE_TYPES.contains(&message_type) {
        return Ok(WorkerProtocolDirection::WorkerToDaemon);
    }
    Err(WorkerProtocolError::UnknownMessageType(
        message_type.to_string(),
    ))
}

fn canonical_json_stringify(value: &Value) -> WorkerProtocolResult<String> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            serde_json::to_string(value)
                .map_err(|error| WorkerProtocolError::JsonEncodeFailed(error.to_string()))
        }
        Value::Array(values) => {
            let items = values
                .iter()
                .map(canonical_json_stringify)
                .collect::<WorkerProtocolResult<Vec<_>>>()?;
            Ok(format!("[{}]", items.join(",")))
        }
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();

            let fields = keys
                .into_iter()
                .map(|key| {
                    let encoded_key = serde_json::to_string(key).map_err(|error| {
                        WorkerProtocolError::JsonEncodeFailed(error.to_string())
                    })?;
                    let encoded_value = canonical_json_stringify(
                        object
                            .get(key)
                            .expect("sorted key must still exist in JSON object"),
                    )?;
                    Ok(format!("{encoded_key}:{encoded_value}"))
                })
                .collect::<WorkerProtocolResult<Vec<_>>>()?;

            Ok(format!("{{{}}}", fields.join(",")))
        }
    }
}

fn validate_common_frame(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    let version = require_u64(object, "version")?;
    if version != AGENT_WORKER_PROTOCOL_VERSION {
        return Err(WorkerProtocolError::UnsupportedVersion(version));
    }

    require_string(object, "type")?;
    require_string(object, "correlationId")?;
    require_u64(object, "sequence")?;
    require_u64(object, "timestamp")?;

    Ok(())
}

fn validate_execute(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    require_string(object, "projectId")?;
    require_string(object, "projectBasePath")?;
    require_string(object, "metadataPath")?;
    require_hex_pubkey(object, "agentPubkey")?;
    require_string(object, "conversationId")?;
    require_positive_u64(object, "ralNumber")?;
    require_string(object, "ralClaimToken")?;
    validate_inbound_envelope(object, "triggeringEnvelope")?;

    let flags = require_object(object, "executionFlags")?;
    require_bool(flags, "isDelegationCompletion")?;
    require_bool(flags, "hasPendingDelegations")?;
    require_bool(flags, "debug")?;

    Ok(())
}

fn validate_inject(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_string(object, "injectionId")?;
    require_string(object, "leaseToken")?;
    require_one_of(object, "role", &["user", "system"])?;
    require_string(object, "content")?;
    Ok(())
}

fn validate_abort(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_string(object, "reason")?;
    require_positive_u64(object, "gracefulTimeoutMs")?;
    Ok(())
}

fn validate_shutdown(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    require_string(object, "reason")?;
    require_positive_u64(object, "forceKillTimeoutMs")?;
    Ok(())
}

fn validate_publish_result(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    require_string(object, "requestId")?;
    require_u64(object, "requestSequence")?;
    let status = require_string(object, "status")?;
    if !["accepted", "published", "failed", "timeout"].contains(&status) {
        return Err(WorkerProtocolError::InvalidField("status"));
    }
    require_string_array(object, "eventIds")?;

    let has_error = object.contains_key("error");
    if matches!(status, "failed" | "timeout") && !has_error {
        return Err(WorkerProtocolError::MissingField("error"));
    }
    if matches!(status, "accepted" | "published") && has_error {
        return Err(WorkerProtocolError::InvalidField("error"));
    }
    if has_error {
        validate_error_object(object, "error")?;
    }
    Ok(())
}

fn validate_ack(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    require_u64(object, "acknowledgedSequence")?;
    require_bool(object, "durable")?;
    Ok(())
}

fn validate_ready(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    require_string(object, "workerId")?;
    require_positive_u64(object, "pid")?;

    let protocol = require_object(object, "protocol")?;
    let config = WorkerProtocolConfig {
        version: require_u64(protocol, "version")?,
        encoding: require_string(protocol, "encoding")?.to_string(),
        max_frame_bytes: require_u64(protocol, "maxFrameBytes")?,
        stream_batch_ms: require_u64(protocol, "streamBatchMs")?,
        stream_batch_max_bytes: require_u64(protocol, "streamBatchMaxBytes")?,
        heartbeat_interval_ms: None,
        missed_heartbeat_threshold: None,
        worker_boot_timeout_ms: None,
        graceful_abort_timeout_ms: None,
        force_kill_timeout_ms: None,
        idle_ttl_ms: None,
    };
    validate_worker_protocol_config(&config)?;

    Ok(())
}

fn validate_execution_identity(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    require_string(object, "projectId")?;
    require_hex_pubkey(object, "agentPubkey")?;
    require_string(object, "conversationId")?;
    require_positive_u64(object, "ralNumber")?;
    Ok(())
}

fn validate_stream_delta(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_positive_u64(object, "batchSequence")?;

    let has_delta = object.contains_key("delta");
    let has_content_ref = object.contains_key("contentRef");
    if has_delta == has_content_ref {
        if has_delta {
            return Err(WorkerProtocolError::InvalidField("delta|contentRef"));
        }
        return Err(WorkerProtocolError::MissingField("delta|contentRef"));
    }
    if has_delta {
        let delta = require_string(object, "delta")?;
        if delta.len() as u64 > AGENT_WORKER_STREAM_BATCH_MAX_BYTES {
            return Err(WorkerProtocolError::InvalidField("delta"));
        }
    }
    if has_content_ref {
        validate_content_ref(object, "contentRef")?;
    }

    Ok(())
}

fn validate_reasoning_delta(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_positive_u64(object, "batchSequence")?;
    require_string(object, "delta")?;
    require_one_of(object, "visibility", &["debug", "operator", "client"])?;
    Ok(())
}

fn validate_tool_call_started(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_string(object, "toolCallId")?;
    require_string(object, "toolName")?;
    Ok(())
}

fn validate_tool_call_completed(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_string(object, "toolCallId")?;
    require_string(object, "toolName")?;
    require_u64(object, "durationMs")?;
    Ok(())
}

fn validate_tool_call_failed(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_string(object, "toolCallId")?;
    require_string(object, "toolName")?;
    validate_error_object(object, "error")?;
    Ok(())
}

fn validate_delegation_registered(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_string(object, "delegationConversationId")?;
    require_hex_pubkey(object, "recipientPubkey")?;
    require_one_of(
        object,
        "delegationType",
        &["standard", "followup", "external", "ask"],
    )?;
    Ok(())
}

fn validate_waiting_for_delegation(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_string_array(object, "pendingDelegations")?;
    validate_terminal_fields(object, "waiting_for_delegation")?;
    Ok(())
}

fn validate_publish_request(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_string(object, "requestId")?;
    require_bool(object, "waitForRelayOk")?;
    require_positive_u64(object, "timeoutMs")?;
    validate_publish_event(object, "event")?;
    validate_runtime_event_class(object)?;
    Ok(())
}

fn validate_runtime_event_class(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    use crate::telegram::types::{ConversationVariant, RuntimeEventClass};

    require_one_of(object, "runtimeEventClass", RuntimeEventClass::ALL_WIRE)?;
    let class_value = object
        .get("runtimeEventClass")
        .and_then(Value::as_str)
        .ok_or(WorkerProtocolError::MissingField("runtimeEventClass"))?;
    let class = RuntimeEventClass::from_wire(class_value)
        .ok_or(WorkerProtocolError::InvalidField("runtimeEventClass"))?;

    match object.get("conversationVariant") {
        Some(Value::String(value)) => {
            if !class.permits_conversation_variant() {
                return Err(WorkerProtocolError::InvalidField("conversationVariant"));
            }
            if !ConversationVariant::ALL_WIRE.contains(&value.as_str()) {
                return Err(WorkerProtocolError::InvalidField("conversationVariant"));
            }
        }
        Some(_) => return Err(WorkerProtocolError::InvalidField("conversationVariant")),
        None => {
            if class.permits_conversation_variant() {
                return Err(WorkerProtocolError::MissingField("conversationVariant"));
            }
        }
    }

    Ok(())
}

fn validate_published(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_one_of(
        object,
        "mode",
        &["direct_worker_publish", "rust_publish_request"],
    )?;
    require_string_array(object, "eventIds")?;
    Ok(())
}

fn validate_complete(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    validate_terminal_fields(object, "completed")?;
    Ok(())
}

fn validate_silent_completion_requested(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_string(object, "reason")?;
    Ok(())
}

fn validate_no_response(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    validate_terminal_fields(object, "no_response")?;
    Ok(())
}

fn validate_aborted(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_string(object, "abortReason")?;
    validate_terminal_fields(object, "aborted")?;
    Ok(())
}

fn validate_error_message(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_bool(object, "terminal")?;
    validate_error_object(object, "error")?;
    validate_terminal_fields(object, "error")?;
    Ok(())
}

fn validate_heartbeat(object: &Map<String, Value>) -> WorkerProtocolResult<()> {
    validate_execution_identity(object)?;
    require_one_of(
        object,
        "state",
        &["starting", "streaming", "acting", "waiting", "idle"],
    )?;
    require_u64(object, "activeToolCount")?;
    require_u64(object, "accumulatedRuntimeMs")?;
    Ok(())
}

fn validate_terminal_fields(
    object: &Map<String, Value>,
    expected_state: &'static str,
) -> WorkerProtocolResult<()> {
    if require_string(object, "finalRalState")? != expected_state {
        return Err(WorkerProtocolError::InvalidField("finalRalState"));
    }
    require_bool(object, "publishedUserVisibleEvent")?;
    require_bool(object, "pendingDelegationsRemain")?;
    require_u64(object, "accumulatedRuntimeMs")?;
    require_string_array(object, "finalEventIds")?;
    require_bool(object, "keepWorkerWarm")?;
    Ok(())
}

fn validate_inbound_envelope(
    object: &Map<String, Value>,
    key: &'static str,
) -> WorkerProtocolResult<()> {
    let envelope = require_object(object, key)?;
    require_one_of(
        envelope,
        "transport",
        &["local", "mcp", "nostr", "telegram"],
    )?;
    validate_principal_ref(envelope, "principal")?;
    validate_channel_ref(envelope, "channel")?;
    validate_external_message_ref(envelope, "message")?;
    require_array(envelope, "recipients")?;
    require_string(envelope, "content")?;
    require_u64(envelope, "occurredAt")?;
    require_string_array(envelope, "capabilities")?;
    require_object(envelope, "metadata")?;
    Ok(())
}

fn validate_principal_ref(
    object: &Map<String, Value>,
    key: &'static str,
) -> WorkerProtocolResult<()> {
    let principal = require_object(object, key)?;
    require_string(principal, "id")?;
    require_one_of(
        principal,
        "transport",
        &["local", "mcp", "nostr", "telegram"],
    )?;
    if principal.contains_key("kind") {
        require_one_of(principal, "kind", &["agent", "human", "system"])?;
    }
    Ok(())
}

fn validate_channel_ref(
    object: &Map<String, Value>,
    key: &'static str,
) -> WorkerProtocolResult<()> {
    let channel = require_object(object, key)?;
    require_string(channel, "id")?;
    require_one_of(channel, "transport", &["local", "mcp", "nostr", "telegram"])?;
    require_one_of(
        channel,
        "kind",
        &["conversation", "dm", "group", "project", "topic"],
    )?;
    Ok(())
}

fn validate_external_message_ref(
    object: &Map<String, Value>,
    key: &'static str,
) -> WorkerProtocolResult<()> {
    let message = require_object(object, key)?;
    require_string(message, "id")?;
    require_one_of(message, "transport", &["local", "mcp", "nostr", "telegram"])?;
    require_string(message, "nativeId")?;
    Ok(())
}

fn validate_error_object(
    object: &Map<String, Value>,
    key: &'static str,
) -> WorkerProtocolResult<()> {
    let error = require_object(object, key)?;
    require_string(error, "code")?;
    require_string(error, "message")?;
    require_bool(error, "retryable")?;
    Ok(())
}

fn validate_content_ref(
    object: &Map<String, Value>,
    key: &'static str,
) -> WorkerProtocolResult<()> {
    let content_ref = require_object(object, key)?;
    require_string(content_ref, "path")?;
    require_positive_u64(content_ref, "byteLength")?;
    require_hex_string(content_ref, "sha256", 64)?;
    Ok(())
}

fn validate_publish_event(
    object: &Map<String, Value>,
    key: &'static str,
) -> WorkerProtocolResult<()> {
    let event = require_object(object, key)?;
    require_hex_string(event, "id", 64)?;
    require_hex_pubkey(event, "pubkey")?;
    require_u64(event, "kind")?;
    require_string(event, "content")?;
    let tags = require_array(event, "tags")?;
    for tag in tags {
        let tag = tag
            .as_array()
            .ok_or(WorkerProtocolError::InvalidField("tags"))?;
        for value in tag {
            if value.as_str().is_none() {
                return Err(WorkerProtocolError::InvalidField("tags"));
            }
        }
    }
    require_u64(event, "created_at")?;
    require_hex_string(event, "sig", 128)?;
    Ok(())
}

fn as_object(value: &Value) -> WorkerProtocolResult<&Map<String, Value>> {
    value.as_object().ok_or(WorkerProtocolError::ExpectedObject)
}

fn require_object<'a>(
    object: &'a Map<String, Value>,
    key: &'static str,
) -> WorkerProtocolResult<&'a Map<String, Value>> {
    object
        .get(key)
        .ok_or(WorkerProtocolError::MissingField(key))?
        .as_object()
        .ok_or(WorkerProtocolError::InvalidField(key))
}

fn require_array<'a>(
    object: &'a Map<String, Value>,
    key: &'static str,
) -> WorkerProtocolResult<&'a Vec<Value>> {
    object
        .get(key)
        .ok_or(WorkerProtocolError::MissingField(key))?
        .as_array()
        .ok_or(WorkerProtocolError::InvalidField(key))
}

fn require_string<'a>(
    object: &'a Map<String, Value>,
    key: &'static str,
) -> WorkerProtocolResult<&'a str> {
    let value = object
        .get(key)
        .ok_or(WorkerProtocolError::MissingField(key))?
        .as_str()
        .ok_or(WorkerProtocolError::InvalidField(key))?;

    if value.is_empty() {
        return Err(WorkerProtocolError::InvalidField(key));
    }

    Ok(value)
}

fn require_bool(object: &Map<String, Value>, key: &'static str) -> WorkerProtocolResult<bool> {
    object
        .get(key)
        .ok_or(WorkerProtocolError::MissingField(key))?
        .as_bool()
        .ok_or(WorkerProtocolError::InvalidField(key))
}

fn require_u64(object: &Map<String, Value>, key: &'static str) -> WorkerProtocolResult<u64> {
    object
        .get(key)
        .ok_or(WorkerProtocolError::MissingField(key))?
        .as_u64()
        .ok_or(WorkerProtocolError::InvalidField(key))
}

fn require_positive_u64(
    object: &Map<String, Value>,
    key: &'static str,
) -> WorkerProtocolResult<u64> {
    let value = require_u64(object, key)?;
    if value == 0 {
        return Err(WorkerProtocolError::InvalidField(key));
    }
    Ok(value)
}

fn require_one_of(
    object: &Map<String, Value>,
    key: &'static str,
    allowed: &[&str],
) -> WorkerProtocolResult<()> {
    let value = require_string(object, key)?;
    if !allowed.contains(&value) {
        return Err(WorkerProtocolError::InvalidField(key));
    }
    Ok(())
}

fn require_hex_pubkey(object: &Map<String, Value>, key: &'static str) -> WorkerProtocolResult<()> {
    require_hex_string(object, key, 64)
}

fn require_hex_string(
    object: &Map<String, Value>,
    key: &'static str,
    length: usize,
) -> WorkerProtocolResult<()> {
    let value = require_string(object, key)?;
    if value.len() != length || !value.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return Err(WorkerProtocolError::InvalidField(key));
    }
    Ok(())
}

fn require_string_array(
    object: &Map<String, Value>,
    key: &'static str,
) -> WorkerProtocolResult<()> {
    let array = require_array(object, key)?;
    for value in array {
        if value.as_str().is_none() {
            return Err(WorkerProtocolError::InvalidField(key));
        }
    }
    Ok(())
}

fn triggering_envelope_native_id(envelope: &Value) -> WorkerProtocolResult<&str> {
    let envelope = envelope
        .as_object()
        .ok_or(WorkerProtocolError::InvalidField("triggeringEnvelope"))?;
    let message = require_object(envelope, "message")?;
    require_string(message, "nativeId")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecordParams, DispatchRalIdentity, build_dispatch_queue_record,
    };
    use serde_json::json;

    const WORKER_PROTOCOL_FIXTURE: &str = include_str!(
        "../../../src/test-utils/fixtures/worker-protocol/agent-execution.compat.json"
    );
    const WORKER_FRAME_CODEC_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/worker-protocol/frame-codec.compat.json");

    #[test]
    fn execute_message_builder_matches_shared_fixture_and_round_trips() {
        let expected = fixture_valid_message("execute");
        let dispatch = fixture_dispatch_from_execute(&expected, DispatchQueueStatus::Leased);

        let built = build_agent_worker_execute_message(fixture_execute_input(&dispatch, &expected))
            .expect("execute message must build");

        assert_eq!(built, expected);
        assert_eq!(
            validate_agent_worker_protocol_message(&built),
            Ok(WorkerProtocolDirection::DaemonToWorker)
        );

        let encoded = encode_agent_worker_protocol_frame(&built).expect("frame must encode");
        let decoded = decode_agent_worker_protocol_frame(&encoded).expect("frame must decode");
        assert_eq!(decoded, expected);
    }

    #[test]
    fn execute_message_builder_rejects_non_leased_dispatch_records() {
        let expected = fixture_valid_message("execute");

        for status in [
            DispatchQueueStatus::Queued,
            DispatchQueueStatus::Completed,
            DispatchQueueStatus::Cancelled,
        ] {
            let dispatch = fixture_dispatch_from_execute(&expected, status);
            let error =
                build_agent_worker_execute_message(fixture_execute_input(&dispatch, &expected))
                    .expect_err("non-leased dispatch must not build");

            assert_eq!(
                error,
                WorkerProtocolError::DispatchNotLeasedForExecute {
                    dispatch_id: "dispatch-fixture".to_string(),
                    status,
                }
            );
        }
    }

    #[test]
    fn execute_message_builder_rejects_triggering_envelope_mismatch() {
        let expected = fixture_valid_message("execute");
        let dispatch = fixture_dispatch_from_execute(&expected, DispatchQueueStatus::Leased);
        let mut input = fixture_execute_input(&dispatch, &expected);
        input.triggering_envelope["message"]["nativeId"] = json!("different-event-id");

        let error = build_agent_worker_execute_message(input)
            .expect_err("mismatched triggering envelope must fail");

        assert_eq!(
            error,
            WorkerProtocolError::TriggeringEnvelopeMismatch {
                triggering_event_id: "trigger-event-id".to_string(),
                native_id: "different-event-id".to_string(),
            }
        );
    }

    #[test]
    fn execute_message_builder_validates_explicit_context_and_record_identity() {
        let expected = fixture_valid_message("execute");
        let dispatch = fixture_dispatch_from_execute(&expected, DispatchQueueStatus::Leased);
        let mut input = fixture_execute_input(&dispatch, &expected);
        input.project_base_path.clear();

        assert_eq!(
            build_agent_worker_execute_message(input),
            Err(WorkerProtocolError::InvalidField("projectBasePath"))
        );

        let mut invalid_dispatch =
            fixture_dispatch_from_execute(&expected, DispatchQueueStatus::Leased);
        invalid_dispatch.ral.agent_pubkey = "not-a-hex-pubkey".to_string();

        assert_eq!(
            build_agent_worker_execute_message(fixture_execute_input(&invalid_dispatch, &expected)),
            Err(WorkerProtocolError::InvalidField("agentPubkey"))
        );
    }

    #[test]
    fn parent_to_worker_builders_match_shared_fixture_messages() {
        let shutdown = fixture_valid_message("shutdown");
        assert_builder_matches_fixture(
            build_agent_worker_shutdown_message(AgentWorkerShutdownMessageInput {
                correlation_id: value_string(&shutdown, "correlationId"),
                sequence: value_u64(&shutdown, "sequence"),
                timestamp: value_u64(&shutdown, "timestamp"),
                reason: value_string(&shutdown, "reason"),
                force_kill_timeout_ms: value_u64(&shutdown, "forceKillTimeoutMs"),
            })
            .expect("shutdown must build"),
            shutdown,
        );

        let publish_result = fixture_valid_message("publish-result");
        assert_builder_matches_fixture(
            build_agent_worker_publish_result_message(AgentWorkerPublishResultMessageInput {
                correlation_id: value_string(&publish_result, "correlationId"),
                sequence: value_u64(&publish_result, "sequence"),
                timestamp: value_u64(&publish_result, "timestamp"),
                request_id: value_string(&publish_result, "requestId"),
                request_sequence: value_u64(&publish_result, "requestSequence"),
                status: AgentWorkerPublishResultStatus::Published,
                event_ids: value_string_array(&publish_result, "eventIds"),
                error: None,
            })
            .expect("publish_result must build"),
            publish_result,
        );

        let ack = fixture_valid_message("ack");
        assert_builder_matches_fixture(
            build_agent_worker_ack_message(AgentWorkerAckMessageInput {
                correlation_id: value_string(&ack, "correlationId"),
                sequence: value_u64(&ack, "sequence"),
                timestamp: value_u64(&ack, "timestamp"),
                acknowledged_sequence: value_u64(&ack, "acknowledgedSequence"),
                durable: ack["durable"].as_bool().expect("durable must be bool"),
            })
            .expect("ack must build"),
            ack,
        );
    }

    #[test]
    fn parent_to_worker_builders_validate_inputs() {
        assert_eq!(
            build_agent_worker_shutdown_message(AgentWorkerShutdownMessageInput {
                correlation_id: "correlation".to_string(),
                sequence: 1,
                timestamp: 1710000400000,
                reason: "operator_shutdown".to_string(),
                force_kill_timeout_ms: 0,
            }),
            Err(WorkerProtocolError::InvalidField("forceKillTimeoutMs"))
        );

        assert_eq!(
            build_agent_worker_publish_result_message(AgentWorkerPublishResultMessageInput {
                correlation_id: "correlation".to_string(),
                sequence: 2,
                timestamp: 1710000400001,
                request_id: "request-1".to_string(),
                request_sequence: 1,
                status: AgentWorkerPublishResultStatus::Failed,
                event_ids: Vec::new(),
                error: Some(AgentWorkerErrorObject {
                    code: String::new(),
                    message: "publish failed".to_string(),
                    retryable: true,
                }),
            }),
            Err(WorkerProtocolError::InvalidField("code"))
        );
    }

    #[test]
    fn publish_result_status_error_semantics_are_validated() {
        for status in ["failed", "timeout"] {
            let mut message = publish_result_message(status);
            assert_eq!(
                validate_agent_worker_protocol_message(&message),
                Err(WorkerProtocolError::MissingField("error")),
                "{status} without error"
            );

            message["error"] = json!({
                "code": "publish_failed",
                "message": "relay publish failed",
                "retryable": true,
            });
            assert_eq!(
                validate_agent_worker_protocol_message(&message),
                Ok(WorkerProtocolDirection::DaemonToWorker),
                "{status} with error"
            );
        }

        for status in ["accepted", "published"] {
            let mut message = publish_result_message(status);
            message["eventIds"] = json!(["published-event-id"]);
            assert_eq!(
                validate_agent_worker_protocol_message(&message),
                Ok(WorkerProtocolDirection::DaemonToWorker),
                "{status} without error"
            );

            message["error"] = json!({
                "code": "publish_failed",
                "message": "success statuses must not include an error",
                "retryable": false,
            });
            assert_eq!(
                validate_agent_worker_protocol_message(&message),
                Err(WorkerProtocolError::InvalidField("error")),
                "{status} with error"
            );
        }

        assert_eq!(
            build_agent_worker_publish_result_message(AgentWorkerPublishResultMessageInput {
                correlation_id: "correlation".to_string(),
                sequence: 3,
                timestamp: 1710000400002,
                request_id: "request-1".to_string(),
                request_sequence: 2,
                status: AgentWorkerPublishResultStatus::Timeout,
                event_ids: Vec::new(),
                error: None,
            }),
            Err(WorkerProtocolError::MissingField("error"))
        );

        assert_eq!(
            build_agent_worker_publish_result_message(AgentWorkerPublishResultMessageInput {
                correlation_id: "correlation".to_string(),
                sequence: 4,
                timestamp: 1710000400003,
                request_id: "request-1".to_string(),
                request_sequence: 2,
                status: AgentWorkerPublishResultStatus::Accepted,
                event_ids: vec!["published-event-id".to_string()],
                error: Some(AgentWorkerErrorObject {
                    code: "publish_failed".to_string(),
                    message: "accepted status must not include an error".to_string(),
                    retryable: false,
                }),
            }),
            Err(WorkerProtocolError::InvalidField("error"))
        );
    }

    #[test]
    fn stream_delta_payload_and_content_ref_semantics_are_validated() {
        let mut inline_delta = stream_delta_message();
        inline_delta["delta"] = json!("x".repeat(AGENT_WORKER_STREAM_BATCH_MAX_BYTES as usize));
        assert_eq!(
            validate_agent_worker_protocol_message(&inline_delta),
            Ok(WorkerProtocolDirection::WorkerToDaemon)
        );

        inline_delta["delta"] = json!("x".repeat(AGENT_WORKER_STREAM_BATCH_MAX_BYTES as usize + 1));
        assert_eq!(
            validate_agent_worker_protocol_message(&inline_delta),
            Err(WorkerProtocolError::InvalidField("delta"))
        );

        let mut referenced_delta = stream_delta_message();
        referenced_delta["contentRef"] = json!({
            "path": "/tmp/tenex/worker/exec_stream_delta_semantics/delta-2.txt",
            "byteLength": AGENT_WORKER_MAX_FRAME_BYTES + 1,
            "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        });
        assert_eq!(
            validate_agent_worker_protocol_message(&referenced_delta),
            Ok(WorkerProtocolDirection::WorkerToDaemon)
        );

        let mut ambiguous_delta = referenced_delta.clone();
        ambiguous_delta["delta"] = json!("inline and referenced");
        assert_eq!(
            validate_agent_worker_protocol_message(&ambiguous_delta),
            Err(WorkerProtocolError::InvalidField("delta|contentRef"))
        );

        let mut invalid_content_ref = stream_delta_message();
        invalid_content_ref["contentRef"] = json!({
            "path": "",
            "byteLength": 1,
            "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        });
        assert_eq!(
            validate_agent_worker_protocol_message(&invalid_content_ref),
            Err(WorkerProtocolError::InvalidField("path"))
        );

        invalid_content_ref["contentRef"] = json!({
            "path": "/tmp/tenex/worker/exec_stream_delta_semantics/delta-2.txt",
            "byteLength": 0,
            "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        });
        assert_eq!(
            validate_agent_worker_protocol_message(&invalid_content_ref),
            Err(WorkerProtocolError::InvalidField("byteLength"))
        );

        invalid_content_ref["contentRef"] = json!({
            "path": "/tmp/tenex/worker/exec_stream_delta_semantics/delta-2.txt",
            "byteLength": 1,
            "sha256": "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        });
        assert_eq!(
            validate_agent_worker_protocol_message(&invalid_content_ref),
            Err(WorkerProtocolError::InvalidField("sha256"))
        );
    }

    #[test]
    fn frame_codec_rejects_declared_oversized_payload_without_allocating() {
        let mut frame = Vec::new();
        frame.extend_from_slice(&((AGENT_WORKER_MAX_PAYLOAD_BYTES + 1) as u32).to_be_bytes());

        assert_eq!(
            decode_agent_worker_protocol_frame(&frame),
            Err(WorkerProtocolError::FramePayloadTooLarge {
                payload_bytes: AGENT_WORKER_MAX_PAYLOAD_BYTES + 1,
                max_payload_bytes: AGENT_WORKER_MAX_PAYLOAD_BYTES,
            })
        );
    }

    #[test]
    fn worker_protocol_fixture_matches_rust_validator() {
        let fixture: WorkerProtocolFixture =
            serde_json::from_str(WORKER_PROTOCOL_FIXTURE).expect("fixture must parse");

        validate_worker_protocol_config(&fixture.protocol).expect("protocol config must validate");

        for fixture_message in &fixture.valid_messages {
            assert_eq!(
                validate_agent_worker_protocol_message(&fixture_message.message),
                Ok(fixture_message.direction),
                "{}",
                fixture_message.name
            );
        }

        for fixture_message in &fixture.invalid_messages {
            assert!(
                validate_agent_worker_protocol_message(&fixture_message.message).is_err(),
                "{}",
                fixture_message.name
            );
        }
    }

    #[test]
    fn worker_frame_codec_fixture_matches_rust_codec() {
        let fixture: WorkerFrameCodecFixture =
            serde_json::from_str(WORKER_FRAME_CODEC_FIXTURE).expect("fixture must parse");

        assert_eq!(
            fixture.format.length_prefix_bytes,
            AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES
        );
        assert_eq!(fixture.format.length_endian, "big");
        assert_eq!(fixture.format.payload_encoding, "utf-8");
        assert_eq!(
            fixture.format.json_canonicalization,
            "sorted-object-keys-no-whitespace"
        );
        assert_eq!(fixture.format.max_frame_bytes, AGENT_WORKER_MAX_FRAME_BYTES);

        for frame_fixture in &fixture.frames {
            let canonical_json = canonical_agent_worker_protocol_json(&frame_fixture.message)
                .unwrap_or_else(|error| panic!("{}: {error}", frame_fixture.name));
            assert_eq!(canonical_json, frame_fixture.canonical_json);
            assert_eq!(canonical_json.len(), frame_fixture.payload_byte_length);

            let encoded = encode_agent_worker_protocol_frame(&frame_fixture.message)
                .unwrap_or_else(|error| panic!("{}: {error}", frame_fixture.name));
            assert_eq!(hex::encode(&encoded), frame_fixture.frame_hex);

            let fixture_frame = hex::decode(&frame_fixture.frame_hex)
                .unwrap_or_else(|error| panic!("{}: {error}", frame_fixture.name));
            let decoded = decode_agent_worker_protocol_frame(&fixture_frame)
                .unwrap_or_else(|error| panic!("{}: {error}", frame_fixture.name));
            assert_eq!(decoded, frame_fixture.message);
        }

        for invalid_frame in &fixture.invalid_frames {
            let frame = hex::decode(&invalid_frame.frame_hex)
                .unwrap_or_else(|error| panic!("{}: {error}", invalid_frame.name));
            assert!(
                decode_agent_worker_protocol_frame(&frame).is_err(),
                "{}",
                invalid_frame.name
            );
        }
    }

    fn fixture_valid_message(name: &'static str) -> Value {
        let fixture: WorkerProtocolFixture =
            serde_json::from_str(WORKER_PROTOCOL_FIXTURE).expect("fixture must parse");
        fixture
            .valid_messages
            .into_iter()
            .find(|message| message.name == name)
            .unwrap_or_else(|| panic!("fixture must include {name} message"))
            .message
    }

    fn assert_builder_matches_fixture(built: Value, expected: Value) {
        assert_eq!(built, expected);
        assert_eq!(
            validate_agent_worker_protocol_message(&built),
            Ok(WorkerProtocolDirection::DaemonToWorker)
        );

        let encoded = encode_agent_worker_protocol_frame(&built).expect("frame must encode");
        let decoded = decode_agent_worker_protocol_frame(&encoded).expect("frame must decode");
        assert_eq!(decoded, expected);
    }

    fn publish_result_message(status: &'static str) -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_result",
            "correlationId": "exec_publish_result_semantics",
            "sequence": 9,
            "timestamp": 1710000410400_u64,
            "requestId": "pub_semantics",
            "requestSequence": 8,
            "status": status,
            "eventIds": [],
        })
    }

    fn stream_delta_message() -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "stream_delta",
            "correlationId": "exec_stream_delta_semantics",
            "sequence": 10,
            "timestamp": 1710000410500_u64,
            "projectId": "project-alpha",
            "agentPubkey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "conversationId": "conversation-alpha",
            "ralNumber": 3,
            "batchSequence": 1,
        })
    }

    fn fixture_dispatch_from_execute(
        execute: &Value,
        status: DispatchQueueStatus,
    ) -> DispatchQueueRecord {
        build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence: 42,
            timestamp: 1710000400999,
            correlation_id: value_string(execute, "correlationId"),
            dispatch_id: "dispatch-fixture".to_string(),
            ral: DispatchRalIdentity {
                project_id: value_string(execute, "projectId"),
                agent_pubkey: value_string(execute, "agentPubkey"),
                conversation_id: value_string(execute, "conversationId"),
                ral_number: execute["ralNumber"]
                    .as_u64()
                    .expect("fixture ral number must be u64"),
            },
            triggering_event_id: execute["triggeringEnvelope"]["message"]["nativeId"]
                .as_str()
                .expect("fixture triggering native id must be string")
                .to_string(),
            claim_token: value_string(execute, "ralClaimToken"),
            status,
        })
    }

    fn fixture_execute_input<'a>(
        dispatch: &'a DispatchQueueRecord,
        execute: &Value,
    ) -> AgentWorkerExecuteMessageInput<'a> {
        let flags = &execute["executionFlags"];
        AgentWorkerExecuteMessageInput {
            dispatch,
            sequence: execute["sequence"]
                .as_u64()
                .expect("fixture sequence must be u64"),
            timestamp: execute["timestamp"]
                .as_u64()
                .expect("fixture timestamp must be u64"),
            project_base_path: value_string(execute, "projectBasePath"),
            metadata_path: value_string(execute, "metadataPath"),
            triggering_envelope: execute["triggeringEnvelope"].clone(),
            execution_flags: AgentWorkerExecutionFlags {
                is_delegation_completion: flags["isDelegationCompletion"]
                    .as_bool()
                    .expect("fixture delegation flag must be bool"),
                has_pending_delegations: flags["hasPendingDelegations"]
                    .as_bool()
                    .expect("fixture pending flag must be bool"),
                debug: flags["debug"]
                    .as_bool()
                    .expect("fixture debug flag must be bool"),
            },
        }
    }

    fn value_string(value: &Value, key: &'static str) -> String {
        value[key]
            .as_str()
            .unwrap_or_else(|| panic!("fixture field {key} must be string"))
            .to_string()
    }

    fn value_string_array(value: &Value, key: &'static str) -> Vec<String> {
        value[key]
            .as_array()
            .unwrap_or_else(|| panic!("fixture field {key} must be array"))
            .iter()
            .map(|item| {
                item.as_str()
                    .unwrap_or_else(|| panic!("fixture field {key} item must be string"))
                    .to_string()
            })
            .collect()
    }

    fn value_u64(value: &Value, key: &'static str) -> u64 {
        value[key]
            .as_u64()
            .unwrap_or_else(|| panic!("fixture field {key} must be u64"))
    }
}
