//! Conversation storage adapter for the per-project `conversation.db` file.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;
use tenex_conversations::{ConversationStore, MessageQuery, MessageRecord, ProjectRef};
use tenex_project::Signer;

use crate::paths;

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

/// Enumerate projects under the host's TENEX base directory.
pub fn discover_projects() -> Result<Vec<ProjectRef>> {
    tenex_conversations::discover_projects(&paths::base_dir())
}

/// PM identity for a project — the first agent listed in the project's
/// kind:31933 event.
///
/// `pubkey` is always known when this returns `Some`; it is the authority
/// for kind:513 events for this project (publishers sign with it,
/// ingesters authenticate against it).
///
/// `local_signer` is `Some` only when the PM agent has a usable on-disk
/// projection on this backend — i.e., this backend can sign as the PM
/// and is therefore the publisher for the project. Other backends keep
/// `local_signer = None` and rely on the ingester to receive metadata.
pub struct PmIdentity {
    pub pubkey: String,
    pub local_signer: Option<Box<dyn Signer>>,
}

/// Resolve the PM identity for a project from on-disk state. Returns
/// `None` when the project has no agents listed in its kind:31933 event.
pub fn pm_identity(d_tag: &str, base_dir: &Path) -> Result<Option<PmIdentity>> {
    let project = tenex_project::Project::open(d_tag, base_dir)
        .with_context(|| format!("open project {d_tag}"))?;
    let agents = project
        .project_agents()
        .with_context(|| format!("read project agents for {d_tag}"))?;
    let Some(pm) = agents.into_iter().find(|a| a.is_pm) else {
        return Ok(None);
    };

    let agent = project
        .agent_by_pubkey(&pm.agent_pubkey)
        .with_context(|| format!("read PM agent {} for {d_tag}", pm.agent_pubkey))?;
    let local_signer = match agent {
        Some(a) if a.is_local => match project.signer_for_agent(&pm.agent_pubkey)? {
            Ok(signer) => Some(signer),
            Err(e) => {
                return Err(anyhow::anyhow!(
                    "PM agent {} for {d_tag} has signer_ref but signer_for_agent failed: {e}",
                    pm.agent_pubkey
                ));
            }
        },
        _ => None,
    };

    Ok(Some(PmIdentity {
        pubkey: pm.agent_pubkey,
        local_signer,
    }))
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
