use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;
use thiserror::Error;

const METADATA_DIR_NAME: &str = ".tenex";
const CONVERSATIONS_DIR_NAME: &str = "conversations";

#[derive(Debug, Error)]
pub enum RootEventLookupError {
    #[error("conversation file io error at {path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("conversation file json error at {path}: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
}

pub type RootEventLookupResult<T> = Result<T, RootEventLookupError>;

pub fn conversation_file_path(project_base_path: &Path, conversation_id: &str) -> PathBuf {
    project_base_path
        .join(METADATA_DIR_NAME)
        .join(CONVERSATIONS_DIR_NAME)
        .join(format!("{conversation_id}.json"))
}

/// Return the author pubkey of the conversation's root event, or `None` if
/// the conversation file does not exist or the root cannot be located.
pub fn read_root_event_author(
    project_base_path: &Path,
    conversation_id: &str,
) -> RootEventLookupResult<Option<String>> {
    let path = conversation_file_path(project_base_path, conversation_id);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(RootEventLookupError::Io { path, source }),
    };
    let state: Value =
        serde_json::from_str(&content).map_err(|source| RootEventLookupError::Json {
            path: path.clone(),
            source,
        })?;
    Ok(extract_root_author(&state, conversation_id))
}

/// Return the most recent post by `user_pubkey` in the conversation that is
/// newer than `after_ms` (milliseconds since epoch). Used at fire time to
/// detect a user reply between arm and fire.
pub fn user_replied_after(
    project_base_path: &Path,
    conversation_id: &str,
    user_pubkey: &str,
    after_ms: u64,
) -> RootEventLookupResult<bool> {
    let path = conversation_file_path(project_base_path, conversation_id);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(source) => return Err(RootEventLookupError::Io { path, source }),
    };
    let state: Value =
        serde_json::from_str(&content).map_err(|source| RootEventLookupError::Json {
            path: path.clone(),
            source,
        })?;
    let Some(messages) = state.get("messages").and_then(Value::as_array) else {
        return Ok(false);
    };
    Ok(messages
        .iter()
        .any(|message| message_matches_user_after(message, user_pubkey, after_ms)))
}

fn extract_root_author(state: &Value, conversation_id: &str) -> Option<String> {
    let messages = state.get("messages").and_then(Value::as_array)?;
    let root = messages
        .iter()
        .find(|message| message.get("eventId").and_then(Value::as_str) == Some(conversation_id))
        .or_else(|| messages.first())?;
    message_author_pubkey(root)
}

fn message_author_pubkey(message: &Value) -> Option<String> {
    if let Some(sender_principal) = message.get("senderPrincipal")
        && let Some(linked) = sender_principal.get("linkedPubkey").and_then(Value::as_str)
        && !linked.is_empty()
    {
        return Some(linked.to_string());
    }
    if let Some(sender_pubkey) = message.get("senderPubkey").and_then(Value::as_str)
        && !sender_pubkey.is_empty()
    {
        return Some(sender_pubkey.to_string());
    }
    message
        .get("pubkey")
        .and_then(Value::as_str)
        .filter(|pubkey| !pubkey.is_empty())
        .map(str::to_string)
}

fn message_matches_user_after(message: &Value, user_pubkey: &str, after_ms: u64) -> bool {
    let Some(author) = message_author_pubkey(message) else {
        return false;
    };
    if author != user_pubkey {
        return false;
    }
    let timestamp_ms = match message.get("timestamp") {
        Some(Value::Number(number)) => number
            .as_u64()
            .or_else(|| number.as_i64().map(|v| v as u64)),
        _ => None,
    };
    timestamp_ms.is_some_and(|ts| ts > after_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_project_base() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("tenex-intervention-root-{nanos}-{counter}"));
        fs::create_dir_all(dir.join(METADATA_DIR_NAME).join(CONVERSATIONS_DIR_NAME))
            .expect("create temp dirs");
        dir
    }

    fn write_conversation(dir: &Path, conv_id: &str, value: &Value) {
        let path = conversation_file_path(dir, conv_id);
        fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
    }

    #[test]
    fn returns_none_for_missing_file() {
        let base = unique_temp_project_base();
        let result = read_root_event_author(&base, "conv-missing").expect("read");
        assert_eq!(result, None);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn finds_root_by_matching_event_id() {
        let base = unique_temp_project_base();
        let conv = "conv-alpha";
        let author = "aa".repeat(32);
        write_conversation(
            &base,
            conv,
            &json!({
                "messages": [
                    {"eventId": "unrelated", "senderPubkey": "bb".repeat(32)},
                    {"eventId": conv, "senderPubkey": author.clone()},
                ]
            }),
        );
        let result = read_root_event_author(&base, conv).expect("read");
        assert_eq!(result, Some(author));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn falls_back_to_first_message_when_event_id_missing() {
        let base = unique_temp_project_base();
        let conv = "conv-alpha";
        let first_author = "aa".repeat(32);
        write_conversation(
            &base,
            conv,
            &json!({
                "messages": [
                    {"senderPubkey": first_author.clone()},
                    {"senderPubkey": "bb".repeat(32)},
                ]
            }),
        );
        let result = read_root_event_author(&base, conv).expect("read");
        assert_eq!(result, Some(first_author));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn prefers_linked_pubkey_from_sender_principal() {
        let base = unique_temp_project_base();
        let conv = "conv-alpha";
        let linked = "aa".repeat(32);
        write_conversation(
            &base,
            conv,
            &json!({
                "messages": [
                    {
                        "eventId": conv,
                        "senderPubkey": "cc".repeat(32),
                        "senderPrincipal": {"linkedPubkey": linked.clone()},
                    }
                ]
            }),
        );
        let result = read_root_event_author(&base, conv).expect("read");
        assert_eq!(result, Some(linked));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn detects_user_reply_after_timestamp() {
        let base = unique_temp_project_base();
        let conv = "conv-alpha";
        let user = "aa".repeat(32);
        write_conversation(
            &base,
            conv,
            &json!({
                "messages": [
                    {"eventId": conv, "senderPubkey": user.clone(), "timestamp": 1_000},
                    {"senderPubkey": "bb".repeat(32), "timestamp": 1_500},
                    {"senderPubkey": user.clone(), "timestamp": 2_000},
                ]
            }),
        );
        assert!(user_replied_after(&base, conv, &user, 1_500).expect("read"));
        assert!(!user_replied_after(&base, conv, &user, 2_500).expect("read"));
        assert!(
            !user_replied_after(&base, conv, &"cc".repeat(32), 100).expect("read"),
            "unrelated user must not trigger reply detection",
        );
        fs::remove_dir_all(&base).ok();
    }
}
