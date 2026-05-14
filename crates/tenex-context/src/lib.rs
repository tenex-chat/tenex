//! `tenex-context` — projection of conversation history into the
//! `messages[]` half of an LLM request.
//!
//! Sits between [`tenex_conversations`] (storage) and the agent runner
//! (LLM loop). Owns:
//!
//! - **Projection**: history → `Vec<Message>`.
//! - **Strategies**: composable compaction, tool-result decay, reminder
//!   overlays.
//! - **Cache anchors** for the message stream.
//! - **Frozen prompt-history** write-back via [`record_turn`].
//!
//! The system prompt is an opaque `&str` input — assembly belongs to
//! `tenex-system-prompt`. Tool *definitions* flow agent → `rig` directly;
//! they enter this crate only so strategies can resolve `preserve_results`
//! by name.

mod projection;
pub mod strategies;
mod tokens;
mod turn;
pub mod types;

pub use projection::DisplayNameResolver;
pub use strategies::{
    default_stack, stack_with_compaction_override, CompactionSummarizer, CompactionToolStrategy,
    ProjectionContext, RemindersStrategy, Strategy, ToolResultDecayStrategy,
};
pub use types::{
    BreakpointHint, BreakpointKind, CacheObservation, CompactionOverride, Message, ModelProfile,
    Projection, ProjectionOptions, ProjectionTelemetry, ReasoningBlock, ToolCall, ToolDef,
    TurnRecord,
};

use tenex_conversations::ConversationStore;

/// Project conversation history for `agent_pubkey` into the message
/// stream half of an LLM request.
///
/// `system_prompt` is opaque — built upstream and treated as stable.
/// `tool_defs` is consulted by the decay strategy to resolve the
/// `preserve_results` flag for tool results in history; it is not
/// rendered.
/// `summarizer` is an optional LLM-backed compaction summarizer. When
/// provided, the compaction strategy generates a semantic 8-section
/// summary instead of a deterministic placeholder.
pub async fn project(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    system_prompt: &str,
    model_profile: &ModelProfile,
    tool_defs: &[ToolDef],
    summarizer: Option<std::sync::Arc<dyn CompactionSummarizer>>,
    name_resolver: Option<&dyn DisplayNameResolver>,
) -> anyhow::Result<Projection> {
    project_with_options(
        store,
        conversation_id,
        agent_pubkey,
        system_prompt,
        model_profile,
        tool_defs,
        summarizer,
        name_resolver,
        ProjectionOptions::default(),
    )
    .await
}

/// Like [`project`], but can omit one materialized Nostr event from history
/// and append unpersisted in-turn messages before strategies run.
///
/// Agent runners pass the triggering user event separately as the live prompt;
/// when the runtime has already materialized that same event into the
/// conversation DB, excluding it here prevents the current user message from
/// appearing twice in the provider request.
#[allow(clippy::too_many_arguments)]
pub async fn project_with_options(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    system_prompt: &str,
    model_profile: &ModelProfile,
    tool_defs: &[ToolDef],
    summarizer: Option<std::sync::Arc<dyn CompactionSummarizer>>,
    name_resolver: Option<&dyn DisplayNameResolver>,
    options: ProjectionOptions,
) -> anyhow::Result<Projection> {
    tracing::trace!(
        conversation_id,
        agent_pubkey,
        provider = %model_profile.provider,
        model = %model_profile.model_id,
        "projecting conversation"
    );

    let ProjectionOptions {
        excluded_event_id,
        in_turn_tail,
        compaction_override,
    } = options;

    let mut messages = projection::project_messages(
        store,
        conversation_id,
        agent_pubkey,
        system_prompt,
        name_resolver,
        excluded_event_id.as_deref(),
    )?;
    messages.extend(in_turn_tail);
    let telemetry = ProjectionTelemetry::default();
    let agent_todos = store
        .get_agent_context_state(conversation_id, agent_pubkey)
        .ok()
        .flatten()
        .and_then(|s| s.todos);

    let mut ctx = ProjectionContext {
        messages,
        telemetry,
        model_profile,
        tool_defs,
        agent_todos,
    };

    for strat in stack_with_compaction_override(summarizer, compaction_override.as_ref()) {
        strat.apply(&mut ctx).await?;
    }

    let cache_breakpoints = compute_breakpoints(&ctx.messages, model_profile);

    Ok(Projection {
        messages: ctx.messages,
        cache_breakpoints,
        telemetry: ctx.telemetry,
    })
}

/// Persist what the agent runner sent and what the provider observed.
/// Updates frozen prompt-history and per-agent context state.
pub fn record_turn(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    turn: TurnRecord,
) -> anyhow::Result<()> {
    turn::write_turn(store, conversation_id, agent_pubkey, turn)
}

fn compute_breakpoints(messages: &[Message], profile: &ModelProfile) -> Vec<BreakpointHint> {
    let mut hints = Vec::new();
    // System anchor: always at the boundary just past the system prompt.
    // Position points to the first non-system message (or end-of-vec if
    // there are none yet).
    let system_anchor_pos = messages
        .iter()
        .position(|m| !matches!(m, Message::System { .. }))
        .unwrap_or(messages.len());
    hints.push(BreakpointHint {
        position: system_anchor_pos,
        kind: BreakpointKind::SystemAnchor,
    });

    if profile.prompt_cache && messages.len() > system_anchor_pos {
        // Anchor inside the message stream at the last position so the
        // entire stream up through the most recent message is cached.
        hints.push(BreakpointHint {
            position: messages.len() - 1,
            kind: BreakpointKind::MessageStream,
        });
    }

    hints
}
