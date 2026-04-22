//! Synchronous Telegram Bot API client used by the outbox drainer.
//!
//! The Rust daemon is entirely synchronous today, and the
//! [`crate::telegram_outbox::TelegramDeliveryPublisher`] trait is a blocking
//! `fn(&mut self, &TelegramOutboxRecord) -> TelegramDeliveryResult`. This
//! client therefore uses `reqwest::blocking` and owns a single shared
//! [`reqwest::blocking::Client`] per instance.
//!
//! Behavior oracle: `src/services/telegram/TelegramBotClient.ts` (the request
//! shape, URL layout, parse_mode handling, multipart upload for voice, and
//! the response envelope parsing `{ ok, result, description }`) and the
//! HTML/plain fallback in `src/services/telegram/TelegramDeliveryService.ts`.
//!
//! This module implements only the Bot API methods the Rust adapter actually
//! consumes across Slices 2-5:
//!
//! | method                          | consumer slice |
//! |---------------------------------|----------------|
//! | [`TelegramBotClient::send_message`]           | Slice 2        |
//! | [`TelegramBotClient::send_voice`]             | Slice 2        |
//! | [`TelegramBotClient::get_me`]                 | Slice 4 / 5    |
//! | [`TelegramBotClient::get_updates`]            | Slice 4        |
//! | [`TelegramBotClient::get_chat`]               | Slice 3        |
//! | [`TelegramBotClient::get_chat_administrators`]| Slice 3        |
//! | [`TelegramBotClient::get_chat_member_count`]  | Slice 3        |
//! | [`TelegramBotClient::get_forum_topic`]        | Slice 3        |
//! | [`TelegramBotClient::get_forum_topic_icon_stickers`] | Slice 3 |
//!
//! The methods are implemented here so later slices do not have to widen the
//! client surface in churn. They are however exercised only to the extent
//! that Slice 2's outbox drainer needs (send_message + send_voice); the rest
//! are validated through focused unit tests.
//!
//! Error mapping: `ApiError` cases are classified into the existing
//! [`crate::telegram_outbox::TelegramErrorClass`] through
//! [`TelegramClientError::classify`] so the publisher layer does not need to
//! interpret Bot API descriptions itself.

use std::path::PathBuf;
use std::time::Duration;

use reqwest::blocking::{Client, multipart};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::telegram_outbox::TelegramErrorClass;

/// Default base URL for the public Bot API. Tests may override this to point
/// at a local mock.
pub const DEFAULT_TELEGRAM_API_BASE_URL: &str = "https://api.telegram.org";
/// Default request timeout: matches the TS client's default tolerance for
/// interactive Bot API calls (Telegram rarely exceeds 10 s) while keeping
/// long-poll callers free to override.
pub const DEFAULT_HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Configuration for [`TelegramBotClient`].
///
/// `bot_token` is the full token string (e.g. `12345:ABCDE...`). The client
/// never logs it; diagnostics use a short suffix only.
#[derive(Debug, Clone)]
pub struct TelegramBotClientConfig {
    pub bot_token: String,
    pub api_base_url: String,
    pub http_timeout: Duration,
}

impl TelegramBotClientConfig {
    pub fn new(bot_token: impl Into<String>) -> Self {
        Self {
            bot_token: bot_token.into(),
            api_base_url: DEFAULT_TELEGRAM_API_BASE_URL.to_string(),
            http_timeout: DEFAULT_HTTP_TIMEOUT,
        }
    }

    pub fn with_api_base_url(mut self, api_base_url: impl Into<String>) -> Self {
        self.api_base_url = api_base_url.into();
        self
    }

    pub fn with_http_timeout(mut self, http_timeout: Duration) -> Self {
        self.http_timeout = http_timeout;
        self
    }
}

/// Errors produced by the Bot API client. `ApiError` carries the raw
/// `description` so callers and diagnostics retain the Bot API's original
/// wording; [`TelegramClientError::classify`] turns them into the durable
/// [`TelegramErrorClass`] used by the outbox.
#[derive(Debug, Error)]
pub enum TelegramClientError {
    #[error("telegram network error: {0}")]
    Network(reqwest::Error),
    #[error("telegram request timeout")]
    Timeout,
    #[error("telegram HTTP error status {status}: {description}")]
    Http { status: u16, description: String },
    #[error("telegram API error {error_code}: {description}")]
    ApiError {
        error_code: i64,
        description: String,
        retry_after: Option<u64>,
    },
    #[error("telegram response serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("telegram voice source file missing: {0}")]
    MissingFile(PathBuf),
    #[error("telegram bot token rejected by Bot API")]
    InvalidToken,
    #[error("telegram HTML parse error: {0}")]
    HtmlParseError(String),
}

