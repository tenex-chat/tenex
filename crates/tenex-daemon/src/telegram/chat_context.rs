//! Durable per-chat Telegram context.
//!
//! Behavior oracle: `src/services/telegram/TelegramChatContextService.ts` and
//! `src/services/telegram/TelegramChatContextStoreService.ts`.
//!
//! Each chat (keyed by Telegram `chat_id`) gets a snapshot stamped with a
//! schema version, a writer identity, and atomic write/rename semantics. The
//! Rust inbound normalizer reads the snapshot to enrich
//! [`crate::inbound_envelope::TelegramTransportMetadata`] without calling the
//! Bot API on every message. A periodic TTL-gated refresh (matching the TS
//! service's `apiSyncTtlMs`) repopulates administrators, chat title/member
//! count and (for forum topics) the topic title.
//!
//! Storage layout:
//!
//! ```text
//! $TENEX_BASE_DIR/daemon/telegram/chat-context/
//!   <chat_id>.json
//!   tmp/
//!     <chat_id>.json.<pid>.<nanos>.tmp
//! ```
//!
//! `<chat_id>` is encoded by replacing a leading `-` with `n` (matching
//! `createTelegramNativeMessageId`'s segment normaliser) so file names stay
//! filesystem-safe. The `chatId` field inside the snapshot preserves the
//! original value verbatim.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::inbound_envelope::{
    TelegramChatAdministratorMetadata, TelegramChatType, TelegramSeenParticipantMetadata,
};
use crate::telegram::client::{ChatAdministrator, ChatId, TelegramBotClient, TelegramClientError};

pub const TELEGRAM_CHAT_CONTEXT_SCHEMA_VERSION: u32 = 1;
pub const TELEGRAM_CHAT_CONTEXT_WRITER: &str = "tenex-daemon";
/// TS oracle `DEFAULT_API_SYNC_TTL_MS` = 5 minutes.
pub const DEFAULT_API_SYNC_TTL_MS: u64 = 5 * 60 * 1000;
/// TS oracle `MAX_SEEN_PARTICIPANTS` = 25.
pub const MAX_SEEN_PARTICIPANTS: usize = 25;

const DIR_NAME: &str = "telegram/chat-context";
const TMP_SUBDIR: &str = "tmp";

#[derive(Debug, Error)]
pub enum ChatContextError {
    #[error("chat context io error: {0}")]
    Io(#[from] io::Error),
    #[error("chat context json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("chat context schema version {found} is not supported (expected {expected})")]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
    #[error("chat context writer must not be empty")]
    MissingWriter,
    #[error("chat context writerVersion must not be empty")]
    MissingWriterVersion,
    #[error("chat context chatId must not be empty")]
    MissingChatId,
    #[error("chat context updatedAt must be non-zero")]
    InvalidUpdatedAt,
    #[error("chat context api refresh failed: {0}")]
    ApiRefresh(#[from] TelegramClientError),
}

pub type ChatContextResult<T> = Result<T, ChatContextError>;

/// Snapshot persisted to disk per chat. Mirrors
/// `TelegramChatContextRecord` on the TS side but stamps the daemon-owned
/// durable file with `schemaVersion`, `writer`, `writerVersion`, and
/// `createdAt`/`updatedAt`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContextSnapshot {
    pub schema_version: u32,
    pub writer: String,
    pub writer_version: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub chat_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_type: Option<TelegramChatType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_count: Option<u64>,
    #[serde(default)]
    pub administrators: Vec<TelegramChatAdministratorMetadata>,
    #[serde(default)]
    pub seen_participants: Vec<TelegramSeenParticipantMetadata>,
    /// Map from `message_thread_id` (as string) to topic title. Populated on
    /// refresh for forum topics.
    #[serde(default)]
    pub topic_titles: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_api_sync_at: Option<u64>,
}

/// Small bundle describing a Telegram user used to upsert
/// `seen_participants`. The normaliser builds this synchronously from each
/// inbound message.
#[derive(Debug, Clone)]
pub struct SeenUser<'a> {
    pub user_id: &'a str,
    pub display_name: Option<&'a str>,
    pub username: Option<&'a str>,
    pub is_bot: bool,
}

