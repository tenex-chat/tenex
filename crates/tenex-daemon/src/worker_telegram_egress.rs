use std::path::Path;

use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

use crate::nostr_event::{NostrEventError, SignedNostrEvent, verify_signed_event};
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

pub const TENEX_EGRESS_TAG: &str = "tenex:egress";
pub const TENEX_CHANNEL_TAG: &str = "tenex:channel";
pub const TELEGRAM_EGRESS_VALUE: &str = "telegram";
pub const NOSTR_EGRESS_VALUE: &str = "nostr";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerEgressRoute {
    Nostr,
    Telegram,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerTelegramEgressContext<'a> {
    pub data_dir: &'a Path,
    pub backend_pubkey: &'a str,
    pub writer_version: &'a str,
}

#[derive(Debug, Clone, Copy)]
pub struct WorkerTelegramEgressInput<'a> {
    pub daemon_dir: &'a Path,
    pub message: &'a Value,
    pub context: WorkerTelegramEgressContext<'a>,
    pub accepted_at: u64,
}

#[derive(Debug, Error)]
pub enum WorkerEgressRouteError {
    #[error("signed event has multiple tenex:egress tags")]
    MultipleEgressTags,
    #[error("signed event has unsupported tenex:egress value {0}")]
    UnsupportedEgress(String),
    #[error("nostr egress event must not carry tenex:channel")]
    NostrWithChannel,
}

#[derive(Debug, Error)]
pub enum WorkerTelegramEgressError {
    #[error("worker telegram egress field is missing or invalid: {0}")]
    InvalidField(&'static str),
    #[error("worker telegram egress routing failed: {0}")]
    Route(#[from] WorkerEgressRouteError),
    #[error(
        "worker telegram egress event pubkey {event_pubkey} does not match agent {agent_pubkey}"
    )]
    AgentPubkeyMismatch {
        event_pubkey: String,
        agent_pubkey: String,
    },
    #[error("worker telegram egress event signature is invalid: {0}")]
    Nostr(#[from] NostrEventError),
    #[error("worker telegram egress event is missing tenex:channel")]
    MissingChannel,
    #[error("worker telegram egress event has multiple tenex:channel tags")]
    MultipleChannels,
    #[error("worker telegram egress event has invalid channel id: {0}")]
    InvalidChannelId(String),
    #[error("worker telegram egress event has invalid thread target: {0}")]
    InvalidThreadTarget(String),
    #[error("worker telegram egress event is missing project a-tag")]
    MissingProjectTag,
    #[error("worker telegram egress event has multiple project a-tags")]
    MultipleProjectTags,
    #[error(
        "worker telegram egress project a-tag {project_d_tag} does not match request project {request_project_id}"
    )]
    ProjectTagMismatch {
        project_d_tag: String,
        request_project_id: String,
    },
    #[error("worker telegram egress transport bindings read failed: {0}")]
    BindingsRead(#[from] TransportBindingReadError),
    #[error("telegram channel {channel_id} is not remembered for agent {agent_pubkey}")]
    UnboundChannel {
        agent_pubkey: String,
        channel_id: String,
    },
    #[error(
        "telegram channel {channel_id} is bound to project {binding_project_id} but event targets project {event_project_id}"
    )]
    ProjectBindingMismatch {
        channel_id: String,
        binding_project_id: String,
        event_project_id: String,
    },
    #[error("worker telegram egress rendered message text is empty")]
    EmptyRenderedMessage,
    #[error("telegram outbox acceptance failed: {0}")]
    Outbox(#[from] TelegramOutboxError),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerPublishRequestForTelegram {
    project_id: String,
    agent_pubkey: String,
    request_id: String,
    event: SignedNostrEvent,
}

pub fn classify_worker_egress_route(
    event: &SignedNostrEvent,
) -> Result<WorkerEgressRoute, WorkerEgressRouteError> {
    let egress_values: Vec<&str> = event
        .tags
        .iter()
        .filter(|tag| tag.first().is_some_and(|name| name == TENEX_EGRESS_TAG))
        .filter_map(|tag| tag.get(1).map(String::as_str))
        .collect();

    let route = match egress_values.as_slice() {
        [] => WorkerEgressRoute::Nostr,
        [NOSTR_EGRESS_VALUE] => WorkerEgressRoute::Nostr,
        [TELEGRAM_EGRESS_VALUE] => WorkerEgressRoute::Telegram,
        [_] => {
            return Err(WorkerEgressRouteError::UnsupportedEgress(
                egress_values[0].to_string(),
            ));
        }
        _ => return Err(WorkerEgressRouteError::MultipleEgressTags),
    };

    if route == WorkerEgressRoute::Nostr
        && event
            .tags
            .iter()
            .any(|tag| tag.first().is_some_and(|name| name == TENEX_CHANNEL_TAG))
    {
        return Err(WorkerEgressRouteError::NostrWithChannel);
    }

    Ok(route)
}