impl TelegramClientError {
    /// Map the client error to a durable [`TelegramErrorClass`] for the
    /// outbox. Retry-after (seconds) is surfaced alongside so the delivery
    /// publisher can hand it to the outbox record in the caller's native
    /// unit (milliseconds).
    pub fn classify(&self) -> ClassifiedError {
        match self {
            TelegramClientError::Network(error) => {
                if error.is_timeout() {
                    ClassifiedError::retryable(TelegramErrorClass::Timeout)
                } else {
                    ClassifiedError::retryable(TelegramErrorClass::Network)
                }
            }
            TelegramClientError::Timeout => ClassifiedError::retryable(TelegramErrorClass::Timeout),
            TelegramClientError::Http { status, .. } => {
                if *status >= 500 {
                    ClassifiedError::retryable(TelegramErrorClass::ServerError)
                } else if *status == 429 {
                    ClassifiedError::retryable(TelegramErrorClass::RateLimited)
                } else {
                    ClassifiedError::permanent(TelegramErrorClass::BadRequest)
                }
            }
            TelegramClientError::ApiError {
                error_code,
                description,
                retry_after,
            } => classify_api_error(*error_code, description, *retry_after),
            TelegramClientError::Serialization(_) => {
                ClassifiedError::permanent(TelegramErrorClass::Unknown)
            }
            TelegramClientError::MissingFile(_) => {
                ClassifiedError::permanent(TelegramErrorClass::BadRequest)
            }
            TelegramClientError::InvalidToken => {
                ClassifiedError::permanent(TelegramErrorClass::Unauthorized)
            }
            TelegramClientError::HtmlParseError(_) => {
                ClassifiedError::permanent(TelegramErrorClass::BadRequest)
            }
        }
    }

    /// Convenience: does this error represent a Bot API refusal to parse
    /// HTML entities, which the delivery layer treats as a signal to retry
    /// in plain text? Mirrors
    /// `TelegramDeliveryService.sendMessageWithHtmlRetry` in the TS oracle.
    pub fn is_html_parse_error(&self) -> bool {
        matches!(self, TelegramClientError::HtmlParseError(_))
    }
}

/// Convert a raw `description` string from the Bot API into a typed error
/// class. The matching rules mirror TS behavior observed in production:
///
/// - 401 / "Unauthorized" → permanent Unauthorized (token rejected)
/// - 403 "bot was blocked by the user" → permanent BotBlocked
/// - 403 "chat not found" / 400 "chat not found" → permanent ChatNotFound
/// - 429 with retry_after → retryable RateLimited
/// - 400 "can't parse entities" → the HtmlParseError sentinel (callers
///   should never reach here with the 400 mapping because the client
///   upgrades such errors to [`TelegramClientError::HtmlParseError`] before
///   classification; kept here as a defensive fallback)
/// - 5xx → retryable ServerError
fn classify_api_error(
    error_code: i64,
    description: &str,
    retry_after: Option<u64>,
) -> ClassifiedError {
    let lowered = description.to_ascii_lowercase();
    if error_code == 401 || lowered.contains("unauthorized") {
        return ClassifiedError::permanent(TelegramErrorClass::Unauthorized);
    }
    if lowered.contains("bot was blocked") {
        return ClassifiedError::permanent(TelegramErrorClass::BotBlocked);
    }
    if lowered.contains("chat not found") {
        return ClassifiedError::permanent(TelegramErrorClass::ChatNotFound);
    }
    if error_code == 429 {
        return ClassifiedError {
            class: TelegramErrorClass::RateLimited,
            retryable: true,
            retry_after_seconds: retry_after,
        };
    }
    if (500..600).contains(&error_code) {
        return ClassifiedError::retryable(TelegramErrorClass::ServerError);
    }
    if lowered.contains("can't parse entities") || lowered.contains("can't find end tag") {
        return ClassifiedError::permanent(TelegramErrorClass::BadRequest);
    }
    if error_code == 400 {
        return ClassifiedError::permanent(TelegramErrorClass::BadRequest);
    }
    ClassifiedError::permanent(TelegramErrorClass::Unknown)
}

/// Outcome of [`TelegramClientError::classify`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedError {
    pub class: TelegramErrorClass,
    pub retryable: bool,
    pub retry_after_seconds: Option<u64>,
}

impl ClassifiedError {
    fn retryable(class: TelegramErrorClass) -> Self {
        Self {
            class,
            retryable: true,
            retry_after_seconds: None,
        }
    }

    fn permanent(class: TelegramErrorClass) -> Self {
        Self {
            class,
            retryable: false,
            retry_after_seconds: None,
        }
    }
}

/// Bot API raw response envelope: `{ ok, result?, description?,
/// error_code?, parameters?.retry_after? }`.
#[derive(Debug, Clone, Deserialize)]
struct BotApiEnvelope<T> {
    ok: bool,
    result: Option<T>,
    description: Option<String>,
    error_code: Option<i64>,
    parameters: Option<BotApiResponseParameters>,
}

#[derive(Debug, Clone, Deserialize)]
struct BotApiResponseParameters {
    #[serde(default)]
    retry_after: Option<u64>,
}

/// Typed `chat_id` value. Telegram chat IDs are signed 64-bit integers for
/// supergroups/channels/DMs and string `@username` for public chats. The
/// client accepts either shape without stringifying numerics ad-hoc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatId {
    Numeric(i64),
    Username(String),
}

impl ChatId {
    fn serialize_value(&self) -> serde_json::Value {
        match self {
            ChatId::Numeric(id) => serde_json::Value::from(*id),
            ChatId::Username(name) => serde_json::Value::from(name.as_str()),
        }
    }

    fn as_form_string(&self) -> String {
        match self {
            ChatId::Numeric(id) => id.to_string(),
            ChatId::Username(name) => name.clone(),
        }
    }

    fn as_query_param(&self) -> String {
        self.as_form_string()
    }
}

