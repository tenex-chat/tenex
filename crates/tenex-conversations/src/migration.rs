//! One-time data migration from the four legacy stores into the
//! consolidated `conversation.db`.
//!
//! Sources, in priority order:
//!
//! 1. JSON transcripts at `<base>/projects/<dTag>/conversations/*.json` —
//!    canonical content (messages, metadata, prompt-history, context state).
//! 2. Legacy catalog DB at `<base>/projects/<dTag>/conversation-catalog.db`
//!    — title/summary/lastUserMessage/statusLabel header data is also in
//!    the JSON metadata, so we use the catalog as a fallback only when the
//!    JSON metadata block is missing a field. Embedding state is RAG
//!    concern and not migrated. Participants / delegations are derived
//!    from messages on read, not stored separately.
//! 3. Tool-messages at `<base>/tool-messages/`. Two on-disk shapes:
//!    - Nested: `<base>/tool-messages/<conversationId>/<toolCallId>.json`
//!      (current TS code). The `conversationId` is also embedded in the file.
//!    - Flat: `<base>/tool-messages/<eventId>.json` (older shape). The
//!      file's outer `eventId` is the conversation id.
//!
//! Lessons are out of scope. They live elsewhere; this migration leaves
//! them untouched.
//!
//! On success, source files are renamed with `.legacy.bak` so the operator
//! can verify before deleting. The migration is idempotent: re-running it
//! after a partial failure resumes from where it stopped because writes
//! are idempotent on `record_id` / `tool_call_id` / `nostr_event_id`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::OptionalExtension;
use serde::Deserialize;

use crate::error::{ConversationsError, Result};
use crate::ids::normalize_project_id;
use crate::model::{
    AgentContextState, ConversationRow, NewMessage, NewPromptHistoryEntry, NewToolMessage,
};
use crate::paths::{
    conversation_db_path, legacy_catalog_db_path, legacy_conversations_dir,
    legacy_tool_messages_dir, project_dir, LEGACY_BAK_SUFFIX,
};
use crate::store::ConversationStore;

#[derive(Debug, Default, Clone)]
pub struct MigrationReport {
    pub conversations_migrated: usize,
    pub messages_migrated: usize,
    pub prompt_history_entries_migrated: usize,
    pub agent_context_states_migrated: usize,
    pub tool_messages_migrated: usize,
    pub flat_tool_messages_skipped: usize,
    pub catalog_only_conversations: usize,
    pub legacy_files_archived: Vec<PathBuf>,
    pub warnings: Vec<String>,
}

pub fn migrate_from_legacy(project_id: &str, base_dir: &Path) -> Result<MigrationReport> {
    let d_tag = normalize_project_id(project_id)?;
    let mut report = MigrationReport::default();

    let project_root = project_dir(base_dir, &d_tag);
    fs::create_dir_all(&project_root)?;

    let mut store = ConversationStore::open(&conversation_db_path(base_dir, &d_tag))?;

    let catalog_headers = read_legacy_catalog(&legacy_catalog_db_path(base_dir, &d_tag))?;

    let conversations_dir = legacy_conversations_dir(base_dir, &d_tag);
    let mut migrated_conversation_ids: Vec<String> = Vec::new();

    if conversations_dir.is_dir() {
        for entry in fs::read_dir(&conversations_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let conversation_id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) if !s.is_empty() => s.to_owned(),
                _ => continue,
            };

            match migrate_conversation_json(&store, &path, &conversation_id, &catalog_headers) {
                Ok(stats) => {
                    report.conversations_migrated += 1;
                    report.messages_migrated += stats.messages;
                    report.prompt_history_entries_migrated += stats.prompt_history;
                    report.agent_context_states_migrated += stats.agent_context_states;
                    migrated_conversation_ids.push(conversation_id);
                }
                Err(err) => {
                    report.warnings.push(format!(
                        "failed to migrate conversation file {}: {err}",
                        path.display()
                    ));
                }
            }
        }
    }

    // Carry forward catalog-only conversations (rows in the catalog DB
    // without a corresponding JSON transcript on disk). Their header data
    // is preserved; messages will be empty until reingested.
    for (conversation_id, header) in &catalog_headers {
        if migrated_conversation_ids
            .iter()
            .any(|id| id == conversation_id)
        {
            continue;
        }
        let row = ConversationRow {
            id: conversation_id.clone(),
            title: header.title.clone(),
            summary: header.summary.clone(),
            last_user_message: header.last_user_message.clone(),
            status_label: header.status_label.clone(),
            status_current_activity: header.status_current_activity.clone(),
            owner_pubkey: None,
            created_at: header.created_at,
            last_activity: header.last_activity,
            metadata: serde_json::Value::Object(serde_json::Map::new()),
            runtime_state: serde_json::Value::Object(serde_json::Map::new()),
            updated_at: now_ms(),
        };
        store.upsert_conversation(&row)?;
        report.conversations_migrated += 1;
        report.catalog_only_conversations += 1;
    }

    // Tool messages.
    let tool_dir = legacy_tool_messages_dir(base_dir);
    let known_conversation_ids = collect_known_conversation_ids(&store)?;
    let tool_stats =
        migrate_tool_messages(&mut store, &tool_dir, &known_conversation_ids, &mut report)?;
    report.tool_messages_migrated += tool_stats.migrated;
    report.flat_tool_messages_skipped += tool_stats.skipped_flat;

    // Archive legacy files. Old catalog DB and the JSON transcripts dir
    // are project-local; the tool-messages dir is global, so we only
    // archive the per-conversation subdirs we actually consumed.
    archive_legacy_files(base_dir, &d_tag, &migrated_conversation_ids, &mut report)?;

    Ok(report)
}

