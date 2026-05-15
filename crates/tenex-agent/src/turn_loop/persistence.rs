//! Side-effecting persistence helpers used by [`super::run_turn_loop`].
//!
//! Each helper logs and swallows individual storage failures so a flaky
//! database does not abort an in-flight agent turn — the rig response has
//! already been emitted by the time these run.

use tenex_accounting::{LlmUsage, RecordLlmCall, RootKind, record_llm_call};
use tenex_context::{
    BreakpointHint, BreakpointKind, CacheObservation, Message as CtxMessage, TurnRecord,
};
use tenex_conversations::{ConversationStore, NewToolMessage};

use crate::agent_bootstrap::AgentBootstrap;
use crate::tools::TodoItem;
use crate::tools::recording::ToolCallRecord;

pub(super) use crate::tools::agent_context_state::save_context_state;

pub(super) fn record_step_user(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    content: &str,
) {
    let turn = TurnRecord {
        messages_visible: vec![CtxMessage::User {
            content: content.to_string(),
        }],
        reminders_applied: Vec::new(),
        compaction_decisions: Vec::new(),
        cache_observed: CacheObservation::default(),
        breakpoint_hints: Vec::new(),
    };
    if let Err(e) = tenex_context::record_turn(store, conversation_id, agent_pubkey, turn) {
        eprintln!("[tenex-agent] Failed to record user step: {e}");
    }
}

/// Persist the tool calls captured during one provider step into
/// `tool_messages`. Pairs with the assistant prompt-history entry recorded for
/// the same step.
pub(super) fn record_step_tool_messages(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    recorded_calls: &[ToolCallRecord],
) {
    for rec in recorded_calls {
        if let Some(provider_call_id) = rec.provider_call_id.as_deref() {
            tracing::debug!(
                tool_call_id = %rec.call_id,
                provider_call_id,
                tool_name = %rec.tool_name,
                "persisting tool message with provider call id"
            );
        }
        let new_tool = NewToolMessage {
            tool_call_id: rec.call_id.clone(),
            parent_message_id: None,
            agent_pubkey: agent_pubkey.to_string(),
            tool_name: rec.tool_name.clone(),
            call_input: rec.args.clone(),
            result_output: Some(rec.result.clone()),
            is_error: rec.is_error,
            timestamp: Some(rec.timestamp_ms),
        };
        if let Err(e) = store.record_tool_message(conversation_id, &new_tool) {
            eprintln!("[tenex-agent] Failed to persist tool message: {e}");
        }
    }
}

pub(super) fn record_step_assistant(
    boot: &AgentBootstrap,
    store: &ConversationStore,
    assistant_message: CtxMessage,
    stream_usage: &rig::completion::Usage,
) {
    let hit_tokens = stream_usage.cached_input_tokens;
    let messages_visible = vec![assistant_message];
    // When the provider reports a cache hit, record the position of
    // the assistant response as the live cache anchor for this turn.
    let breakpoint_hints = if hit_tokens > 0 {
        vec![BreakpointHint {
            position: 0,
            kind: BreakpointKind::MessageStream,
        }]
    } else {
        Vec::new()
    };
    let turn = TurnRecord {
        messages_visible,
        reminders_applied: Vec::new(),
        compaction_decisions: Vec::new(),
        cache_observed: CacheObservation {
            hit_tokens,
            miss_tokens: 0,
            written_tokens: stream_usage.cache_creation_input_tokens,
        },
        breakpoint_hints,
    };
    if let Err(e) = tenex_context::record_turn(store, &boot.conversation_id, &boot.pubkey_hex, turn)
    {
        eprintln!("[tenex-agent] Failed to record assistant step: {e}");
    }
}

/// Record this turn's accounting row after the step loop has completed.
pub(super) async fn record_turn_accounting(
    boot: &AgentBootstrap,
    current_message: &str,
    response: &str,
    stream_usage: &rig::completion::Usage,
) {
    record_llm_call(RecordLlmCall {
        root_kind: RootKind::UserMessage.into(),
        provider: boot.resolved.provider.clone(),
        provider_model_id: boot.resolved.model.clone(),
        operation: "stream".into(),
        agent_pubkey: Some(boot.pubkey_hex.clone()),
        agent_slug: Some(boot.agent_slug.clone()),
        conversation_id: Some(boot.conversation_id.clone()),
        project_id: Some(boot.project_id.clone()),
        user_message: Some(current_message.to_string()),
        assistant_response: Some(response.to_string()),
        usage: LlmUsage {
            input_tokens: stream_usage.input_tokens,
            output_tokens: stream_usage.output_tokens,
            cached_input_tokens: stream_usage.cached_input_tokens,
            cache_creation_input_tokens: stream_usage.cache_creation_input_tokens,
            reasoning_tokens: 0,
            total_tokens: Some(stream_usage.total_tokens),
        },
        ..Default::default()
    })
    .await;
}
