use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use tenex_conversations::{store::ConversationListFilter, ConversationStore};

#[derive(Debug, Deserialize, Serialize)]
pub struct ConversationListArgs {
    pub limit: Option<i64>,
    pub from_time: Option<i64>,
    pub to_time: Option<i64>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConversationListError(String);

#[derive(Clone)]
pub struct ConversationListTool {
    db_path: PathBuf,
}

impl ConversationListTool {
    pub fn new(db_path: PathBuf) -> Self {
        Self { db_path }
    }
}

impl Tool for ConversationListTool {
    const NAME: &'static str = "conversation_list";
    type Error = ConversationListError;
    type Args = ConversationListArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List conversations in the current project, sorted by most recent activity. Returns conversation IDs, titles, and last activity timestamps.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of conversations to return (default: 20)"
                    },
                    "from_time": {
                        "type": "integer",
                        "description": "Filter conversations with activity after this Unix timestamp (milliseconds)"
                    },
                    "to_time": {
                        "type": "integer",
                        "description": "Filter conversations with activity before this Unix timestamp (milliseconds)"
                    }
                },
                "required": []
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let store = ConversationStore::open(&self.db_path)
            .map_err(|e| ConversationListError(format!("failed to open conversation store: {e}")))?;

        let filter = ConversationListFilter {
            limit: Some(args.limit.unwrap_or(20)),
            from_time: args.from_time,
            to_time: args.to_time,
            participant_pubkey: None,
        };

        let conversations = store
            .list_recent(filter)
            .map_err(|e| ConversationListError(format!("failed to list conversations: {e}")))?;

        if conversations.is_empty() {
            return Ok("No conversations found in this project.".to_string());
        }

        let mut lines = vec![format!("{} conversation(s):", conversations.len())];

        for conv in &conversations {
            let id_short = &conv.id[..8.min(conv.id.len())];
            let title = conv.title.as_deref().unwrap_or("(untitled)");
            let last_msg = conv
                .last_user_message
                .as_deref()
                .map(|m| {
                    let truncated: String = m.chars().take(60).collect();
                    if m.chars().count() > 60 { format!("{truncated}…") } else { truncated }
                })
                .unwrap_or_default();
            let activity = conv
                .last_activity
                .map(|ts| format!(" [last active: {ts}]"))
                .unwrap_or_default();
            lines.push(format!(
                "  {}: {}{}{} — full id: {}",
                id_short,
                title,
                activity,
                if last_msg.is_empty() { String::new() } else { format!(" | {last_msg}") },
                conv.id,
            ));
        }

        Ok(lines.join("\n"))
    }
}
