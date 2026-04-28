//! Light, read-only helpers for the on-disk conversation tree at
//! `~/.tenex/projects/<dTag>/conversations/<conversationId>.json`.
//!
//! Mirrors `src/conversations/ConversationDiskReader.ts` (`:115-152`)
//! verbatim. No DB load, no full-store mount — pure file reads. Intended
//! consumer is `tenex doctor conversations status`, which needs to walk
//! every project's conversation file count + content-version breakdown
//! without touching the SQLite catalog.
//!
//! All functions silently return empty results on I/O errors / missing
//! directories — same as the TS source's `try { … } catch { return [] }`
//! shape. Conversation file content parsing failures are similarly
//! treated as "no metadata available" rather than propagated.

use serde_json::Value;

const PROJECTS_DIRNAME: &str = "projects";
const CONVERSATIONS_DIRNAME: &str = "conversations";

fn projects_base(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join(PROJECTS_DIRNAME)
}

fn conversations_dir(
    base_dir: &std::path::Path,
    project_dtag: &str,
) -> std::path::PathBuf {
    projects_base(base_dir).join(project_dtag).join(CONVERSATIONS_DIRNAME)
}

fn conversation_file(
    base_dir: &std::path::Path,
    project_dtag: &str,
    conversation_id: &str,
) -> std::path::PathBuf {
    conversations_dir(base_dir, project_dtag).join(format!("{conversation_id}.json"))
}

/// `listProjectIdsFromDisk` (`ConversationDiskReader.ts:118-133`).
///
/// Returns every subdirectory name under `<base_dir>/projects/`. Missing
/// dir → empty Vec. Order follows OS readdir order (mirrors TS, no
/// explicit sort).
pub fn list_project_ids_from_disk(base_dir: &std::path::Path) -> Vec<String> {
    let dir = projects_base(base_dir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                out.push(name.to_owned());
            }
        }
    }
    out
}

/// `listConversationIdsFromDiskForProject` (`:138-152`).
///
/// Lists every `*.json` filename (sans extension) under
/// `<base_dir>/projects/<project_dtag>/conversations/`. Missing dir →
/// empty Vec.
pub fn list_conversation_ids_from_project(
    base_dir: &std::path::Path,
    project_dtag: &str,
) -> Vec<String> {
    let dir = conversations_dir(base_dir, project_dtag);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if let Some(stem) = name.strip_suffix(".json") {
            out.push(stem.to_owned());
        }
    }
    out
}

/// Lightweight metadata pulled from a conversation file. Mirrors the
/// inline shape returned at `ConversationDiskReader.ts:18-46`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LightweightMetadata {
    pub id: String,
    /// Timestamp of the last message, or `0` if no messages.
    pub last_activity: u64,
    pub title: Option<String>,
    pub summary: Option<String>,
    /// `metadata.lastUserMessage` (preferred) falling back to
    /// `metadata.last_user_message` — the TS code mirrors both spellings
    /// for legacy compatibility.
    pub last_user_message: Option<String>,
}

