use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use tenex_conversations::{AgentContextState, ConversationStore};

#[derive(Debug, Deserialize, Serialize)]
pub struct ChangeModelArgs {
    pub model: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ChangeModelError(String);

#[derive(Clone)]
pub struct ChangeModelTool {
    db_path: PathBuf,
    conversation_id: String,
    agent_pubkey: String,
}

impl ChangeModelTool {
    pub fn new(db_path: PathBuf, conversation_id: String, agent_pubkey: String) -> Self {
        Self { db_path, conversation_id, agent_pubkey }
    }
}

impl Tool for ChangeModelTool {
    const NAME: &'static str = "change_model";
    type Error = ChangeModelError;
    type Args = ChangeModelArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Switch the LLM model used by this agent for subsequent turns in this conversation. Accepts a model identifier in any supported format: a named preset from llms.json (e.g. 'fast'), 'provider:model' (e.g. 'anthropic:claude-haiku-4-5'), or 'provider/model' (e.g. 'openai/gpt-4o'). Takes effect on the next invocation of this agent.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "model": {
                        "type": "string",
                        "description": "Model identifier: named preset, 'provider:model', or 'provider/model'"
                    }
                },
                "required": ["model"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let store = ConversationStore::open(&self.db_path)
            .map_err(|e| ChangeModelError(format!("failed to open conversation store: {e}")))?;

        let existing = store
            .get_agent_context_state(&self.conversation_id, &self.agent_pubkey)
            .map_err(|e| ChangeModelError(format!("failed to read agent context state: {e}")))?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let updated = AgentContextState {
            conversation_id: self.conversation_id.clone(),
            agent_pubkey: self.agent_pubkey.clone(),
            next_prompt_sequence: existing.as_ref().map(|s| s.next_prompt_sequence).unwrap_or(0),
            cache_anchored: existing.as_ref().map(|s| s.cache_anchored).unwrap_or(false),
            seen_message_ids: existing.as_ref().map(|s| s.seen_message_ids.clone()).unwrap_or_default(),
            compaction_state: existing.as_ref().and_then(|s| s.compaction_state.clone()),
            reminder_state: existing.as_ref().and_then(|s| s.reminder_state.clone()),
            reminder_delta_state: existing.as_ref().and_then(|s| s.reminder_delta_state.clone()),
            todos: existing.as_ref().and_then(|s| s.todos.clone()),
            self_applied_skills: existing.as_ref().and_then(|s| s.self_applied_skills.clone()),
            meta_model_variant: Some(args.model.clone()),
            is_blocked: existing.as_ref().map(|s| s.is_blocked).unwrap_or(false),
            todo_nudged: existing.as_ref().map(|s| s.todo_nudged).unwrap_or(false),
            updated_at: now,
        };

        store
            .upsert_agent_context_state(&updated)
            .map_err(|e| ChangeModelError(format!("failed to save model override: {e}")))?;

        Ok(format!(
            "Model switched to '{}'. Takes effect on the next invocation of this agent in this conversation.",
            args.model
        ))
    }
}