impl From<i64> for ChatId {
    fn from(value: i64) -> Self {
        ChatId::Numeric(value)
    }
}

/// Input to [`TelegramBotClient::send_message`].
#[derive(Debug, Clone)]
pub struct SendMessageParams {
    pub chat_id: ChatId,
    pub text: String,
    pub parse_mode: Option<ParseMode>,
    pub reply_to_message_id: Option<i64>,
    pub message_thread_id: Option<i64>,
    pub disable_link_preview: bool,
}

/// Input to [`TelegramBotClient::send_voice`]. The voice file must be a
/// local, absolute path; the delivery publisher validates this before
/// calling the client.
#[derive(Debug, Clone)]
pub struct SendVoiceParams {
    pub chat_id: ChatId,
    pub voice_path: PathBuf,
    pub reply_to_message_id: Option<i64>,
    pub message_thread_id: Option<i64>,
    pub caption: Option<String>,
    pub parse_mode: Option<ParseMode>,
}

/// Input to [`TelegramBotClient::get_updates`].
#[derive(Debug, Clone, Default)]
pub struct GetUpdatesParams {
    pub offset: Option<i64>,
    pub timeout_seconds: Option<u64>,
    pub limit: Option<u32>,
    pub allowed_updates: Option<Vec<String>>,
}

/// Telegram HTML / MarkdownV2 parse modes the client is willing to send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ParseMode {
    #[serde(rename = "HTML")]
    Html,
    #[serde(rename = "MarkdownV2")]
    MarkdownV2,
}

impl ParseMode {
    fn as_str(self) -> &'static str {
        match self {
            ParseMode::Html => "HTML",
            ParseMode::MarkdownV2 => "MarkdownV2",
        }
    }
}

/// Subset of `TelegramMessage` the client exposes back. Downstream slices
/// that need full chat metadata can extend this with additive fields; the
/// existing fields are what the outbox publisher needs to record
/// `native_message_id` and the chat/thread it landed in.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SentMessage {
    pub message_id: i64,
    pub chat: SentChat,
    #[serde(default)]
    pub message_thread_id: Option<i64>,
    #[serde(default)]
    pub date: Option<i64>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub caption: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SentChat {
    pub id: i64,
    #[serde(rename = "type")]
    pub chat_type: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
}

/// Bot user as returned by `getMe`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BotUser {
    pub id: i64,
    pub is_bot: bool,
    pub first_name: String,
    #[serde(default)]
    pub username: Option<String>,
}

/// Full chat info as returned by `getChat`. Only fields Slice 3 needs for
/// chat-context metadata; additive expansion is fine.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Chat {
    pub id: i64,
    #[serde(rename = "type")]
    pub chat_type: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// One entry of `getChatAdministrators`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChatAdministrator {
    pub status: String,
    pub user: BotUser,
    #[serde(default)]
    pub custom_title: Option<String>,
}

/// Result of `getFile`. Telegram returns a relative `file_path`; the
/// client exposes [`TelegramBotClient::file_download_url`] to construct the
/// corresponding public download URL.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TelegramFile {
    #[serde(default)]
    pub file_id: Option<String>,
    #[serde(default)]
    pub file_unique_id: Option<String>,
    #[serde(default)]
    pub file_size: Option<i64>,
    /// Relative path under `/file/bot<token>/`. Always present in practice;
    /// we keep it `Option` to reflect the raw Bot API shape.
    #[serde(default)]
    pub file_path: Option<String>,
}

/// Result of `getForumTopic`. Slice 3 consumes `name` to populate
/// `TelegramTransportMetadata.topicTitle`; the other fields are surfaced for
/// completeness.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ForumTopic {
    pub message_thread_id: i64,
    pub name: String,
    #[serde(default)]
    pub icon_color: i64,
    #[serde(default)]
    pub icon_custom_emoji_id: Option<String>,
}

/// One entry of `getUpdates`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Update {
    pub update_id: i64,
    #[serde(default)]
    pub message: Option<serde_json::Value>,
    #[serde(default)]
    pub edited_message: Option<serde_json::Value>,
    #[serde(default)]
    pub callback_query: Option<serde_json::Value>,
}

/// Telegram Bot API client. Cheap to construct; call sites can share a
/// single instance per bot token across the crate.
#[derive(Debug, Clone)]
pub struct TelegramBotClient {
    config: TelegramBotClientConfig,
    http: Client,
}

impl TelegramBotClient {
    /// Construct a new client. The internal `reqwest::blocking::Client` is
    /// configured with the configured timeout and pooled connections.
    pub fn new(config: TelegramBotClientConfig) -> Result<Self, TelegramClientError> {
        let http = Client::builder()
            .timeout(config.http_timeout)
            .build()
            .map_err(TelegramClientError::Network)?;
        Ok(Self { config, http })
    }

    /// Construct a client from just a token, using the default API base URL
    /// and timeout. Intended for production use.
    pub fn from_bot_token(bot_token: impl Into<String>) -> Result<Self, TelegramClientError> {
        Self::new(TelegramBotClientConfig::new(bot_token))
    }

    fn url(&self, method: &str) -> String {
        let base = self.config.api_base_url.trim_end_matches('/');
        format!("{base}/bot{}/{method}", self.config.bot_token)
    }

