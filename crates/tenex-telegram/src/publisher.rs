use anyhow::{Context, Result};
use nostr_sdk::prelude::*;

use crate::discovery::ProjectRoute;

pub struct TelegramPublishRequest<'a> {
    pub agent_pubkey: &'a str,
    pub project: &'a ProjectRoute,
    pub backend_keys: &'a Keys,
    pub nostr: &'a Client,
    pub root_event_id: Option<String>,
    pub sender_first_name: &'a str,
    pub sender_username: Option<&'a str>,
    pub sender_id: i64,
    pub chat_id: &'a str,
    pub message_id: &'a str,
    pub thread_id: Option<&'a str>,
    pub channel_id: &'a str,
    pub text: &'a str,
}

pub struct TelegramPublishOutcome {
    pub event_id: String,
    pub new_root: bool,
}

pub async fn publish_telegram_message(
    request: TelegramPublishRequest<'_>,
) -> Result<TelegramPublishOutcome> {
    let agent_pubkey = PublicKey::from_hex(request.agent_pubkey).context("parse agent pubkey")?;
    let mut tags = vec![
        Tag::public_key(agent_pubkey),
        Tag::custom(
            TagKind::Custom("telegram-chat-id".into()),
            vec![request.chat_id.to_string()],
        ),
        Tag::custom(
            TagKind::Custom("telegram-message-id".into()),
            vec![request.message_id.to_string()],
        ),
        Tag::custom(
            TagKind::Custom("telegram-channel-id".into()),
            vec![request.channel_id.to_string()],
        ),
    ];
    if let Some(tid) = request.thread_id {
        tags.push(Tag::custom(
            TagKind::Custom("telegram-thread-id".into()),
            vec![tid.to_string()],
        ));
    }

    let new_root = if let Some(ref root_hex) = request.root_event_id {
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

    if let Some(owner) = &request.project.owner_pubkey {
        let coord = format!("31933:{owner}:{}", request.project.project_id);
        tags.push(Tag::custom(TagKind::Custom("a".into()), vec![coord]));
    }

    let user_info = format!(
        "[Telegram user {} ({})]",
        request.sender_first_name,
        request
            .sender_username
            .map(|u| format!("@{u}"))
            .unwrap_or_else(|| request.sender_id.to_string())
    );
    let content = format!("{user_info} {}", request.text);
    let event = EventBuilder::new(Kind::TextNote, content)
        .tags(tags)
        .sign_with_keys(request.backend_keys)
        .context("sign event")?;
    let event_id = event.id;

    request
        .nostr
        .send_event(&event)
        .await
        .context("publish Nostr event")?;

    Ok(TelegramPublishOutcome {
        event_id: event_id.to_hex(),
        new_root,
    })
}