#[derive(Debug, Default)]
struct ConversationMigrationStats {
    messages: usize,
    prompt_history: usize,
    agent_context_states: usize,
}

fn migrate_conversation_json(
    store: &ConversationStore,
    path: &Path,
    conversation_id: &str,
    catalog_headers: &std::collections::HashMap<String, CatalogHeader>,
) -> Result<ConversationMigrationStats> {
    let raw = fs::read_to_string(path)?;
    let parsed: LegacyConversationJson = serde_json::from_str(&raw)?;

    let runtime_state = build_runtime_state(&parsed);
    let messages = parsed.messages.unwrap_or_default();
    let metadata = parsed
        .metadata
        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

    let owner_pubkey = messages
        .first()
        .and_then(|m| m.pubkey.as_ref())
        .filter(|s| !s.is_empty())
        .cloned();
    let created_at = messages.first().and_then(|m| m.timestamp);
    let last_activity = messages.last().and_then(|m| m.timestamp);

    let title = pick_string(&metadata, "title").or_else(|| {
        catalog_headers
            .get(conversation_id)
            .and_then(|h| h.title.clone())
    });
    let summary = pick_string(&metadata, "summary").or_else(|| {
        catalog_headers
            .get(conversation_id)
            .and_then(|h| h.summary.clone())
    });
    let last_user_message = pick_string(&metadata, "lastUserMessage").or_else(|| {
        catalog_headers
            .get(conversation_id)
            .and_then(|h| h.last_user_message.clone())
    });
    let status_label = pick_string(&metadata, "statusLabel").or_else(|| {
        catalog_headers
            .get(conversation_id)
            .and_then(|h| h.status_label.clone())
    });
    let status_current_activity = pick_string(&metadata, "statusCurrentActivity").or_else(|| {
        catalog_headers
            .get(conversation_id)
            .and_then(|h| h.status_current_activity.clone())
    });

    store.upsert_conversation(&ConversationRow {
        id: conversation_id.to_owned(),
        title,
        summary,
        last_user_message,
        status_label,
        status_current_activity,
        owner_pubkey,
        created_at,
        last_activity,
        metadata,
        runtime_state,
        updated_at: now_ms(),
    })?;

    let mut stats = ConversationMigrationStats::default();

    for (index, msg) in messages.iter().enumerate() {
        let record_id = msg
            .id
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("legacy:{conversation_id}:{index}"));
        let new_msg = NewMessage {
            record_id,
            nostr_event_id: msg.event_id.clone(),
            author_pubkey: msg.pubkey.clone().unwrap_or_default(),
            sender_pubkey: msg.sender_pubkey.clone(),
            ral: msg.ral,
            message_type: msg.message_type.clone().unwrap_or_else(|| "text".into()),
            role: msg.role.clone(),
            content: msg.content.clone().unwrap_or_default(),
            timestamp: msg.timestamp,
            targeted_pubkeys: msg.targeted_pubkeys.clone(),
            sender_principal: msg.sender_principal.clone(),
            targeted_principals: msg.targeted_principals.clone(),
            tool_data: msg.tool_data.clone(),
            delegation_marker: msg.delegation_marker.clone(),
            human_readable: msg.human_readable.clone(),
            transcript_tool_attributes: msg.transcript_tool_attributes.clone(),
        };
        store.append_message(conversation_id, &new_msg)?;
        stats.messages += 1;
    }

    if let Some(prompt_histories) = &parsed.agent_prompt_histories {
        for (agent_pubkey, history) in prompt_histories.iter() {
            for (sequence, prompt_msg) in history
                .messages
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .enumerate()
            {
                let prompt_id = prompt_msg
                    .id
                    .clone()
                    .unwrap_or_else(|| format!("prompt:{}:{sequence}", agent_pubkey));
                let source = prompt_msg
                    .source
                    .clone()
                    .unwrap_or(LegacyPromptSource::default());
                let entry = NewPromptHistoryEntry {
                    agent_pubkey: agent_pubkey.clone(),
                    prompt_id,
                    sequence: sequence as i64,
                    role: prompt_msg.role.clone().unwrap_or_else(|| "user".into()),
                    source_kind: source.kind.unwrap_or_else(|| "canonical".into()),
                    source_message_id: source.source_message_id,
                    source_record_id: source.source_record_id,
                    source_event_id: source.source_event_id,
                    overlay_type: source.overlay_type,
                    content: prompt_msg
                        .content
                        .clone()
                        .unwrap_or(serde_json::Value::Null),
                };
                store.append_prompt_history(conversation_id, &entry)?;
                stats.prompt_history += 1;
            }

            let next_sequence = history
                .next_sequence
                .unwrap_or_else(|| history.messages.as_deref().unwrap_or(&[]).len() as i64);
            let cache_anchored = history.cache_anchored.unwrap_or(false);
            let seen_message_ids = history.seen_message_ids.clone().unwrap_or_default();

            let compaction_state = parsed
                .context_management_compactions
                .as_ref()
                .and_then(|m| m.get(agent_pubkey).cloned());
            let reminder_state = parsed
                .context_management_reminder_states
                .as_ref()
                .and_then(|m| m.get(agent_pubkey).cloned());
            let reminder_delta_state = history.reminder_delta_state.clone();
            let todos = parsed
                .agent_todos
                .as_ref()
                .and_then(|m| m.get(agent_pubkey).cloned());
            let self_applied_skills = parsed
                .self_applied_skills
                .as_ref()
                .and_then(|m| m.get(agent_pubkey).cloned());
            let meta_model_variant = parsed
                .meta_model_variant_override
                .as_ref()
                .and_then(|m| m.get(agent_pubkey).cloned());
            let is_blocked = parsed
                .blocked_agents
                .as_deref()
                .map(|v| v.iter().any(|a| a == agent_pubkey))
                .unwrap_or(false);
            let todo_nudged = parsed
                .todo_nudged_agents
                .as_deref()
                .map(|v| v.iter().any(|a| a == agent_pubkey))
                .unwrap_or(false);

            store.upsert_agent_context_state(&AgentContextState {
                conversation_id: conversation_id.to_owned(),
                agent_pubkey: agent_pubkey.clone(),
                next_prompt_sequence: next_sequence,
                cache_anchored,
                seen_message_ids,
                compaction_state,
                reminder_state,
                reminder_delta_state,
                todos,
                self_applied_skills,
                meta_model_variant,
                is_blocked,
                todo_nudged,
                updated_at: now_ms(),
            })?;
            stats.agent_context_states += 1;
        }
    }

    Ok(stats)
}

