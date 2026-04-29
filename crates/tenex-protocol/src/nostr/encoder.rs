//! Pure intent → `EventBuilder` encoder. No I/O, no key material, no globals.
//!
//! Mirrors `src/nostr/AgentEventEncoder.ts` byte-for-byte (modulo signature
//! randomness). Each intent variant has a private `encode_*` function; the
//! public [`NostrEncoder::encode`] dispatches on the [`Intent`] enum.

use nostr::{EventBuilder, Kind, Timestamp};

use crate::context::EncodingContext;
use crate::intent::{
    AskIntent, AskQuestion, CompletionIntent, ConversationIntent, DelegationIntent, ErrorIntent,
    Intent, InterventionReviewIntent, LessonIntent, PublishArticleIntent, StreamTextDeltaIntent,
    ToolUseIntent,
};
use crate::refs::{ConversationRef, MessageRef};

use super::kinds;
use super::tags::{
    add_llm_metadata_tags, add_llm_usage_tags, add_standard_tags, e_agent_definition_tag,
    e_reply_tag, e_root_tag, forward_branch_team, p_tag, project_a_tag, q_tag, tag,
};

#[derive(Debug, thiserror::Error)]
pub enum EncodeError {
    #[error("tag construction: {0}")]
    Tag(String),
}

/// Stateless encoder. Kept as a unit struct so callers can write
/// `NostrEncoder::encode(...)` without juggling free imports.
pub struct NostrEncoder;

impl NostrEncoder {
    /// Encode an intent. Returns one [`EventBuilder`] per emitted wire message;
    /// [`Intent::Delegation`] yields `delegations.len()` builders, every other
    /// variant yields one.
    pub fn encode(
        intent: &Intent,
        ctx: &EncodingContext,
    ) -> Result<Vec<EventBuilder>, EncodeError> {
        match intent {
            Intent::Completion(i) => Ok(vec![encode_completion(i, ctx)?]),
            Intent::Conversation(i) => Ok(vec![encode_conversation(i, ctx)?]),
            Intent::Delegation(i) => encode_delegation(i, ctx),
            Intent::Ask(i) => Ok(vec![encode_ask(i, ctx)?]),
            Intent::Error(i) => Ok(vec![encode_error(i, ctx)?]),
            Intent::Lesson(i) => Ok(vec![encode_lesson(i, ctx)?]),
            Intent::ToolUse(i) => Ok(vec![encode_tool_use(i, ctx)?]),
            Intent::StreamTextDelta(i) => Ok(vec![encode_stream_text_delta(i, ctx)?]),
            Intent::InterventionReview(i) => Ok(vec![encode_intervention_review(i, ctx)?]),
            Intent::PublishArticle(i) => Ok(vec![encode_publish_article(i, ctx)?]),
        }
    }
}

