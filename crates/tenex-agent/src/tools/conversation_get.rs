use crate::config::ResolvedModel;
use rig::providers::{anthropic, ollama, openai, openrouter};
use rig::{client::CompletionClient, completion::Prompt, completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tenex_conversations::{store::MessageQuery, ConversationStore};

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
        let store = ConversationStore::open(&self.db_path)
            .map_err(|e| ConversationGetError(format!("failed to open conversation store: {e}")))?;

        let mut messages = store
            .list_messages(
                &args.conversation_id,
                MessageQuery {
                    limit: args.limit,
                    ..Default::default()
                },
            )
            .map_err(|e| ConversationGetError(format!("failed to list messages: {e}")))?;

        if let Some(uid) = args.until_id.as_deref() {
            if let Some(idx) = messages
                .iter()
                .position(|m| m.nostr_event_id.as_deref() == Some(uid) || m.record_id == uid)
            {
                messages.truncate(idx);
            }
        }

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