fn build_runtime_state(parsed: &LegacyConversationJson) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    if let Some(execution_time) = &parsed.execution_time {
        obj.insert("executionTime".into(), execution_time.clone());
    }
    if let Some(active_ral) = &parsed.active_ral {
        obj.insert("activeRal".into(), active_ral.clone());
    }
    if let Some(next_ral_number) = &parsed.next_ral_number {
        obj.insert("nextRalNumber".into(), next_ral_number.clone());
    }
    if let Some(injections) = &parsed.injections {
        obj.insert("injections".into(), injections.clone());
    }
    serde_json::Value::Object(obj)
}

fn pick_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned())
}

#[derive(Debug, Default, Clone)]
struct CatalogHeader {
    title: Option<String>,
    summary: Option<String>,
    last_user_message: Option<String>,
    status_label: Option<String>,
    status_current_activity: Option<String>,
    created_at: Option<i64>,
    last_activity: Option<i64>,
}

fn read_legacy_catalog(
    catalog_path: &Path,
) -> Result<std::collections::HashMap<String, CatalogHeader>> {
    let mut map = std::collections::HashMap::new();
    if !catalog_path.is_file() {
        return Ok(map);
    }
    let conn = rusqlite::Connection::open_with_flags(
        catalog_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let table_present: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if table_present.is_none() {
        return Ok(map);
    }
    let mut stmt = conn.prepare(
        "SELECT conversation_id, title, summary, last_user_message, status_label,
                status_current_activity, created_at, last_activity
           FROM conversations",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            CatalogHeader {
                title: row.get(1)?,
                summary: row.get(2)?,
                last_user_message: row.get(3)?,
                status_label: row.get(4)?,
                status_current_activity: row.get(5)?,
                created_at: row.get(6)?,
                last_activity: row.get(7)?,
            },
        ))
    })?;
    for row in rows {
        let (id, header) = row?;
        map.insert(id, header);
    }
    Ok(map)
}

