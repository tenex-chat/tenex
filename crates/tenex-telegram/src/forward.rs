//! Decide what to forward from the agent's Nostr event stream to Telegram.
//!
//! tenex-telegram receives a stream of Nostr `Event`s teed off the agent's
//! stdout via the runtime control socket. This module classifies each event
//! against the same set of rules the agent-side `delivery.rs` filter used to
//! enforce, then renders to the body the bot will send.
//!
//! Classification is by event kind plus a small set of distinguishing tags
//! (the encoder is in `tenex-protocol::nostr::encoder`). Anything that would
//! have been an `Intent::Delegation`, `Intent::Lesson`, `Intent::StreamTextDelta`,
//! `Intent::InterventionReview`, or `Intent::PublishArticle` is dropped.

use anyhow::Result;
use nostr_sdk::prelude::*;
use regex::Regex;
use std::sync::OnceLock;
use tenex_protocol::nostr::kinds;

use crate::client::BotClient;
use crate::render::render_message;

/// The event-derived body to send to Telegram, plus the chat coordinates.
pub struct TelegramReply {
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct TelegramChatRef<'a> {
    pub chat_id: &'a str,
    pub message_id: &'a str,
    pub thread_id: Option<&'a str>,
}

/// Returns `Some(text)` if the event should be sent as a Telegram message.
pub fn telegram_text_for_event(event: &Event, publish_conversation: bool) -> Option<String> {
    let kind_u16 = event.kind.as_u16();

    // Custom kinds that are always intermediate / internal.
    if kind_u16 == kinds::AGENT_LESSON
        || kind_u16 == kinds::STREAM_TEXT_DELTA
        || kind_u16 == kinds::LONG_FORM_ARTICLE
    {
        return None;
    }

    // Beyond TextNote, nothing else from the agent side is user-facing.
    if event.kind != Kind::TextNote {
        return None;
    }

    // Tag-based discrimination on TextNote events. Order matters: a
    // delegation event also has the project a-tag, etc.
    if has_tag_named(event, "delegation") {
        return None;
    }
    if has_tag_named(event, "reasoning") {
        return None;
    }
    if first_tag_value(event, "context").as_deref() == Some("intervention-review") {
        return None;
    }

    if first_tag_value(event, "intent").as_deref() == Some("ask") {
        let title = first_tag_value(event, "title").unwrap_or_default();
        let context = event.content.clone();
        return Some(if title.is_empty() {
            context
        } else {
            format!("{title}\n\n{context}")
        });
    }

    if first_tag_value(event, "error").is_some() {
        return Some(event.content.clone());
    }

    if let Some(tool_name) = first_tag_value(event, "tool") {
        return render_tool_event(&tool_name, event);
    }

    // Completion: status=completed and not flagged as something else.
    if first_tag_value(event, "status").as_deref() == Some("completed") {
        return Some(event.content.clone());
    }

    // Plain conversation reply. Gated by per-agent config.
    if publish_conversation {
        Some(event.content.clone())
    } else {
        None
    }
}

fn render_tool_event(tool_name: &str, event: &Event) -> Option<String> {
    // Reconstruct just enough of `ToolUseIntent` to reuse the existing
    // tool-publication renderer.
    let args_json = first_tag_value(event, "tool-args");
    let intent = tenex_protocol::ToolUseIntent {
        tool_name: tool_name.to_string(),
        content: event.content.clone(),
        args_json,
        referenced_messages: Vec::new(),
        usage: None,
    };
    crate::tool_publications::render_tool_publication(&intent)
}

fn has_tag_named(event: &Event, name: &str) -> bool {
    event
        .tags
        .iter()
        .any(|t| t.as_slice().first().is_some_and(|head| head == name))
}

fn first_tag_value(event: &Event, name: &str) -> Option<String> {
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().map(String::as_str) == Some(name) {
            return parts.get(1).cloned();
        }
    }
    None
}

fn voice_marker_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^\s*\[\[telegram_voice:(.+?)\]\]\s*$").expect("voice marker regex")
    })
}

struct VoiceReply {
    voice_path: String,
    remaining: String,
}

fn extract_voice_reply(content: &str) -> Option<VoiceReply> {
    let re = voice_marker_pattern();
    let matches: Vec<_> = re.find_iter(content).collect();
    if matches.len() != 1 {
        return None;
    }
    let m = matches[0];
    let caps = re.captures(m.as_str())?;
    let path = caps.get(1)?.as_str().trim().to_string();
    if !std::path::Path::new(&path).is_absolute() {
        return None;
    }
    let remaining = content
        .replacen(m.as_str(), "", 1)
        .replace("\n\n\n", "\n\n")
        .trim()
        .to_string();
    Some(VoiceReply {
        voice_path: path,
        remaining,
    })
}

/// Send `text` to a Telegram chat. Honors `[[telegram_voice:<path>]]` markers
/// by uploading a voice file and sending the remainder (if any) as a follow-up
/// HTML message. Falls back to plain text on HTML-render failure.
pub async fn send_to_telegram(
    client: &BotClient,
    chat: &TelegramChatRef<'_>,
    text: &str,
) -> Result<()> {
    if let Some(voice) = extract_voice_reply(text) {
        let voice_result = client
            .send_voice(
                chat.chat_id,
                &voice.voice_path,
                Some(chat.message_id),
                chat.thread_id,
            )
            .await;
        if let Err(e) = voice_result {
            tracing::warn!(error = %e, "Telegram voice delivery failed");
            if voice.remaining.is_empty() {
                return Err(e);
            }
        }
        if !voice.remaining.is_empty() {
            send_html_with_fallback(client, chat, &voice.remaining).await?;
        }
        return Ok(());
    }

    send_html_with_fallback(client, chat, text).await
}

async fn send_html_with_fallback(
    client: &BotClient,
    chat: &TelegramChatRef<'_>,
    content: &str,
) -> Result<()> {
    let rendered = render_message(content);
    let result = client
        .send_message(
            chat.chat_id,
            &rendered.text,
            Some(rendered.parse_mode),
            Some(chat.message_id),
            chat.thread_id,
        )
        .await;

    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            tracing::warn!(error = %e, "Telegram HTML send failed, retrying plain text");
            client
                .send_message(
                    chat.chat_id,
                    content,
                    None,
                    Some(chat.message_id),
                    chat.thread_id,
                )
                .await
                .map(|_| ())
        }
    }
}
