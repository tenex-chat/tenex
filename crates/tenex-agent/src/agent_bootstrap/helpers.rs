//! Pure-function bootstrap helpers extracted from
//! [`crate::agent_bootstrap::build`]. Each helper has a narrow contract so
//! the orchestrator stays focused on sequencing.
//!
//! Functions in this module never panic on bad config — they fall back to
//! sensible defaults and `eprintln!` the failure so the agent can still
//! make a turn. This matches the behaviour the orchestrator expects.

use anyhow::{Context, Result};

use tenex_conversations::{ConversationListFilter, ConversationStore};
use tenex_protocol::{ConversationRef, InboundEnvelope};

use crate::categorize;
use crate::config::{AgentConfig, ResolvedModel};
use crate::tools::{McpProxyTool, TodoItem};

/// Read persisted todos for `(conversation, agent)` from the conversation store.
pub(super) fn load_todos_from_store(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
) -> Vec<TodoItem> {
    let Ok(Some(state)) = store.get_agent_context_state(conversation_id, agent_pubkey) else {
        return Vec::new();
    };
    let Some(todos_val) = state.todos else {
        return Vec::new();
    };
    serde_json::from_value(todos_val).unwrap_or_default()
}

/// Read `blossomServerUrl` from `<base_dir>/config.json`.
///
/// Returns `None` if the file is missing, unreadable, or the field is absent.
pub(super) fn read_blossom_server_url(base_dir: &std::path::Path) -> Option<String> {
    let path = base_dir.join("config.json");
    let bytes = std::fs::read(&path).ok()?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    raw.get("blossomServerUrl")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Load the MCP proxy tool list from the manifest path declared in the
/// `TENEX_MCP_MANIFEST` environment variable. Returns an empty list when the
/// variable is unset or empty.
pub(super) fn load_mcp_proxy_tools() -> Result<Vec<McpProxyTool>> {
    let manifest_path = match std::env::var("TENEX_MCP_MANIFEST") {
        Ok(path) if !path.is_empty() => std::path::PathBuf::from(path),
        Ok(_) => return Ok(Vec::new()),
        Err(std::env::VarError::NotPresent) => return Ok(Vec::new()),
        Err(e) => return Err(e).context("reading TENEX_MCP_MANIFEST"),
    };
    let socket_path = std::env::var("TENEX_MCP_SOCKET")
        .context("TENEX_MCP_SOCKET is required when TENEX_MCP_MANIFEST is set")?;
    let bytes = std::fs::read(&manifest_path)
        .with_context(|| format!("reading MCP manifest {}", manifest_path.display()))?;
    let manifest: tenex_mcp::ToolManifest = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing MCP manifest {}", manifest_path.display()))?;
    let socket_path = std::path::PathBuf::from(socket_path);
    Ok(manifest
        .tools
        .into_iter()
        .map(|entry| McpProxyTool::new(entry, socket_path.clone()))
        .collect())
}

/// Build the conversation reminders overlay for the system prompt.
///
/// Queries the conversation store for conversations active in the last hour
/// (by `last_activity` Unix seconds), excludes the current conversation, and
/// resolves the delegation parent title from the store when applicable.
pub(super) fn build_conversation_reminders(
    store: &ConversationStore,
    conversation_id: &str,
    delegation_parent_id: Option<&str>,
) -> tenex_system_prompt::ConversationRemindersForPrompt {
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let one_hour_ago = now_secs - 3600;

    let recent = store
        .list_recent(ConversationListFilter {
            from_time: Some(one_hour_ago),
            limit: Some(20),
            ..Default::default()
        })
        .unwrap_or_default();

    let active_conversations = recent
        .into_iter()
        .filter(|row| row.id != conversation_id)
        .map(|row| {
            let last_active_human = row
                .last_activity
                .map(|ts| format_relative_time(now_secs - ts))
                .unwrap_or_else(|| "unknown".to_string());
            let id_short = row.id[..row.id.len().min(8)].to_string();
            tenex_system_prompt::ConversationSummary {
                id_short,
                title: row.title,
                last_active_human,
            }
        })
        .collect();

    let delegation_parent = delegation_parent_id.map(|parent_id| {
        let title = store
            .get_conversation(parent_id)
            .ok()
            .flatten()
            .and_then(|row| row.title);
        let id_short = parent_id[..parent_id.len().min(8)].to_string();
        tenex_system_prompt::DelegationParentRef { id_short, title }
    });

    tenex_system_prompt::ConversationRemindersForPrompt {
        active_conversations,
        delegation_parent,
    }
}

/// Format a duration in seconds as a human-readable relative time string.
fn format_relative_time(elapsed_secs: i64) -> String {
    if elapsed_secs < 0 {
        return "just now".to_string();
    }
    if elapsed_secs < 60 {
        return format!("{elapsed_secs} seconds ago");
    }
    let minutes = elapsed_secs / 60;
    if minutes < 60 {
        return format!("{minutes} minutes ago");
    }
    let hours = minutes / 60;
    format!("{hours} hours ago")
}

/// Load Telegram channel bindings registered for this `(agent, project)`.
pub(super) fn load_telegram_channel_bindings(
    base_dir: &std::path::Path,
    agent_pubkey: &str,
    project_d_tag: &str,
) -> Vec<tenex_system_prompt::TelegramChannelBinding> {
    let bindings_path = base_dir.join("data").join("transport-bindings.json");
    let store = tenex_telegram::binding::BindingStore::open(bindings_path);
    store
        .list_telegram_for_agent_project(agent_pubkey, project_d_tag)
        .into_iter()
        .filter_map(|r| tenex_system_prompt::TelegramChannelBinding::parse(&r.channel_id))
        .collect()
}

/// Fetch Fragment 33's Telegram chat context when the trigger arrived via
/// the Telegram transport. Returns `None` for non-Telegram triggers or when
/// the agent has no Telegram credentials.
pub(super) async fn fetch_telegram_chat_context(
    envelope: &InboundEnvelope,
    agent_config: &AgentConfig,
) -> Option<tenex_system_prompt::TelegramChatContextForPrompt> {
    let (tg_meta, tg_config) = match (&envelope.metadata.telegram, &agent_config.telegram) {
        (Some(meta), Some(cfg)) => (meta, cfg),
        _ => return None,
    };
    let bot_client = tenex_telegram::client::BotClient::new(
        tg_config.bot_token.clone(),
        tg_config.api_base_url.clone(),
    );
    let svc = tenex_telegram::chat_context::TelegramChatContextService::new(bot_client);
    let ctx = svc
        .get_context(&tg_meta.chat_id, tg_meta.thread_id.as_deref(), &[])
        .await;
    let formatted = tenex_telegram::chat_context::TelegramChatContextForPrompt::from(ctx);
    Some(tenex_system_prompt::TelegramChatContextForPrompt {
        chat_title: formatted.chat_title,
        topic_title: formatted.topic_title,
        admin_names: formatted.admin_names,
        member_count: formatted.member_count,
        recently_seen: formatted.recently_seen,
    })
}

/// Resolve the conversation ID of the delegation parent, if any.
pub(super) fn delegation_parent_id(envelope: &InboundEnvelope) -> Option<String> {
    envelope
        .metadata
        .delegation_parent_conversation
        .as_ref()
        .map(|conv_ref| match conv_ref {
            ConversationRef::Nostr { root_event_id } => root_event_id.to_hex(),
        })
}

/// Load Fragment 22's scheduled tasks for this agent. Logs and returns an
/// empty list on store failure.
pub(super) fn load_scheduled_tasks_for_prompt(
    agent_pubkey: &str,
) -> Vec<tenex_system_prompt::ScheduledTaskForPrompt> {
    match tenex_scheduler::storage::tasks_for_agent(agent_pubkey) {
        Ok(tasks) => tasks
            .into_iter()
            .map(|t| {
                let description = t
                    .title
                    .unwrap_or_else(|| t.prompt.chars().take(80).collect());
                let next_run_ms = t.next_run.as_deref().and_then(|s| {
                    chrono::DateTime::parse_from_rfc3339(s)
                        .ok()
                        .map(|dt| dt.timestamp_millis())
                });
                tenex_system_prompt::ScheduledTaskForPrompt {
                    id: t.id,
                    cron_expr: t.schedule,
                    description,
                    next_run_ms,
                    is_oneoff: t
                        .task_type
                        .map(|ty| ty == tenex_scheduler::model::TaskType::Oneoff)
                        .unwrap_or(false),
                }
            })
            .collect(),
        Err(e) => {
            eprintln!("[tenex-agent] Failed to load scheduled tasks: {e}");
            Vec::new()
        }
    }
}

/// List git worktrees rooted at `project_root`. Logs and returns an empty
/// list on git failure.
pub(super) fn list_worktrees_safe(
    project_root: &std::path::Path,
) -> Vec<tenex_project::WorktreeInfo> {
    match tenex_project::list_worktrees(project_root) {
        Ok(wts) => wts,
        Err(e) => {
            eprintln!("[tenex-agent] Failed to list worktrees: {e}");
            Vec::new()
        }
    }
}

/// Resolve the agent's category, backfilling via LLM when the static config
/// has none. Best-effort: returns `None` on backfill failure so the agent
/// can still boot.
pub(super) async fn resolve_agent_category(
    agent_config: &AgentConfig,
    resolved: &ResolvedModel,
    base_dir: &std::path::Path,
    agent_pubkey: &str,
) -> Option<String> {
    if let Some(c) = agent_config.category.clone() {
        return Some(c);
    }
    let metadata = tenex_agent_registry::AgentMetadata {
        name: agent_config.name.clone(),
        role: String::new(),
        description: None,
        instructions: agent_config.instructions.clone(),
        use_criteria: None,
    };
    match categorize::backfill_and_persist(resolved, &metadata, base_dir, agent_pubkey).await {
        Ok(cat) => Some(cat.as_str().to_owned()),
        Err(e) => {
            eprintln!("[tenex-agent] category backfill failed: {e}");
            None
        }
    }
}

/// Compose the initial user message that drives the first turn: the inbound
/// envelope content followed by any todo reminder, conversation reminders,
/// and external-trigger disclosure.
pub(super) fn compose_user_message(
    envelope_content: &str,
    todo_reminder: &str,
    conversation_reminders_text: Option<&str>,
    external_disclosure: Option<&str>,
) -> String {
    let mut msg = envelope_content.to_string();
    if !todo_reminder.is_empty() {
        msg = format!("{msg}\n\n{todo_reminder}");
    }
    if let Some(reminders_text) = conversation_reminders_text {
        msg = format!("{msg}\n\n{reminders_text}");
    }
    if let Some(disclosure) = external_disclosure {
        msg = format!("{msg}\n\n{disclosure}");
    }
    msg
}
