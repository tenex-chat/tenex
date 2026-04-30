//! In-process Telegram chat context cache with a 5-minute TTL.
//!
//! [`TelegramChatContextService`] fetches group/topic metadata from the Bot
//! API on the first call per `(chat_id, thread_id)` key, then serves cached
//! results until the TTL expires.  API calls run in parallel and failures are
//! isolated — a single failed method does not void the rest of the context.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::client::BotClient;
use crate::types::TelegramChatMemberAdministrator;

const TTL: Duration = Duration::from_secs(5 * 60);
const MAX_ADMINS: usize = 10;
const MAX_SEEN: usize = 12;

/// A single administrator with enough info to render in the system prompt.
#[derive(Debug, Clone)]
pub struct ChatAdministrator {
    pub display_name: Option<String>,
    pub username: Option<String>,
    pub custom_title: Option<String>,
}

/// Snapshot of Telegram context for one chat/topic, ready for system-prompt
/// injection.
#[derive(Debug, Clone)]
pub struct ChatContext {
    pub chat_title: Option<String>,
    pub topic_title: Option<String>,
    pub administrators: Vec<ChatAdministrator>,
    pub member_count: Option<i64>,
    pub recently_seen: Vec<String>,
}

/// Cache key: `"<chat_id>|<thread_id>"` where the thread suffix is `""` when
/// there is no topic.
fn cache_key(chat_id: &str, thread_id: Option<&str>) -> String {
    format!("{}|{}", chat_id, thread_id.unwrap_or(""))
}

fn is_group_chat(chat_id: &str) -> bool {
    chat_id.starts_with('-')
}

fn user_display_name(user: &crate::types::TelegramUser) -> Option<String> {
    // Rust TelegramUser has only first_name (no last_name field).
    let trimmed = user.first_name.trim().to_string();
    if !trimmed.is_empty() {
        Some(trimmed)
    } else {
        user.username.clone()
    }
}

fn to_administrator(member: TelegramChatMemberAdministrator) -> Option<ChatAdministrator> {
    if member.user.is_bot {
        return None;
    }
    Some(ChatAdministrator {
        display_name: user_display_name(&member.user),
        username: member.user.username.clone(),
        custom_title: member
            .custom_title
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string()),
    })
}

struct CacheEntry {
    context: ChatContext,
    fetched_at: Instant,
}

/// Fetches Telegram chat metadata from the Bot API and caches it per
/// `(chat_id, thread_id)` for 5 minutes.
pub struct TelegramChatContextService {
    client: BotClient,
    cache: Mutex<HashMap<String, CacheEntry>>,
}

impl TelegramChatContextService {
    pub fn new(client: BotClient) -> Self {
        Self {
            client,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Return the chat context for the given `chat_id` and optional
    /// `thread_id`.  `recently_seen` is merged into the result as-is — the
    /// caller is responsible for assembling that list from inbound message
    /// observations.
    ///
    /// API calls are skipped for private chats (positive `chat_id`) because
    /// `getChatAdministrators` and `getChatMemberCount` are not valid for them.
    pub async fn get_context(
        &self,
        chat_id: &str,
        thread_id: Option<&str>,
        recently_seen: &[String],
    ) -> ChatContext {
        let key = cache_key(chat_id, thread_id);

        // Check cache under lock (no await inside the critical section).
        let cached = {
            let guard = self.cache.lock().await;
            guard.get(&key).and_then(|entry| {
                if entry.fetched_at.elapsed() < TTL {
                    Some(entry.context.clone())
                } else {
                    None
                }
            })
        };

        let base = if let Some(ctx) = cached {
            ctx
        } else {
            let fetched = self.fetch_from_api(chat_id, thread_id).await;
            let mut guard = self.cache.lock().await;
            guard.insert(
                key,
                CacheEntry {
                    context: fetched.clone(),
                    fetched_at: Instant::now(),
                },
            );
            fetched
        };

        ChatContext {
            recently_seen: recently_seen.iter().take(MAX_SEEN).cloned().collect(),
            ..base
        }
    }

    async fn fetch_from_api(&self, chat_id: &str, thread_id: Option<&str>) -> ChatContext {
        let mut ctx = ChatContext {
            chat_title: None,
            topic_title: None,
            administrators: Vec::new(),
            member_count: None,
            recently_seen: Vec::new(),
        };

        if is_group_chat(chat_id) {
            // Run getChat, getChatAdministrators, and getChatMemberCount in parallel.
            let (chat_result, admins_result, count_result) = tokio::join!(
                self.client.get_chat(chat_id),
                self.client.get_chat_administrators(chat_id),
                self.client.get_chat_member_count(chat_id),
            );

            if let Ok(info) = chat_result {
                let trimmed = info
                    .title
                    .map(|t| t.trim().to_string())
                    .filter(|s| !s.is_empty());
                ctx.chat_title = trimmed;
            }

            if let Ok(members) = admins_result {
                ctx.administrators = members
                    .into_iter()
                    .filter_map(to_administrator)
                    .take(MAX_ADMINS)
                    .collect();
            }

            if let Ok(count) = count_result {
                ctx.member_count = Some(count);
            }

            // Fetch topic title if a thread_id is present.  Failures are
            // expected when the bot lacks `can_manage_topics` — ignore them.
            if let Some(tid) = thread_id {
                if let Ok(topic) = self.client.get_forum_topic_info(chat_id, tid).await {
                    let name = topic.name.trim().to_string();
                    if !name.is_empty() {
                        ctx.topic_title = Some(name);
                    }
                }
            }
        } else {
            // Private chat — only getChat is meaningful.
            if let Ok(info) = self.client.get_chat(chat_id).await {
                let trimmed = info
                    .title
                    .map(|t| t.trim().to_string())
                    .filter(|s| !s.is_empty());
                ctx.chat_title = trimmed;
            }
        }

        ctx
    }
}

/// Plain-data summary of Telegram chat context, suitable for passing to
/// `tenex-system-prompt` without taking a dependency on this crate.
#[derive(Debug, Clone)]
pub struct TelegramChatContextForPrompt {
    pub chat_title: Option<String>,
    pub topic_title: Option<String>,
    pub admin_names: Vec<String>,
    pub member_count: Option<i64>,
    pub recently_seen: Vec<String>,
}

impl From<ChatContext> for TelegramChatContextForPrompt {
    fn from(ctx: ChatContext) -> Self {
        Self {
            chat_title: ctx.chat_title,
            topic_title: ctx.topic_title,
            admin_names: ctx
                .administrators
                .into_iter()
                .map(|a| {
                    let display = a.display_name.clone();
                    let base = display
                        .clone()
                        .or_else(|| a.username.clone())
                        .unwrap_or_default();
                    let handle = a
                        .username
                        .filter(|u| display.as_deref() != Some(u.as_str()))
                        .map(|u| format!(" (@{u})"))
                        .unwrap_or_default();
                    let title = a
                        .custom_title
                        .map(|t| format!(" [{t}]"))
                        .unwrap_or_default();
                    format!("{base}{handle}{title}")
                })
                .collect(),
            member_count: ctx.member_count,
            recently_seen: ctx.recently_seen,
        }
    }
}
