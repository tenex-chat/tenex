//! Conversation storage adapter: reads the canonical on-disk layout used by
//! the bun runtime today (per-project JSON transcripts plus the per-project
//! `conversation-catalog.db` SQLite). When `tenex-conversations` lands this
//! file is replaced wholesale; nothing outside it knows the format.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::paths;

#[derive(Debug, Clone)]
pub struct ProjectRef {
    pub d_tag: String,
    pub root: PathBuf,
    pub catalog_db: PathBuf,
    pub conversations_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CandidateRow {
    pub conversation_id: String,
    /// Last activity in seconds (catalog timestamp).
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

/// Enumerate every project under `~/.tenex/projects/` that has both an
/// `event.json` and a `conversation-catalog.db`. Missing pieces are logged and
/// skipped — projects appear before the catalog has been written, and that's
/// fine.
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
        let catalog = dir.join("conversation-catalog.db");
        let conversations = dir.join("conversations");
        if !catalog.exists() {
            continue;
        }
        out.push(ProjectRef {
            d_tag,
            root: dir.clone(),
            catalog_db: catalog,
            conversations_dir: conversations,
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

/// Catalog rows whose `last_activity` is at least `quiet_seconds` ago. Pure
/// read; no joins. The summarizer's polling decides which of these need work.
pub fn list_candidates(project: &ProjectRef, quiet_seconds: i64) -> Result<Vec<CandidateRow>> {
    let now_secs = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)) as i64;
    let max_activity = now_secs - quiet_seconds;

    let conn = Connection::open_with_flags(
        &project.catalog_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open ro {}", project.catalog_db.display()))?;

    let mut stmt = conn.prepare(
        "SELECT conversation_id, COALESCE(last_activity, 0) AS la
           FROM conversations
          WHERE COALESCE(last_activity, 0) > 0
            AND COALESCE(last_activity, 0) <= ?
          ORDER BY la DESC",
    )?;
    let rows = stmt.query_map([max_activity], |row| {
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

#[derive(Debug, Deserialize, Serialize)]
struct OnDiskMessage {
    #[serde(rename = "messageType")]
    message_type: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(rename = "senderPrincipal", default)]
    sender_principal: Option<SenderPrincipal>,
    #[serde(rename = "senderPubkey", default)]
    sender_pubkey: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct SenderPrincipal {
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(default)]
    username: Option<String>,
}

pub fn fetch_content(
    project: &ProjectRef,
    project_event: &ProjectEvent,
    conversation_id: &str,
) -> Result<Option<ConversationContent>> {
    let path = project
        .conversations_dir
        .join(format!("{conversation_id}.json"));
    if !path.exists() {
        return Ok(None);
    }

    let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;

    #[derive(Deserialize)]
    struct OnDiskConversation {
        #[serde(default)]
        messages: Vec<OnDiskMessage>,
    }

    let parsed: OnDiskConversation =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;

    let mut lines = Vec::new();
    for m in parsed.messages.iter().filter(|m| m.message_type == "text") {
        let speaker = display_name_for(m);
        lines.push(format!("{speaker}: {}", m.content));
    }
    let transcript = lines.join("\n\n");

    Ok(Some(ConversationContent {
        transcript,
        project_event: project_event.clone(),
    }))
}

fn display_name_for(m: &OnDiskMessage) -> String {
    if let Some(p) = &m.sender_principal {
        if let Some(name) = p.display_name.as_deref().filter(|s| !s.is_empty()) {
            return name.to_string();
        }
        if let Some(name) = p.username.as_deref().filter(|s| !s.is_empty()) {
            return name.to_string();
        }
    }
    if let Some(pk) = m.sender_pubkey.as_deref().filter(|s| !s.is_empty()) {
        return pk.chars().take(8).collect();
    }
    if m.role.as_deref() == Some("system") {
        return "system".to_string();
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

/// Writes title/summary/status into the conversation JSON's `metadata` field,
/// matching the bun runtime's `ConversationStore.updateMetadata` shape.
/// Other top-level keys are preserved verbatim.
pub fn write_metadata(
    project: &ProjectRef,
    conversation_id: &str,
    update: &MetadataUpdate,
) -> Result<()> {
    let path = project
        .conversations_dir
        .join(format!("{conversation_id}.json"));
    if !path.exists() {
        return Ok(());
    }
    let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;

    let metadata = value
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("conversation root is not an object: {}", path.display()))?
        .entry("metadata")
        .or_insert_with(|| serde_json::json!({}));
    let metadata_obj = metadata
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("metadata is not an object: {}", path.display()))?;

    if let Some(t) = &update.title {
        metadata_obj.insert("title".into(), serde_json::Value::String(t.clone()));
    }
    if let Some(s) = &update.summary {
        metadata_obj.insert("summary".into(), serde_json::Value::String(s.clone()));
    }
    if let Some(s) = &update.status_label {
        metadata_obj.insert("statusLabel".into(), serde_json::Value::String(s.clone()));
    }
    if let Some(s) = &update.status_current_activity {
        metadata_obj.insert(
            "statusCurrentActivity".into(),
            serde_json::Value::String(s.clone()),
        );
    }

    let serialized = serde_json::to_vec_pretty(&value)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}