fn collect_known_conversation_ids(
    store: &ConversationStore,
) -> Result<std::collections::HashSet<String>> {
    let mut stmt = store.connection().prepare("SELECT id FROM conversations")?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().collect())
}

#[derive(Debug, Default)]
struct ToolMessageMigrationStats {
    migrated: usize,
    skipped_flat: usize,
}

fn migrate_tool_messages(
    store: &mut ConversationStore,
    tool_dir: &Path,
    known_conversation_ids: &std::collections::HashSet<String>,
    report: &mut MigrationReport,
) -> Result<ToolMessageMigrationStats> {
    let mut stats = ToolMessageMigrationStats::default();
    if !tool_dir.is_dir() {
        return Ok(stats);
    }

    for entry in fs::read_dir(tool_dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            let conversation_id = match path.file_name().and_then(|s| s.to_str()) {
                Some(s) => s.to_owned(),
                None => continue,
            };
            if !known_conversation_ids.contains(&conversation_id) {
                continue;
            }
            for tool_file in fs::read_dir(&path)? {
                let tool_file = tool_file?;
                let tool_path = tool_file.path();
                if tool_path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                match migrate_one_tool_message_file(store, &tool_path, Some(&conversation_id)) {
                    Ok(true) => stats.migrated += 1,
                    Ok(false) => {}
                    Err(err) => report.warnings.push(format!(
                        "tool-message {} failed: {err}",
                        tool_path.display()
                    )),
                }
            }
            // The nested directory is per-conversation and was consumed; rename it.
            archive_path(&path, report)?;
        } else if file_type.is_file()
            && path.extension().and_then(|s| s.to_str()) == Some("json")
            && !path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.starts_with("._"))
                .unwrap_or(false)
        {
            // Flat-format file. The outer JSON's `eventId` field is the
            // conversation id. Skip if that conversation isn't ours.
            match read_flat_tool_message(&path) {
                Ok(Some(parsed)) => {
                    if !known_conversation_ids.contains(&parsed.conversation_id) {
                        stats.skipped_flat += 1;
                        continue;
                    }
                    if migrate_one_tool_message_file(store, &path, Some(&parsed.conversation_id))? {
                        stats.migrated += 1;
                        archive_path(&path, report)?;
                    }
                }
                Ok(None) => {
                    stats.skipped_flat += 1;
                }
                Err(err) => report
                    .warnings
                    .push(format!("tool-message {} failed: {err}", path.display())),
            }
        }
    }
    Ok(stats)
}

