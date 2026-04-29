use nostr::EventBuilder;

use crate::context::EncodingContext;
use crate::refs::{ConversationRef, MessageRef};

use super::super::tags::{e_reply_tag, e_root_tag};
use super::EncodeError;

pub(super) fn add_conversation_tags(
    mut builder: EventBuilder,
    ctx: &EncodingContext,
) -> Result<EventBuilder, EncodeError> {
    if let Some(ConversationRef::Nostr { root_event_id }) = ctx.conversation_root.as_ref() {
        builder = builder.tag(e_root_tag(root_event_id)?);
        if let Some(MessageRef::Nostr { event_id }) = ctx.triggering_message.as_ref() {
            builder = builder.tag(e_reply_tag(event_id)?);
        }
    }
    Ok(builder)
}

pub(super) fn prepend_recipient_label(content: &str, label: &str) -> String {
    let trimmed = content.trim_start();
    if trimmed.starts_with("nostr:") || starts_with_slug_prefix(trimmed) {
        return content.to_string();
    }
    format!("{label}: {content}")
}

pub(super) fn shorten_conversation_id(id: &str) -> String {
    if id.len() <= 8 {
        id.to_string()
    } else {
        id[..8].to_string()
    }
}

fn starts_with_slug_prefix(s: &str) -> bool {
    let mut chars = s.chars();
    if chars.next() != Some('@') {
        return false;
    }
    let mut saw_body = false;
    for c in chars {
        if c == ':' {
            return saw_body;
        }
        if c.is_alphanumeric() || c == '-' || c == '_' {
            saw_body = true;
        } else {
            return false;
        }
    }
    false
}
