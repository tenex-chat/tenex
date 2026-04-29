//! Projection: history → `Vec<Message>`.
//!
//! Reads materialized messages and tool messages from storage, then
//! converts them into the role-tagged [`Message`] enum the strategy
//! pipeline operates on. The system prompt is injected at index 0.
//!
//! Tool messages are interleaved into the stream by timestamp so each
//! `ToolResult` follows the assistant message that issued the call. The
//! `tool_calls` block is reconstructed onto the same assistant message
//! so providers see the canonical `tool_use` → `tool_result` pairing
//! they require — without that linkage Anthropic/OpenAI reject the
//! request with a 400.

use std::collections::{HashSet, VecDeque};

use serde_json::Value;
use tenex_conversations::{ConversationStore, MessageQuery, MessageRecord, ToolMessage};

use crate::types::{Message, ToolCall};

/// Build the initial message vector from storage. Index 0 is always the
/// system prompt.
pub(crate) fn project_messages(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    system_prompt: &str,
) -> anyhow::Result<Vec<Message>> {
    let history = store.list_messages(conversation_id, MessageQuery::default())?;
    // Only include tool messages owned by *this* agent. Conversations
    // can host multiple agents; splicing another agent's tool calls
    // into this projection would emit unmatched `tool_use` blocks.
    let mut tool_msgs: VecDeque<ToolMessage> = store
        .list_tool_messages(conversation_id)?
        .into_iter()
        .filter(|t| t.agent_pubkey == agent_pubkey)
        // Drop in-flight tool calls (no result yet); they have no
        // `ToolResult` to emit, and their `tool_use` would be orphaned.
        .filter(|t| t.result_output.is_some())
        .collect();
    let completed_tool_ids: HashSet<String> =
        tool_msgs.iter().map(|t| t.tool_call_id.clone()).collect();
    let mut active_tools =
        load_active_tools(store, conversation_id, agent_pubkey, &completed_tool_ids)?;
    // Sort by timestamp for deterministic slotting. Fall back to
    // `created_at` for legacy rows that pre-date the timestamp column.
    let order_key = |t: &ToolMessage| timestamp_value_ms(t.timestamp.unwrap_or(t.created_at));
    tool_msgs.make_contiguous().sort_by_key(order_key);

    let mut out = Vec::with_capacity(history.len() + tool_msgs.len() + active_tools.len() * 2 + 1);
    out.push(Message::System {
        content: system_prompt.to_string(),
    });

    for (idx, record) in history.iter().enumerate() {
        let Some(role) = record.role.as_deref() else {
            anyhow::bail!(
                "message record {} in conversation {} has no role",
                record.id,
                conversation_id
            );
        };
        match role {
            "system" => out.push(Message::System {
                content: record.content.clone(),
            }),
            "user" => out.push(Message::User {
                content: record.content.clone(),
            }),
            "assistant" => {
                // Pair every tool call/result whose timestamp falls
                // before the next user message with this assistant
                // message. Consecutive assistant messages still belong
                // to the same logical turn, so their tool calls stay
                // grouped.
                let next_user_ts = history[idx + 1..]
                    .iter()
                    .find(|r| matches!(r.role.as_deref(), Some("user")))
                    .and_then(|r| timestamp_ms(r.timestamp))
                    .unwrap_or(i64::MAX);
                let mut paired: Vec<ToolMessage> = Vec::new();
                while tool_msgs
                    .front()
                    .is_some_and(|front| order_key(front) < next_user_ts)
                {
                    if let Some(tool) = tool_msgs.pop_front() {
                        paired.push(tool);
                    }
                }

                let tool_calls: Vec<ToolCall> = paired
                    .iter()
                    .map(|t| ToolCall {
                        id: t.tool_call_id.clone(),
                        name: t.tool_name.clone(),
                        arguments: t.call_input.clone(),
                    })
                    .collect();

                out.push(Message::Assistant {
                    content: record.content.clone(),
                    tool_calls,
                });
                for tool in paired {
                    push_tool_result(&mut out, tool);
                }
            }
            other => anyhow::bail!(
                "message record {} in conversation {} has unknown role {:?}",
                record.id,
                conversation_id,
                other
            ),
        }

        let next_record_ts = next_record_timestamp_ms(&history, idx);
        push_active_tools_before(&mut out, &mut active_tools, next_record_ts);
    }

    // Drop any remaining tool messages: they don't have an assistant
    // row yet (the matching event hasn't been ingested into the
    // `messages` table). Including them would emit orphan
    // `tool_result`s — a 400 from the provider. They'll re-slot
    // correctly on the next projection pass once the assistant lands.
    drop(tool_msgs);
    push_active_tools_before(&mut out, &mut active_tools, i64::MAX);

    Ok(out)
}