    /// POST a JSON body and decode the Bot API envelope.
    fn post_json<T: for<'de> Deserialize<'de>>(
        &self,
        method: &str,
        body: &serde_json::Value,
    ) -> Result<T, TelegramClientError> {
        let response = self
            .http
            .post(self.url(method))
            .header("content-type", "application/json")
            .json(body)
            .send()
            .map_err(TelegramClientError::Network)?;
        decode_response(response)
    }

    /// GET with query parameters.
    fn get_query<T: for<'de> Deserialize<'de>>(
        &self,
        method: &str,
        query: &[(&str, String)],
    ) -> Result<T, TelegramClientError> {
        let response = self
            .http
            .get(self.url(method))
            .query(query)
            .send()
            .map_err(TelegramClientError::Network)?;
        decode_response(response)
    }

    /// POST a multipart body. Used by `send_voice`.
    fn post_multipart<T: for<'de> Deserialize<'de>>(
        &self,
        method: &str,
        form: multipart::Form,
    ) -> Result<T, TelegramClientError> {
        let response = self
            .http
            .post(self.url(method))
            .multipart(form)
            .send()
            .map_err(TelegramClientError::Network)?;
        decode_response(response)
    }

    pub fn get_me(&self) -> Result<BotUser, TelegramClientError> {
        self.get_query("getMe", &[])
    }

    pub fn send_message(
        &self,
        params: SendMessageParams,
    ) -> Result<SentMessage, TelegramClientError> {
        let mut body = serde_json::Map::new();
        body.insert("chat_id".to_string(), params.chat_id.serialize_value());
        body.insert(
            "text".to_string(),
            serde_json::Value::String(params.text.clone()),
        );
        body.insert("allow_sending_without_reply".to_string(), true.into());
        if let Some(parse_mode) = params.parse_mode {
            body.insert("parse_mode".to_string(), parse_mode.as_str().into());
        }
        if let Some(reply_to) = params.reply_to_message_id {
            body.insert("reply_to_message_id".to_string(), reply_to.into());
        }
        if let Some(thread_id) = params.message_thread_id {
            body.insert("message_thread_id".to_string(), thread_id.into());
        }
        if params.disable_link_preview {
            body.insert(
                "link_preview_options".to_string(),
                serde_json::json!({ "is_disabled": true }),
            );
        }

        let envelope: serde_json::Value = body.into();
        match self.post_json::<SentMessage>("sendMessage", &envelope) {
            Ok(result) => Ok(result),
            Err(error) => {
                // Upgrade HTML parse failures to a dedicated variant so the
                // delivery layer can cleanly pivot to a plain-text retry
                // without string-matching the raw description there.
                if params.parse_mode == Some(ParseMode::Html)
                    && let TelegramClientError::ApiError { description, .. } = &error
                    && is_html_parse_description(description)
                {
                    return Err(TelegramClientError::HtmlParseError(description.clone()));
                }
                Err(error)
            }
        }
    }

    pub fn send_voice(&self, params: SendVoiceParams) -> Result<SentMessage, TelegramClientError> {
        if !params.voice_path.is_absolute() {
            return Err(TelegramClientError::MissingFile(params.voice_path.clone()));
        }
        let file_name = params
            .voice_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("voice")
            .to_string();
        let mime = detect_voice_mime_type(&params.voice_path);
        let file_part = multipart::Part::file(&params.voice_path)
            .map_err(|_| TelegramClientError::MissingFile(params.voice_path.clone()))?
            .file_name(file_name)
            .mime_str(&mime)
            .map_err(TelegramClientError::Network)?;

        let mut form = multipart::Form::new()
            .text("chat_id", params.chat_id.as_form_string())
            .text("allow_sending_without_reply", "true")
            .part("voice", file_part);
        if let Some(reply_to) = params.reply_to_message_id {
            form = form.text("reply_to_message_id", reply_to.to_string());
        }
        if let Some(thread_id) = params.message_thread_id {
            form = form.text("message_thread_id", thread_id.to_string());
        }
        if let Some(caption) = params.caption {
            form = form.text("caption", caption);
        }
        if let Some(parse_mode) = params.parse_mode {
            form = form.text("parse_mode", parse_mode.as_str());
        }

        self.post_multipart::<SentMessage>("sendVoice", form)
    }

    pub fn get_updates(
        &self,
        params: GetUpdatesParams,
    ) -> Result<Vec<Update>, TelegramClientError> {
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(offset) = params.offset {
            query.push(("offset", offset.to_string()));
        }
        if let Some(timeout) = params.timeout_seconds {
            query.push(("timeout", timeout.to_string()));
        }
        if let Some(limit) = params.limit {
            query.push(("limit", limit.to_string()));
        }
        if let Some(allowed) = params.allowed_updates {
            let encoded = serde_json::to_string(&allowed)?;
            query.push(("allowed_updates", encoded));
        }
        self.get_query("getUpdates", &query)
    }

    pub fn get_chat(&self, chat_id: ChatId) -> Result<Chat, TelegramClientError> {
        self.get_query("getChat", &[("chat_id", chat_id.as_query_param())])
    }

    pub fn get_chat_administrators(
        &self,
        chat_id: ChatId,
    ) -> Result<Vec<ChatAdministrator>, TelegramClientError> {
        self.get_query(
            "getChatAdministrators",
            &[("chat_id", chat_id.as_query_param())],
        )
    }

