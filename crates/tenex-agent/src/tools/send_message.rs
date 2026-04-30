use std::path::PathBuf;

use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tenex_telegram::{binding::BindingStore, client::BotClient};

#[derive(Debug, Deserialize, Serialize)]
pub struct SendMessageArgs {
    pub channel_id: String,
    pub content: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SendMessageError(String);

#[derive(Clone)]
pub struct SendMessageTool {
    bot_token: String,
    api_base_url: Option<String>,
    /// Path to the transport-bindings.json file.
    bindings_path: PathBuf,
    agent_pubkey: String,
    project_id: String,
}

impl SendMessageTool {
    pub fn new(
        bot_token: String,
        api_base_url: Option<String>,
        base_dir: PathBuf,
        agent_pubkey: String,
        project_id: String,
    ) -> Self {
        Self {
            bot_token,
            api_base_url,
            bindings_path: base_dir.join("data").join("transport-bindings.json"),
            agent_pubkey,
            project_id,
        }
    }
}

/// Parse a channel ID of the form:
/// - `telegram:chat:{chat_id}` → `(chat_id, None)`
/// - `telegram:group:{chat_id}:topic:{thread_id}` → `(chat_id, Some(thread_id))`
fn parse_channel_id(channel_id: &str) -> Option<(String, Option<String>)> {
    if !channel_id.starts_with("telegram:") {
        return None;
    }
    let parts: Vec<&str> = channel_id.split(':').collect();
    match parts.get(1).copied() {
        Some("chat") => parts.get(2).map(|id| (id.to_string(), None)),
        Some("group") => {
            let chat_id = parts.get(2)?.to_string();
            let thread_id = parts.get(4).map(|s| s.to_string());
            Some((chat_id, thread_id))
        }
        _ => None,
    }
}

/// Returns an error string if the chat/thread ID combination is invalid.
fn validate_target(chat_id: &str, thread_id: Option<&str>) -> Result<(), String> {
    let is_numeric = |s: &str| {
        let s = s.strip_prefix('-').unwrap_or(s);
        !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
    };

    if !is_numeric(chat_id) {
        return Err(format!("Invalid Telegram chat ID: {chat_id}"));
    }

    if let Some(tid) = thread_id {
        if tid.chars().any(|c| !c.is_ascii_digit()) {
            return Err(format!(
                "Invalid Telegram message thread ID: {tid}. Thread IDs must be numeric."
            ));
        }
        if !chat_id.starts_with('-') {
            return Err(format!(
                "Invalid Telegram message thread target: chat {chat_id} is not a group chat."
            ));
        }
    }

    Ok(())
}

impl Tool for SendMessageTool {
    const NAME: &'static str = "send_message";
    type Error = SendMessageError;
    type Args = SendMessageArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Send a proactive message to one of your bound Telegram channels. \
                Use the channel IDs from your channel bindings listed in the system prompt."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "channel_id": {
                        "type": "string",
                        "description": "The channel ID to send to (e.g. 'telegram:chat:123456789' or 'telegram:group:123456789:topic:456')"
                    },
                    "content": {
                        "type": "string",
                        "description": "The message content. Markdown is supported."
                    }
                },
                "required": ["channel_id", "content"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let (chat_id, thread_id) = parse_channel_id(&args.channel_id)
            .ok_or_else(|| SendMessageError(format!(
                "Invalid channel ID format: {}. Expected 'telegram:chat:<id>' or 'telegram:group:<id>:topic:<thread_id>'.",
                args.channel_id
            )))?;

        validate_target(&chat_id, thread_id.as_deref()).map_err(SendMessageError)?;

        let store = BindingStore::open(self.bindings_path.clone())
            .map_err(|e| SendMessageError(format!("open transport bindings store: {e:#}")))?;
        let binding = store
            .get_telegram(&self.agent_pubkey, &args.channel_id)
            .ok_or_else(|| {
                SendMessageError(format!(
                    "Channel {} is not in your remembered transport bindings.",
                    args.channel_id
                ))
            })?;

        if binding.project_id != self.project_id {
            return Err(SendMessageError(format!(
                "Channel {} is bound to project '{}', not the current project '{}'.",
                args.channel_id, binding.project_id, self.project_id
            )));
        }

        let client = BotClient::new(self.bot_token.clone(), self.api_base_url.clone());
        client
            .send_message(
                &chat_id,
                &args.content,
                Some("Markdown"),
                None,
                thread_id.as_deref(),
            )
            .await
            .map_err(|e| SendMessageError(format!("Telegram send failed: {e}")))?;

        Ok(format!("Message sent to channel {}.", args.channel_id))
    }
}
