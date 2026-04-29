use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use tenex_conversations::{store::MessageQuery, ConversationStore};

#[derive(Debug, Deserialize, Serialize)]
pub struct ConversationGetArgs {
    pub conversation_id: String,
    pub limit: Option<i64>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConversationGetError(String);

#[derive(Clone)]
pub struct ConversationGetTool {
    db_path: PathBuf,
}

impl ConversationGetTool {
    pub fn new(db_path: PathBuf) -> Self {
        Self { db_path }
    }
}

impl Tool for ConversationGetTool {
    const NAME: &'static str = "conversation_get";
    type Error = ConversationGetError;
    type Args = ConversationGetArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Retrieve the full message transcript for a conversation by its ID. Returns messages in chronological order with role and author prefix.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "conversation_id": {
                        "type": "string",
                        "description": "The conversation ID (64-char hex event ID)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of messages to return (default: all)"
                    }
                },
                "required": ["conversation_id"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let store = ConversationStore::open(&self.db_path)
            .map_err(|e| ConversationGetError(format!("failed to open conversation store: {e}")))?;

        let messages = store
            .list_messages(
                &args.conversation_id,
                MessageQuery {
                    limit: args.limit,
                    ..Default::default()
                },
            )
            .map_err(|e| ConversationGetError(format!("failed to list messages: {e}")))?;

        if messages.is_empty() {
            return Ok(format!(
                "No messages found for conversation {}",
                &args.conversation_id[..8.min(args.conversation_id.len())]
            ));
        }

        let mut lines = vec![format!(
            "Conversation {} ({} messages):",
            &args.conversation_id[..8.min(args.conversation_id.len())],
            messages.len()
        )];

        for msg in &messages {
            let role = msg.role.as_deref().unwrap_or("unknown");
            let author = &msg.author_pubkey[..8.min(msg.author_pubkey.len())];
            let readable = msg.human_readable.as_deref().unwrap_or(&msg.content);
            lines.push(format!("[{role}] {author}: {readable}"));
        }

        Ok(lines.join("\n"))
    }
}