    pub fn get_chat_member_count(&self, chat_id: ChatId) -> Result<i64, TelegramClientError> {
        self.get_query(
            "getChatMemberCount",
            &[("chat_id", chat_id.as_query_param())],
        )
    }

    pub fn get_forum_topic_icon_stickers(
        &self,
    ) -> Result<Vec<serde_json::Value>, TelegramClientError> {
        self.get_query("getForumTopicIconStickers", &[])
    }

    /// Call `getFile` with a `file_id` and return the full [`TelegramFile`].
    /// The `file_path` field is what [`TelegramBotClient::file_download_url`]
    /// needs to produce the actual download URL.
    pub fn get_file(&self, file_id: &str) -> Result<TelegramFile, TelegramClientError> {
        self.get_query("getFile", &[("file_id", file_id.to_string())])
    }

    /// Build the public download URL for a given `file_path` returned by
    /// `getFile`. Mirrors `TelegramBotClient.getFileDownloadUrl` in TS.
    pub fn file_download_url(&self, file_path: &str) -> String {
        let base = self.config.api_base_url.trim_end_matches('/');
        format!("{base}/file/bot{}/{file_path}", self.config.bot_token)
    }

    /// GET a file by absolute URL, writing the response body to `target` via
    /// a streaming copy. The caller is responsible for creating any parent
    /// directories before invoking this function.
    pub fn download_file_to(
        &self,
        download_url: &str,
        target: &std::path::Path,
    ) -> Result<u64, TelegramClientError> {
        let mut response = self
            .http
            .get(download_url)
            .send()
            .map_err(TelegramClientError::Network)?;
        let status = response.status();
        if !status.is_success() {
            return Err(TelegramClientError::Http {
                status: status.as_u16(),
                description: format!("telegram file download failed: {status}"),
            });
        }
        let mut file =
            std::fs::File::create(target).map_err(|source| TelegramClientError::Http {
                status: 0,
                description: format!("create {}: {source}", target.display()),
            })?;
        let bytes = response
            .copy_to(&mut file)
            .map_err(TelegramClientError::Network)?;
        file.sync_all()
            .map_err(|source| TelegramClientError::Http {
                status: 0,
                description: format!("sync {}: {source}", target.display()),
            })?;
        Ok(bytes)
    }

    /// Fetch the metadata of a single forum topic (supergroup + topic id).
    pub fn get_forum_topic(
        &self,
        chat_id: ChatId,
        message_thread_id: i64,
    ) -> Result<ForumTopic, TelegramClientError> {
        self.get_query(
            "getForumTopic",
            &[
                ("chat_id", chat_id.as_query_param()),
                ("message_thread_id", message_thread_id.to_string()),
            ],
        )
    }
}

fn detect_voice_mime_type(path: &std::path::Path) -> String {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("ogg") | Some("oga") | Some("opus") => "audio/ogg".to_string(),
        Some("mp3") => "audio/mpeg".to_string(),
        Some("m4a") => "audio/mp4".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn is_html_parse_description(description: &str) -> bool {
    let lowered = description.to_ascii_lowercase();
    lowered.contains("can't parse entities") || lowered.contains("can't find end tag")
}

fn decode_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::blocking::Response,
) -> Result<T, TelegramClientError> {
    let status = response.status();
    let headers: HeaderMap = response.headers().clone();
    let body = response.text().map_err(TelegramClientError::Network)?;

    let envelope: Option<BotApiEnvelope<T>> = if body.is_empty() {
        None
    } else {
        serde_json::from_str::<BotApiEnvelope<T>>(&body).ok()
    };

    if !status.is_success() {
        let description = envelope
            .as_ref()
            .and_then(|env| env.description.clone())
            .unwrap_or_else(|| body.clone());
        let retry_after = envelope
            .as_ref()
            .and_then(|env| env.parameters.as_ref())
            .and_then(|params| params.retry_after)
            .or_else(|| parse_retry_after_header(&headers));
        let error_code = envelope
            .as_ref()
            .and_then(|env| env.error_code)
            .unwrap_or(status.as_u16() as i64);
        if status.as_u16() == 401 {
            return Err(TelegramClientError::InvalidToken);
        }
        return Err(TelegramClientError::ApiError {
            error_code,
            description,
            retry_after,
        });
    }

    let Some(envelope) = envelope else {
        return Err(TelegramClientError::Http {
            status: status.as_u16(),
            description: "Telegram Bot API returned a non-JSON response".to_string(),
        });
    };

    if !envelope.ok {
        let description = envelope
            .description
            .unwrap_or_else(|| "Telegram Bot API returned ok=false".to_string());
        let retry_after = envelope
            .parameters
            .as_ref()
            .and_then(|params| params.retry_after);
        let error_code = envelope.error_code.unwrap_or(0);
        if error_code == 401 || description.to_ascii_lowercase().contains("unauthorized") {
            return Err(TelegramClientError::InvalidToken);
        }
        return Err(TelegramClientError::ApiError {
            error_code,
            description,
            retry_after,
        });
    }

    envelope.result.ok_or_else(|| TelegramClientError::Http {
        status: status.as_u16(),
        description: "Bot API ok=true but no result".to_string(),
    })
}

