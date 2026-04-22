//! Port of `parseTelegramChannelId` / `getTelegramThreadTargetValidationError`
//! from `src/utils/telegram-identifiers.ts`.
//!
//! The worker's proactive `send_message` tool hands us a TENEX channel id
//! (for example `telegram:chat:1234` or `telegram:group:-1001:topic:77`);
//! before we can enqueue a delivery we must recover the `(chat_id,
//! message_thread_id)` pair and validate the thread target semantics.

use thiserror::Error;

/// Parsed Telegram channel id produced by [`parse_telegram_channel_id`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramChannelIdParts {
    pub chat_id: i64,
    pub message_thread_id: Option<i64>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TelegramChannelIdError {
    #[error("channel id must start with 'telegram:' and decode to a known shape")]
    Malformed,
    #[error("telegram chat id segment is empty")]
    MissingChatId,
    #[error("telegram chat id '{value}' is not a valid i64 integer")]
    InvalidChatId { value: String },
    #[error("telegram message thread id '{value}' must be a non-negative integer parseable as i64")]
    InvalidMessageThreadId { value: String },
    #[error(
        "telegram message thread target requires a group chat (negative chat id), got {chat_id}"
    )]
    ThreadTargetRequiresGroup { chat_id: i64 },
}

/// Parse a TENEX telegram channel id into `(chat_id, message_thread_id?)`.
///
/// Shapes mirrored from the TS source:
///
/// - `telegram:chat:<chat_id>` — direct chat, no thread
/// - `telegram:group:<chat_id>:topic:<message_thread_id>` — group topic
///
/// The TS parser returned `undefined` for any unrecognized shape. The Rust
/// port returns [`TelegramChannelIdError::Malformed`] so callers can surface
/// a structured reason to the agent.
pub fn parse_telegram_channel_id(
    channel_id: &str,
) -> Result<TelegramChannelIdParts, TelegramChannelIdError> {
    let Some(rest) = channel_id.strip_prefix("telegram:") else {
        return Err(TelegramChannelIdError::Malformed);
    };

    let parts: Vec<&str> = rest.split(':').collect();

    match parts.as_slice() {
        ["chat", chat_segment] => {
            if chat_segment.is_empty() {
                return Err(TelegramChannelIdError::MissingChatId);
            }
            let chat_id = parse_chat_id(chat_segment)?;
            Ok(TelegramChannelIdParts {
                chat_id,
                message_thread_id: None,
            })
        }
        ["group", chat_segment, "topic", thread_segment] => {
            if chat_segment.is_empty() {
                return Err(TelegramChannelIdError::MissingChatId);
            }
            let chat_id = parse_chat_id(chat_segment)?;
            let message_thread_id = if thread_segment.is_empty() {
                None
            } else {
                Some(parse_message_thread_id(thread_segment)?)
            };
            validate_thread_target(chat_id, message_thread_id)?;
            Ok(TelegramChannelIdParts {
                chat_id,
                message_thread_id,
            })
        }
        _ => Err(TelegramChannelIdError::Malformed),
    }
}

fn parse_chat_id(value: &str) -> Result<i64, TelegramChannelIdError> {
    value
        .parse::<i64>()
        .map_err(|_| TelegramChannelIdError::InvalidChatId {
            value: value.to_string(),
        })
}

fn parse_message_thread_id(value: &str) -> Result<i64, TelegramChannelIdError> {
    // TS validation requires `^\d+$` (non-negative). A signed parse would
    // silently accept negative thread ids; rely on the ASCII-digit-only
    // check before converting.
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(TelegramChannelIdError::InvalidMessageThreadId {
            value: value.to_string(),
        });
    }
    value
        .parse::<i64>()
        .map_err(|_| TelegramChannelIdError::InvalidMessageThreadId {
            value: value.to_string(),
        })
}

fn validate_thread_target(
    chat_id: i64,
    message_thread_id: Option<i64>,
) -> Result<(), TelegramChannelIdError> {
    if message_thread_id.is_some() && chat_id >= 0 {
        return Err(TelegramChannelIdError::ThreadTargetRequiresGroup { chat_id });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_direct_chat() {
        let parts = parse_telegram_channel_id("telegram:chat:1234").expect("chat must parse");
        assert_eq!(
            parts,
            TelegramChannelIdParts {
                chat_id: 1234,
                message_thread_id: None,
            }
        );
    }

    #[test]
    fn parses_group_topic() {
        let parts = parse_telegram_channel_id("telegram:group:-1001:topic:77")
            .expect("group topic must parse");
        assert_eq!(
            parts,
            TelegramChannelIdParts {
                chat_id: -1001,
                message_thread_id: Some(77),
            }
        );
    }

    #[test]
    fn rejects_missing_telegram_prefix() {
        assert_eq!(
            parse_telegram_channel_id("1001"),
            Err(TelegramChannelIdError::Malformed)
        );
    }

    #[test]
    fn rejects_non_numeric_thread_id() {
        let error = parse_telegram_channel_id("telegram:group:-1001:topic:abc")
            .expect_err("non-numeric thread id must fail");
        assert_eq!(
            error,
            TelegramChannelIdError::InvalidMessageThreadId {
                value: "abc".to_string(),
            }
        );
    }

    #[test]
    fn rejects_thread_target_on_non_group_chat() {
        let error = parse_telegram_channel_id("telegram:group:5104033799:topic:77")
            .expect_err("positive chat id must not accept thread target");
        assert_eq!(
            error,
            TelegramChannelIdError::ThreadTargetRequiresGroup {
                chat_id: 5104033799
            }
        );
    }

    #[test]
    fn rejects_non_numeric_chat_id() {
        let error = parse_telegram_channel_id("telegram:chat:abc")
            .expect_err("non-numeric chat id must fail");
        assert_eq!(
            error,
            TelegramChannelIdError::InvalidChatId {
                value: "abc".to_string(),
            }
        );
    }

    #[test]
    fn rejects_unknown_shape() {
        assert_eq!(
            parse_telegram_channel_id("telegram:wat:1234"),
            Err(TelegramChannelIdError::Malformed)
        );
    }

    #[test]
    fn allows_group_topic_with_empty_thread_segment_matching_ts() {
        // TS parser returned `messageThreadId: undefined` when the topic
        // segment was empty; validation of the empty thread is the caller's
        // responsibility. We mirror that by accepting the absence.
        let parts = parse_telegram_channel_id("telegram:group:-1001:topic:")
            .expect("empty topic must parse as no-thread");
        assert_eq!(
            parts,
            TelegramChannelIdParts {
                chat_id: -1001,
                message_thread_id: None,
            }
        );
    }
}
