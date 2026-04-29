//! Conversation storage adapter for the per-project `conversation.db` file.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::Deserialize;
use tenex_conversations::{ConversationStore, MessageQuery, MessageRecord};

use crate::paths;

#[derive(Debug, Clone)]
pub struct ProjectRef {
    pub d_tag: String,
    pub root: PathBuf,
    pub conversation_db: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CandidateRow {
    pub conversation_id: String,
    /// Last activity in seconds.
    pub last_activity: i64,
}

#[derive(Debug)]
pub struct ConversationContent {
    pub transcript: String,
    pub project_event: ProjectEvent,
}

#[derive(Debug, Clone)]
pub struct ProjectEvent {
    pub pubkey: String,
    pub d_tag: String,
}

impl ProjectEvent {
    pub fn tag_id(&self) -> String {
        format!("31933:{}:{}", self.pubkey, self.d_tag)
    }
}

/// Enumerate projects under `~/.tenex/projects/` that have the project event
/// and the canonical conversation database.
pub fn discover_projects() -> Result<Vec<ProjectRef>> {
    let root = paths::projects_dir();
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).with_context(|| format!("read {}", root.display()))? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        let d_tag = match dir.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let event = dir.join("event.json");
        let conversation_db = dir.join(tenex_conversations::paths::CONVERSATION_DB_FILENAME);
        if !event.exists() || !conversation_db.exists() {
            continue;
        }
        out.push(ProjectRef {
            d_tag,
            root: dir,
            conversation_db,
        });
    }
    out.sort_by(|a, b| a.d_tag.cmp(&b.d_tag));
    Ok(out)
}

pub fn load_project_event(project: &ProjectRef) -> Result<ProjectEvent> {
    #[derive(Deserialize)]
    struct OnDisk {
        pubkey: String,
        tags: Vec<Vec<String>>,
    }

    let path = project.root.join("event.json");
    let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let parsed: OnDisk =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    let d_tag = parsed
        .tags
        .iter()
        .find(|t| t.first().map(String::as_str) == Some("d"))
        .and_then(|t| t.get(1).cloned())
        .unwrap_or_else(|| project.d_tag.clone());
    Ok(ProjectEvent {
        pubkey: parsed.pubkey,
        d_tag,
    })
}

/// Conversations whose latest message activity is between `max_age_seconds`
/// and `quiet_seconds` ago.
pub fn list_candidates(
    project: &ProjectRef,
    quiet_seconds: i64,
    max_age_seconds: i64,
) -> Result<Vec<CandidateRow>> {
    let now_secs = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)) as i64;
    let max_activity = now_secs - quiet_seconds;
    let min_activity = now_secs - max_age_seconds;

    let store = ConversationStore::open(&project.conversation_db)
        .with_context(|| format!("open {}", project.conversation_db.display()))?;
    let mut stmt = store.connection().prepare(
        "SELECT conversation_id,
                MAX(COALESCE(timestamp, created_at / 1000)) AS last_activity
           FROM messages
          GROUP BY conversation_id
         HAVING last_activity >= ?1
            AND last_activity <= ?2
          ORDER BY last_activity DESC",
    )?;
    let rows = stmt.query_map([min_activity, max_activity], |row| {
        Ok(CandidateRow {
            conversation_id: row.get(0)?,
            last_activity: row.get(1)?,
        })
    })?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn fetch_content(
    project: &ProjectRef,
    project_event: &ProjectEvent,
    conversation_id: &str,
) -> Result<Option<ConversationContent>> {
    let store = ConversationStore::open(&project.conversation_db)
        .with_context(|| format!("open {}", project.conversation_db.display()))?;
    if store.get_conversation(conversation_id)?.is_none() {
        return Ok(None);
    }

    let messages = store.list_messages(conversation_id, MessageQuery::default())?;
    let mut lines = Vec::new();
    for message in messages.iter().filter(|m| m.message_type == "text") {
        let speaker = display_name_for(message);
        lines.push(format!("{speaker}: {}", message.content));
    }
    let transcript = lines.join("\n\n");

    Ok(Some(ConversationContent {
        transcript,
        project_event: project_event.clone(),
    }))
}

fn display_name_for(message: &MessageRecord) -> String {
    if message.role.as_deref() == Some("system") {
        return "system".to_string();
    }

    if let Some(principal) = &message.sender_principal {
        if let Some(name) = principal
            .get("displayName")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return name.to_string();
        }
        if let Some(name) = principal
            .get("username")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return name.to_string();
        }
    }
    if let Some(pk) = message.sender_pubkey.as_deref().filter(|s| !s.is_empty()) {
        return pk.chars().take(8).collect();
    }
    if !message.author_pubkey.is_empty() {
        return message.author_pubkey.chars().take(8).collect();
    }
    "unknown".to_string()
}

#[derive(Debug, Clone)]
pub struct MetadataUpdate {
    pub title: Option<String>,
    pub summary: Option<String>,
    pub status_label: Option<String>,
    pub status_current_activity: Option<String>,
}

pub fn write_metadata(
    project: &ProjectRef,
    conversation_id: &str,
    update: &MetadataUpdate,
) -> Result<()> {
    let store = ConversationStore::open(&project.conversation_db)
        .with_context(|| format!("open {}", project.conversation_db.display()))?;
    store.update_metadata(
        conversation_id,
        update.title.as_deref(),
        update.summary.as_deref(),
        update.status_label.as_deref(),
        update.status_current_activity.as_deref(),
    )?;
    Ok(())
}