fn migrate_one_tool_message_file(
    store: &mut ConversationStore,
    path: &Path,
    conversation_id_hint: Option<&str>,
) -> Result<bool> {
    let raw = fs::read_to_string(path)?;
    let parsed: LegacyToolMessageFile = serde_json::from_str(&raw)?;

    let conversation_id = match parsed
        .conversation_id
        .as_deref()
        .or(conversation_id_hint)
        .or(parsed.event_id.as_deref())
    {
        Some(id) if !id.is_empty() => id.to_owned(),
        _ => return Ok(false),
    };

    let messages = parsed.messages.unwrap_or_default();
    let mut tool_call: Option<ToolCallExtract> = None;
    let mut tool_result: Option<ToolResultExtract> = None;
    for msg in &messages {
        let parts = match &msg.content {
            Some(serde_json::Value::Array(arr)) => arr.clone(),
            _ => continue,
        };
        for part in parts {
            let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match part_type {
                "tool-call" => {
                    tool_call = Some(ToolCallExtract {
                        tool_call_id: part
                            .get("toolCallId")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_owned(),
                        tool_name: part
                            .get("toolName")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_owned(),
                        input: part
                            .get("input")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    });
                }
                "tool-result" => {
                    tool_result = Some(ToolResultExtract {
                        output: part.get("output").cloned(),
                    });
                }
                _ => {}
            }
        }
    }

    let call = match tool_call {
        Some(c) if !c.tool_call_id.is_empty() => c,
        _ => return Ok(false),
    };
    let agent_pubkey = parsed.agent_pubkey.unwrap_or_default();

    store.ensure_conversation(&conversation_id)?;
    let new_tool = NewToolMessage {
        tool_call_id: call.tool_call_id,
        parent_message_id: None,
        agent_pubkey,
        tool_name: call.tool_name,
        call_input: call.input,
        result_output: tool_result.and_then(|r| r.output),
        is_error: false,
        timestamp: parsed.timestamp,
    };
    store.record_tool_message(&conversation_id, &new_tool)?;
    Ok(true)
}

#[derive(Debug)]
struct FlatToolMessage {
    conversation_id: String,
}

fn read_flat_tool_message(path: &Path) -> Result<Option<FlatToolMessage>> {
    let raw = fs::read_to_string(path)?;
    let parsed: LegacyToolMessageFile = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    if let Some(id) = parsed.conversation_id {
        return Ok(Some(FlatToolMessage {
            conversation_id: id,
        }));
    }
    if let Some(id) = parsed.event_id {
        return Ok(Some(FlatToolMessage {
            conversation_id: id,
        }));
    }
    Ok(None)
}

fn archive_legacy_files(
    base_dir: &Path,
    d_tag: &str,
    migrated_conversation_ids: &[String],
    report: &mut MigrationReport,
) -> Result<()> {
    let conversations_dir = legacy_conversations_dir(base_dir, d_tag);
    if conversations_dir.is_dir() {
        archive_path(&conversations_dir, report)?;
    }
    let catalog_path = legacy_catalog_db_path(base_dir, d_tag);
    if catalog_path.is_file() {
        archive_path(&catalog_path, report)?;
        for suffix in ["-wal", "-shm"] {
            let sidecar = catalog_path.with_extension(format!("db{suffix}"));
            if sidecar.is_file() {
                archive_path(&sidecar, report)?;
            }
        }
    }
    let _ = migrated_conversation_ids;
    Ok(())
}

fn archive_path(path: &Path, report: &mut MigrationReport) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut new_path = path.as_os_str().to_owned();
    new_path.push(LEGACY_BAK_SUFFIX);
    let new_path = PathBuf::from(new_path);
    if new_path.exists() {
        // Already archived in a previous run; nothing to do.
        return Ok(());
    }
    fs::rename(path, &new_path).map_err(ConversationsError::from)?;
    report.legacy_files_archived.push(new_path);
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ==========================================================================
// Legacy JSON shapes (deserialization-only; carry-forward types).
// ==========================================================================

