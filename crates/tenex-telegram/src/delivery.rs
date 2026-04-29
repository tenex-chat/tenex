//! Delivers intent content to a Telegram chat.
//!
//! Called from [`CompositeChannel`](crate::composite::CompositeChannel) when
//! the inbound envelope carries Telegram transport metadata.

use anyhow::Result;
use regex::Regex;
use std::sync::OnceLock;
use tenex_protocol::{ConversationIntent, Intent};

use crate::client::BotClient;
use crate::config::TelegramAgentConfig;
use crate::render::render_message;
use crate::tool_publications::render_tool_publication;

/// Context for a single inbound Telegram message, held by `CompositeChannel`.
#[derive(Debug, Clone)]
pub struct TelegramContext {
    pub chat_id: String,
    pub message_id: String,
    pub thread_id: Option<String>,
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

/// Deliver `intent` content to Telegram alongside the Nostr publish.
///
/// Returns `Ok(())` whether or not a message was sent — delivery is
/// best-effort. Only propagates errors so callers can log them.
pub async fn deliver_intent(
    intent: &Intent,
    ctx: &TelegramContext,
    agent_cfg: &TelegramAgentConfig,
    publish_conversation: bool,
) -> Result<()> {
    let content = telegram_content_for_intent(intent, publish_conversation);
    if let Some(text) = content {
        let client = BotClient::new(agent_cfg.bot_token.clone(), agent_cfg.api_base_url.clone());
        send_text_with_voice(&client, ctx, &text).await?;
    }
    Ok(())
}

fn telegram_content_for_intent(intent: &Intent, publish_conversation: bool) -> Option<String> {
    match intent {
        Intent::Completion(i) => Some(i.content.clone()),
        Intent::Conversation(ConversationIntent {
            content,
            is_reasoning,
            ..
        }) => {
            if *is_reasoning {
                None
            } else if publish_conversation {
                Some(content.clone())
            } else {
                None
            }
        }
        Intent::Ask(i) => Some(format!("{}\n\n{}", i.title, i.context)),
        Intent::Error(i) => Some(i.message.clone()),
        Intent::ToolUse(i) => render_tool_publication(i),
        Intent::Delegation(_)
        | Intent::Lesson(_)
        | Intent::StreamTextDelta(_)
        | Intent::InterventionReview(_)
        | Intent::PublishArticle(_) => None,
    }
}

async fn send_text_with_voice(
    client: &BotClient,
    ctx: &TelegramContext,
    content: &str,
) -> Result<()> {
    if let Some(voice) = extract_voice_reply(content) {
        let voice_result = client
            .send_voice(
                &ctx.chat_id,
                &voice.voice_path,
                Some(&ctx.message_id),
                ctx.thread_id.as_deref(),
            )
            .await;
        if let Err(e) = voice_result {
            tracing::warn!(error = %e, "Telegram voice delivery failed");
            if voice.remaining.is_empty() {
                return Err(e);
            }
        }
        if !voice.remaining.is_empty() {
            send_html_with_fallback(client, ctx, &voice.remaining).await?;
        }
        return Ok(());
    }

    send_html_with_fallback(client, ctx, content).await
}

async fn send_html_with_fallback(
    client: &BotClient,
    ctx: &TelegramContext,
    content: &str,
) -> Result<()> {
    let rendered = render_message(content);
    let result = client
        .send_message(
            &ctx.chat_id,
            &rendered.text,
            Some(rendered.parse_mode),
            Some(&ctx.message_id),
            ctx.thread_id.as_deref(),
        )
        .await;

    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            tracing::warn!(error = %e, "Telegram HTML send failed, retrying plain text");
            client
                .send_message(
                    &ctx.chat_id,
                    content,
                    None,
                    Some(&ctx.message_id),
                    ctx.thread_id.as_deref(),
                )
                .await
                .map(|_| ())
        }
    }
}
