//! Pure delivery-derivation planner.
//!
//! Given a retained triggering `InboundEnvelope` (specifically its Telegram
//! transport metadata if present), the `runtimeEventClass` + optional
//! `ConversationVariant` from the worker's `publish_request`, a small slice
//! of the agent's Telegram config, and the accepted event's final content,
//! this function decides whether a Telegram outbox record should be
//! enqueued, and if so, returns a ready-to-persist
//! [`crate::telegram_outbox::TelegramDeliveryRequest`].
//!
//! The function is the single Rust-owned delivery classification boundary. It
//! does no I/O.
//!
//! Matrix (matches TS exactly):
//!
//! | class              | variant   | config flag                         | produces           |
//! |--------------------|-----------|-------------------------------------|--------------------|
//! | complete           | n/a       | n/a (always)                        | FinalReply         |
//! | conversation       | primary   | publishConversationToTelegram=true  | ConversationMirror |
//! | conversation       | reasoning | publishReasoningToTelegram=true     | ReasoningMirror    |
//! | ask                | n/a       | n/a (always)                        | AskError           |
//! | error              | n/a       | n/a (always)                        | AskError           |
//! | tool_use           | n/a       | tool_render provided                | ToolPublicationMirror |
//! | delegation         | n/a       | -                                   | None               |
//! | delegate_followup  | n/a       | -                                   | None               |
//! | lesson             | n/a       | -                                   | None               |
//! | stream_text_delta  | n/a       | -                                   | None               |
//!
//! Voice marker: when the delivery payload is a FinalReply and the accepted
//! content matches exactly one `[[telegram_voice:/absolute/path]]` marker,
//! the planner splits the delivery into up to two records: a voice record
//! plus (optionally) a remaining-text
//! record. This preserves the TS send-voice-then-text behavior while keeping
//! the outbox record as the single durable boundary.

use crate::telegram::renderer::render_telegram_message;
use crate::telegram::types::{ConversationVariant, RuntimeEventClass};
use crate::telegram_outbox::{
    TelegramChannelBinding, TelegramDeliveryPayload, TelegramDeliveryReason,
    TelegramDeliveryRequest, TelegramProjectBinding, TelegramSenderIdentity,
};

/// Telegram transport metadata extracted from the retained triggering envelope.
///
/// Field names match `TelegramTransportMetadata` in
/// `src/events/runtime/InboundEnvelope.ts`. Only the fields the planner
/// actually needs to derive a delivery destination are represented here;
/// richer metadata (chat title, administrators) is irrelevant to delivery
/// routing and lives in the outbox record only if a later slice adds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramEnvelopeRouting<'a> {
    pub chat_id: &'a str,
    pub message_id: &'a str,
    pub thread_id: Option<&'a str>,
}

/// Minimal slice of the per-agent Telegram config needed for delivery
/// derivation. The gateway slice will populate this from the agent's
/// storage record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramAgentConfig<'a> {
    pub agent_pubkey: &'a str,
    pub agent_display_name: Option<&'a str>,
    pub publish_conversation_to_telegram: bool,
    pub publish_reasoning_to_telegram: bool,
}

/// Minimal slice of the project binding derived from daemon state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramProjectContext<'a> {
    pub project_d_tag: &'a str,
    pub backend_pubkey: &'a str,
}

/// Classification reported by the worker on the accepted `publish_request`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TelegramPublishClass {
    pub class: RuntimeEventClass,
    pub conversation_variant: Option<ConversationVariant>,
}

/// Slice of the accepted, worker-signed Nostr event needed for delivery
/// derivation. The event ID is preserved on the outbox record; the content
/// is what the final delivery payload renders from. `tool_render` is the
/// pre-computed Telegram-specific tool-use rendering (from
/// `renderTelegramToolPublication` on the TS side); when `None` for a
/// `tool_use` class, no Telegram delivery is produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedRuntimeEvent<'a> {
    pub event_id: &'a str,
    pub correlation_id: &'a str,
    pub content: &'a str,
    pub tool_render: Option<&'a str>,
}