fn parse_retry_after_header(headers: &HeaderMap) -> Option<u64> {
    let header: &HeaderValue = headers.get("retry-after")?;
    header.to_str().ok()?.trim().parse::<u64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};

    /// Minimal one-shot HTTP mock. Returns the configured response for the
    /// first request, captures the body/path for assertions, then exits.
    struct MockHttpServer {
        url: String,
        captured: Arc<Mutex<Option<CapturedRequest>>>,
        handle: Option<JoinHandle<()>>,
    }

    #[derive(Debug, Clone)]
    struct CapturedRequest {
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl MockHttpServer {
        fn start(status: u16, body: impl Into<String>) -> Self {
            Self::start_with_headers(status, body, Vec::new())
        }

        fn start_with_headers(
            status: u16,
            body: impl Into<String>,
            extra_headers: Vec<(String, String)>,
        ) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("mock http bind");
            let url = format!(
                "http://{}",
                listener.local_addr().expect("mock http local addr")
            );
            let captured: Arc<Mutex<Option<CapturedRequest>>> = Arc::new(Mutex::new(None));
            let captured_clone = captured.clone();
            let body_string: String = body.into();
            let handle = thread::spawn(move || {
                let (stream, _) = listener.accept().expect("mock accept");
                serve_one(stream, status, &body_string, &extra_headers, captured_clone);
            });
            Self {
                url,
                captured,
                handle: Some(handle),
            }
        }

        fn captured(&self) -> CapturedRequest {
            self.captured
                .lock()
                .expect("captured lock")
                .clone()
                .expect("no captured request")
        }

        fn join(&mut self) {
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    impl Drop for MockHttpServer {
        fn drop(&mut self) {
            self.join();
        }
    }

    fn serve_one(
        mut stream: std::net::TcpStream,
        status: u16,
        body: &str,
        extra_headers: &[(String, String)],
        captured: Arc<Mutex<Option<CapturedRequest>>>,
    ) {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));

        // Request line
        let mut request_line = String::new();
        reader.read_line(&mut request_line).expect("request line");
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("").to_string();

        // Headers
        let mut headers: Vec<(String, String)> = Vec::new();
        let mut content_length: usize = 0;
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).expect("header line");
            if n == 0 || line == "\r\n" || line == "\n" {
                break;
            }
            let line = line.trim_end().to_string();
            if let Some((name, value)) = line.split_once(':') {
                let name = name.trim().to_ascii_lowercase();
                let value = value.trim().to_string();
                if name == "content-length" {
                    content_length = value.parse().unwrap_or(0);
                }
                headers.push((name, value));
            }
        }

        // Body
        let mut body_bytes = vec![0u8; content_length];
        if content_length > 0 {
            reader.read_exact(&mut body_bytes).expect("read body");
        }

        *captured.lock().expect("captured lock") = Some(CapturedRequest {
            method,
            path,
            headers,
            body: body_bytes,
        });

        // Response
        let status_text = match status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            429 => "Too Many Requests",
            500 => "Internal Server Error",
            503 => "Service Unavailable",
            _ => "OK",
        };
        let mut response = format!(
            "HTTP/1.1 {status} {status_text}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n",
            body.len()
        );
        for (name, value) in extra_headers {
            response.push_str(&format!("{name}: {value}\r\n"));
        }
        response.push_str("\r\n");
        stream.write_all(response.as_bytes()).expect("write status");
        stream.write_all(body.as_bytes()).expect("write body");
        stream.flush().expect("flush");
    }

    fn client_for(url: &str) -> TelegramBotClient {
        let config = TelegramBotClientConfig::new("TESTTOKEN").with_api_base_url(url);
        TelegramBotClient::new(config).expect("client")
    }

    #[test]
    fn send_message_html_encodes_html_parse_mode() {
        let body = serde_json::json!({
            "ok": true,
            "result": {
                "message_id": 4242,
                "chat": { "id": -1001, "type": "supergroup" },
                "message_thread_id": 7
            }
        })
        .to_string();
        let server = MockHttpServer::start(200, body);
        let client = client_for(&server.url);

        let sent = client
            .send_message(SendMessageParams {
                chat_id: ChatId::Numeric(-1001),
                text: "<b>hello</b>".to_string(),
                parse_mode: Some(ParseMode::Html),
                reply_to_message_id: Some(42),
                message_thread_id: Some(7),
                disable_link_preview: true,
            })
            .expect("send_message succeeds");

        assert_eq!(sent.message_id, 4242);
        assert_eq!(sent.chat.id, -1001);
        assert_eq!(sent.message_thread_id, Some(7));

        let captured = server.captured();
        assert_eq!(captured.method, "POST");
        assert!(captured.path.contains("/botTESTTOKEN/sendMessage"));
        let body_str = String::from_utf8(captured.body).expect("utf8 body");
        assert!(body_str.contains("\"chat_id\":-1001"));
        assert!(body_str.contains("\"parse_mode\":\"HTML\""));
        assert!(body_str.contains("\"reply_to_message_id\":42"));
        assert!(body_str.contains("\"message_thread_id\":7"));
        assert!(body_str.contains("\"link_preview_options\":{\"is_disabled\":true}"));
        assert!(body_str.contains("\"allow_sending_without_reply\":true"));
    }

    #[test]
    fn send_message_plain_omits_parse_mode() {
        let body = serde_json::json!({
            "ok": true,
            "result": {
                "message_id": 1,
                "chat": { "id": 99, "type": "private" }
            }
        })
        .to_string();
        let server = MockHttpServer::start(200, body);
        let client = client_for(&server.url);

        client
            .send_message(SendMessageParams {
                chat_id: ChatId::Numeric(99),
                text: "plain".to_string(),
                parse_mode: None,
                reply_to_message_id: None,
                message_thread_id: None,
                disable_link_preview: false,
            })
            .expect("plain send_message");
        let body_str = String::from_utf8(server.captured().body).unwrap();
        assert!(!body_str.contains("parse_mode"));
        assert!(!body_str.contains("link_preview_options"));
        assert!(!body_str.contains("reply_to_message_id"));
    }

    #[test]
    fn send_message_surfaces_html_parse_error() {
        let body = serde_json::json!({
            "ok": false,
            "error_code": 400,
            "description": "Bad Request: can't parse entities: unclosed tag at byte offset 17"
        })
        .to_string();
        let server = MockHttpServer::start(400, body);
        let client = client_for(&server.url);

        let error = client
            .send_message(SendMessageParams {
                chat_id: ChatId::Numeric(-1001),
                text: "<b>broken".to_string(),
                parse_mode: Some(ParseMode::Html),
                reply_to_message_id: None,
                message_thread_id: None,
                disable_link_preview: false,
            })
            .expect_err("html parse rejection");
        assert!(
            matches!(error, TelegramClientError::HtmlParseError(ref d) if d.contains("can't parse entities")),
            "expected HtmlParseError, got {error:?}"
        );
    }

    #[test]
    fn send_message_rate_limited_includes_retry_after() {
        let body = serde_json::json!({
            "ok": false,
            "error_code": 429,
            "description": "Too Many Requests: retry after 30",
            "parameters": { "retry_after": 30 }
        })
        .to_string();
        let server = MockHttpServer::start(429, body);
        let client = client_for(&server.url);

        let error = client
            .send_message(SendMessageParams {
                chat_id: ChatId::Numeric(1),
                text: "hi".to_string(),
                parse_mode: None,
                reply_to_message_id: None,
                message_thread_id: None,
                disable_link_preview: false,
            })
            .expect_err("rate limited");
        match error {
            TelegramClientError::ApiError {
                error_code,
                retry_after,
                ..
            } => {
                assert_eq!(error_code, 429);
                assert_eq!(retry_after, Some(30));
            }
            other => panic!("expected ApiError, got {other:?}"),
        }
        let classified = error.classify();
        assert_eq!(classified.class, TelegramErrorClass::RateLimited);
        assert!(classified.retryable);
        assert_eq!(classified.retry_after_seconds, Some(30));
    }

    #[test]
    fn send_message_unauthorized_maps_to_invalid_token() {
        let body = serde_json::json!({
            "ok": false,
            "error_code": 401,
            "description": "Unauthorized"
        })
        .to_string();
        let server = MockHttpServer::start(401, body);
        let client = client_for(&server.url);

        let error = client
            .send_message(SendMessageParams {
                chat_id: ChatId::Numeric(1),
                text: "hi".to_string(),
                parse_mode: None,
                reply_to_message_id: None,
                message_thread_id: None,
                disable_link_preview: false,
            })
            .expect_err("unauthorized");
        assert!(matches!(error, TelegramClientError::InvalidToken));
        let classified = error.classify();
        assert_eq!(classified.class, TelegramErrorClass::Unauthorized);
        assert!(!classified.retryable);
    }

    #[test]
    fn send_message_chat_not_found_is_permanent() {
        let body = serde_json::json!({
            "ok": false,
            "error_code": 400,
            "description": "Bad Request: chat not found"
        })
        .to_string();
        let server = MockHttpServer::start(400, body);
        let client = client_for(&server.url);

        let error = client
            .send_message(SendMessageParams {
                chat_id: ChatId::Numeric(1),
                text: "hi".to_string(),
                parse_mode: None,
                reply_to_message_id: None,
                message_thread_id: None,
                disable_link_preview: false,
            })
            .expect_err("chat not found");
        let classified = error.classify();
        assert_eq!(classified.class, TelegramErrorClass::ChatNotFound);
        assert!(!classified.retryable);
    }

    #[test]
    fn send_message_bot_blocked_is_permanent() {
        let body = serde_json::json!({
            "ok": false,
            "error_code": 403,
            "description": "Forbidden: bot was blocked by the user"
        })
        .to_string();
        let server = MockHttpServer::start(403, body);
        let client = client_for(&server.url);

        let error = client
            .send_message(SendMessageParams {
                chat_id: ChatId::Numeric(1),
                text: "hi".to_string(),
                parse_mode: None,
                reply_to_message_id: None,
                message_thread_id: None,
                disable_link_preview: false,
            })
            .expect_err("bot blocked");
        let classified = error.classify();
        assert_eq!(classified.class, TelegramErrorClass::BotBlocked);
        assert!(!classified.retryable);
    }

    #[test]
    fn send_message_server_error_is_retryable() {
        let body = serde_json::json!({
            "ok": false,
            "error_code": 503,
            "description": "Service Unavailable"
        })
        .to_string();
        let server = MockHttpServer::start(503, body);
        let client = client_for(&server.url);

        let error = client
            .send_message(SendMessageParams {
                chat_id: ChatId::Numeric(1),
                text: "hi".to_string(),
                parse_mode: None,
                reply_to_message_id: None,
                message_thread_id: None,
                disable_link_preview: false,
            })
            .expect_err("server error");
        let classified = error.classify();
        assert_eq!(classified.class, TelegramErrorClass::ServerError);
        assert!(classified.retryable);
    }

    #[test]
    fn send_voice_multipart_upload_includes_expected_fields() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let voice_path = tempdir.path().join("sample.ogg");
        std::fs::write(&voice_path, b"OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00")
            .expect("voice write");
        let body = serde_json::json!({
            "ok": true,
            "result": {
                "message_id": 77,
                "chat": { "id": -500, "type": "group" }
            }
        })
        .to_string();
        let server = MockHttpServer::start(200, body);
        let client = client_for(&server.url);

        client
            .send_voice(SendVoiceParams {
                chat_id: ChatId::Numeric(-500),
                voice_path: voice_path.clone(),
                reply_to_message_id: Some(3),
                message_thread_id: Some(2),
                caption: Some("optional caption".to_string()),
                parse_mode: None,
            })
            .expect("send_voice success");

        let captured = server.captured();
        assert_eq!(captured.method, "POST");
        assert!(captured.path.contains("/botTESTTOKEN/sendVoice"));
        let content_type = captured
            .headers
            .iter()
            .find(|(name, _)| name == "content-type")
            .map(|(_, value)| value.clone())
            .expect("content-type header");
        assert!(content_type.starts_with("multipart/form-data"));

        let body_text = String::from_utf8_lossy(&captured.body).to_string();
        assert!(body_text.contains("name=\"chat_id\""));
        assert!(body_text.contains("-500"));
        assert!(body_text.contains("name=\"voice\""));
        assert!(body_text.contains("filename=\"sample.ogg\""));
        assert!(body_text.contains("name=\"reply_to_message_id\""));
        assert!(body_text.contains("3"));
        assert!(body_text.contains("name=\"message_thread_id\""));
        assert!(body_text.contains("name=\"caption\""));
        assert!(body_text.contains("optional caption"));
        assert!(body_text.contains("name=\"allow_sending_without_reply\""));
    }

    #[test]
    fn send_voice_rejects_relative_path_without_network() {
        let config =
            TelegramBotClientConfig::new("TESTTOKEN").with_api_base_url("http://127.0.0.1:1");
        let client = TelegramBotClient::new(config).expect("client");
        let error = client
            .send_voice(SendVoiceParams {
                chat_id: ChatId::Numeric(1),
                voice_path: PathBuf::from("relative/voice.ogg"),
                reply_to_message_id: None,
                message_thread_id: None,
                caption: None,
                parse_mode: None,
            })
            .expect_err("relative path rejected");
        assert!(matches!(error, TelegramClientError::MissingFile(_)));
    }

    #[test]
    fn get_me_decodes_bot_identity() {
        let body = serde_json::json!({
            "ok": true,
            "result": {
                "id": 12345,
                "is_bot": true,
                "first_name": "TenexBot",
                "username": "tenex_bot"
            }
        })
        .to_string();
        let server = MockHttpServer::start(200, body);
        let client = client_for(&server.url);

        let bot = client.get_me().expect("get_me");
        assert_eq!(bot.id, 12345);
        assert_eq!(bot.username.as_deref(), Some("tenex_bot"));
    }

    #[test]
    fn get_updates_encodes_allowed_updates_as_json() {
        let body = serde_json::json!({
            "ok": true,
            "result": []
        })
        .to_string();
        let server = MockHttpServer::start(200, body);
        let client = client_for(&server.url);

        client
            .get_updates(GetUpdatesParams {
                offset: Some(42),
                timeout_seconds: Some(25),
                limit: Some(100),
                allowed_updates: Some(vec!["message".into(), "edited_message".into()]),
            })
            .expect("get_updates");

        let captured = server.captured();
        assert!(captured.path.contains("offset=42"));
        assert!(captured.path.contains("timeout=25"));
        assert!(captured.path.contains("limit=100"));
        assert!(captured.path.contains("allowed_updates=") && captured.path.contains("message"));
    }

    #[test]
    fn network_timeout_maps_to_retryable_timeout() {
        // Bind to a port that we never answer on. A short timeout triggers
        // a reqwest timeout, which classifies as a retryable Timeout.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let url = format!("http://{addr}");

        let config = TelegramBotClientConfig::new("TESTTOKEN")
            .with_api_base_url(url)
            .with_http_timeout(Duration::from_millis(100));
        let client = TelegramBotClient::new(config).expect("client");
        let err = client
            .send_message(SendMessageParams {
                chat_id: ChatId::Numeric(1),
                text: "x".to_string(),
                parse_mode: None,
                reply_to_message_id: None,
                message_thread_id: None,
                disable_link_preview: false,
            })
            .expect_err("should time out");
        let classified = err.classify();
        assert!(classified.retryable);
        assert!(matches!(
            classified.class,
            TelegramErrorClass::Timeout | TelegramErrorClass::Network
        ));
        drop(listener);
    }

    #[test]
    fn classify_unknown_description_falls_back_to_unknown() {
        let error = TelegramClientError::ApiError {
            error_code: 0,
            description: "some surprise".to_string(),
            retry_after: None,
        };
        let classified = error.classify();
        assert_eq!(classified.class, TelegramErrorClass::Unknown);
        assert!(!classified.retryable);
    }
}
