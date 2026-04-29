//! Telegram channel/message ID encoding helpers.
//!
//! Mirrors `src/utils/telegram-identifiers.ts` verbatim. Pure
//! functions — no I/O, no Telegram API.
//!
//! Two distinct ID schemes:
//!
//! - **Channel ID** (`telegram:chat:<n>` or `telegram:group:<n>:topic:<m>`)
//!   — colon-separated, used as the conversation channel address.
//!   Negative chat IDs (i.e. group chats) keep their leading `-` here
//!   because the segment is colon-bounded.
//! - **Native message ID** (`tg_<chat>_<msg>`) — underscore-separated, so
//!   negative numbers are encoded as `n<digits>` to avoid the underscore
//!   parsing ambiguity. Both segments are normalised + denormalised
//!   symmetrically by [`normalize_numeric_segment`] /
//!   [`denormalize_numeric_segment`].

/// Mirror of `TELEGRAM_CHAT_ID_PATTERN` (`:1`): optional leading `-`
/// followed by ≥1 digits.
fn is_valid_chat_id(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let bytes = s.as_bytes();
    let (start, _) = if bytes[0] == b'-' { (1, true) } else { (0, false) };
    if start == s.len() {
        return false; // just "-"
    }
    s.as_bytes()[start..].iter().all(u8::is_ascii_digit)
}

