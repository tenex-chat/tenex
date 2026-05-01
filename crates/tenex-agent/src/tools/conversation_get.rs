use crate::config::ResolvedModel;
use rig::providers::{anthropic, ollama, openai, openrouter};
use rig::{client::CompletionClient, completion::Prompt, completion::ToolDefinition, tool::Tool};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Deserialize, Serialize)]
pub struct ConversationGetArgs {
    pub conversation_id: String,
    pub limit: Option<i64>,
    pub until_id: Option<String>,
    pub prompt: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConversationGetError(String);

#[derive(Clone)]
pub struct ConversationGetTool {
    db_path: PathBuf,
    resolved: Arc<ResolvedModel>,
}

impl ConversationGetTool {
    pub fn new(db_path: PathBuf, resolved: Arc<ResolvedModel>) -> Self {
        Self { db_path, resolved }
    }

    async fn call_llm(&self, system: &str, user: String) -> anyhow::Result<String> {
        use rig::client::Nothing;

        let result = match self.resolved.provider.as_str() {
            "openrouter" => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no OpenRouter API key"))?;
                let agent = openrouter::Client::new(key)?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build();
                agent
                    .prompt(user)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
            }
            "openai" => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no OpenAI API key"))?;
                let agent = openai::CompletionsClient::builder()
                    .api_key(key)
                    .build()?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build();
                agent
                    .prompt(user)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
            }
            "ollama" => {
                let mut builder = ollama::Client::builder().api_key(Nothing);
                if let Some(url) = self.resolved.base_url.as_deref() {
                    builder = builder.base_url(url);
                }
                let agent = builder
                    .build()?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build();
                agent
                    .prompt(user)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
            }
            _ => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no Anthropic API key"))?;
                let agent = anthropic::Client::new(key)?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build();
                agent
                    .prompt(user)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
            }
        };

        Ok(result)
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
                    },
                    "until_id": {
                        "type": "string",
                        "description": "Stop before the message with this event ID or record ID (exclusive). Useful for reading a conversation slice."
                    },
                    "prompt": {
                        "type": "string",
                        "description": "If provided, analyze the conversation transcript with this prompt using an LLM and return the analysis instead of the raw transcript."
                    }
                },
                "required": ["conversation_id"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let messages: Vec<(String, String, String, String)> = {
            let conn = Connection::open(&self.db_path)
                .map_err(|e| ConversationGetError(format!("failed to open database: {e}")))?;

            let mut stmt = conn
                .prepare(
                    "SELECT id, author_pubkey, message_type, content \
                     FROM messages \
                     WHERE conversation_id = ? \
                     ORDER BY sequence ASC"
                )
                .map_err(|e| ConversationGetError(format!("failed to prepare statement: {e}")))?;

            let rows = stmt
                .query_map([&args.conversation_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| ConversationGetError(format!("failed to query messages: {e}")))?;

            let mut result = Vec::new();
            for row in rows {
                result.push(row.map_err(|e| ConversationGetError(format!("failed to get row: {e}")))?);
            }
            result
        };

        if messages.is_empty() {
            return Ok(format!(
                "No messages found for conversation {}",
                &args.conversation_id[..8.min(args.conversation_id.len())]
            ));
        }

        let limit = args.limit.unwrap_or(i64::MAX) as usize;
        let mut filtered_messages: Vec<_> = messages.iter().take(limit).collect();

        if let Some(uid) = args.until_id.as_deref() {
            if let Some(idx) = filtered_messages
                .iter()
                .position(|(id, _, _, _)| id == uid)
            {
                filtered_messages.truncate(idx);
            }
        }

        if filtered_messages.is_empty() {
            return Ok(format!(
                "No messages found for conversation {}",
                &args.conversation_id[..8.min(args.conversation_id.len())]
            ));
        }

        let mut lines = vec![format!(
            "Conversation {} ({} messages):",
            &args.conversation_id[..8.min(args.conversation_id.len())],
            filtered_messages.len()
        )];

        for (_, author, msg_type, content) in filtered_messages {
            let author_short = &author[..8.min(author.len())];
            lines.push(format!("[{msg_type}] {author_short}: {content}"));
        }

        let transcript = lines.join("\n");

        if let Some(p) = args.prompt {
            let system = "You are analyzing a conversation transcript. Answer concisely based only on the transcript provided.";
            let user = format!("<transcript>\n{transcript}\n</transcript>\n\n{p}");
            return self
                .call_llm(system, user)
                .await
                .map_err(|e| ConversationGetError(format!("LLM call failed: {e}")));
        }

        Ok(transcript)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conversation_get_tool_creation() {
        let db_path = PathBuf::from("/home/user/.tenex/projects/myproject/conversation.db");
        let resolved = Arc::new(ResolvedModel {
            provider: "anthropic".to_string(),
            model: "claude-3-sonnet".to_string(),
            api_key: None,
            base_url: None,
        });
        let tool = ConversationGetTool::new(db_path.clone(), resolved);
        assert_eq!(tool.db_path, db_path);
    }
}
