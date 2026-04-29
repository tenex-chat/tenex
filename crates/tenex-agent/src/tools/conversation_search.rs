use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use tenex_conversations::ConversationStore;

#[derive(Debug, Deserialize, Serialize)]
pub struct ConversationSearchArgs {
    pub query: String,
    /// "keyword" (default, title/summary search) or "full-text" (also searches message content)
    pub mode: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConversationSearchError(String);

#[derive(Clone)]
pub struct ConversationSearchTool {
    db_path: PathBuf,
}

impl ConversationSearchTool {
    pub fn new(db_path: PathBuf) -> Self {
        Self { db_path }
    }
}

impl Tool for ConversationSearchTool {
    const NAME: &'static str = "conversation_search";
    type Error = ConversationSearchError;
    type Args = ConversationSearchArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Search conversations by keyword. Returns matching conversations with \
                IDs, titles, and metadata. mode='keyword' (default) matches title, summary, and \
                last user message. mode='full-text' also searches all message content."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search term to match against conversation titles and content"
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["keyword", "full-text"],
                        "description": "Search mode: 'keyword' (default, fast) or 'full-text' (searches all messages)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default: 20)"
                    }
                },
                "required": ["query"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let store = ConversationStore::open(&self.db_path).map_err(|e| {
            ConversationSearchError(format!("failed to open conversation store: {e}"))
        })?;

        let full_text = args.mode.as_deref() == Some("full-text");
        let limit = args.limit.unwrap_or(20);

        let conversations = store
            .search_conversations(&args.query, full_text, limit)
            .map_err(|e| ConversationSearchError(format!("search failed: {e}")))?;

        if conversations.is_empty() {
            return Ok(format!(
                "No conversations found matching '{}'.",
                args.query
            ));
        }

        let mode_label = if full_text { "full-text" } else { "keyword" };
        let mut lines = vec![format!(
            "{} conversation(s) matching '{}' ({mode_label}):",
            conversations.len(),
            args.query
        )];

        for conv in &conversations {
            let id_short = &conv.id[..8.min(conv.id.len())];
            let title = conv.title.as_deref().unwrap_or("(untitled)");
            let summary = conv
                .summary
                .as_deref()
                .map(|s| {
                    let truncated: String = s.chars().take(80).collect();
                    if s.chars().count() > 80 {
                        format!(" | {truncated}…")
                    } else {
                        format!(" | {truncated}")
                    }
                })
                .unwrap_or_default();
            let activity = conv
                .last_activity
                .map(|ts| format!(" [last: {ts}]"))
                .unwrap_or_default();
            lines.push(format!(
                "  {}: {}{}{} — full id: {}",
                id_short, title, activity, summary, conv.id,
            ));
        }

        Ok(lines.join("\n"))
    }
}