/// Inputs to [`plan_telegram_delivery`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramDeliveryPlanInput<'a> {
    pub routing: &'a TelegramEnvelopeRouting<'a>,
    pub agent: &'a TelegramAgentConfig<'a>,
    pub project: &'a TelegramProjectContext<'a>,
    pub classification: TelegramPublishClass,
    pub event: AcceptedRuntimeEvent<'a>,
    pub writer_version: &'a str,
}

/// Plan zero, one, or two outbox requests for the given publish acceptance.
///
/// Most paths yield zero or one record. The single two-record path is a
/// `Complete` accept whose content is exactly one `[[telegram_voice:…]]`
/// marker plus surrounding text.
pub fn plan_telegram_delivery(
    input: &TelegramDeliveryPlanInput<'_>,
) -> Vec<TelegramDeliveryRequest> {
    match input.classification.class {
        RuntimeEventClass::Complete => plan_complete(input),
        RuntimeEventClass::Conversation => plan_conversation(input),
        RuntimeEventClass::Ask | RuntimeEventClass::Error => plan_ask_error(input),
        RuntimeEventClass::ToolUse => plan_tool_use(input),
        RuntimeEventClass::Delegation
        | RuntimeEventClass::DelegateFollowup
        | RuntimeEventClass::Lesson
        | RuntimeEventClass::StreamTextDelta => Vec::new(),
    }
}

fn plan_complete(input: &TelegramDeliveryPlanInput<'_>) -> Vec<TelegramDeliveryRequest> {
    let content = input.event.content;
    if let Some(voice) = extract_telegram_voice_reply(content) {
        let mut records = Vec::with_capacity(2);
        records.push(build_request(
            input,
            TelegramDeliveryReason::Voice,
            TelegramDeliveryPayload::ReservedVoice {
                marker: voice.marker.to_string(),
            },
        ));
        if let Some(remaining) = voice.remaining_content.as_deref()
            && !remaining.is_empty()
        {
            let rendered = render_telegram_message(remaining);
            records.push(build_request(
                input,
                TelegramDeliveryReason::FinalReply,
                TelegramDeliveryPayload::HtmlText {
                    html: rendered.text,
                },
            ));
        }
        records
    } else {
        let rendered = render_telegram_message(content);
        vec![build_request(
            input,
            TelegramDeliveryReason::FinalReply,
            TelegramDeliveryPayload::HtmlText {
                html: rendered.text,
            },
        )]
    }
}

fn plan_conversation(input: &TelegramDeliveryPlanInput<'_>) -> Vec<TelegramDeliveryRequest> {
    let variant = match input.classification.conversation_variant {
        Some(variant) => variant,
        None => return Vec::new(),
    };
    let (allowed, reason) = match variant {
        ConversationVariant::Primary => (
            input.agent.publish_conversation_to_telegram,
            TelegramDeliveryReason::ConversationMirror,
        ),
        ConversationVariant::Reasoning => (
            input.agent.publish_reasoning_to_telegram,
            TelegramDeliveryReason::ReasoningMirror,
        ),
    };
    if !allowed {
        return Vec::new();
    }
    let rendered = render_telegram_message(input.event.content);
    vec![build_request(
        input,
        reason,
        TelegramDeliveryPayload::HtmlText {
            html: rendered.text,
        },
    )]
}

fn plan_ask_error(input: &TelegramDeliveryPlanInput<'_>) -> Vec<TelegramDeliveryRequest> {
    let rendered = render_telegram_message(input.event.content);
    vec![build_request(
        input,
        TelegramDeliveryReason::AskError,
        TelegramDeliveryPayload::AskError {
            html: rendered.text,
        },
    )]
}

fn plan_tool_use(input: &TelegramDeliveryPlanInput<'_>) -> Vec<TelegramDeliveryRequest> {
    let content = match input.event.tool_render {
        Some(value) if !value.is_empty() => value,
        _ => return Vec::new(),
    };
    let rendered = render_telegram_message(content);
    vec![build_request(
        input,
        TelegramDeliveryReason::ToolPublicationMirror,
        TelegramDeliveryPayload::HtmlText {
            html: rendered.text,
        },
    )]
}