pub fn chat_context_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    daemon_dir.as_ref().join(DIR_NAME)
}

pub fn chat_context_tmp_dir(daemon_dir: impl AsRef<Path>) -> PathBuf {
    chat_context_dir(daemon_dir).join(TMP_SUBDIR)
}

pub fn chat_context_path(daemon_dir: impl AsRef<Path>, chat_id: &str) -> PathBuf {
    chat_context_dir(daemon_dir).join(format!("{}.json", encode_chat_id_segment(chat_id)))
}

/// Encode a chat id for use as a filename segment. Mirrors the leading-dash
/// handling in `normalizeNumericSegment` from
/// `src/utils/telegram-identifiers.ts` so that `-1002` becomes `n1002`. Non
/// alphanumeric/underscore chars are replaced with `_`.
fn encode_chat_id_segment(chat_id: &str) -> String {
    let mut buf = String::with_capacity(chat_id.len());
    for (index, ch) in chat_id.chars().enumerate() {
        if index == 0 && ch == '-' {
            buf.push('n');
            continue;
        }
        if ch.is_ascii_alphanumeric() || ch == '_' {
            buf.push(ch);
        } else {
            buf.push('_');
        }
    }
    buf
}

/// Load a chat context snapshot. `Ok(None)` on missing file, fail closed on
/// schema mismatch or malformed content.
pub fn load_chat_context(
    daemon_dir: impl AsRef<Path>,
    chat_id: &str,
) -> ChatContextResult<Option<ChatContextSnapshot>> {
    let path = chat_context_path(&daemon_dir, chat_id);
    match fs::read_to_string(&path) {
        Ok(content) => {
            let snapshot: ChatContextSnapshot = serde_json::from_str(&content)?;
            validate_snapshot(&snapshot)?;
            Ok(Some(snapshot))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn validate_snapshot(snapshot: &ChatContextSnapshot) -> ChatContextResult<()> {
    if snapshot.schema_version != TELEGRAM_CHAT_CONTEXT_SCHEMA_VERSION {
        return Err(ChatContextError::UnsupportedSchemaVersion {
            found: snapshot.schema_version,
            expected: TELEGRAM_CHAT_CONTEXT_SCHEMA_VERSION,
        });
    }
    if snapshot.writer.is_empty() {
        return Err(ChatContextError::MissingWriter);
    }
    if snapshot.writer_version.is_empty() {
        return Err(ChatContextError::MissingWriterVersion);
    }
    if snapshot.chat_id.is_empty() {
        return Err(ChatContextError::MissingChatId);
    }
    if snapshot.updated_at == 0 {
        return Err(ChatContextError::InvalidUpdatedAt);
    }
    Ok(())
}

fn write_snapshot(
    daemon_dir: impl AsRef<Path>,
    snapshot: &ChatContextSnapshot,
) -> ChatContextResult<()> {
    validate_snapshot(snapshot)?;
    let daemon_dir = daemon_dir.as_ref();
    let dir = chat_context_dir(daemon_dir);
    let tmp_dir = chat_context_tmp_dir(daemon_dir);
    fs::create_dir_all(&dir)?;
    fs::create_dir_all(&tmp_dir)?;
    let file_name = format!("{}.json", encode_chat_id_segment(&snapshot.chat_id));
    let target = dir.join(&file_name);
    let tmp = tmp_dir.join(format!(
        "{file_name}.{}.{}.tmp",
        std::process::id(),
        now_nanos()
    ));
    let outcome = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        serde_json::to_writer_pretty(&mut file, snapshot)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&tmp, &target)?;
        sync_parent_dir(&target)?;
        Ok(())
    })();
    if outcome.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    outcome
}

fn sync_parent_dir(path: &Path) -> ChatContextResult<()> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn trim_or_none(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
        .map(str::to_string)
}

