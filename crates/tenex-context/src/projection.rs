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

use std::collections::VecDeque;

use tenex_conversations::{ConversationStore, MessageQuery, ToolMessage};

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
    // Sort by timestamp for deterministic slotting. Fall back to
    // `created_at` for legacy rows that pre-date the timestamp column.
    let order_key = |t: &ToolMessage| t.timestamp.unwrap_or(t.created_at);
    tool_msgs.make_contiguous().sort_by_key(order_key);

    let mut out = Vec::with_capacity(history.len() + tool_msgs.len() + 1);
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
                    .and_then(|r| r.timestamp)
                    .unwrap_or(i64::MAX);
                let mut paired: Vec<ToolMessage> = Vec::new();
                while let Some(front) = tool_msgs.front() {
                    if order_key(front) < next_user_ts {
                        paired.push(tool_msgs.pop_front().expect("front exists"));
                    } else {
                        break;
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
    }

    // Drop any remaining tool messages: they don't have an assistant
    // row yet (the matching event hasn't been ingested into the
    // `messages` table). Including them would emit orphan
    // `tool_result`s — a 400 from the provider. They'll re-slot
    // correctly on the next projection pass once the assistant lands.
    drop(tool_msgs);

    Ok(out)
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