fn build_request(
    input: &TelegramDeliveryPlanInput<'_>,
    delivery_reason: TelegramDeliveryReason,
    payload: TelegramDeliveryPayload,
) -> TelegramDeliveryRequest {
    let chat_id = input
        .routing
        .chat_id
        .parse::<i64>()
        .unwrap_or_else(|_| fallback_numeric_id(input.routing.chat_id));
    let message_id = input
        .routing
        .message_id
        .parse::<i64>()
        .ok()
        .and_then(|v| if v > 0 { Some(v) } else { None });
    let thread_id = input
        .routing
        .thread_id
        .and_then(|value| value.parse::<i64>().ok());

    TelegramDeliveryRequest {
        nostr_event_id: input.event.event_id.to_string(),
        correlation_id: input.event.correlation_id.to_string(),
        project_binding: TelegramProjectBinding {
            project_d_tag: input.project.project_d_tag.to_string(),
            backend_pubkey: input.project.backend_pubkey.to_string(),
        },
        channel_binding: TelegramChannelBinding {
            chat_id,
            message_thread_id: thread_id,
            channel_label: None,
        },
        sender_identity: TelegramSenderIdentity {
            agent_pubkey: input.agent.agent_pubkey.to_string(),
            display_name: input.agent.agent_display_name.map(str::to_string),
        },
        delivery_reason,
        reply_to_telegram_message_id: message_id,
        payload,
        writer_version: input.writer_version.to_string(),
    }
}

/// Telegram chat IDs are signed 64-bit integers on the Bot API. If the
/// caller passes something non-numeric (the channelId form `telegram:…`),
/// we best-effort extract the trailing numeric tail so the outbox record
/// still captures the intended destination. This should not happen in
/// practice once the gateway slice lands and envelope metadata always
/// carries the split chat id.
fn fallback_numeric_id(raw: &str) -> i64 {
    let digits: String = raw
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '-')
        .collect();
    digits
        .chars()
        .rev()
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
struct VoiceReply<'a> {
    marker: &'a str,
    remaining_content: Option<String>,
}

/// Match `^\s*[[telegram_voice:/abs/path]]\s*$` anywhere on a line; accept
/// only when exactly one marker is present and the path is absolute, same
/// as `extractTelegramVoiceReply` in TS.
fn extract_telegram_voice_reply(content: &str) -> Option<VoiceReply<'_>> {
    let mut matches = Vec::new();
    for line in content.lines() {
        let trimmed_leading = line.trim_start();
        let trimmed = trimmed_leading.trim_end();
        if !trimmed.starts_with("[[telegram_voice:") || !trimmed.ends_with("]]") {
            continue;
        }
        let inner = &trimmed["[[telegram_voice:".len()..trimmed.len() - "]]".len()];
        let path = inner.trim();
        if !path.starts_with('/') {
            continue;
        }
        matches.push((line, trimmed, path));
    }
    if matches.len() != 1 {
        return None;
    }

    let (full_line, trimmed_marker, _path) = matches[0];
    // Slice back from the original content so the caller can reconstruct
    // the remaining content deterministically.
    let marker = find_full_match_span(content, full_line, trimmed_marker)?;

    let mut remaining = content.replace(marker, "");
    // Collapse 3+ newlines to exactly two to mirror TS behavior.
    loop {
        let collapsed = remaining.replace("\n\n\n", "\n\n");
        if collapsed == remaining {
            break;
        }
        remaining = collapsed;
    }
    let trimmed_remaining = remaining.trim().to_string();
    let remaining_content = if trimmed_remaining.is_empty() {
        None
    } else {
        Some(trimmed_remaining)
    };

    Some(VoiceReply {
        marker,
        remaining_content,
    })
}

