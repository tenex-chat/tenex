//! Nostr `Event` → [`InboundEnvelope`].
//!
//! Mirrors `src/nostr/AgentEventDecoder.ts` and the per-tag extraction logic
//! used by `NostrInboundAdapter.ts`. The decoder makes no network calls and
//! reads only what the event itself carries.

use nostr::{Event, EventId};

use crate::channel::{InboundEnvelope, InboundMetadata, TelegramTransportMetadata};
use crate::refs::{ConversationRef, MessageRef, PrincipalKind, PrincipalRef};

use super::kinds;

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("invalid event id in tag {0}: {1}")]
    InvalidEventId(&'static str, String),
    #[error("invalid pubkey in tag {0}: {1}")]
    InvalidPubkey(&'static str, String),
}

/// Decode a Nostr event into a transport-tagged [`InboundEnvelope`].
pub fn decode(event: &Event) -> Result<InboundEnvelope, DecodeError> {
    let kind_u16 = event.kind.as_u16();

    let mut tool_name: Option<String> = None;
    let mut status: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut commit: Option<String> = None;
    let mut team: Option<String> = None;
    let mut variant_override: Option<String> = None;
    let mut article_references: Vec<String> = Vec::new();
    let mut reply_targets: Vec<MessageRef> = Vec::new();
    let mut delegation_parent_conversation: Option<ConversationRef> = None;
    let mut project_a_tags: Vec<String> = Vec::new();
    let mut skills: Vec<String> = Vec::new();
    let mut recipients: Vec<PrincipalRef> = Vec::new();
    let mut root_event_id: Option<EventId> = None;
    let mut reply_to: Option<MessageRef> = None;
    let mut telegram_chat_id: Option<String> = None;
    let mut telegram_message_id: Option<String> = None;
    let mut telegram_thread_id: Option<String> = None;

    for tag in event.tags.iter() {
        let parts: Vec<String> = tag.clone().to_vec();
        let head = parts.first().map(|s| s.as_str()).unwrap_or("");
        match head {
            "e" => {
                let id = parts
                    .get(1)
                    .ok_or_else(|| DecodeError::InvalidEventId("e", "missing".into()))?;
                let parsed = EventId::from_hex(id)
                    .map_err(|e| DecodeError::InvalidEventId("e", e.to_string()))?;
                let marker = parts.get(3).map(|s| s.as_str()).unwrap_or("");
                match marker {
                    "root" => root_event_id = Some(parsed),
                    "reply" => reply_to = Some(MessageRef::Nostr { event_id: parsed }),
                    _ => {
                        // Unmarked e-tag. Use as root if no root yet, else as reply target.
                        if root_event_id.is_none() {
                            root_event_id = Some(parsed);
                        } else {
                            reply_targets.push(MessageRef::Nostr { event_id: parsed });
                        }
                    }
                }
            }
            "p" => {
                if let Some(hex) = parts.get(1) {
                    let pubkey = nostr::PublicKey::from_hex(hex)
                        .map_err(|e| DecodeError::InvalidPubkey("p", e.to_string()))?;
                    recipients.push(PrincipalRef::Nostr {
                        pubkey,
                        kind: PrincipalKind::Agent,
                        display_name: None,
                    });
                }
            }
            "a" => {
                if let Some(coord) = parts.get(1) {
                    article_references.push(coord.clone());
                    if coord.starts_with(&format!("{}:", kinds::PROJECT)) {
                        project_a_tags.push(coord.clone());
                    }
                }
            }
            "tool" => tool_name = parts.get(1).cloned(),
            "status" => status = parts.get(1).cloned(),
            "branch" => branch = parts.get(1).cloned(),
            "commit" => commit = parts.get(1).cloned(),
            "team" => team = parts.get(1).cloned(),
            "variant" => variant_override = parts.get(1).cloned(),
            "delegation" => {
                if let Some(parent) = parts.get(1) {
                    if let Ok(id) = EventId::from_hex(parent) {
                        delegation_parent_conversation =
                            Some(ConversationRef::Nostr { root_event_id: id });
                    }
                }
            }
            "skill" => {
                if let Some(id) = parts.get(1) {
                    skills.push(id.clone());
                }
            }
            "telegram-chat-id" => telegram_chat_id = parts.get(1).cloned(),
            "telegram-message-id" => telegram_message_id = parts.get(1).cloned(),
            "telegram-thread-id" => telegram_thread_id = parts.get(1).cloned(),
            _ => {}
        }
    }

    let telegram = match (telegram_chat_id, telegram_message_id) {
        (Some(chat_id), Some(message_id)) => Some(TelegramTransportMetadata {
            chat_id,
            message_id,
            thread_id: telegram_thread_id,
        }),
        _ => None,
    };

    let root_id = root_event_id.unwrap_or(event.id);
    let conversation = ConversationRef::Nostr {
        root_event_id: root_id,
    };
    let message = MessageRef::Nostr { event_id: event.id };
    let root = MessageRef::Nostr { event_id: root_id };

    let principal = PrincipalRef::Nostr {
        pubkey: event.pubkey,
        kind: PrincipalKind::Agent,
        display_name: None,
    };

    let metadata = InboundMetadata {
        event_kind: Some(u32::from(kind_u16)),
        tool_name,
        status,
        branch,
        commit,
        variant_override,
        team,
        article_references,
        reply_targets,
        delegation_parent_conversation,
        is_kill_signal: kind_u16 == kinds::STOP_COMMAND,
        project_a_tags,
        skills,
        telegram,
    };

    Ok(InboundEnvelope {
        channel: "nostr",
        principal,
        conversation,
        message,
        recipients,
        content: event.content.clone(),
        occurred_at: event.created_at.as_secs(),
        root,
        reply_to,
        metadata,
    })
}

impl InboundEnvelope {
    /// Match TS `isDelegationCompletion`: kind:1 + `["status","completed"]`.
    pub fn is_completion(&self) -> bool {
        self.metadata.event_kind == Some(1) && self.metadata.status.as_deref() == Some("completed")
    }

    /// Match TS `isAgentInternalMessage`: has tool tag or status tag.
    pub fn is_agent_internal_message(&self) -> bool {
        self.metadata.tool_name.is_some() || self.metadata.status.is_some()
    }
}
