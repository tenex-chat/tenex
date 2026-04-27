use std::path::Path;

use thiserror::Error;

use crate::backend_events::heartbeat::{
    BackendSigner, HeartbeatEncodeError, HeartbeatInputs, encode_heartbeat,
};
use crate::backend_events::installed_agent_list::{
    AgentConfigEncodeError, AgentConfigInputs, AgentListEncodeError, AgentListInputs,
    encode_agent_config, encode_agent_list,
};
use crate::backend_events::operations_status::{
    OperationsStatusEncodeError, OperationsStatusInputs, encode_operations_status,
};
use crate::backend_events::project_status::{
    ProjectStatusEncodeError, ProjectStatusInputs, encode_project_status,
};
use crate::backend_profile::{
    BackendProfileEncodeError, BackendProfileInputs, encode_backend_profile,
};
use crate::nostr_event::SignedNostrEvent;
use crate::publish_outbox::PublishOutboxError;
use crate::publish_runtime::{
    BackendPublishRuntimeInput, BackendPublishRuntimeOutcome, enqueue_backend_event_for_publish,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendEventPublishContext<'a> {
    pub daemon_dir: &'a Path,
    pub accepted_at: u64,
    pub request_id: &'a str,
    pub request_sequence: u64,
    pub request_timestamp: u64,
    pub correlation_id: &'a str,
    pub project_id: &'a str,
    pub conversation_id: &'a str,
    pub ral_number: u64,
    pub wait_for_relay_ok: bool,
    pub timeout_ms: u64,
}

#[derive(Debug, Error)]
pub enum BackendEventPublishError {
    #[error("heartbeat encode failed: {0}")]
    Heartbeat(#[from] HeartbeatEncodeError),
    #[error("project-status encode failed: {0}")]
    ProjectStatus(#[from] ProjectStatusEncodeError),
    #[error("agent-config encode failed: {0}")]
    AgentConfig(#[from] AgentConfigEncodeError),
    #[error("agent-list encode failed: {0}")]
    AgentList(#[from] AgentListEncodeError),
    #[error("operations-status encode failed: {0}")]
    OperationsStatus(#[from] OperationsStatusEncodeError),
    #[error("backend-profile encode failed: {0}")]
    BackendProfile(#[from] BackendProfileEncodeError),
    #[error("publish outbox error: {0}")]
    PublishOutbox(#[from] PublishOutboxError),
}

pub fn publish_backend_heartbeat<S: BackendSigner>(
    context: BackendEventPublishContext<'_>,
    inputs: HeartbeatInputs<'_>,
    signer: &S,
) -> Result<BackendPublishRuntimeOutcome, BackendEventPublishError> {
    let event = encode_heartbeat(&inputs, signer)?;
    enqueue_backend_signed_event(context, event, signer).map_err(BackendEventPublishError::from)
}

pub fn publish_backend_project_status<S: BackendSigner>(
    context: BackendEventPublishContext<'_>,
    inputs: ProjectStatusInputs<'_>,
    signer: &S,
) -> Result<BackendPublishRuntimeOutcome, BackendEventPublishError> {
    let event = encode_project_status(&inputs, signer)?;
    enqueue_backend_signed_event(context, event, signer).map_err(BackendEventPublishError::from)
}

pub fn publish_backend_agent_list<S: BackendSigner>(
    context: BackendEventPublishContext<'_>,
    inputs: AgentListInputs<'_>,
    signer: &S,
) -> Result<BackendPublishRuntimeOutcome, BackendEventPublishError> {
    let event = encode_agent_list(&inputs, signer)?;
    enqueue_backend_signed_event(context, event, signer).map_err(BackendEventPublishError::from)
}

pub fn publish_backend_agent_config<S: BackendSigner>(
    context: BackendEventPublishContext<'_>,
    inputs: AgentConfigInputs<'_>,
    signer: &S,
) -> Result<BackendPublishRuntimeOutcome, BackendEventPublishError> {
    let event = encode_agent_config(&inputs, signer)?;
    enqueue_backend_signed_event(context, event, signer).map_err(BackendEventPublishError::from)
}

pub fn publish_backend_operations_status<S: BackendSigner>(
    context: BackendEventPublishContext<'_>,
    inputs: OperationsStatusInputs<'_>,
    signer: &S,
) -> Result<BackendPublishRuntimeOutcome, BackendEventPublishError> {
    let event = encode_operations_status(&inputs, signer)?;
    enqueue_backend_signed_event(context, event, signer).map_err(BackendEventPublishError::from)
}

pub fn publish_backend_profile<S: BackendSigner>(
    context: BackendEventPublishContext<'_>,
    inputs: BackendProfileInputs<'_>,
    signer: &S,
) -> Result<BackendPublishRuntimeOutcome, BackendEventPublishError> {
    let event = encode_backend_profile(&inputs, signer)?;
    enqueue_backend_signed_event(context, event, signer).map_err(BackendEventPublishError::from)
}

fn enqueue_backend_signed_event<S: BackendSigner>(
    context: BackendEventPublishContext<'_>,
    event: SignedNostrEvent,
    signer: &S,
) -> Result<BackendPublishRuntimeOutcome, PublishOutboxError> {
    let expected_publisher_pubkey = signer.xonly_pubkey_hex();
    enqueue_backend_event_for_publish(BackendPublishRuntimeInput {
        daemon_dir: context.daemon_dir,
        event,
        accepted_at: context.accepted_at,
        request_id: context.request_id,
        request_sequence: context.request_sequence,
        request_timestamp: context.request_timestamp,
        correlation_id: context.correlation_id,
        project_id: context.project_id,
        conversation_id: context.conversation_id,
        expected_publisher_pubkey: &expected_publisher_pubkey,
        ral_number: context.ral_number,
        wait_for_relay_ok: context.wait_for_relay_ok,
        timeout_ms: context.timeout_ms,
    })
}