/// `readLightweightMetadata` (`:15-46`). Returns `None` for missing
/// file, parse errors, or any I/O failure (matches the TS `catch
/// { return null }` shape).
pub fn read_lightweight_metadata(
    base_dir: &std::path::Path,
    project_dtag: &str,
    conversation_id: &str,
) -> Option<LightweightMetadata> {
    let path = conversation_file(base_dir, project_dtag, conversation_id);
    let bytes = std::fs::read(&path).ok()?;
    let parsed: Value = serde_json::from_slice(&bytes).ok()?;

    let messages = parsed.get("messages").and_then(Value::as_array);
    let last_activity = messages
        .and_then(|m| m.last())
        .and_then(|m| m.get("timestamp"))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let metadata = parsed.get("metadata").and_then(Value::as_object);
    let title = metadata
        .and_then(|m| m.get("title"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let summary = metadata
        .and_then(|m| m.get("summary"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let last_user_message = metadata
        .and_then(|m| {
            m.get("lastUserMessage")
                .or_else(|| m.get("last_user_message"))
        })
        .and_then(Value::as_str)
        .map(str::to_owned);

    Some(LightweightMetadata {
        id: conversation_id.to_owned(),
        last_activity,
        title,
        summary,
        last_user_message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-conv-disk-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_conversation(
        base: &std::path::Path,
        project: &str,
        id: &str,
        body: &str,
    ) {
        let dir = conversations_dir(base, project);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.json")), body).unwrap();
    }

    // ── list_project_ids_from_disk ─────────────────────────────────────

    #[test]
    fn list_projects_returns_empty_when_projects_dir_absent() {
        let base = unique_temp();
        assert!(list_project_ids_from_disk(&base).is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn list_projects_returns_subdirectory_names() {
        let base = unique_temp();
        std::fs::create_dir_all(projects_base(&base).join("alpha")).unwrap();
        std::fs::create_dir_all(projects_base(&base).join("beta")).unwrap();
        let mut got = list_project_ids_from_disk(&base);
        got.sort();
        assert_eq!(got, vec!["alpha".to_string(), "beta".to_string()]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn list_projects_skips_files() {
        let base = unique_temp();
        std::fs::create_dir_all(projects_base(&base)).unwrap();
        std::fs::create_dir_all(projects_base(&base).join("real-project")).unwrap();
        std::fs::write(projects_base(&base).join("stray.txt"), "x").unwrap();
        let got = list_project_ids_from_disk(&base);
        assert_eq!(got, vec!["real-project".to_string()]);
        std::fs::remove_dir_all(&base).ok();
    }

    // ── list_conversation_ids_from_project ─────────────────────────────

    #[test]
    fn list_conversations_returns_empty_for_missing_dir() {
        let base = unique_temp();
        let got = list_conversation_ids_from_project(&base, "ghost");
        assert!(got.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn list_conversations_strips_json_extension() {
        let base = unique_temp();
        write_conversation(&base, "p1", "abc", r#"{"messages":[]}"#);
        write_conversation(&base, "p1", "def", r#"{"messages":[]}"#);
        let mut got = list_conversation_ids_from_project(&base, "p1");
        got.sort();
        assert_eq!(got, vec!["abc".to_string(), "def".to_string()]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn list_conversations_skips_non_json_files() {
        let base = unique_temp();
        let dir = conversations_dir(&base, "p1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("real.json"), r#"{"messages":[]}"#).unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        std::fs::write(dir.join("README.md"), "x").unwrap();
        let got = list_conversation_ids_from_project(&base, "p1");
        assert_eq!(got, vec!["real".to_string()]);
        std::fs::remove_dir_all(&base).ok();
    }

    // ── read_lightweight_metadata ──────────────────────────────────────

    #[test]
    fn metadata_returns_none_for_missing_file() {
        let base = unique_temp();
        assert!(read_lightweight_metadata(&base, "p1", "ghost").is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn metadata_returns_none_for_malformed_json() {
        let base = unique_temp();
        write_conversation(&base, "p1", "broken", "not-json");
        assert!(read_lightweight_metadata(&base, "p1", "broken").is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn metadata_extracts_last_activity_from_last_message_timestamp() {
        let base = unique_temp();
        write_conversation(
            &base,
            "p1",
            "c1",
            r#"{"messages":[{"timestamp":1000},{"timestamp":2000}]}"#,
        );
        let m = read_lightweight_metadata(&base, "p1", "c1").unwrap();
        assert_eq!(m.id, "c1");
        assert_eq!(m.last_activity, 2000);
        assert!(m.title.is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn metadata_zero_last_activity_when_no_messages() {
        let base = unique_temp();
        write_conversation(&base, "p1", "empty", r#"{"messages":[]}"#);
        let m = read_lightweight_metadata(&base, "p1", "empty").unwrap();
        assert_eq!(m.last_activity, 0);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn metadata_zero_last_activity_when_messages_missing_timestamp() {
        let base = unique_temp();
        write_conversation(
            &base,
            "p1",
            "no-ts",
            r#"{"messages":[{"content":"x"}]}"#,
        );
        let m = read_lightweight_metadata(&base, "p1", "no-ts").unwrap();
        assert_eq!(m.last_activity, 0);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn metadata_extracts_title_summary_from_metadata_object() {
        let base = unique_temp();
        write_conversation(
            &base,
            "p1",
            "c1",
            r#"{
                "messages": [],
                "metadata": {
                    "title": "Hello",
                    "summary": "Brief"
                }
            }"#,
        );
        let m = read_lightweight_metadata(&base, "p1", "c1").unwrap();
        assert_eq!(m.title.as_deref(), Some("Hello"));
        assert_eq!(m.summary.as_deref(), Some("Brief"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn metadata_prefers_camel_case_last_user_message_over_snake_case() {
        // TS source: `metadata?.lastUserMessage ?? metadata?.last_user_message`
        let base = unique_temp();
        write_conversation(
            &base,
            "p1",
            "c1",
            r#"{
                "messages": [],
                "metadata": {
                    "lastUserMessage": "camelCase",
                    "last_user_message": "snake_case"
                }
            }"#,
        );
        let m = read_lightweight_metadata(&base, "p1", "c1").unwrap();
        assert_eq!(m.last_user_message.as_deref(), Some("camelCase"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn metadata_falls_back_to_snake_case_when_camel_absent() {
        let base = unique_temp();
        write_conversation(
            &base,
            "p1",
            "c1",
            r#"{
                "messages": [],
                "metadata": {
                    "last_user_message": "snake_only"
                }
            }"#,
        );
        let m = read_lightweight_metadata(&base, "p1", "c1").unwrap();
        assert_eq!(m.last_user_message.as_deref(), Some("snake_only"));
        std::fs::remove_dir_all(&base).ok();
    }
}
