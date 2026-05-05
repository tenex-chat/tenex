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
    add_llm_metadata_tags, add_llm_usage_tags, add_standard_tags, delegation_parent_tag,
    e_agent_definition_tag, e_root_tag, forward_branch_team, p_tag, project_a_tag, q_tag, tag,
};

#[path = "encoder_helpers.rs"]
mod encoder_helpers;
use encoder_helpers::{add_conversation_tags, prepend_recipient_label, shorten_conversation_id};

#[derive(Debug, thiserror::Error)]
pub enum EncodeError {
    #[error("tag construction: {0}")]
    Tag(String),
}

/// Wrap an [`EventBuilder`] so the recipient `#p` tag survives signing even
/// when the recipient's pubkey equals the signer's.
///
/// nostr-rs strips author-matching `#p` tags by default — fine for NIP-01
/// mention semantics, but TENEX uses `#p` as **routing** (the runtime's
/// `directed` subscription is `authors AND #p`). Without self-tagging,
/// self-addressed events (self_delegate, completion-back-to-self in a
/// self-delegated turn, etc.) lose the routing tag and never wake the agent.
fn allow_self_addressed(builder: EventBuilder) -> EventBuilder {
    builder.allow_self_tagging()
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

fn encode_completion(
    intent: &CompletionIntent,
    ctx: &EncodingContext,
) -> Result<EventBuilder, EncodeError> {
    // TENEX uses `#p` as routing (the runtime's `directed` subscription filters
    // on authors AND #p), so we must keep the recipient tag even when it equals
    // the signer's pubkey. nostr's default is to strip self p-tags as a NIP-01
    // mention dedupe, which would silently break self-addressed routing.
    let mut builder = allow_self_addressed(EventBuilder::new(Kind::TextNote, &intent.content));
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
    builder = add_completion_project_tags(builder, ctx)?;
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
            let mut builder = allow_self_addressed(EventBuilder::new(Kind::TextNote, prefixed))
                .custom_created_at(now_plus_one);

            // Followup delegations stay in the original delegated conversation.
            // Fresh delegations start a new conversation without any e-tag.
            if let Some(MessageRef::Nostr { event_id }) = d.followup_of.as_ref() {
                builder = builder.tag(e_root_tag(event_id)?);
            } else if let Some(ConversationRef::Nostr { root_event_id }) =
                ctx.conversation_root.as_ref()
            {
                builder = builder.tag(delegation_parent_tag(root_event_id)?);
            }

            builder = builder.tag(p_tag(&d.recipient)?);

            if let Some(branch) = d.branch.as_deref() {
                builder = builder.tag(tag(["branch", branch])?);
            }

            if let Some(commit) = d.commit.as_deref() {
                builder = builder.tag(tag(["commit", commit])?);
            }

            for parts in &d.extra_tags {
                builder = builder.tag(tag(parts.iter().map(String::as_str))?);
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
    let mut builder = allow_self_addressed(EventBuilder::new(Kind::TextNote, &intent.context));
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

fn add_completion_project_tags(
    mut builder: EventBuilder,
    ctx: &EncodingContext,
) -> Result<EventBuilder, EncodeError> {
    let primary = ctx.project.coordinate();
    for addr in &ctx.completion_project_a_tags {
        if addr != &primary && addr.starts_with("31933:") {
            builder = builder.tag(tag(["a", addr.as_str()])?);
        }
    }
    Ok(builder)
}

fn encode_error(intent: &ErrorIntent, ctx: &EncodingContext) -> Result<EventBuilder, EncodeError> {
    let mut builder = allow_self_addressed(EventBuilder::new(Kind::TextNote, &intent.message));
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
    let mut builder = allow_self_addressed(EventBuilder::new(Kind::TextNote, &intent.content));
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

    for parts in &intent.extra_tags {
        builder = builder.tag(tag(parts.iter().map(String::as_str))?);
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
    let mut builder = allow_self_addressed(EventBuilder::new(Kind::TextNote, content));

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
    builder = builder.tag(tag(["title", &intent.title])?);
    builder = builder.tag(tag(["document", &intent.document_tag])?);
    builder = builder.tag(project_a_tag(&ctx.project)?);
    Ok(builder)
}

#[cfg(test)]
#[path = "encoder_tests.rs"]
mod encoder_tests;