fn new_snapshot(chat_id: &str, writer_version: &str, now_ms: u64) -> ChatContextSnapshot {
    ChatContextSnapshot {
        schema_version: TELEGRAM_CHAT_CONTEXT_SCHEMA_VERSION,
        writer: TELEGRAM_CHAT_CONTEXT_WRITER.to_string(),
        writer_version: writer_version.to_string(),
        created_at: now_ms,
        updated_at: now_ms,
        chat_id: chat_id.to_string(),
        chat_type: None,
        chat_title: None,
        chat_username: None,
        member_count: None,
        administrators: Vec::new(),
        seen_participants: Vec::new(),
        topic_titles: std::collections::BTreeMap::new(),
        last_api_sync_at: None,
    }
}

/// Update `seen_participants` in a snapshot according to the sliding-window
/// policy the TS oracle uses: merge on `userId`, keep `lastSeenAt = max`,
/// sort descending, cap to [`MAX_SEEN_PARTICIPANTS`]. Bot users are ignored.
pub fn upsert_seen_participant(
    snapshot: &mut ChatContextSnapshot,
    user: SeenUser<'_>,
    now_ms: u64,
) {
    if user.is_bot || user.user_id.is_empty() {
        return;
    }
    let incoming = TelegramSeenParticipantMetadata {
        user_id: user.user_id.to_string(),
        display_name: trim_or_none(user.display_name),
        username: trim_or_none(user.username),
        last_seen_at: now_ms,
    };

    let mut merged = std::mem::take(&mut snapshot.seen_participants);
    let mut found_at: Option<usize> = None;
    for (index, existing) in merged.iter_mut().enumerate() {
        if existing.user_id == incoming.user_id {
            found_at = Some(index);
            existing.display_name = incoming
                .display_name
                .clone()
                .or_else(|| existing.display_name.clone());
            existing.username = incoming
                .username
                .clone()
                .or_else(|| existing.username.clone());
            existing.last_seen_at = existing.last_seen_at.max(incoming.last_seen_at);
            break;
        }
    }
    if found_at.is_none() {
        merged.push(incoming);
    }
    merged.sort_by(|left, right| right.last_seen_at.cmp(&left.last_seen_at));
    merged.truncate(MAX_SEEN_PARTICIPANTS);
    snapshot.seen_participants = merged;
}

/// Record a seen participant and persist the updated snapshot. Creates a
/// fresh snapshot for the chat if none exists yet.
pub fn record_seen_participant(
    daemon_dir: impl AsRef<Path>,
    chat_id: &str,
    writer_version: &str,
    user: SeenUser<'_>,
    now_ms: u64,
) -> ChatContextResult<ChatContextSnapshot> {
    let daemon_dir = daemon_dir.as_ref();
    let mut snapshot = load_chat_context(daemon_dir, chat_id)?
        .unwrap_or_else(|| new_snapshot(chat_id, writer_version, now_ms));
    upsert_seen_participant(&mut snapshot, user, now_ms);
    snapshot.updated_at = now_ms;
    // Keep writer/writerVersion current: if the loaded snapshot had stale
    // values we still want the latest writer pinned.
    snapshot.writer = TELEGRAM_CHAT_CONTEXT_WRITER.to_string();
    snapshot.writer_version = writer_version.to_string();
    write_snapshot(daemon_dir, &snapshot)?;
    Ok(snapshot)
}

/// Trait abstraction so tests can inject a fake Bot API surface without a
/// real HTTP client. Method names match [`TelegramBotClient`] so production
/// wiring is a thin forwarding impl.
pub trait ChatContextRefreshClient {
    fn get_chat(&self, chat_id: ChatId) -> Result<ChatSummary, TelegramClientError>;
    fn get_chat_administrators(
        &self,
        chat_id: ChatId,
    ) -> Result<Vec<ChatAdministrator>, TelegramClientError>;
    fn get_chat_member_count(&self, chat_id: ChatId) -> Result<i64, TelegramClientError>;
    fn get_forum_topic(
        &self,
        chat_id: ChatId,
        message_thread_id: i64,
    ) -> Result<ForumTopicSummary, TelegramClientError>;
}