/// Mirror of `TELEGRAM_MESSAGE_THREAD_ID_PATTERN` (`:2`): ≥1 digits
/// (no sign).
fn is_valid_thread_id(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// Mirror `normalizeNumericSegment` (`:4-6`).
///
/// Replaces a leading `-` with `n` (so `-12345` → `n12345`), then
/// replaces every non-`[A-Za-z0-9_]` char with `_`. The resulting
/// segment is safe inside an underscore-delimited identifier.
fn normalize_numeric_segment(value: &str) -> String {
    let stripped: String = if let Some(rest) = value.strip_prefix('-') {
        format!("n{rest}")
    } else {
        value.to_owned()
    };
    stripped
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Mirror `denormalizeNumericSegment` (`:8-10`):
/// reverse the leading-dash replacement only; non-`[A-Za-z0-9_]`
/// characters were lossy in `normalize` and cannot be recovered.
fn denormalize_numeric_segment(value: &str) -> String {
    if let Some(rest) = value.strip_prefix('n') {
        format!("-{rest}")
    } else {
        value.to_owned()
    }
}

/// Mirror `createTelegramChannelId` (`:12-21`).
///
/// - With `message_thread_id`: `"telegram:group:<chat>:topic:<thread>"`
/// - Without: `"telegram:chat:<chat>"`
///
/// Both args are stringified by the caller (the TS source accepts
/// `string | number` and calls `String(…)`).
pub fn create_telegram_channel_id(
    chat_id: &str,
    message_thread_id: Option<&str>,
) -> String {
    match message_thread_id {
        Some(thread) => format!("telegram:group:{chat_id}:topic:{thread}"),
        None => format!("telegram:chat:{chat_id}"),
    }
}

/// Mirror `getTelegramThreadTargetValidationError` (`:23-54`).
///
/// Returns `Some(verbatim_error)` for the four invalid cases and `None`
/// when the inputs validate. The error strings are user-facing and must
/// match the TS source verbatim — they are surfaced by the agent
/// telegram-bot config TUI.
pub fn get_telegram_thread_target_validation_error(
    chat_id: &str,
    message_thread_id: Option<&str>,
) -> Option<String> {
    let normalized_chat = chat_id.trim();
    if normalized_chat.is_empty() {
        return Some("Telegram chat ID is required".to_owned());
    }
    if !is_valid_chat_id(normalized_chat) {
        return Some(format!("Invalid Telegram chat ID: {normalized_chat}"));
    }
    let thread = message_thread_id?;
    let normalized_thread = thread.trim();
    if normalized_thread.is_empty() {
        return None;
    }
    if !is_valid_thread_id(normalized_thread) {
        return Some(format!(
            "Invalid Telegram message thread ID: {normalized_thread}. Thread IDs must be numeric."
        ));
    }
    if !normalized_chat.starts_with('-') {
        return Some(format!(
            "Invalid Telegram message thread target: chat {normalized_chat} is not a group chat."
        ));
    }
    None
}

/// Parsed counterpart to [`create_telegram_channel_id`]. Mirrors
/// `parseTelegramChannelId` (`:56-77`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTelegramChannel {
    pub chat_id: String,
    pub message_thread_id: Option<String>,
}

/// Mirror `parseTelegramChannelId` (`:56-77`).
///
/// Returns `Some` when `channel_id` matches one of the two recognized
/// shapes; `None` otherwise. The `group:…:topic:` form's `parts[4]` is
/// `Some(<thread>)` — but if the topic segment is missing entirely the
/// thread becomes the empty option-of-`""`, mirroring the TS `parts[4]`
/// (which would yield `undefined` when out of bounds, but a literal
/// empty string when present).
pub fn parse_telegram_channel_id(channel_id: &str) -> Option<ParsedTelegramChannel> {
    if !channel_id.starts_with("telegram:") {
        return None;
    }
    let parts: Vec<&str> = channel_id.split(':').collect();
    match parts.as_slice() {
        [_, "chat", chat_id, ..] if !chat_id.is_empty() => Some(ParsedTelegramChannel {
            chat_id: (*chat_id).to_owned(),
            message_thread_id: None,
        }),
        [_, "group", chat_id, _topic, thread, ..] if !chat_id.is_empty() => {
            Some(ParsedTelegramChannel {
                chat_id: (*chat_id).to_owned(),
                message_thread_id: Some((*thread).to_owned()),
            })
        }
        // `telegram:group:<chat>:topic` with no thread segment — TS
        // returns `{ chatId, messageThreadId: undefined }` because
        // `parts[4]` is out of bounds. Mirror that.
        [_, "group", chat_id, _topic] if !chat_id.is_empty() => {
            Some(ParsedTelegramChannel {
                chat_id: (*chat_id).to_owned(),
                message_thread_id: None,
            })
        }
        _ => None,
    }
}

/// Mirror `createTelegramNativeMessageId` (`:79-84`):
/// `tg_<normalized_chat>_<normalized_msg>`.
pub fn create_telegram_native_message_id(chat_id: &str, message_id: &str) -> String {
    format!(
        "tg_{}_{}",
        normalize_numeric_segment(chat_id),
        normalize_numeric_segment(message_id),
    )
}

/// Parsed counterpart. Mirrors `parseTelegramNativeMessageId` (`:86-110`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTelegramNativeMessage {
    pub chat_id: String,
    pub message_id: String,
}

