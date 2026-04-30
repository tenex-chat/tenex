use serde::{Deserialize, Serialize};

/// Returned by `getChat` — superset of [`TelegramChat`] with full info.
#[derive(Debug, Clone, Deserialize)]
pub struct TelegramChatInfo {
    pub id: i64,
    #[serde(rename = "type")]
    pub chat_type: String,
    pub title: Option<String>,
    pub username: Option<String>,
}

/// One entry from `getChatAdministrators`.
#[derive(Debug, Clone, Deserialize)]
pub struct TelegramChatMemberAdministrator {
    /// `"administrator"` or `"creator"`.
    pub status: String,
    pub user: TelegramUser,
    pub custom_title: Option<String>,
}

/// Returned by `getForumTopic` / `getForumTopicInfo`.
///
/// Note: the Telegram Bot API method `getForumTopicInfo` requires the bot to
/// have `can_manage_topics` permission. This call will fail for bots without
/// that permission — the caller must handle the error gracefully.
#[derive(Debug, Clone, Deserialize)]
pub struct TelegramForumTopic {
    pub message_thread_id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramUpdate {
    pub update_id: i64,
    pub message: Option<TelegramMessage>,
    pub edited_message: Option<TelegramMessage>,
    pub callback_query: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramMessage {
    pub message_id: i64,
    pub from: Option<TelegramUser>,
    pub chat: TelegramChat,
    pub text: Option<String>,
    pub caption: Option<String>,
    pub voice: Option<TelegramVoice>,
    pub audio: Option<TelegramAudio>,
    pub photo: Option<Vec<TelegramPhotoSize>>,
    pub message_thread_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramPhotoSize {
    pub file_id: String,
    pub file_unique_id: String,
    pub width: i64,
    pub height: i64,
    pub file_size: Option<i64>,
}

/// Result of `getFile`. `file_path` is what we feed to `file_download_url`.
#[derive(Debug, Clone, Deserialize)]
pub struct TelegramFile {
    pub file_id: String,
    pub file_unique_id: String,
    pub file_size: Option<i64>,
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramUser {
    pub id: i64,
    pub is_bot: bool,
    pub first_name: String,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramChat {
    pub id: i64,
    #[serde(rename = "type")]
    pub chat_type: String,
    pub title: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramVoice {
    pub file_id: String,
    pub mime_type: Option<String>,
    pub duration: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramAudio {
    pub file_id: String,
    pub mime_type: Option<String>,
    pub duration: Option<i64>,
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramBotInfo {
    pub id: i64,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TelegramBotCommand {
    pub command: String,
    pub description: String,
}

#[derive(Debug, Deserialize)]
struct TelegramApiResponse<T> {
    ok: bool,
    description: Option<String>,
    result: Option<T>,
}

/// Extract the result from a Telegram API response body, returning an error if
/// `ok` is false or the response cannot be parsed.
pub fn parse_response<T: for<'de> Deserialize<'de>>(body: &str) -> anyhow::Result<T> {
    let resp: TelegramApiResponse<T> = serde_json::from_str(body)?;
    if !resp.ok {
        anyhow::bail!(
            "Telegram API error: {}",
            resp.description.as_deref().unwrap_or("unknown")
        );
    }
    resp.result
        .ok_or_else(|| anyhow::anyhow!("Telegram API returned ok=true but no result"))
}
