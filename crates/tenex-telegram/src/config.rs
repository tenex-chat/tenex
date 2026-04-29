use serde::Deserialize;

/// Telegram configuration for a single agent, stored in the agent JSON file
/// under the `telegram` key.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramAgentConfig {
    pub bot_token: String,
    pub api_base_url: Option<String>,
    /// Allow direct messages (private chats). Defaults to true.
    pub allow_dms: Option<bool>,
    /// Allow group/supergroup messages. Defaults to true.
    pub allow_groups: Option<bool>,
    /// Send conversation-intent messages to Telegram. Defaults to false.
    pub publish_conversation_to_telegram: Option<bool>,
    /// Send reasoning messages to Telegram. Defaults to false.
    pub publish_reasoning_to_telegram: Option<bool>,
}

impl TelegramAgentConfig {
    pub fn allows_dms(&self) -> bool {
        self.allow_dms.unwrap_or(true)
    }

    pub fn allows_groups(&self) -> bool {
        self.allow_groups.unwrap_or(true)
    }
}

/// Parse a `TelegramAgentConfig` from the agent file's `telegram` JSON value.
pub fn parse_agent_config(json: &str) -> Option<TelegramAgentConfig> {
    serde_json::from_str(json).ok()
}
