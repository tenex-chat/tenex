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

pub mod strategies;
mod projection;
mod tokens;
mod turn;
pub mod types;

pub use strategies::{
    default_stack, CompactionToolStrategy, ProjectionContext, RemindersStrategy, Strategy,
    ToolResultDecayStrategy,
};
pub use types::{
    BreakpointHint, BreakpointKind, CacheObservation, Message, ModelProfile, Projection,
    ProjectionTelemetry, ToolCall, ToolDef, TurnRecord,
};

use tenex_conversations::ConversationStore;

/// Project conversation history for `agent_pubkey` into the message
/// stream half of an LLM request.
///
/// `system_prompt` is opaque — built upstream and treated as stable.
/// `tool_defs` is consulted by the decay strategy to resolve the
/// `preserve_results` flag for tool results in history; it is not
/// rendered.
pub fn project(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    system_prompt: &str,
    model_profile: &ModelProfile,
    tool_defs: &[ToolDef],
) -> anyhow::Result<Projection> {
    tracing::trace!(
        conversation_id,
        agent_pubkey,
        provider = %model_profile.provider,
        model = %model_profile.model_id,
        "projecting conversation"
    );

    let messages =
        projection::project_messages(store, conversation_id, agent_pubkey, system_prompt)?;
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

    for strat in default_stack() {
        strat.apply(&mut ctx)?;
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