/// Mirror `parseTelegramNativeMessageId` (`:86-110`).
///
/// Splits at the **last** `_` (so chat IDs that round-tripped through
/// `normalize_numeric_segment` and contain underscores still parse).
/// Returns `None` when the prefix is missing, no `_` is present after
/// `tg_`, or either segment is empty.
pub fn parse_telegram_native_message_id(
    native_message_id: &str,
) -> Option<ParsedTelegramNativeMessage> {
    let payload = native_message_id.strip_prefix("tg_")?;
    let separator = payload.rfind('_')?;
    let chat_segment = &payload[..separator];
    let message_segment = &payload[separator + 1..];
    if chat_segment.is_empty() || message_segment.is_empty() {
        return None;
    }
    Some(ParsedTelegramNativeMessage {
        chat_id: denormalize_numeric_segment(chat_segment),
        message_id: denormalize_numeric_segment(message_segment),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── normalize / denormalize ────────────────────────────────────────

    #[test]
    fn normalize_replaces_leading_dash_with_n() {
        assert_eq!(normalize_numeric_segment("-12345"), "n12345");
        assert_eq!(normalize_numeric_segment("12345"), "12345");
    }

    #[test]
    fn normalize_replaces_non_alnum_chars_with_underscore() {
        assert_eq!(normalize_numeric_segment("abc.def"), "abc_def");
        assert_eq!(normalize_numeric_segment("-1.2.3"), "n1_2_3");
    }

    #[test]
    fn normalize_preserves_underscores_and_alphanumerics() {
        assert_eq!(normalize_numeric_segment("abc_123"), "abc_123");
    }

    #[test]
    fn denormalize_inverts_leading_n_only() {
        assert_eq!(denormalize_numeric_segment("n12345"), "-12345");
        assert_eq!(denormalize_numeric_segment("12345"), "12345");
        // Lossy non-alnum substitution is NOT recovered.
        assert_eq!(denormalize_numeric_segment("abc_def"), "abc_def");
    }

    // ── create_telegram_channel_id ──────────────────────────────────────

    #[test]
    fn create_channel_id_chat_form() {
        assert_eq!(
            create_telegram_channel_id("12345", None),
            "telegram:chat:12345"
        );
    }

    #[test]
    fn create_channel_id_group_form_with_thread() {
        assert_eq!(
            create_telegram_channel_id("-100123456", Some("42")),
            "telegram:group:-100123456:topic:42"
        );
    }

    // ── parse_telegram_channel_id ──────────────────────────────────────

    #[test]
    fn parse_channel_id_chat_form() {
        let parsed = parse_telegram_channel_id("telegram:chat:12345").unwrap();
        assert_eq!(parsed.chat_id, "12345");
        assert!(parsed.message_thread_id.is_none());
    }

    #[test]
    fn parse_channel_id_group_form() {
        let parsed =
            parse_telegram_channel_id("telegram:group:-100123:topic:42").unwrap();
        assert_eq!(parsed.chat_id, "-100123");
        assert_eq!(parsed.message_thread_id.as_deref(), Some("42"));
    }

    #[test]
    fn parse_channel_id_rejects_unrelated_strings() {
        assert!(parse_telegram_channel_id("not-telegram").is_none());
        assert!(parse_telegram_channel_id("telegram:").is_none());
        assert!(parse_telegram_channel_id("telegram:chat:").is_none());
        assert!(parse_telegram_channel_id("telegram:other:x").is_none());
    }

    #[test]
    fn parse_channel_id_round_trips_with_create() {
        let original_chat = create_telegram_channel_id("100", None);
        let parsed = parse_telegram_channel_id(&original_chat).unwrap();
        assert_eq!(parsed.chat_id, "100");
        assert!(parsed.message_thread_id.is_none());

        let original_group = create_telegram_channel_id("-200", Some("7"));
        let parsed = parse_telegram_channel_id(&original_group).unwrap();
        assert_eq!(parsed.chat_id, "-200");
        assert_eq!(parsed.message_thread_id.as_deref(), Some("7"));
    }

    // ── validation ──────────────────────────────────────────────────────

    #[test]
    fn validation_empty_chat_id_returns_required_message() {
        assert_eq!(
            get_telegram_thread_target_validation_error("", None).as_deref(),
            Some("Telegram chat ID is required")
        );
        // Whitespace-only is also empty after trim.
        assert_eq!(
            get_telegram_thread_target_validation_error("   ", None).as_deref(),
            Some("Telegram chat ID is required")
        );
    }

    #[test]
    fn validation_invalid_chat_id_returns_invalid_message() {
        assert_eq!(
            get_telegram_thread_target_validation_error("abc", None).as_deref(),
            Some("Invalid Telegram chat ID: abc")
        );
        // Trim before formatting.
        assert_eq!(
            get_telegram_thread_target_validation_error("  abc  ", None).as_deref(),
            Some("Invalid Telegram chat ID: abc")
        );
    }

    #[test]
    fn validation_chat_only_passes_when_id_is_numeric() {
        assert!(get_telegram_thread_target_validation_error("12345", None).is_none());
        assert!(get_telegram_thread_target_validation_error("-12345", None).is_none());
    }

    #[test]
    fn validation_passes_when_thread_is_empty_or_whitespace() {
        // TS: `if (!normalizedThreadId) return undefined;`
        assert!(
            get_telegram_thread_target_validation_error("12345", Some("")).is_none()
        );
        assert!(
            get_telegram_thread_target_validation_error("12345", Some("   ")).is_none()
        );
    }

    #[test]
    fn validation_invalid_thread_id_returns_format_message() {
        assert_eq!(
            get_telegram_thread_target_validation_error("-100", Some("abc")).as_deref(),
            Some("Invalid Telegram message thread ID: abc. Thread IDs must be numeric.")
        );
        // Negative thread IDs aren't valid.
        assert_eq!(
            get_telegram_thread_target_validation_error("-100", Some("-1"))
                .as_deref(),
            Some("Invalid Telegram message thread ID: -1. Thread IDs must be numeric.")
        );
    }

    #[test]
    fn validation_thread_with_non_group_chat_returns_target_message() {
        assert_eq!(
            get_telegram_thread_target_validation_error("100", Some("42")).as_deref(),
            Some("Invalid Telegram message thread target: chat 100 is not a group chat.")
        );
    }

    #[test]
    fn validation_passes_when_group_chat_with_numeric_thread() {
        assert!(
            get_telegram_thread_target_validation_error("-100", Some("42")).is_none()
        );
    }

    // ── native message id ──────────────────────────────────────────────

    #[test]
    fn create_native_message_id_uses_tg_prefix_and_normalises_negatives() {
        // chat_id with `-` becomes `n…`, message_id positive stays as is.
        assert_eq!(
            create_telegram_native_message_id("-100123", "42"),
            "tg_n100123_42"
        );
        assert_eq!(
            create_telegram_native_message_id("100", "200"),
            "tg_100_200"
        );
    }

    #[test]
    fn parse_native_message_id_round_trips_negative_chat() {
        let id = create_telegram_native_message_id("-100123", "42");
        let parsed = parse_telegram_native_message_id(&id).unwrap();
        assert_eq!(parsed.chat_id, "-100123");
        assert_eq!(parsed.message_id, "42");
    }

    #[test]
    fn parse_native_message_id_round_trips_positive_chat() {
        let id = create_telegram_native_message_id("100", "200");
        let parsed = parse_telegram_native_message_id(&id).unwrap();
        assert_eq!(parsed.chat_id, "100");
        assert_eq!(parsed.message_id, "200");
    }

    #[test]
    fn parse_native_message_id_rejects_bad_inputs() {
        assert!(parse_telegram_native_message_id("not_tg").is_none());
        assert!(parse_telegram_native_message_id("tg_").is_none()); // no payload
        assert!(parse_telegram_native_message_id("tg_only").is_none()); // no separator
        // Empty chat segment.
        assert!(parse_telegram_native_message_id("tg__42").is_none());
        // Empty message segment.
        assert!(parse_telegram_native_message_id("tg_chat_").is_none());
    }

    #[test]
    fn parse_native_message_id_uses_last_underscore_as_separator() {
        // If the chat segment normalised to contain underscores (it
        // shouldn't for plain numeric IDs, but the algorithm allows it),
        // the LAST underscore separates chat from message.
        let parsed = parse_telegram_native_message_id("tg_a_b_c_42").unwrap();
        // chat_segment = "a_b_c", message_segment = "42"
        // a_b_c does not start with `n` so denormalize is identity.
        assert_eq!(parsed.chat_id, "a_b_c");
        assert_eq!(parsed.message_id, "42");
    }
}