fn find_full_match_span<'a>(
    haystack: &'a str,
    full_line: &str,
    trimmed_marker: &str,
) -> Option<&'a str> {
    // The matched substring the TS `replace(fullMatch, "")` call receives
    // is the whole regex match, which spans the entire line since the TS
    // regex uses `m` / `g`. We mirror that by finding the trimmed marker
    // inside the original line to preserve any surrounding whitespace.
    let line_start = haystack.find(full_line)?;
    let within_line_start = full_line.find(trimmed_marker)?;
    let marker_start = line_start + within_line_start;
    let marker_end = marker_start + trimmed_marker.len();
    Some(&haystack[marker_start..marker_end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telegram_outbox::{TelegramDeliveryPayload, TelegramDeliveryReason};

    fn base_inputs(
        class: RuntimeEventClass,
        variant: Option<ConversationVariant>,
        content: &str,
        tool_render: Option<&str>,
        publish_conversation: bool,
        publish_reasoning: bool,
    ) -> (
        TelegramEnvelopeRouting<'static>,
        TelegramAgentConfig<'static>,
        TelegramProjectContext<'static>,
        TelegramPublishClass,
        String,
        Option<String>,
    ) {
        let routing = TelegramEnvelopeRouting {
            chat_id: "-1001234",
            message_id: "42",
            thread_id: Some("7"),
        };
        let agent = TelegramAgentConfig {
            agent_pubkey: "abc123",
            agent_display_name: Some("Agent Smith"),
            publish_conversation_to_telegram: publish_conversation,
            publish_reasoning_to_telegram: publish_reasoning,
        };
        let project = TelegramProjectContext {
            project_d_tag: "demo",
            backend_pubkey: "backend-pubkey",
        };
        let classification = TelegramPublishClass {
            class,
            conversation_variant: variant,
        };
        (
            routing,
            agent,
            project,
            classification,
            content.to_string(),
            tool_render.map(str::to_string),
        )
    }

    fn plan(
        class: RuntimeEventClass,
        variant: Option<ConversationVariant>,
        content: &str,
        tool_render: Option<&str>,
        publish_conversation: bool,
        publish_reasoning: bool,
    ) -> Vec<TelegramDeliveryRequest> {
        let (routing, agent, project, classification, content_owned, tool_owned) = base_inputs(
            class,
            variant,
            content,
            tool_render,
            publish_conversation,
            publish_reasoning,
        );
        let input = TelegramDeliveryPlanInput {
            routing: &routing,
            agent: &agent,
            project: &project,
            classification,
            event: AcceptedRuntimeEvent {
                event_id: "ev-1",
                correlation_id: "corr-1",
                content: &content_owned,
                tool_render: tool_owned.as_deref(),
            },
            writer_version: "test",
        };
        plan_telegram_delivery(&input)
    }

    #[test]
    fn complete_always_produces_final_reply() {
        let records = plan(
            RuntimeEventClass::Complete,
            None,
            "hello **world**",
            None,
            false,
            false,
        );
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].delivery_reason,
            TelegramDeliveryReason::FinalReply
        );
        matches_html(&records[0].payload, "hello <b>world</b>");
        assert_eq!(records[0].channel_binding.chat_id, -1001234);
        assert_eq!(records[0].channel_binding.message_thread_id, Some(7));
        assert_eq!(records[0].reply_to_telegram_message_id, Some(42));
    }

    #[test]
    fn voice_marker_splits_into_voice_then_text() {
        let content =
            "Here is your summary:\n\n[[telegram_voice:/tmp/voice.ogg]]\n\nAnd more notes.";
        let records = plan(
            RuntimeEventClass::Complete,
            None,
            content,
            None,
            false,
            false,
        );
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].delivery_reason, TelegramDeliveryReason::Voice);
        assert!(matches!(
            records[0].payload,
            TelegramDeliveryPayload::ReservedVoice { .. }
        ));
        assert_eq!(
            records[1].delivery_reason,
            TelegramDeliveryReason::FinalReply
        );
        matches_html(
            &records[1].payload,
            "Here is your summary:\n\nAnd more notes.",
        );
    }

    #[test]
    fn voice_marker_without_surrounding_text_produces_one_record() {
        let records = plan(
            RuntimeEventClass::Complete,
            None,
            "[[telegram_voice:/tmp/voice.ogg]]",
            None,
            false,
            false,
        );
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].delivery_reason, TelegramDeliveryReason::Voice);
    }

    #[test]
    fn voice_marker_rejects_non_absolute_path() {
        let records = plan(
            RuntimeEventClass::Complete,
            None,
            "[[telegram_voice:relative/path.ogg]]",
            None,
            false,
            false,
        );
        // Treated as plain text — escaped, FinalReply.
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].delivery_reason,
            TelegramDeliveryReason::FinalReply
        );
    }

    #[test]
    fn duplicate_voice_markers_reject_voice_handling() {
        let content = "[[telegram_voice:/a.ogg]]\n[[telegram_voice:/b.ogg]]";
        let records = plan(
            RuntimeEventClass::Complete,
            None,
            content,
            None,
            false,
            false,
        );
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].delivery_reason,
            TelegramDeliveryReason::FinalReply
        );
    }

    #[test]
    fn conversation_primary_requires_flag() {
        let off = plan(
            RuntimeEventClass::Conversation,
            Some(ConversationVariant::Primary),
            "hi",
            None,
            false,
            false,
        );
        assert!(off.is_empty());
        let on = plan(
            RuntimeEventClass::Conversation,
            Some(ConversationVariant::Primary),
            "hi",
            None,
            true,
            false,
        );
        assert_eq!(on.len(), 1);
        assert_eq!(
            on[0].delivery_reason,
            TelegramDeliveryReason::ConversationMirror
        );
    }

    #[test]
    fn conversation_reasoning_requires_flag() {
        let off = plan(
            RuntimeEventClass::Conversation,
            Some(ConversationVariant::Reasoning),
            "hmm",
            None,
            true,
            false,
        );
        assert!(off.is_empty());
        let on = plan(
            RuntimeEventClass::Conversation,
            Some(ConversationVariant::Reasoning),
            "hmm",
            None,
            false,
            true,
        );
        assert_eq!(on.len(), 1);
        assert_eq!(
            on[0].delivery_reason,
            TelegramDeliveryReason::ReasoningMirror
        );
    }

    #[test]
    fn conversation_without_variant_is_no_op() {
        let records = plan(
            RuntimeEventClass::Conversation,
            None,
            "hi",
            None,
            true,
            true,
        );
        assert!(records.is_empty());
    }

    #[test]
    fn ask_and_error_always_produce_ask_error() {
        let ask = plan(RuntimeEventClass::Ask, None, "Q: what?", None, false, false);
        assert_eq!(ask.len(), 1);
        assert_eq!(ask[0].delivery_reason, TelegramDeliveryReason::AskError);
        assert!(matches!(
            ask[0].payload,
            TelegramDeliveryPayload::AskError { .. }
        ));

        let err = plan(RuntimeEventClass::Error, None, "boom", None, false, false);
        assert_eq!(err.len(), 1);
        assert_eq!(err[0].delivery_reason, TelegramDeliveryReason::AskError);
    }

    #[test]
    fn tool_use_without_render_is_no_op() {
        let records = plan(
            RuntimeEventClass::ToolUse,
            None,
            "tool ran",
            None,
            false,
            false,
        );
        assert!(records.is_empty());
    }

    #[test]
    fn tool_use_with_render_mirrors() {
        let records = plan(
            RuntimeEventClass::ToolUse,
            None,
            "raw",
            Some("• tool: grep"),
            false,
            false,
        );
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].delivery_reason,
            TelegramDeliveryReason::ToolPublicationMirror,
        );
    }

    #[test]
    fn non_delivering_classes_skip_outbox() {
        for class in [
            RuntimeEventClass::Delegation,
            RuntimeEventClass::DelegateFollowup,
            RuntimeEventClass::Lesson,
            RuntimeEventClass::StreamTextDelta,
        ] {
            let records = plan(class, None, "x", None, true, true);
            assert!(records.is_empty(), "class {class:?} must not enqueue");
        }
    }

    fn matches_html(payload: &TelegramDeliveryPayload, expected: &str) {
        match payload {
            TelegramDeliveryPayload::HtmlText { html } => assert_eq!(html, expected),
            other => panic!("expected HtmlText, got {other:?}"),
        }
    }
}
