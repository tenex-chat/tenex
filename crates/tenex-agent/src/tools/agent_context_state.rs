//! Shared persistence helper for the `agent_context_state` row. Both the
//! turn-loop (writes after each turn) and the standalone `tenex mcp agent`
//! server (writes when the MCP session ends) use this to save todos +
//! self-applied skills via a column-scoped atomic upsert, so concurrent
//! writers updating other fields on the same row cannot lose updates.

use anyhow::{Context, Result};
use tenex_conversations::ConversationStore;

use super::TodoItem;

pub fn save_context_state(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    todos: &[TodoItem],
    self_applied_skills: &[String],
) -> Result<()> {
    let todos_json = serde_json::to_value(todos).context("serialize todos")?;
    let skills_json =
        serde_json::to_value(self_applied_skills).context("serialize self_applied_skills")?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);

    store
        .patch_agent_context_todos(
            conversation_id,
            agent_pubkey,
            &todos_json,
            &skills_json,
            now,
        )
        .with_context(|| {
            format!(
                "patch agent_context_state todos for conversation {conversation_id}, agent {agent_pubkey}"
            )
        })
}
