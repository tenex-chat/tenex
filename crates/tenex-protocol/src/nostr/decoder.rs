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
    #[error("tag {0} is missing its required value")]
    MissingTagValue(&'static str),
}

/// Decode a Nostr event into a transport-tagged [`InboundEnvelope`].
pub fn decode(event: &Event) -> Result<InboundEnvelope, DecodeError> {
    let kind_u16 = event.kind.as_u16();

    let mut tool_name: Option<String> = None;
    let mut status: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut team: Option<String> = None;
    let mut variant_override: Option<String> = None;
    let mut article_references: Vec<String> = Vec::new();
    let mut reply_targets: Vec<MessageRef> = Vec::new();
    let mut delegation_parent_conversation: Option<ConversationRef> = None;
    let mut project_a_tags: Vec<String> = Vec::new();
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
                let id = required_value(&parts, "e")?;
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
                let hex = required_value(&parts, "p")?;
                let pubkey = nostr::PublicKey::from_hex(hex)
                    .map_err(|e| DecodeError::InvalidPubkey("p", e.to_string()))?;
                recipients.push(PrincipalRef::Nostr {
                    pubkey,
                    kind: PrincipalKind::Agent,
                    display_name: None,
                });
            }
            "a" => {
                let coord = required_value(&parts, "a")?;
                article_references.push(coord.clone());
                if coord.starts_with(&format!("{}:", kinds::PROJECT)) {
                    project_a_tags.push(coord.clone());
                }
            }
            "tool" => tool_name = Some(required_value(&parts, "tool")?.clone()),
            "status" => status = Some(required_value(&parts, "status")?.clone()),
            "branch" => branch = Some(required_value(&parts, "branch")?.clone()),
            "team" => team = Some(required_value(&parts, "team")?.clone()),
            "variant" => variant_override = Some(required_value(&parts, "variant")?.clone()),
            "delegation" => {
                let parent = required_value(&parts, "delegation")?;
                let id = EventId::from_hex(parent)
                    .map_err(|e| DecodeError::InvalidEventId("delegation", e.to_string()))?;
                delegation_parent_conversation = Some(ConversationRef::Nostr { root_event_id: id });
            }
            "telegram-chat-id" => {
                telegram_chat_id = Some(required_value(&parts, "telegram-chat-id")?.clone())
            }
            "telegram-message-id" => {
                telegram_message_id = Some(required_value(&parts, "telegram-message-id")?.clone())
            }
            "telegram-thread-id" => {
                telegram_thread_id = Some(required_value(&parts, "telegram-thread-id")?.clone())
            }
            // Unknown tag types are ignored: NIP-01 explicitly allows arbitrary
            // tag names, and the protocol layer must tolerate forward-compatible
            // additions emitted by other clients.
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
        variant_override,
        team,
        article_references,
        reply_targets,
        delegation_parent_conversation,
        is_kill_signal: kind_u16 == kinds::STOP_COMMAND,
        project_a_tags,
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

fn required_value<'a>(parts: &'a [String], tag: &'static str) -> Result<&'a String, DecodeError> {
    parts
        .get(1)
        .ok_or(DecodeError::MissingTagValue(tag))
        .and_then(|v| {
            if v.is_empty() {
                Err(DecodeError::MissingTagValue(tag))
            } else {
                Ok(v)
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Tag};

    fn signed(builder: EventBuilder) -> Event {
        let keys = Keys::generate();
        builder.sign_with_keys(&keys).expect("sign")
    }

    fn build_with_tags(tags: Vec<Tag>) -> Event {
        let mut builder = EventBuilder::new(nostr::Kind::TextNote, "hello");
        for tag in tags {
            builder = builder.tag(tag);
        }
        signed(builder)
    }

    #[test]
    fn well_formed_event_decodes_successfully() {
        let other = Keys::generate().public_key();
        let parent_id = EventId::all_zeros().to_hex();
        let event = build_with_tags(vec![
            Tag::parse(["e", &parent_id, "", "root"]).unwrap(),
            Tag::parse(["p", &other.to_hex()]).unwrap(),
            Tag::parse(["a", "31933:abc:my-project"]).unwrap(),
            Tag::parse(["status", "completed"]).unwrap(),
            Tag::parse(["tool", "shell"]).unwrap(),
            Tag::parse(["delegation", &parent_id]).unwrap(),
        ]);

        let env = decode(&event).expect("decode well-formed");
        assert_eq!(env.metadata.status.as_deref(), Some("completed"));
        assert_eq!(env.metadata.tool_name.as_deref(), Some("shell"));
        assert_eq!(env.recipients.len(), 1);
        assert_eq!(env.metadata.article_references.len(), 1);
        assert_eq!(env.metadata.project_a_tags.len(), 1);
        assert!(env.metadata.delegation_parent_conversation.is_some());
    }

    #[test]
    fn unmarked_e_tag_first_becomes_root() {
        let parent_id = EventId::all_zeros().to_hex();
        let event = build_with_tags(vec![Tag::parse(["e", &parent_id]).unwrap()]);
        let env = decode(&event).expect("decode");
        match env.root {
            MessageRef::Nostr { event_id } => assert_eq!(event_id.to_hex(), parent_id),
        }
    }

    #[test]
    fn missing_e_tag_value_errors() {
        // Build a raw tag with only the head; bypass nostr Tag parsing rules
        // by constructing the event from its parts. Since `Tag::parse(["e"])`
        // is itself rejected, we go via `Tag::custom`.
        let event = build_with_tags(vec![Tag::custom(
            nostr::TagKind::SingleLetter(nostr::SingleLetterTag::lowercase(nostr::Alphabet::E)),
            Vec::<String>::new(),
        )]);
        match decode(&event) {
            Err(DecodeError::MissingTagValue("e")) => {}
            other => panic!("expected MissingTagValue(\"e\"), got {other:?}"),
        }
    }

    #[test]
    fn empty_p_tag_value_errors() {
        let event = build_with_tags(vec![Tag::parse(["p", ""]).unwrap()]);
        match decode(&event) {
            Err(DecodeError::MissingTagValue("p")) => {}
            other => panic!("expected MissingTagValue(\"p\"), got {other:?}"),
        }
    }

    #[test]
    fn malformed_p_tag_value_errors() {
        let event = build_with_tags(vec![Tag::parse(["p", "not-a-real-pubkey"]).unwrap()]);
        match decode(&event) {
            Err(DecodeError::InvalidPubkey("p", _)) => {}
            other => panic!("expected InvalidPubkey(\"p\", _), got {other:?}"),
        }
    }

    #[test]
    fn malformed_delegation_tag_errors() {
        let event = build_with_tags(vec![Tag::parse(["delegation", "not-hex"]).unwrap()]);
        match decode(&event) {
            Err(DecodeError::InvalidEventId("delegation", _)) => {}
            other => panic!("expected InvalidEventId(\"delegation\", _), got {other:?}"),
        }
    }

    #[test]
    fn missing_status_tag_value_errors() {
        let event = build_with_tags(vec![Tag::custom(
            nostr::TagKind::Custom("status".into()),
            Vec::<String>::new(),
        )]);
        match decode(&event) {
            Err(DecodeError::MissingTagValue("status")) => {}
            other => panic!("expected MissingTagValue(\"status\"), got {other:?}"),
        }
    }

    #[test]
    fn unknown_tag_kinds_are_ignored() {
        let event = build_with_tags(vec![Tag::custom(
            nostr::TagKind::Custom("some-future-tag".into()),
            ["x"],
        )]);
        decode(&event).expect("unknown tags must not break decode");
    }
}
