//! Tag-builder helpers used by the Nostr encoder.
//!
//! Every helper takes an [`EventBuilder`] by value and returns it threaded
//! through, mirroring the chained-builder style used elsewhere in nostr 0.44.

use nostr::{EventBuilder, EventId, Tag};

use crate::context::EncodingContext;
use crate::intent::{LlmMetadata, LlmUsage};
use crate::refs::{MessageRef, PrincipalRef, ProjectRef};

use super::encoder::EncodeError;

pub(super) fn tag<I, T>(parts: I) -> Result<Tag, EncodeError>
where
    I: IntoIterator<Item = T>,
    T: Into<String>,
{
    Tag::parse(parts).map_err(|e| EncodeError::Tag(e.to_string()))
}

pub fn project_a_tag(project: &ProjectRef) -> Result<Tag, EncodeError> {
    tag(["a", &project.coordinate()])
}

pub fn e_root_tag(root_id: &EventId) -> Result<Tag, EncodeError> {
    tag(["e", &root_id.to_hex(), "", "root"])
}

pub fn e_reply_tag(event_id: &EventId) -> Result<Tag, EncodeError> {
    tag(["e", &event_id.to_hex(), "", "reply"])
}

pub fn delegation_parent_tag(root_id: &EventId) -> Result<Tag, EncodeError> {
    tag(["delegation", &root_id.to_hex()])
}

pub fn p_tag(principal: &PrincipalRef) -> Result<Tag, EncodeError> {
    let PrincipalRef::Nostr { pubkey, .. } = principal;
    tag(["p", &pubkey.to_hex()])
}

pub fn q_tag(message: &MessageRef) -> Result<Tag, EncodeError> {
    let MessageRef::Nostr { event_id } = message;
    tag(["q", &event_id.to_hex()])
}

pub fn e_agent_definition_tag(message: &MessageRef) -> Result<Tag, EncodeError> {
    let MessageRef::Nostr { event_id } = message;
    tag(["e", &event_id.to_hex()])
}

pub fn message_event_id(message: &MessageRef) -> &EventId {
    let MessageRef::Nostr { event_id } = message;
    event_id
}

/// Apply the standard tag set every agent event carries: project a-tag, model,
/// cost, execution-time, llm-runtime, llm-runtime-total (when present), llm-ral.
///
/// Mirrors `addStandardTags` in `src/nostr/AgentEventEncoder.ts`.
pub fn add_standard_tags(
    mut builder: EventBuilder,
    ctx: &EncodingContext,
) -> Result<EventBuilder, EncodeError> {
    builder = builder.tag(project_a_tag(&ctx.project)?);

    if let Some(model) = ctx.model.as_deref() {
        builder = builder.tag(tag(["llm-model", model])?);
    }

    if let Some(cost) = ctx.cost_usd {
        builder = builder.tag(tag(["llm-cost-usd", &format_cost(cost)])?);
    }

    if let Some(ms) = ctx.execution_time_ms {
        builder = builder.tag(tag(["execution-time", &ms.to_string()])?);
    }

    if let Some(ms) = ctx.llm_runtime_ms.filter(|m| *m > 0) {
        builder = builder.tag(tag(["llm-runtime", &ms.to_string(), "ms"])?);
    }

    if let Some(ms) = ctx.llm_runtime_total_ms.filter(|m| *m > 0) {
        builder = builder.tag(tag(["llm-runtime-total", &ms.to_string(), "ms"])?);
    }

    builder = builder.tag(tag(["llm-ral", &ctx.ral.to_string()])?);

    Ok(builder)
}

/// Forward `branch` and `team` tags from the encoding context.
///
/// In TypeScript these are forwarded from `triggeringEnvelope.metadata`. In
/// Rust the caller flattens them onto [`EncodingContext`] before calling.
pub fn forward_branch_team(
    mut builder: EventBuilder,
    ctx: &EncodingContext,
) -> Result<EventBuilder, EncodeError> {
    if let Some(branch) = ctx.branch.as_deref() {
        builder = builder.tag(tag(["branch", branch])?);
    }
    if let Some(team) = ctx.team.as_deref() {
        builder = builder.tag(tag(["team", team])?);
    }
    Ok(builder)
}

