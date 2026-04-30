/// Minimal Telegram channel binding descriptor — enough for the `<channels>` system
/// prompt block. Defined here so `tenex-system-prompt` does not need to depend on
/// `tenex-telegram`.
pub struct TelegramChannelBinding {
    /// Canonical channel ID, e.g. `telegram:chat:12345` or
    /// `telegram:group:-100987654321:topic:42`.
    pub channel_id: String,
    /// Chat-level ID (the numeric portion after `telegram:chat:` or
    /// `telegram:group:`). Negative values indicate groups/supergroups; positive
    /// values indicate private DMs.
    pub chat_id: String,
    /// Thread ID (forum topic), present only for `telegram:group:…:topic:…` keys.
    pub thread_id: Option<String>,
}

impl TelegramChannelBinding {
    /// Parse a canonical channel ID string into a `TelegramChannelBinding`.
    /// Returns `None` if the format is unrecognised.
    ///
    /// Supported formats (from `tenex-telegram::session::SessionStore::channel_key`):
    /// - `telegram:chat:<chat_id>`
    /// - `telegram:group:<chat_id>:topic:<thread_id>`
    pub fn parse(channel_id: &str) -> Option<Self> {
        if let Some(rest) = channel_id.strip_prefix("telegram:group:") {
            if let Some((chat_part, topic_part)) = rest.split_once(":topic:") {
                return Some(Self {
                    channel_id: channel_id.to_string(),
                    chat_id: chat_part.to_string(),
                    thread_id: Some(topic_part.to_string()),
                });
            }
            return Some(Self {
                channel_id: channel_id.to_string(),
                chat_id: rest.to_string(),
                thread_id: None,
            });
        }
        if let Some(rest) = channel_id.strip_prefix("telegram:chat:") {
            return Some(Self {
                channel_id: channel_id.to_string(),
                chat_id: rest.to_string(),
                thread_id: None,
            });
        }
        None
    }

    /// Classify the channel as `"dm"`, `"topic"`, or `"group"`.
    pub fn channel_type(&self) -> &'static str {
        if !self.chat_id.starts_with('-') {
            "dm"
        } else if self.thread_id.is_some() {
            "topic"
        } else {
            "group"
        }
    }
}

/// Plain-data Telegram chat context passed into the system prompt builder.
/// Defined here so `tenex-system-prompt` has no dependency on the Telegram crate.
pub struct TelegramChatContextForPrompt {
    pub chat_title: Option<String>,
    pub topic_title: Option<String>,
    pub admin_names: Vec<String>,
    pub member_count: Option<i64>,
    pub recently_seen: Vec<String>,
}

pub(crate) const TELEGRAM_DELIVERY_RULES: &str = "## Telegram Delivery Rules
- To send a Telegram voice reply, output the reserved marker `[[telegram_voice:/absolute/path/to/file.ogg]]` on its own line.
- Use an absolute local path only, and emit the marker only when the file already exists and is ready to send.
- Prefer an `.ogg` voice-note file for this marker.
- If you include prose outside the marker, TENEX will send the voice message first and then send the remaining text as a normal Telegram message.
- Never explain the marker, quote it back to the user, or include more than one `telegram_voice` marker in the same reply.";

pub(crate) fn render_telegram_chat_context(ctx: &TelegramChatContextForPrompt) -> String {
    let mut detail_lines: Vec<String> = Vec::new();

    if let Some(title) = &ctx.chat_title {
        detail_lines.push(format!("- Chat title: {title}"));
    }

    if let Some(topic) = &ctx.topic_title {
        detail_lines.push(format!("- Topic: {topic}"));
    }

    if let Some(count) = ctx.member_count {
        detail_lines.push(format!("- Member count (Telegram API snapshot): {count}"));
    }

    if !ctx.admin_names.is_empty() {
        detail_lines.push(format!(
            "- Administrators (Telegram API snapshot): {}",
            ctx.admin_names.join(", ")
        ));
    }

    if !ctx.recently_seen.is_empty() {
        detail_lines.push(format!(
            "- Recently seen participants (TENEX-local observations): {}",
            ctx.recently_seen.join(", ")
        ));
    }

    if detail_lines.is_empty() {
        return String::new();
    }

    let mut lines = vec!["## Telegram Chat Context".to_string()];
    lines.extend(detail_lines);
    lines.join("\n")
}
