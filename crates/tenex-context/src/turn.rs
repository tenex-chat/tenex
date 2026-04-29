//! Per-turn write-back: persist what the agent runner actually sent and
//! what the provider observed back into `tenex-conversations`.

use tenex_conversations::{AgentContextState, ConversationStore, NewPromptHistoryEntry};

use crate::types::{Message, TurnRecord};

pub(crate) fn write_turn(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    turn: TurnRecord,
) -> anyhow::Result<()> {
    let existing = store.get_agent_context_state(conversation_id, agent_pubkey)?;
    let now_ms = now_ms();
    let prompt_id_base = now_ms;

    let mut next_seq = existing
        .as_ref()
        .map(|s| s.next_prompt_sequence)
        .unwrap_or(0);

    for (idx, msg) in turn.messages_visible.iter().enumerate() {
        let entry = build_history_entry(agent_pubkey, prompt_id_base, idx, next_seq, msg)?;
        store.append_prompt_history(conversation_id, &entry)?;
        next_seq += 1;
    }

    let cache_observed_json = serde_json::to_value(&turn.cache_observed)?;
    let reminders_json = serde_json::to_value(&turn.reminders_applied)?;
    let compaction_json = serde_json::to_value(&turn.compaction_decisions)?;

    let mut state = existing.unwrap_or_else(|| AgentContextState {
        conversation_id: conversation_id.to_string(),
        agent_pubkey: agent_pubkey.to_string(),
        next_prompt_sequence: 0,
        cache_anchored: false,
        seen_message_ids: Vec::new(),
        compaction_state: None,
        reminder_state: None,
        reminder_delta_state: None,
        todos: None,
        self_applied_skills: None,
        meta_model_variant: None,
        is_blocked: false,
        todo_nudged: false,
        updated_at: 0,
    });

    state.next_prompt_sequence = next_seq;
    state.cache_anchored = turn.cache_observed.hit_tokens > 0;
    state.compaction_state = Some(serde_json::json!({
        "decisions": compaction_json,
        "cache_observed": cache_observed_json,
    }));
    state.reminder_state = Some(serde_json::json!({
        "applied": reminders_json,
    }));
    state.updated_at = now_ms;

    store.upsert_agent_context_state(&state)?;
    Ok(())
}

fn build_history_entry(
    agent_pubkey: &str,
    prompt_id_base: i64,
    idx: usize,
    sequence: i64,
    msg: &Message,
) -> anyhow::Result<NewPromptHistoryEntry> {
    let (role, source_kind, overlay_type) = match msg {
        Message::System { .. } => ("system", "system_prompt", None),
        Message::User { .. } => ("user", "message", None),
        Message::Assistant { .. } => ("assistant", "message", None),
        Message::ToolResult { .. } => ("tool", "tool_result", None),
    };
    let content = serde_json::to_value(msg)?;
    Ok(NewPromptHistoryEntry {
        agent_pubkey: agent_pubkey.to_string(),
        prompt_id: format!("turn-{prompt_id_base}-{idx}"),
        sequence,
        role: role.to_string(),
        source_kind: source_kind.to_string(),
        source_message_id: None,
        source_record_id: None,
        source_event_id: None,
        overlay_type: overlay_type.map(str::to_string),
        content,
    })
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before UNIX epoch")
        .as_millis() as i64
}