/// Add LLM usage tags. Mirrors `addLLMUsageTags` in TS.
pub fn add_llm_usage_tags(
    mut builder: EventBuilder,
    usage: &LlmUsage,
) -> Result<EventBuilder, EncodeError> {
    if let Some(n) = usage.input_tokens {
        builder = builder.tag(tag(["llm-prompt-tokens", &n.to_string()])?);
    }
    if let Some(n) = usage.output_tokens {
        builder = builder.tag(tag(["llm-completion-tokens", &n.to_string()])?);
    }
    let total = usage
        .total_tokens
        .or_else(|| match (usage.input_tokens, usage.output_tokens) {
            (Some(i), Some(o)) => Some(i + o),
            _ => None,
        });
    if let Some(n) = total {
        builder = builder.tag(tag(["llm-total-tokens", &n.to_string()])?);
    }
    if let Some(c) = usage.cost_usd {
        builder = builder.tag(tag(["llm-cost-usd", &c.to_string()])?);
    }
    if let Some(n) = usage.reasoning_tokens {
        builder = builder.tag(tag(["llm-reasoning-tokens", &n.to_string()])?);
    }
    if let Some(n) = usage.cached_input_tokens {
        builder = builder.tag(tag(["llm-cached-input-tokens", &n.to_string()])?);
    }
    if let Some(n) = usage.context_window {
        builder = builder.tag(tag(["llm-context-window", &n.to_string()])?);
    }
    Ok(builder)
}

/// Add LLM provider-side metadata tags. Mirrors `addLLMMetadataTags` in TS.
pub fn add_llm_metadata_tags(
    mut builder: EventBuilder,
    md: &LlmMetadata,
) -> Result<EventBuilder, EncodeError> {
    if let Some(s) = md.thread_id.as_deref() {
        builder = builder.tag(tag(["llm-thread-id", s])?);
    }
    if let Some(s) = md.turn_id.as_deref() {
        builder = builder.tag(tag(["llm-turn-id", s])?);
    }
    if let Some(n) = md.tool_total_calls {
        builder = builder.tag(tag(["llm-tool-total-calls", &n.to_string()])?);
    }
    if let Some(n) = md.tool_total_duration_ms {
        builder = builder.tag(tag(["llm-tool-total-duration-ms", &n.to_string()])?);
    }
    if let Some(n) = md.tool_command_calls {
        builder = builder.tag(tag(["llm-tool-command-calls", &n.to_string()])?);
    }
    if let Some(n) = md.tool_file_change_calls {
        builder = builder.tag(tag(["llm-tool-file-change-calls", &n.to_string()])?);
    }
    if let Some(n) = md.tool_mcp_calls {
        builder = builder.tag(tag(["llm-tool-mcp-calls", &n.to_string()])?);
    }
    if let Some(n) = md.tool_other_calls {
        builder = builder.tag(tag(["llm-tool-other-calls", &n.to_string()])?);
    }
    Ok(builder)
}

/// Format a USD cost without scientific notation, trimming trailing zeros and
/// any trailing decimal point. Mirrors `cost.toFixed(10).replace(/\.?0+$/, '')`.
pub fn format_cost(cost: f64) -> String {
    let s = format!("{cost:.10}");
    let s = s.trim_end_matches('0');
    let s = s.trim_end_matches('.');
    if s.is_empty() {
        "0".to_string()
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_formatting_strips_trailing_zeros() {
        assert_eq!(format_cost(0.001234), "0.001234");
        assert_eq!(format_cost(1.0), "1");
        assert_eq!(format_cost(0.0), "0");
        assert_eq!(format_cost(0.000_000_000_5), "0.0000000005");
    }
}
