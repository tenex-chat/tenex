//! Side-effecting persistence helpers used by [`super::run_turn_loop`].
//!
//! Each helper logs and swallows individual storage failures so a flaky
//! database does not abort an in-flight agent turn — the rig response has
//! already been emitted by the time these run.

use tenex_accounting::{flush as flush_accounting, record_llm_call, LlmUsage, RecordLlmCall, RootKind};
use tenex_context::{
    BreakpointHint, BreakpointKind, CacheObservation, Message as CtxMessage,
    ToolCall as CtxToolCall, TurnRecord,
};
use tenex_conversations::{AgentContextState, ConversationStore, NewToolMessage};

use crate::agent_bootstrap::AgentBootstrap;
use crate::tools::recording::ToolCallRecord;
use crate::tools::TodoItem;

/// Unified save for both todos and self_applied_skills in a single
/// read-modify-write. Keeping these in one call prevents the second writer
/// from overwriting the first's changes.
pub(super) fn save_context_state(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    todos: &[TodoItem],
    self_applied_skills: &[String],
) {
    let todos_json = match serde_json::to_value(todos) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[tenex-agent] Failed to serialize todos: {e}");
            return;
        }
    };
    // Serialize as explicit empty array (not None) so future reads can distinguish
    // "never set" (None) from "user cleared all" (Some([])).
    let skills_json = serde_json::to_value(self_applied_skills).ok();

    let existing = store
        .get_agent_context_state(conversation_id, agent_pubkey)
        .ok()
        .flatten();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);

    let state = AgentContextState {
        conversation_id: conversation_id.to_string(),
        agent_pubkey: agent_pubkey.to_string(),
        next_prompt_sequence: existing.as_ref().map_or(0, |s| s.next_prompt_sequence),
        cache_anchored: existing.as_ref().is_some_and(|s| s.cache_anchored),
        seen_message_ids: existing
            .as_ref()
            .map(|s| s.seen_message_ids.clone())
            .unwrap_or_default(),
        compaction_state: existing.as_ref().and_then(|s| s.compaction_state.clone()),
        reminder_state: existing.as_ref().and_then(|s| s.reminder_state.clone()),
        reminder_delta_state: existing
            .as_ref()
            .and_then(|s| s.reminder_delta_state.clone()),
        todos: Some(todos_json),
        self_applied_skills: skills_json,
        meta_model_variant: existing.as_ref().and_then(|s| s.meta_model_variant.clone()),
        is_blocked: existing.as_ref().is_some_and(|s| s.is_blocked),
        todo_nudged: existing.as_ref().is_some_and(|s| s.todo_nudged),
        updated_at: now,
    };

    if let Err(e) = store.upsert_agent_context_state(&state) {
        eprintln!("[tenex-agent] Failed to save agent context state: {e}");
    }
}

/// Persist the tool calls captured during this turn into `tool_messages`.
/// Pairs with the assistant prompt-history entry recorded by [`record_turn`].
pub(super) fn record_tool_messages(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    recorded_calls: &[ToolCallRecord],
) {
    for rec in recorded_calls {
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

/// Record this turn's assistant + tool messages into the conversation store
/// and run the accounting hook.
pub(super) async fn record_turn_outcome(
    boot: &AgentBootstrap,
    store: &ConversationStore,
    current_message: &str,
    response: &str,
    recorded_calls: &[ToolCallRecord],
    stream_usage: &rig::completion::Usage,
) {
    let assistant_tool_calls: Vec<CtxToolCall> = recorded_calls
        .iter()
        .map(|r| CtxToolCall {
            id: r.call_id.clone(),
            name: r.tool_name.clone(),
            arguments: r.args.clone(),
        })
        .collect();
    let hit_tokens = stream_usage.cached_input_tokens;
    let messages_visible = vec![
        CtxMessage::User {
            content: current_message.to_string(),
        },
        CtxMessage::Assistant {
            content: response.to_string(),
            tool_calls: assistant_tool_calls,
        },
    ];
    // When the provider reports a cache hit, record the position of
    // the assistant response as the live cache anchor for this turn.
    let breakpoint_hints = if hit_tokens > 0 {
        vec![BreakpointHint {
            position: 1,
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
        eprintln!("[tenex-agent] Failed to record turn: {e}");
    }
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
    flush_accounting().await;
}