fn add_conversation_tags(
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

fn encode_completion(
    intent: &CompletionIntent,
    ctx: &EncodingContext,
) -> Result<EventBuilder, EncodeError> {
    let mut builder = EventBuilder::new(Kind::TextNote, &intent.content);
    builder = add_conversation_tags(builder, ctx)?;

    let recipient = ctx
        .completion_recipient
        .as_ref()
        .unwrap_or(&ctx.triggering_principal);
    builder = builder.tag(p_tag(recipient)?);
    builder = builder.tag(tag(["status", "completed"])?);

    if let Some(usage) = intent.usage.as_ref() {
        builder = add_llm_usage_tags(builder, usage)?;
    }
    if let Some(md) = intent.metadata.as_ref() {
        builder = add_llm_metadata_tags(builder, md)?;
    }
    builder = add_standard_tags(builder, ctx)?;
    builder = forward_branch_team(builder, ctx)?;
    Ok(builder)
}

fn encode_conversation(
    intent: &ConversationIntent,
    ctx: &EncodingContext,
) -> Result<EventBuilder, EncodeError> {
    let mut builder = EventBuilder::new(Kind::TextNote, &intent.content);
    builder = add_conversation_tags(builder, ctx)?;

    if intent.is_reasoning {
        builder = builder.tag(tag(["reasoning"])?);
    }
    if let Some(usage) = intent.usage.as_ref() {
        builder = add_llm_usage_tags(builder, usage)?;
    }
    if let Some(md) = intent.metadata.as_ref() {
        builder = add_llm_metadata_tags(builder, md)?;
    }
    builder = add_standard_tags(builder, ctx)?;
    builder = forward_branch_team(builder, ctx)?;
    Ok(builder)
}

fn encode_delegation(
    intent: &DelegationIntent,
    ctx: &EncodingContext,
) -> Result<Vec<EventBuilder>, EncodeError> {
    let now_plus_one = Timestamp::now() + 1u64;
    intent
        .items
        .iter()
        .map(|d| {
            let prefixed = prepend_recipient_label(&d.request, &d.recipient_label);
            let mut builder =
                EventBuilder::new(Kind::TextNote, prefixed).custom_created_at(now_plus_one);

            // Followup delegations carry an e-tag referencing the original event.
            // Fresh delegations start a new conversation without any e-tag.
            if let Some(MessageRef::Nostr { event_id }) = d.followup_of.as_ref() {
                builder = builder.tag(e_reply_tag(event_id)?);
            }

            builder = builder.tag(p_tag(&d.recipient)?);

            if let Some(branch) = d.branch.as_deref() {
                builder = builder.tag(tag(["branch", branch])?);
            }

            builder = add_standard_tags(builder, ctx)?;

            // TS: forwardTagPair only when delegation has no explicit branch.
            if d.branch.is_none() {
                builder = forward_branch_team(builder, ctx)?;
            }
            Ok(builder)
        })
        .collect()
}

fn encode_ask(intent: &AskIntent, ctx: &EncodingContext) -> Result<EventBuilder, EncodeError> {
    let mut builder = EventBuilder::new(Kind::TextNote, &intent.context);
    builder = add_conversation_tags(builder, ctx)?;
    builder = builder.tag(p_tag(&intent.recipient)?);
    builder = builder.tag(tag(["title", &intent.title])?);

    for question in &intent.questions {
        let parts = match question {
            AskQuestion::SingleSelect {
                title,
                prompt,
                suggestions,
            } => {
                let mut v = vec!["question", title.as_str(), prompt.as_str()];
                v.extend(suggestions.iter().map(|s| s.as_str()));
                v
            }
            AskQuestion::MultiSelect {
                title,
                prompt,
                options,
            } => {
                let mut v = vec!["multiselect", title.as_str(), prompt.as_str()];
                v.extend(options.iter().map(|s| s.as_str()));
                v
            }
        };
        builder = builder.tag(tag(parts)?);
    }

    builder = builder.tag(tag(["intent", "ask"])?);
    builder = add_standard_tags(builder, ctx)?;
    builder = forward_branch_team(builder, ctx)?;
    Ok(builder)
}

fn encode_error(intent: &ErrorIntent, ctx: &EncodingContext) -> Result<EventBuilder, EncodeError> {
    let mut builder = EventBuilder::new(Kind::TextNote, &intent.message);
    builder = add_conversation_tags(builder, ctx)?;

    let error_type = intent.error_type.as_deref().unwrap_or("system");
    builder = builder.tag(tag(["error", error_type])?);

    builder = builder.tag(p_tag(&ctx.triggering_principal)?);
    builder = builder.tag(tag(["status", "completed"])?);
    builder = add_standard_tags(builder, ctx)?;
    builder = forward_branch_team(builder, ctx)?;
    Ok(builder)
}

fn encode_lesson(
    intent: &LessonIntent,
    ctx: &EncodingContext,
) -> Result<EventBuilder, EncodeError> {
    let mut builder = EventBuilder::new(kinds::custom(kinds::AGENT_LESSON), &intent.lesson);
    builder = builder.tag(tag(["title", &intent.title])?);
    if let Some(category) = intent.category.as_deref() {
        builder = builder.tag(tag(["category", category])?);
    }
    for hashtag in &intent.hashtags {
        builder = builder.tag(tag(["t", hashtag])?);
    }
    if let Some(agent_def) = intent.agent_definition_id.as_ref() {
        builder = builder.tag(e_agent_definition_tag(agent_def)?);
    }
    builder = add_standard_tags(builder, ctx)?;
    Ok(builder)
}

fn encode_tool_use(
    intent: &ToolUseIntent,
    ctx: &EncodingContext,
) -> Result<EventBuilder, EncodeError> {
    let mut builder = EventBuilder::new(Kind::TextNote, &intent.content);
    builder = add_conversation_tags(builder, ctx)?;
    builder = builder.tag(tag(["tool", &intent.tool_name])?);

    if let Some(args) = intent.args_json.as_deref() {
        let tag = if args.len() <= 100_000 {
            tag(["tool-args", args])
        } else {
            tag(["tool-args"])
        }?;
        builder = builder.tag(tag);
    }

    for refd in &intent.referenced_messages {
        builder = builder.tag(q_tag(refd)?);
    }

    builder = add_standard_tags(builder, ctx)?;
    builder = forward_branch_team(builder, ctx)?;

    if let Some(usage) = intent.usage.as_ref() {
        builder = add_llm_usage_tags(builder, usage)?;
    }
    Ok(builder)
}

fn encode_stream_text_delta(
    intent: &StreamTextDeltaIntent,
    ctx: &EncodingContext,
) -> Result<EventBuilder, EncodeError> {
    let mut builder = EventBuilder::new(kinds::custom(kinds::STREAM_TEXT_DELTA), &intent.delta);
    builder = add_conversation_tags(builder, ctx)?;
    builder = builder.tag(project_a_tag(&ctx.project)?);

    if let Some(model) = ctx.model.as_deref() {
        builder = builder.tag(tag(["llm-model", model])?);
    }
    builder = builder.tag(tag(["llm-ral", &ctx.ral.to_string()])?);
    builder = builder.tag(tag(["stream-seq", &intent.sequence.to_string()])?);

    builder = forward_branch_team(builder, ctx)?;
    Ok(builder)
}

fn encode_intervention_review(
    intent: &InterventionReviewIntent,
    ctx: &EncodingContext,
) -> Result<EventBuilder, EncodeError> {
    let ConversationRef::Nostr { root_event_id } = &intent.conversation;
    let short_id = shorten_conversation_id(&root_event_id.to_hex());
    let content = format!(
        "Conversation {short_id} has completed and {user} hasn't responded. {agent} finished their work. Please review and decide if action is needed.",
        user = intent.user_name,
        agent = intent.agent_name,
    );
    let mut builder = EventBuilder::new(Kind::TextNote, content);

    builder = builder.tag(p_tag(&intent.target)?);
    builder = builder.tag(tag(["context", "intervention-review"])?);
    builder = builder.tag(project_a_tag(&ctx.project)?);
    Ok(builder)
}

fn encode_publish_article(
    intent: &PublishArticleIntent,
    ctx: &EncodingContext,
) -> Result<EventBuilder, EncodeError> {
    let mut builder = EventBuilder::new(kinds::custom(kinds::LONG_FORM_ARTICLE), &intent.content);
    builder = builder.tag(tag(["d", &intent.d_tag])?);
    builder = builder.tag(tag(["document", &intent.document_tag])?);
    builder = builder.tag(project_a_tag(&ctx.project)?);
    Ok(builder)
}

fn prepend_recipient_label(content: &str, label: &str) -> String {
    // Don't double-prepend if the content already starts with `nostr:` or `@slug:`.
    let trimmed = content.trim_start();
    if trimmed.starts_with("nostr:") || starts_with_slug_prefix(trimmed) {
        return content.to_string();
    }
    format!("{label}: {content}")
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

fn shorten_conversation_id(id: &str) -> String {
    if id.len() <= 8 {
        id.to_string()
    } else {
        id[..8].to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::{LlmUsage, ToolUseIntent};
    use crate::refs::{MessageRef, PrincipalKind, PrincipalRef, ProjectRef};
    use nostr::{EventId, Keys};

    fn test_ctx() -> EncodingContext {
        let keys = Keys::generate();
        EncodingContext {
            project: ProjectRef {
                author: keys.public_key(),
                d_tag: "demo".into(),
            },
            conversation_root: Some(ConversationRef::Nostr {
                root_event_id: EventId::all_zeros(),
            }),
            triggering_message: Some(MessageRef::Nostr {
                event_id: EventId::all_zeros(),
            }),
            completion_recipient: None,
            triggering_principal: PrincipalRef::Nostr {
                pubkey: keys.public_key(),
                kind: PrincipalKind::Human,
                display_name: None,
            },
            ral: 1,
            model: Some("openai:gpt-4".into()),
            cost_usd: Some(0.001234),
            execution_time_ms: Some(1500),
            llm_runtime_ms: Some(1200),
            llm_runtime_total_ms: None,
            branch: None,
            team: None,
        }
    }

    fn signed_tags(builder: EventBuilder) -> Vec<Vec<String>> {
        let keys = Keys::generate();
        let event = builder.sign_with_keys(&keys).expect("sign");
        event.tags.iter().map(|t| t.clone().to_vec()).collect()
    }

    #[test]
    fn completion_has_status_and_p_tag() {
        let ctx = test_ctx();
        let intent = CompletionIntent {
            content: "done".into(),
            usage: Some(LlmUsage {
                input_tokens: Some(100),
                output_tokens: Some(50),
                ..Default::default()
            }),
            metadata: None,
        };
        let builders = NostrEncoder::encode(&Intent::Completion(intent), &ctx).expect("encode");
        assert_eq!(builders.len(), 1);
        let tags = signed_tags(builders.into_iter().next().unwrap());
        assert!(tags.iter().any(|t| t[0] == "status" && t[1] == "completed"));
        assert!(tags.iter().any(|t| t[0] == "p"));
        assert!(tags
            .iter()
            .any(|t| t[0] == "e" && t.len() >= 4 && t[3] == "root"));
        assert!(tags
            .iter()
            .any(|t| t[0] == "llm-prompt-tokens" && t[1] == "100"));
        assert!(tags
            .iter()
            .any(|t| t[0] == "llm-total-tokens" && t[1] == "150"));
    }

    #[test]
    fn conversation_omits_p_and_status() {
        let ctx = test_ctx();
        let intent = ConversationIntent {
            content: "thinking".into(),
            is_reasoning: true,
            usage: None,
            metadata: None,
        };
        let builders = NostrEncoder::encode(&Intent::Conversation(intent), &ctx).expect("encode");
        let tags = signed_tags(builders.into_iter().next().unwrap());
        assert!(!tags.iter().any(|t| t[0] == "p"));
        assert!(!tags.iter().any(|t| t[0] == "status"));
        assert!(tags.iter().any(|t| t[0] == "reasoning"));
    }

    #[test]
    fn tool_use_emits_q_tags_and_tool_args() {
        let ctx = test_ctx();
        let id = EventId::all_zeros();
        let intent = ToolUseIntent {
            tool_name: "delegate".into(),
            content: "delegating".into(),
            args_json: Some("{\"x\":1}".into()),
            referenced_messages: vec![MessageRef::Nostr { event_id: id }],
            usage: None,
        };
        let builders = NostrEncoder::encode(&Intent::ToolUse(intent), &ctx).expect("encode");
        let tags = signed_tags(builders.into_iter().next().unwrap());
        assert!(tags.iter().any(|t| t[0] == "tool" && t[1] == "delegate"));
        assert!(tags
            .iter()
            .any(|t| t[0] == "tool-args" && t[1] == "{\"x\":1}"));
        assert!(tags.iter().any(|t| t[0] == "q"));
    }

    #[test]
    fn threaded_events_emit_root_and_reply_tags() {
        let ctx = test_ctx();
        let intent = ConversationIntent {
            content: "hi".into(),
            is_reasoning: false,
            usage: None,
            metadata: None,
        };
        let builders = NostrEncoder::encode(&Intent::Conversation(intent), &ctx).expect("encode");
        let tags = signed_tags(builders.into_iter().next().unwrap());
        let e_tags: Vec<&Vec<String>> = tags.iter().filter(|t| t[0] == "e").collect();
        assert_eq!(e_tags.len(), 2, "expected one root and one reply e-tag");
        assert!(e_tags.iter().any(|t| t.len() >= 4 && t[3] == "root"));
        assert!(e_tags.iter().any(|t| t.len() >= 4 && t[3] == "reply"));
    }

    #[test]
    fn publish_article_emits_kind_30023_with_required_tags() {
        let ctx = test_ctx();
        let intent = crate::intent::PublishArticleIntent {
            d_tag: "notes/2024-01-01".into(),
            document_tag: "notes".into(),
            content: "# Hello\nWorld".into(),
        };
        let builders = NostrEncoder::encode(&Intent::PublishArticle(intent), &ctx).expect("encode");
        assert_eq!(builders.len(), 1);
        let tags = signed_tags(builders.into_iter().next().unwrap());
        assert!(tags
            .iter()
            .any(|t| t[0] == "d" && t[1] == "notes/2024-01-01"));
        assert!(tags.iter().any(|t| t[0] == "document" && t[1] == "notes"));
        assert!(tags
            .iter()
            .any(|t| t[0] == "a" && t[1].starts_with("31933:")));
        // Must NOT carry conversation threading tags
        assert!(!tags.iter().any(|t| t[0] == "e"));
        assert!(!tags.iter().any(|t| t[0] == "p"));
    }

    #[test]
    fn delegation_omits_e_root_and_prepends_label() {
        let mut ctx = test_ctx();
        ctx.conversation_root = None;
        ctx.triggering_message = None;
        let recipient_keys = Keys::generate();
        let intent = DelegationIntent {
            items: vec![crate::intent::DelegationRequest {
                recipient: PrincipalRef::Nostr {
                    pubkey: recipient_keys.public_key(),
                    kind: PrincipalKind::Agent,
                    display_name: None,
                },
                recipient_label: "@architect".into(),
                request: "Please review".into(),
                branch: None,
                followup_of: None,
            }],
        };
        let builders = NostrEncoder::encode(&Intent::Delegation(intent), &ctx).expect("encode");
        assert_eq!(builders.len(), 1);
        let keys = Keys::generate();
        let event = builders
            .into_iter()
            .next()
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
        let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.clone().to_vec()).collect();
        assert!(!tags.iter().any(|t| t[0] == "e"));
        assert!(tags.iter().any(|t| t[0] == "p"));
        assert_eq!(event.content, "@architect: Please review");
    }
}