pub fn accept_worker_telegram_egress(
    input: WorkerTelegramEgressInput<'_>,
) -> Result<TelegramOutboxRecord, WorkerTelegramEgressError> {
    let request: WorkerPublishRequestForTelegram = serde_json::from_value(input.message.clone())
        .map_err(|_| WorkerTelegramEgressError::InvalidField("publish_request"))?;

    if request.event.pubkey != request.agent_pubkey {
        return Err(WorkerTelegramEgressError::AgentPubkeyMismatch {
            event_pubkey: request.event.pubkey.clone(),
            agent_pubkey: request.agent_pubkey,
        });
    }
    verify_signed_event(&request.event)?;
    if classify_worker_egress_route(&request.event)? != WorkerEgressRoute::Telegram {
        return Err(WorkerTelegramEgressError::InvalidField("tenex:egress"));
    }

    let channel_id = single_tag_value(&request.event, TENEX_CHANNEL_TAG).map_err(|multiple| {
        if multiple {
            WorkerTelegramEgressError::MultipleChannels
        } else {
            WorkerTelegramEgressError::MissingChannel
        }
    })?;

    let project_d_tag = project_d_tag_from_event(&request.event)?;
    if project_d_tag != request.project_id {
        return Err(WorkerTelegramEgressError::ProjectTagMismatch {
            project_d_tag,
            request_project_id: request.project_id,
        });
    }

    let parts = parse_telegram_channel_id(&channel_id).map_err(|error| match error {
        TelegramChannelIdError::Malformed
        | TelegramChannelIdError::MissingChatId
        | TelegramChannelIdError::InvalidChatId { .. } => {
            WorkerTelegramEgressError::InvalidChannelId(error.to_string())
        }
        TelegramChannelIdError::InvalidMessageThreadId { .. }
        | TelegramChannelIdError::ThreadTargetRequiresGroup { .. } => {
            WorkerTelegramEgressError::InvalidThreadTarget(error.to_string())
        }
    })?;

    let bindings = read_transport_bindings(input.context.data_dir)?;
    let binding = find_binding(
        &bindings,
        &request.agent_pubkey,
        &channel_id,
        BindingRuntimeTransport::Telegram,
    )
    .ok_or_else(|| WorkerTelegramEgressError::UnboundChannel {
        agent_pubkey: request.agent_pubkey.clone(),
        channel_id: channel_id.clone(),
    })?;

    if binding.project_id != request.project_id {
        return Err(WorkerTelegramEgressError::ProjectBindingMismatch {
            channel_id: channel_id.clone(),
            binding_project_id: binding.project_id.clone(),
            event_project_id: request.project_id,
        });
    }

    let rendered = render_telegram_message(&request.event.content);
    if rendered.text.is_empty() {
        return Err(WorkerTelegramEgressError::EmptyRenderedMessage);
    }

    accept_telegram_delivery_request(
        input.daemon_dir,
        TelegramDeliveryRequest {
            nostr_event_id: request.event.id.clone(),
            correlation_id: request.request_id,
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
                agent_pubkey: request.event.pubkey,
                display_name: None,
            },
            delivery_reason: TelegramDeliveryReason::ProactiveSend,
            reply_to_telegram_message_id: None,
            payload: TelegramDeliveryPayload::HtmlText {
                html: rendered.text,
            },
            writer_version: input.context.writer_version.to_string(),
        },
        input.accepted_at,
    )
    .map_err(WorkerTelegramEgressError::from)
}

fn single_tag_value(event: &SignedNostrEvent, tag_name: &str) -> Result<String, bool> {
    let values: Vec<&str> = event
        .tags
        .iter()
        .filter(|tag| tag.first().is_some_and(|name| name == tag_name))
        .filter_map(|tag| tag.get(1).map(String::as_str))
        .collect();
    match values.as_slice() {
        [value] if !value.is_empty() => Ok((*value).to_string()),
        [] => Err(false),
        _ => Err(true),
    }
}

fn project_d_tag_from_event(event: &SignedNostrEvent) -> Result<String, WorkerTelegramEgressError> {
    let values: Vec<&str> = event
        .tags
        .iter()
        .filter(|tag| tag.first().is_some_and(|name| name == "a"))
        .filter_map(|tag| tag.get(1).map(String::as_str))
        .filter(|value| value.starts_with("31933:"))
        .collect();
    let value = match values.as_slice() {
        [value] => *value,
        [] => return Err(WorkerTelegramEgressError::MissingProjectTag),
        _ => return Err(WorkerTelegramEgressError::MultipleProjectTags),
    };
    value
        .split(':')
        .nth(2)
        .filter(|d_tag| !d_tag.is_empty())
        .map(str::to_string)
        .ok_or(WorkerTelegramEgressError::MissingProjectTag)
}