#[derive(Debug, Clone)]
struct ActiveTool {
    tool_call_id: String,
    tool_name: String,
    args: Value,
    started_at_ms: i64,
}

fn load_active_tools(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    completed_tool_ids: &HashSet<String>,
) -> anyhow::Result<VecDeque<ActiveTool>> {
    let Some(conversation) = store.get_conversation(conversation_id)? else {
        return Ok(VecDeque::new());
    };
    let Some(tools) = conversation
        .runtime_state
        .get("rustRuntime")
        .and_then(|root| root.get("activeTools"))
        .and_then(Value::as_object)
    else {
        return Ok(VecDeque::new());
    };

    let mut active = tools
        .values()
        .filter_map(|tool| active_tool(tool, conversation_id, agent_pubkey, completed_tool_ids))
        .collect::<Vec<_>>();
    active.sort_by_key(|tool| tool.started_at_ms);
    Ok(active.into())
}

fn active_tool(
    tool: &Value,
    conversation_id: &str,
    agent_pubkey: &str,
    completed_tool_ids: &HashSet<String>,
) -> Option<ActiveTool> {
    if tool.get("agentPubkey").and_then(Value::as_str) != Some(agent_pubkey) {
        return None;
    }
    if tool.get("conversationId").and_then(Value::as_str) != Some(conversation_id) {
        return None;
    }

    let tool_call_id = tool.get("toolCallId")?.as_str()?.to_string();
    if completed_tool_ids.contains(&tool_call_id) {
        return None;
    }
    let tool_name = tool.get("toolName")?.as_str()?.to_string();
    let args = tool
        .get("args")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let started_at_ms = timestamp_value_ms(tool.get("startedAt")?.as_i64()?);
    Some(ActiveTool {
        tool_call_id,
        tool_name,
        args,
        started_at_ms,
    })
}

fn push_active_tools_before(
    out: &mut Vec<Message>,
    active_tools: &mut VecDeque<ActiveTool>,
    before_ms: i64,
) {
    while active_tools
        .front()
        .is_some_and(|tool| tool.started_at_ms < before_ms)
    {
        let Some(tool) = active_tools.pop_front() else {
            break;
        };
        push_active_tool(out, tool);
    }
}

fn push_active_tool(out: &mut Vec<Message>, tool: ActiveTool) {
    let content = pending_tool_result_content(&tool);
    out.push(Message::Assistant {
        content: String::new(),
        tool_calls: vec![ToolCall {
            id: tool.tool_call_id.clone(),
            name: tool.tool_name.clone(),
            arguments: tool.args.clone(),
        }],
    });
    out.push(Message::ToolResult {
        tool_call_id: tool.tool_call_id,
        tool_name: tool.tool_name,
        content,
        is_error: false,
    });
}

fn pending_tool_result_content(tool: &ActiveTool) -> String {
    format!(
        "<system-reminder type=\"pending-tool-result\">\nTool call {} ({}) is still running.\nArguments: {}\nDo not repeat this same tool call just because its final result is not available yet. Account for this pending execution before deciding the next action.\n</system-reminder>",
        tool.tool_call_id,
        tool.tool_name,
        compact_json(&tool.args),
    )
}

fn next_record_timestamp_ms(history: &[MessageRecord], idx: usize) -> i64 {
    history
        .get(idx + 1)
        .and_then(|record| timestamp_ms(record.timestamp))
        .unwrap_or(i64::MAX)
}

fn timestamp_ms(timestamp: Option<i64>) -> Option<i64> {
    timestamp.map(timestamp_value_ms)
}

fn timestamp_value_ms(timestamp: i64) -> i64 {
    if timestamp.abs() < 10_000_000_000 {
        timestamp.saturating_mul(1000)
    } else {
        timestamp
    }
}

fn compact_json(value: &Value) -> String {
    let raw = value.to_string();
    const MAX: usize = 500;
    if raw.len() <= MAX {
        raw
    } else {
        format!("{}...", &raw[..MAX])
    }
}

fn push_tool_result(out: &mut Vec<Message>, tool: ToolMessage) {
    let content = match tool.result_output {
        Some(serde_json::Value::String(s)) => s,
        Some(other) => other.to_string(),
        None => String::new(),
    };
    out.push(Message::ToolResult {
        tool_call_id: tool.tool_call_id,
        tool_name: tool.tool_name,
        content,
        is_error: tool.is_error,
    });
}
