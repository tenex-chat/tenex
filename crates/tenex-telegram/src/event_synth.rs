//! Synthesizes a signed Nostr event for an inbound Telegram message.
//!
//! The event is **not** published to a relay — it is fed directly into the
//! per-project runtime via the streaming control socket. Tags retain the
//! `telegram-*` metadata the agent needs to identify the originating chat
//! (used today by the conversation store to correlate replies).

use anyhow::{Context, Result};
use nostr_sdk::prelude::*;

use crate::discovery::ProjectRoute;

pub struct TelegramEventInput<'a> {
    pub agent_pubkey: &'a str,
    pub project: &'a ProjectRoute,
    pub backend_keys: &'a Keys,
    pub root_event_id: Option<String>,
    pub sender_first_name: &'a str,
    pub sender_username: Option<&'a str>,
    pub sender_id: i64,
    pub chat_id: &'a str,
    pub message_id: &'a str,
    pub thread_id: Option<&'a str>,
    pub channel_id: &'a str,
    pub text: &'a str,
    /// URLs for inbound media (e.g. `file://` paths to cached Telegram photos).
    /// Appended to the event content as markdown image references so the
    /// agent's multimodal pipeline picks them up.
    pub image_urls: &'a [String],
}

pub struct SynthesizedTelegramEvent {
    pub event: Event,
    /// True when no `e root` tag was attached — caller should remember this
    /// event's id as the new conversation root for the channel.
    pub new_root: bool,
}

pub fn synthesize_telegram_event(
    input: TelegramEventInput<'_>,
) -> Result<SynthesizedTelegramEvent> {
    let agent_pubkey = PublicKey::from_hex(input.agent_pubkey).context("parse agent pubkey")?;
    let mut tags = vec![
        Tag::public_key(agent_pubkey),
        Tag::custom(
            TagKind::Custom("telegram-chat-id".into()),
            vec![input.chat_id.to_string()],
        ),
        Tag::custom(
            TagKind::Custom("telegram-message-id".into()),
            vec![input.message_id.to_string()],
        ),
        Tag::custom(
            TagKind::Custom("telegram-channel-id".into()),
            vec![input.channel_id.to_string()],
        ),
    ];
    if let Some(tid) = input.thread_id {
        tags.push(Tag::custom(
            TagKind::Custom("telegram-thread-id".into()),
            vec![tid.to_string()],
        ));
    }

    let new_root = if let Some(ref root_hex) = input.root_event_id {
        if let Ok(root_id) = EventId::from_hex(root_hex) {
            tags.push(Tag::from_standardized_without_cell(TagStandard::Event {
                event_id: root_id,
                relay_url: None,
                marker: Some(Marker::Root),
                public_key: None,
                uppercase: false,
            }));
            false
        } else {
            true
        }
    } else {
        true
    };

    if let Some(owner) = &input.project.owner_pubkey {
        let coord = format!("31933:{owner}:{}", input.project.project_id);
        tags.push(Tag::custom(TagKind::Custom("a".into()), vec![coord]));
    }

    let user_info = format!(
        "[Telegram user {} ({})]",
        input.sender_first_name,
        input
            .sender_username
            .map(|u| format!("@{u}"))
            .unwrap_or_else(|| input.sender_id.to_string())
    );
    let mut content = format!("{user_info} {}", input.text);
    for url in input.image_urls {
        content.push_str(&format!("\n\n![photo]({url})"));
    }
    let event = EventBuilder::new(Kind::TextNote, content)
        .tags(tags)
        .sign_with_keys(input.backend_keys)
        .context("sign event")?;

    Ok(SynthesizedTelegramEvent { event, new_root })
}