/// Flat view of what the refresh path needs from `getChat`. Using a flat
/// struct avoids coupling the chat-context module to the full
/// [`crate::telegram::client::Chat`] type (and keeps tests terser).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatSummary {
    pub id: i64,
    pub chat_type: String,
    pub title: Option<String>,
    pub username: Option<String>,
}

/// Flat view of what the refresh path needs from `getForumTopic`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForumTopicSummary {
    pub message_thread_id: i64,
    pub name: String,
}

impl ChatContextRefreshClient for TelegramBotClient {
    fn get_chat(&self, chat_id: ChatId) -> Result<ChatSummary, TelegramClientError> {
        let chat = TelegramBotClient::get_chat(self, chat_id)?;
        Ok(ChatSummary {
            id: chat.id,
            chat_type: chat.chat_type,
            title: chat.title,
            username: chat.username,
        })
    }

    fn get_chat_administrators(
        &self,
        chat_id: ChatId,
    ) -> Result<Vec<ChatAdministrator>, TelegramClientError> {
        TelegramBotClient::get_chat_administrators(self, chat_id)
    }

    fn get_chat_member_count(&self, chat_id: ChatId) -> Result<i64, TelegramClientError> {
        TelegramBotClient::get_chat_member_count(self, chat_id)
    }

    fn get_forum_topic(
        &self,
        chat_id: ChatId,
        message_thread_id: i64,
    ) -> Result<ForumTopicSummary, TelegramClientError> {
        let topic = TelegramBotClient::get_forum_topic(self, chat_id, message_thread_id)?;
        Ok(ForumTopicSummary {
            message_thread_id: topic.message_thread_id,
            name: topic.name,
        })
    }
}

/// Options controlling [`refresh_chat_context`].
#[derive(Debug, Clone)]
pub struct RefreshChatContextInput<'a> {
    pub chat_id: &'a str,
    /// Private chats never need API enrichment. Callers pass `false` for
    /// private DMs to skip the API calls entirely (matches the TS service's
    /// `params.message.chat.type !== "private"` guard).
    pub is_private: bool,
    /// Optional forum topic id to refresh along with the core chat data.
    pub thread_id: Option<i64>,
    pub writer_version: &'a str,
    pub api_sync_ttl_ms: u64,
    pub now_ms: u64,
    /// When `true`, bypass the TTL and force a refresh. Useful for operator
    /// commands.
    pub force: bool,
}

/// Refresh API-derived fields of a chat context if the TTL has elapsed (or
/// `force` is set). Safe to call on every inbound message: it no-ops when
/// a fresh sync already happened within the TTL window.
pub fn refresh_chat_context<C: ChatContextRefreshClient>(
    daemon_dir: impl AsRef<Path>,
    client: &C,
    input: &RefreshChatContextInput<'_>,
) -> ChatContextResult<ChatContextSnapshot> {
    let daemon_dir = daemon_dir.as_ref();
    let mut snapshot = load_chat_context(daemon_dir, input.chat_id)?
        .unwrap_or_else(|| new_snapshot(input.chat_id, input.writer_version, input.now_ms));

    let ttl_elapsed = match snapshot.last_api_sync_at {
        Some(last) => input.now_ms.saturating_sub(last) >= input.api_sync_ttl_ms,
        None => true,
    };

    if input.is_private {
        snapshot.chat_type = Some(TelegramChatType::Private);
    }

    let should_refresh = !input.is_private && (input.force || ttl_elapsed);

    if should_refresh {
        let chat_id_val = input.chat_id.parse::<i64>().ok().map(ChatId::Numeric);
        if let Some(chat_id_val) = chat_id_val {
            // Stamp `last_api_sync_at` even if some of the calls fail so
            // transient errors don't hot-loop the API (TS behavior).
            snapshot.last_api_sync_at = Some(input.now_ms);

            if let Ok(chat) = client.get_chat(chat_id_val.clone()) {
                snapshot.chat_title =
                    trim_or_none(chat.title.as_deref()).or_else(|| snapshot.chat_title.clone());
                snapshot.chat_username = trim_or_none(chat.username.as_deref())
                    .or_else(|| snapshot.chat_username.clone());
                snapshot.chat_type = chat_type_from_api(&chat.chat_type).or(snapshot.chat_type);
            }

            if let Ok(admins) = client.get_chat_administrators(chat_id_val.clone()) {
                snapshot.administrators = dedupe_administrators(
                    admins.into_iter().filter_map(to_administrator).collect(),
                );
            }

            if let Ok(count) = client.get_chat_member_count(chat_id_val.clone()) {
                snapshot.member_count = u64::try_from(count).ok();
            }

            if let Some(thread_id) = input.thread_id
                && let Ok(topic) = client.get_forum_topic(chat_id_val, thread_id)
            {
                let key = thread_id.to_string();
                if let Some(title) = trim_or_none(Some(topic.name.as_str())) {
                    snapshot.topic_titles.insert(key, title);
                }
            }
        }
    }

    snapshot.updated_at = input.now_ms;
    snapshot.writer = TELEGRAM_CHAT_CONTEXT_WRITER.to_string();
    snapshot.writer_version = input.writer_version.to_string();
    write_snapshot(daemon_dir, &snapshot)?;
    Ok(snapshot)
}