#[derive(Debug, Deserialize)]
struct LegacyConversationJson {
    #[serde(default)]
    messages: Option<Vec<LegacyMessage>>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
    #[serde(default, rename = "agentPromptHistories")]
    agent_prompt_histories: Option<std::collections::BTreeMap<String, LegacyAgentPromptHistory>>,
    #[serde(default, rename = "contextManagementCompactions")]
    context_management_compactions: Option<std::collections::BTreeMap<String, serde_json::Value>>,
    #[serde(default, rename = "contextManagementReminderStates")]
    context_management_reminder_states:
        Option<std::collections::BTreeMap<String, serde_json::Value>>,
    #[serde(default, rename = "agentTodos")]
    agent_todos: Option<std::collections::BTreeMap<String, serde_json::Value>>,
    #[serde(default, rename = "selfAppliedSkills")]
    self_applied_skills: Option<std::collections::BTreeMap<String, serde_json::Value>>,
    #[serde(default, rename = "metaModelVariantOverride")]
    meta_model_variant_override: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default, rename = "blockedAgents")]
    blocked_agents: Option<Vec<String>>,
    #[serde(default, rename = "todoNudgedAgents")]
    todo_nudged_agents: Option<Vec<String>>,
    #[serde(default, rename = "executionTime")]
    execution_time: Option<serde_json::Value>,
    #[serde(default, rename = "activeRal")]
    active_ral: Option<serde_json::Value>,
    #[serde(default, rename = "nextRalNumber")]
    next_ral_number: Option<serde_json::Value>,
    #[serde(default)]
    injections: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct LegacyMessage {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    pubkey: Option<String>,
    #[serde(default)]
    ral: Option<i64>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default, rename = "messageType")]
    message_type: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default, rename = "eventId")]
    event_id: Option<String>,
    #[serde(default)]
    timestamp: Option<i64>,
    #[serde(default, rename = "targetedPubkeys")]
    targeted_pubkeys: Option<Vec<String>>,
    #[serde(default, rename = "senderPubkey")]
    sender_pubkey: Option<String>,
    #[serde(default, rename = "senderPrincipal")]
    sender_principal: Option<serde_json::Value>,
    #[serde(default, rename = "targetedPrincipals")]
    targeted_principals: Option<serde_json::Value>,
    #[serde(default, rename = "toolData")]
    tool_data: Option<serde_json::Value>,
    #[serde(default, rename = "delegationMarker")]
    delegation_marker: Option<serde_json::Value>,
    #[serde(default, rename = "humanReadable")]
    human_readable: Option<String>,
    #[serde(default, rename = "transcriptToolAttributes")]
    transcript_tool_attributes: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct LegacyAgentPromptHistory {
    #[serde(default)]
    messages: Option<Vec<LegacyPromptMessage>>,
    #[serde(default, rename = "seenMessageIds")]
    seen_message_ids: Option<Vec<String>>,
    #[serde(default, rename = "reminderDeltaState")]
    reminder_delta_state: Option<serde_json::Value>,
    #[serde(default, rename = "nextSequence")]
    next_sequence: Option<i64>,
    #[serde(default, rename = "cacheAnchored")]
    cache_anchored: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct LegacyPromptMessage {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<serde_json::Value>,
    #[serde(default)]
    source: Option<LegacyPromptSource>,
}

#[derive(Debug, Default, Clone, Deserialize)]
struct LegacyPromptSource {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default, rename = "sourceMessageId")]
    source_message_id: Option<String>,
    #[serde(default, rename = "sourceRecordId")]
    source_record_id: Option<String>,
    #[serde(default, rename = "sourceEventId")]
    source_event_id: Option<String>,
    #[serde(default, rename = "overlayType")]
    overlay_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LegacyToolMessageFile {
    #[serde(default, rename = "conversationId")]
    conversation_id: Option<String>,
    #[serde(default, rename = "eventId")]
    event_id: Option<String>,
    #[serde(default, rename = "agentPubkey")]
    agent_pubkey: Option<String>,
    #[serde(default)]
    timestamp: Option<i64>,
    #[serde(default)]
    messages: Option<Vec<LegacyToolMessageEntry>>,
}

#[derive(Debug, Deserialize)]
struct LegacyToolMessageEntry {
    #[serde(default)]
    content: Option<serde_json::Value>,
}

#[derive(Debug)]
struct ToolCallExtract {
    tool_call_id: String,
    tool_name: String,
    input: serde_json::Value,
}

#[derive(Debug)]
struct ToolResultExtract {
    output: Option<serde_json::Value>,
}
