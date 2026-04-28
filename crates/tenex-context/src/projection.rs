//! Projection: history → `Vec<Message>`.
//!
//! Reads materialized messages and tool messages from storage, then
//! converts them into the role-tagged [`Message`] enum the strategy
//! pipeline operates on. The system prompt is injected at index 0.

use tenex_conversations::{ConversationStore, MessageQuery};

use crate::types::Message;

/// Build the initial message vector from storage. Index 0 is always the
/// system prompt.
pub(crate) fn project_messages(
    store: &ConversationStore,
    conversation_id: &str,
    system_prompt: &str,
) -> anyhow::Result<Vec<Message>> {
    let history = store.list_messages(conversation_id, MessageQuery::default())?;
    let tool_msgs = store.list_tool_messages(conversation_id)?;

    let mut out = Vec::with_capacity(history.len() + tool_msgs.len() + 1);
    out.push(Message::System {
        content: system_prompt.to_string(),
    });

    for record in &history {
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
            "assistant" => out.push(Message::Assistant {
                content: record.content.clone(),
                tool_calls: Vec::new(),
            }),
            other => anyhow::bail!(
                "message record {} in conversation {} has unknown role {:?}",
                record.id,
                conversation_id,
                other
            ),
        }
    }

    // Append tool results in `tool_messages` insertion order (id ASC).
    // The agent runner produced that order; preserving it keeps the
    // assistant→tool-result relationship intact downstream.
    for tool in &tool_msgs {
        // A tool row without a result is an in-flight call; skip until
        // the result lands.
        let Some(result) = &tool.result_output else {
            continue;
        };
        let content = match result {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        out.push(Message::ToolResult {
            tool_call_id: tool.tool_call_id.clone(),
            tool_name: tool.tool_name.clone(),
            content,
            is_error: tool.is_error,
        });
    }

    Ok(out)
}