fn chat_type_from_api(raw: &str) -> Option<TelegramChatType> {
    match raw {
        "private" => Some(TelegramChatType::Private),
        "group" => Some(TelegramChatType::Group),
        "supergroup" => Some(TelegramChatType::Supergroup),
        "channel" => Some(TelegramChatType::Channel),
        _ => None,
    }
}

fn to_administrator(entry: ChatAdministrator) -> Option<TelegramChatAdministratorMetadata> {
    if entry.user.is_bot {
        return None;
    }
    let user_id = entry.user.id.to_string();
    // Bot API `BotUser` lacks `last_name`; `first_name` is the only name
    // field we have. The TS service concatenates first+last — we fall back
    // to `first_name` when Rust's type doesn't carry `last_name`.
    let display_name = trim_or_none(Some(entry.user.first_name.as_str()))
        .or_else(|| trim_or_none(entry.user.username.as_deref()));
    Some(TelegramChatAdministratorMetadata {
        user_id,
        display_name,
        username: trim_or_none(entry.user.username.as_deref()),
        custom_title: trim_or_none(entry.custom_title.as_deref()),
    })
}

fn dedupe_administrators(
    admins: Vec<TelegramChatAdministratorMetadata>,
) -> Vec<TelegramChatAdministratorMetadata> {
    let mut out: Vec<TelegramChatAdministratorMetadata> = Vec::with_capacity(admins.len());
    for admin in admins {
        if out.iter().any(|existing| existing.user_id == admin.user_id) {
            continue;
        }
        out.push(admin);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telegram::client::BotUser;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_daemon_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "tenex-telegram-chat-context-{label}-{}-{counter}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("temp dir must create");
        dir
    }

    struct FakeClient {
        get_chat_calls: RefCell<usize>,
        get_admins_calls: RefCell<usize>,
        get_member_count_calls: RefCell<usize>,
        get_forum_topic_calls: RefCell<usize>,
        fail_chat: bool,
        fail_admins: bool,
        fail_member_count: bool,
        chat_response: ChatSummary,
        admins_response: Vec<ChatAdministrator>,
        member_count_response: i64,
        forum_topic_response: ForumTopicSummary,
    }

    impl FakeClient {
        fn base() -> Self {
            Self {
                get_chat_calls: RefCell::new(0),
                get_admins_calls: RefCell::new(0),
                get_member_count_calls: RefCell::new(0),
                get_forum_topic_calls: RefCell::new(0),
                fail_chat: false,
                fail_admins: false,
                fail_member_count: false,
                chat_response: ChatSummary {
                    id: -2001,
                    chat_type: "supergroup".to_string(),
                    title: Some("Operators HQ".to_string()),
                    username: Some("operators_hq".to_string()),
                },
                admins_response: vec![ChatAdministrator {
                    status: "administrator".to_string(),
                    user: BotUser {
                        id: 7,
                        is_bot: false,
                        first_name: "Ada".to_string(),
                        username: Some("ada_admin".to_string()),
                    },
                    custom_title: Some("Owner".to_string()),
                }],
                member_count_response: 14,
                forum_topic_response: ForumTopicSummary {
                    message_thread_id: 0,
                    name: "".to_string(),
                },
            }
        }
    }

    impl ChatContextRefreshClient for FakeClient {
        fn get_chat(&self, _chat_id: ChatId) -> Result<ChatSummary, TelegramClientError> {
            *self.get_chat_calls.borrow_mut() += 1;
            if self.fail_chat {
                return Err(TelegramClientError::ApiError {
                    error_code: 400,
                    description: "fake chat failure".to_string(),
                    retry_after: None,
                });
            }
            Ok(self.chat_response.clone())
        }

        fn get_chat_administrators(
            &self,
            _chat_id: ChatId,
        ) -> Result<Vec<ChatAdministrator>, TelegramClientError> {
            *self.get_admins_calls.borrow_mut() += 1;
            if self.fail_admins {
                return Err(TelegramClientError::ApiError {
                    error_code: 400,
                    description: "fake admins failure".to_string(),
                    retry_after: None,
                });
            }
            Ok(self.admins_response.clone())
        }

        fn get_chat_member_count(&self, _chat_id: ChatId) -> Result<i64, TelegramClientError> {
            *self.get_member_count_calls.borrow_mut() += 1;
            if self.fail_member_count {
                return Err(TelegramClientError::ApiError {
                    error_code: 400,
                    description: "fake member failure".to_string(),
                    retry_after: None,
                });
            }
            Ok(self.member_count_response)
        }

        fn get_forum_topic(
            &self,
            _chat_id: ChatId,
            _message_thread_id: i64,
        ) -> Result<ForumTopicSummary, TelegramClientError> {
            *self.get_forum_topic_calls.borrow_mut() += 1;
            Ok(self.forum_topic_response.clone())
        }
    }

    #[test]
    fn round_trips_snapshot_through_atomic_write() {
        let dir = unique_temp_daemon_dir("round-trip");
        let client = FakeClient::base();
        let snapshot = refresh_chat_context(
            &dir,
            &client,
            &RefreshChatContextInput {
                chat_id: "-2001",
                is_private: false,
                thread_id: None,
                writer_version: "0.1.0",
                api_sync_ttl_ms: 0,
                now_ms: 1_000,
                force: false,
            },
        )
        .expect("refresh");
        assert_eq!(
            snapshot.schema_version,
            TELEGRAM_CHAT_CONTEXT_SCHEMA_VERSION
        );
        assert_eq!(snapshot.writer, TELEGRAM_CHAT_CONTEXT_WRITER);
        assert_eq!(snapshot.chat_id, "-2001");
        assert_eq!(snapshot.chat_title.as_deref(), Some("Operators HQ"));
        assert_eq!(snapshot.chat_username.as_deref(), Some("operators_hq"));
        assert_eq!(snapshot.member_count, Some(14));
        assert_eq!(snapshot.administrators.len(), 1);
        assert_eq!(snapshot.last_api_sync_at, Some(1_000));
        assert_eq!(snapshot.chat_type, Some(TelegramChatType::Supergroup));

        // Loaded via public reader
        let loaded = load_chat_context(&dir, "-2001")
            .expect("load")
            .expect("present");
        assert_eq!(loaded, snapshot);

        // File exists at the expected path
        let expected_path = chat_context_path(&dir, "-2001");
        assert!(expected_path.exists());
        assert!(expected_path.ends_with("telegram/chat-context/n2001.json"));

        // No stray tmp files
        let tmp = chat_context_tmp_dir(&dir);
        let leftover: Vec<_> = fs::read_dir(&tmp)
            .expect("tmp dir readable")
            .filter_map(|entry| entry.ok())
            .collect();
        assert!(
            leftover.is_empty(),
            "tmp dir must not leak files after success: {leftover:?}"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ttl_gates_api_refresh() {
        let dir = unique_temp_daemon_dir("ttl");
        let client = FakeClient::base();
        // First refresh populates; last_api_sync_at = 1000
        refresh_chat_context(
            &dir,
            &client,
            &RefreshChatContextInput {
                chat_id: "-2001",
                is_private: false,
                thread_id: None,
                writer_version: "0.1.0",
                api_sync_ttl_ms: 5_000,
                now_ms: 1_000,
                force: false,
            },
        )
        .expect("first refresh");
        // Second call 2s later should not call the API
        refresh_chat_context(
            &dir,
            &client,
            &RefreshChatContextInput {
                chat_id: "-2001",
                is_private: false,
                thread_id: None,
                writer_version: "0.1.0",
                api_sync_ttl_ms: 5_000,
                now_ms: 3_000,
                force: false,
            },
        )
        .expect("second refresh");
        assert_eq!(*client.get_chat_calls.borrow(), 1);
        assert_eq!(*client.get_admins_calls.borrow(), 1);
        assert_eq!(*client.get_member_count_calls.borrow(), 1);

        // After the TTL elapses, refresh fires again.
        refresh_chat_context(
            &dir,
            &client,
            &RefreshChatContextInput {
                chat_id: "-2001",
                is_private: false,
                thread_id: None,
                writer_version: "0.1.0",
                api_sync_ttl_ms: 5_000,
                now_ms: 7_000,
                force: false,
            },
        )
        .expect("third refresh");
        assert_eq!(*client.get_chat_calls.borrow(), 2);

        // Forced refresh bypasses TTL.
        refresh_chat_context(
            &dir,
            &client,
            &RefreshChatContextInput {
                chat_id: "-2001",
                is_private: false,
                thread_id: None,
                writer_version: "0.1.0",
                api_sync_ttl_ms: 5_000,
                now_ms: 7_500,
                force: true,
            },
        )
        .expect("forced refresh");
        assert_eq!(*client.get_chat_calls.borrow(), 3);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refresh_preserves_cached_values_when_api_fails() {
        let dir = unique_temp_daemon_dir("fallback");
        // Seed cache
        let client = FakeClient::base();
        refresh_chat_context(
            &dir,
            &client,
            &RefreshChatContextInput {
                chat_id: "-2001",
                is_private: false,
                thread_id: None,
                writer_version: "0.1.0",
                api_sync_ttl_ms: 0,
                now_ms: 1_000,
                force: false,
            },
        )
        .expect("seed");

        // Fail everything now; TTL=0 so refresh fires.
        let mut fail = FakeClient::base();
        fail.fail_chat = true;
        fail.fail_admins = true;
        fail.fail_member_count = true;
        let snapshot = refresh_chat_context(
            &dir,
            &fail,
            &RefreshChatContextInput {
                chat_id: "-2001",
                is_private: false,
                thread_id: None,
                writer_version: "0.1.0",
                api_sync_ttl_ms: 0,
                now_ms: 2_000,
                force: false,
            },
        )
        .expect("refresh survives failures");
        assert_eq!(snapshot.chat_title.as_deref(), Some("Operators HQ"));
        assert_eq!(snapshot.member_count, Some(14));
        assert_eq!(snapshot.administrators.len(), 1);
        assert_eq!(snapshot.last_api_sync_at, Some(2_000));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn seen_participant_sliding_window_caps_at_25_and_merges() {
        let dir = unique_temp_daemon_dir("participants");
        let mut now = 1_000u64;
        for index in 1..=30u64 {
            now += 1;
            let display = format!("User {index}");
            let username = format!("user_{index}");
            let id = index.to_string();
            record_seen_participant(
                &dir,
                "-2001",
                "0.1.0",
                SeenUser {
                    user_id: &id,
                    display_name: Some(&display),
                    username: Some(&username),
                    is_bot: false,
                },
                now,
            )
            .expect("record");
        }
        // Update user 5 with new name, expect it to be most recent
        now += 1;
        let snapshot = record_seen_participant(
            &dir,
            "-2001",
            "0.1.0",
            SeenUser {
                user_id: "5",
                display_name: Some("Updated Five"),
                username: Some("five_again"),
                is_bot: false,
            },
            now,
        )
        .expect("update");
        assert_eq!(snapshot.seen_participants.len(), MAX_SEEN_PARTICIPANTS);
        assert_eq!(snapshot.seen_participants[0].user_id, "5");
        assert_eq!(
            snapshot.seen_participants[0].display_name.as_deref(),
            Some("Updated Five")
        );
        assert!(
            !snapshot
                .seen_participants
                .iter()
                .any(|participant| participant.user_id == "1"),
            "the oldest participant must be evicted"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn record_ignores_bots() {
        let dir = unique_temp_daemon_dir("ignore-bot");
        let snapshot = record_seen_participant(
            &dir,
            "-2001",
            "0.1.0",
            SeenUser {
                user_id: "99",
                display_name: Some("BotAccount"),
                username: Some("a_bot"),
                is_bot: true,
            },
            1_000,
        )
        .expect("bot recorded");
        assert!(snapshot.seen_participants.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn private_chat_skips_api_calls() {
        let dir = unique_temp_daemon_dir("private");
        let client = FakeClient::base();
        let snapshot = refresh_chat_context(
            &dir,
            &client,
            &RefreshChatContextInput {
                chat_id: "99",
                is_private: true,
                thread_id: None,
                writer_version: "0.1.0",
                api_sync_ttl_ms: 0,
                now_ms: 1_000,
                force: false,
            },
        )
        .expect("refresh");
        assert_eq!(*client.get_chat_calls.borrow(), 0);
        assert_eq!(*client.get_admins_calls.borrow(), 0);
        assert_eq!(*client.get_member_count_calls.borrow(), 0);
        assert_eq!(snapshot.chat_type, Some(TelegramChatType::Private));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn forum_topic_title_cached_under_thread_id() {
        let dir = unique_temp_daemon_dir("forum");
        let mut client = FakeClient::base();
        client.forum_topic_response = ForumTopicSummary {
            message_thread_id: 7,
            name: "Ops Topic".to_string(),
        };
        let snapshot = refresh_chat_context(
            &dir,
            &client,
            &RefreshChatContextInput {
                chat_id: "-2001",
                is_private: false,
                thread_id: Some(7),
                writer_version: "0.1.0",
                api_sync_ttl_ms: 0,
                now_ms: 1_000,
                force: false,
            },
        )
        .expect("refresh");
        assert_eq!(
            snapshot.topic_titles.get("7").map(String::as_str),
            Some("Ops Topic")
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_fails_closed_on_schema_mismatch() {
        let dir = unique_temp_daemon_dir("schema");
        fs::create_dir_all(chat_context_dir(&dir)).unwrap();
        let path = chat_context_path(&dir, "-2001");
        fs::write(
            &path,
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": 99,
                "writer": "tenex-daemon",
                "writerVersion": "0.1.0",
                "createdAt": 1,
                "updatedAt": 1,
                "chatId": "-2001",
                "administrators": [],
                "seenParticipants": [],
                "topicTitles": {}
            }))
            .unwrap(),
        )
        .unwrap();
        let err = load_chat_context(&dir, "-2001").expect_err("schema mismatch");
        assert!(
            matches!(
                err,
                ChatContextError::UnsupportedSchemaVersion {
                    found: 99,
                    expected: TELEGRAM_CHAT_CONTEXT_SCHEMA_VERSION,
                }
            ),
            "unexpected error: {err:?}"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_missing_returns_none() {
        let dir = unique_temp_daemon_dir("missing");
        let result = load_chat_context(&dir, "-2001").expect("load");
        assert!(result.is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn encode_chat_id_segment_normalises_leading_dash() {
        assert_eq!(encode_chat_id_segment("-1002"), "n1002");
        assert_eq!(encode_chat_id_segment("42"), "42");
        assert_eq!(encode_chat_id_segment("@ops_chat"), "_ops_chat");
    }
}
