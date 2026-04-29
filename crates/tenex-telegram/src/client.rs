use anyhow::{Context, Result};
use serde::Serialize;

use crate::types::{
    parse_response, TelegramBotCommand, TelegramBotInfo, TelegramChatInfo,
    TelegramChatMemberAdministrator, TelegramForumTopic, TelegramMessage, TelegramUpdate,
};

#[derive(Clone)]
pub struct BotClient {
    token: String,
    base_url: String,
    http: reqwest::Client,
}

impl BotClient {
    pub fn new(token: String, api_base_url: Option<String>) -> Self {
        let base_url = api_base_url
            .as_deref()
            .unwrap_or("https://api.telegram.org")
            .trim_end_matches('/')
            .to_string();
        Self {
            token,
            base_url,
            http: reqwest::Client::new(),
        }
    }

    fn url(&self, method: &str) -> String {
        format!("{}/bot{}/{}", self.base_url, self.token, method)
    }

    pub async fn get_me(&self) -> Result<TelegramBotInfo> {
        let resp = self
            .http
            .get(self.url("getMe"))
            .send()
            .await
            .context("getMe request")?;
        let body = resp.text().await.context("getMe body")?;
        parse_response::<TelegramBotInfo>(&body).context("getMe parse")
    }

    pub async fn set_my_commands(&self, commands: &[TelegramBotCommand]) -> Result<()> {
        #[derive(Serialize)]
        struct Payload<'a> {
            commands: &'a [TelegramBotCommand],
        }
        let resp = self
            .http
            .post(self.url("setMyCommands"))
            .json(&Payload { commands })
            .send()
            .await
            .context("setMyCommands request")?;
        let body = resp.text().await.context("setMyCommands body")?;
        parse_response::<bool>(&body).context("setMyCommands parse")?;
        Ok(())
    }

    pub async fn get_updates(
        &self,
        offset: Option<i64>,
        timeout_seconds: u64,
        limit: u32,
    ) -> Result<Vec<TelegramUpdate>> {
        let mut params = vec![
            ("timeout", timeout_seconds.to_string()),
            ("limit", limit.to_string()),
        ];
        if let Some(off) = offset {
            params.push(("offset", off.to_string()));
        }
        let resp = self
            .http
            .get(self.url("getUpdates"))
            .query(&params)
            .timeout(std::time::Duration::from_secs(timeout_seconds + 5))
            .send()
            .await
            .context("getUpdates request")?;
        let body = resp.text().await.context("getUpdates body")?;
        parse_response::<Vec<TelegramUpdate>>(&body).context("getUpdates parse")
    }

    pub async fn send_message(
        &self,
        chat_id: &str,
        text: &str,
        parse_mode: Option<&str>,
        reply_to_message_id: Option<&str>,
        message_thread_id: Option<&str>,
    ) -> Result<TelegramMessage> {
        #[derive(Serialize)]
        struct Payload<'a> {
            chat_id: &'a str,
            text: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            parse_mode: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            reply_to_message_id: Option<i64>,
            #[serde(skip_serializing_if = "Option::is_none")]
            message_thread_id: Option<i64>,
            allow_sending_without_reply: bool,
        }
        let reply_id = reply_to_message_id.and_then(|s| s.parse::<i64>().ok());
        let thread_id = message_thread_id.and_then(|s| s.parse::<i64>().ok());

        let resp = self
            .http
            .post(self.url("sendMessage"))
            .json(&Payload {
                chat_id,
                text,
                parse_mode,
                reply_to_message_id: reply_id,
                message_thread_id: thread_id,
                allow_sending_without_reply: true,
            })
            .send()
            .await
            .context("sendMessage request")?;
        let body = resp.text().await.context("sendMessage body")?;
        parse_response::<TelegramMessage>(&body).context("sendMessage parse")
    }

    /// Send a chat action (e.g. `"typing"`). The Bot API surface returns the
    /// indicator for ~5 seconds; callers that want it visible longer must
    /// re-send periodically.
    pub async fn send_chat_action(
        &self,
        chat_id: &str,
        action: &str,
        message_thread_id: Option<&str>,
    ) -> Result<()> {
        #[derive(Serialize)]
        struct Payload<'a> {
            chat_id: &'a str,
            action: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            message_thread_id: Option<i64>,
        }
        let thread_id = message_thread_id.and_then(|s| s.parse::<i64>().ok());
        let resp = self
            .http
            .post(self.url("sendChatAction"))
            .json(&Payload {
                chat_id,
                action,
                message_thread_id: thread_id,
            })
            .send()
            .await
            .context("sendChatAction request")?;
        let body = resp.text().await.context("sendChatAction body")?;
        parse_response::<bool>(&body).context("sendChatAction parse")?;
        Ok(())
    }

    pub async fn send_voice(
        &self,
        chat_id: &str,
        voice_path: &str,
        reply_to_message_id: Option<&str>,
        message_thread_id: Option<&str>,
    ) -> Result<TelegramMessage> {
        let file_bytes = tokio::fs::read(voice_path)
            .await
            .with_context(|| format!("read voice file {voice_path}"))?;
        let file_name = std::path::Path::new(voice_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("voice.ogg")
            .to_string();
        let mime = detect_voice_mime(voice_path);

        let part = reqwest::multipart::Part::bytes(file_bytes)
            .file_name(file_name)
            .mime_str(mime)?;
        let mut form = reqwest::multipart::Form::new()
            .text("chat_id", chat_id.to_string())
            .text("allow_sending_without_reply", "true")
            .part("voice", part);
        if let Some(rid) = reply_to_message_id {
            form = form.text("reply_to_message_id", rid.to_string());
        }
        if let Some(tid) = message_thread_id {
            form = form.text("message_thread_id", tid.to_string());
        }

        let resp = self
            .http
            .post(self.url("sendVoice"))
            .multipart(form)
            .send()
            .await
            .context("sendVoice request")?;
        let body = resp.text().await.context("sendVoice body")?;
        parse_response::<TelegramMessage>(&body).context("sendVoice parse")
    }

    /// Fetch full chat info via `getChat`.
    ///
    /// Works for groups, supergroups, channels, and private chats.
    pub async fn get_chat(&self, chat_id: &str) -> Result<TelegramChatInfo> {
        let resp = self
            .http
            .get(self.url("getChat"))
            .query(&[("chat_id", chat_id)])
            .send()
            .await
            .context("getChat request")?;
        let body = resp.text().await.context("getChat body")?;
        parse_response::<TelegramChatInfo>(&body).context("getChat parse")
    }

    /// Fetch the list of administrators for a group/supergroup/channel via
    /// `getChatAdministrators`. Not valid for private chats.
    pub async fn get_chat_administrators(
        &self,
        chat_id: &str,
    ) -> Result<Vec<TelegramChatMemberAdministrator>> {
        let resp = self
            .http
            .get(self.url("getChatAdministrators"))
            .query(&[("chat_id", chat_id)])
            .send()
            .await
            .context("getChatAdministrators request")?;
        let body = resp.text().await.context("getChatAdministrators body")?;
        parse_response::<Vec<TelegramChatMemberAdministrator>>(&body)
            .context("getChatAdministrators parse")
    }

    /// Fetch the member count for a group/supergroup/channel via
    /// `getChatMemberCount`. Not valid for private chats.
    pub async fn get_chat_member_count(&self, chat_id: &str) -> Result<i64> {
        let resp = self
            .http
            .get(self.url("getChatMemberCount"))
            .query(&[("chat_id", chat_id)])
            .send()
            .await
            .context("getChatMemberCount request")?;
        let body = resp.text().await.context("getChatMemberCount body")?;
        parse_response::<i64>(&body).context("getChatMemberCount parse")
    }

    /// Fetch forum topic metadata via `getForumTopicInfo`.
    ///
    /// Requires the bot to have `can_manage_topics` permission. Returns an
    /// error if the bot lacks that permission — callers must handle gracefully.
    pub async fn get_forum_topic_info(
        &self,
        chat_id: &str,
        message_thread_id: &str,
    ) -> Result<TelegramForumTopic> {
        let resp = self
            .http
            .get(self.url("getForumTopicInfo"))
            .query(&[
                ("chat_id", chat_id),
                ("message_thread_id", message_thread_id),
            ])
            .send()
            .await
            .context("getForumTopicInfo request")?;
        let body = resp.text().await.context("getForumTopicInfo body")?;
        parse_response::<TelegramForumTopic>(&body).context("getForumTopicInfo parse")
    }

    /// URL to download a file previously obtained via getFile.
    pub fn file_download_url(&self, file_path: &str) -> String {
        format!("{}/file/bot{}/{}", self.base_url, self.token, file_path)
    }
}

fn detect_voice_mime(path: &str) -> &'static str {
    match std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "ogg" | "oga" | "opus" => "audio/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        _ => "application/octet-stream",
    }
}
