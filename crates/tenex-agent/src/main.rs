mod accounting;
mod agent_loop_hook;
mod cassette;
mod cassette_client;
mod cassette_request;
mod categorize;
mod compaction;
mod config;
mod context_discovery;
mod context_rig;
mod emit;
mod escalation;
mod home;
mod hook;
mod identity_resolver;
mod injections;
mod mock_llm;
mod multimodal;
mod oauth_client;
mod progress_monitor;
mod project_instructions;
mod runtime_control;
mod runtime_state;
mod runtime_state_json;
mod shell_task_reminder;
mod skills;
mod stdio_home;
mod tools;

use agent_loop_hook::AgentLoopHook;
use anyhow::{Context, Result};
use cassette::CassetteRecorder;
use cassette_client::{RecordingClient, RecordingModel};
use config::{LlmsConfig, ResolvedModel};
use context_rig::ctx_msg_to_rig;
use emit::{EmitState, EmitStateArgs};
use hook::EmitHook;
use injections::MessageInjectionTracker;
use progress_monitor::RIG_AGENT_TURN_FUSE;
use rig::client::Nothing;
use rig::completion::Message as RigMessage;
use rig::providers::{anthropic, ollama, openai, openrouter};
use runtime_state::RuntimeStateHandle;
use shell_task_reminder::render_active_shell_tasks_reminder;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tenex_context::{
    BreakpointHint, BreakpointKind, CacheObservation, Message as CtxMessage, ModelProfile,
    ToolCall as CtxToolCall, ToolDef, TurnRecord,
};
use tenex_conversations::{
    AgentContextState, ConversationListFilter, ConversationStore, NewToolMessage,
};
use tenex_project::Project;
use tenex_protocol::{
    nostr::{read_one_from_stdin, NostrChannel},
    sink::StdoutNdjsonSink,
    Channel, CompletionIntent, ConversationIntent, ConversationRef, Intent, LlmUsage, MessageRef,
    PrincipalKind, PrincipalRef, ProjectRef,
};
use tenex_rag::{EmbedConfig, RagStore};
use tenex_supervision::heuristics::default_supervisor;
use tenex_supervision::supervisor::PostCompletionOutcome;
use tenex_supervision::types::{TodoEntry as SupTodoEntry, TodoStatus as SupTodoStatus};
use tools::{
    DelegateTool, McpProxyTool, RagAddDocumentsTool, RagSearchTool, SkillListTool, SkillsSetTool,
    TodoItem, TodoStatus, ToolRecorder, ToolSet,
};
use tracing::{info_span, Instrument};
use tracing_opentelemetry::OpenTelemetrySpanExt;

/// Build and run the agent with all tools attached, streaming the response.
/// Tools are passed as a single `Vec<Box<dyn ToolDyn>>` already wrapped by
/// [`RecordingTool`] so every call rig dispatches lands in the shared
/// [`ToolRecorder`] for post-turn persistence.
// run_agent!(client, model, system, message, history, hook, tools)
// run_agent!(client, model, system, message, history, hook, tools, |m| m.with_prompt_caching())
//
// The optional seventh argument is a closure applied to the completion model before building the
// agent. Use it to configure provider-specific options (e.g. Anthropic prompt caching). The
// default is the identity closure, which leaves the model unchanged.
macro_rules! run_agent {
    ($client:expr, $model:expr, $system:expr, $message:expr, $history:expr, $hook:expr, $tools:expr) => {
        run_agent!(
            $client,
            $model,
            $system,
            $message,
            $history,
            $hook,
            $tools,
            |m| m
        )
    };
    ($client:expr, $model:expr, $system:expr, $message:expr, $history:expr, $hook:expr, $tools:expr, $model_config:expr) => {{
        use ::futures::StreamExt as _;
        use ::rig::agent::AgentBuilder;
        use ::rig::client::CompletionClient as _;
        use ::rig::streaming::StreamingChat as _;

        let __model = ($model_config)($client.completion_model($model.to_string()));
        let __hook = AgentLoopHook::new($hook, __model.clone());
        let mut __stream = AgentBuilder::new(__model)
            .preamble($system)
            .max_tokens(16384)
            .default_max_turns(RIG_AGENT_TURN_FUSE)
            .tools($tools)
            .build()
            .stream_chat($message, $history)
            .with_hook(__hook)
            .await;

        let mut __final = ::rig::agent::FinalResponse::empty();
        while let Some(__item) = __stream.next().await {
            match __item {
                Ok(::rig::agent::MultiTurnStreamItem::FinalResponse(__r)) => {
                    __final = __r;
                    break;
                }
                Ok(_) => {}
                Err(__e) => return Err(::anyhow::anyhow!("stream error: {__e}")),
            }
        }
        __final
    }};
}

fn load_todos_from_store(
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

fn load_mcp_proxy_tools() -> Result<Vec<McpProxyTool>> {
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

/// Unified save for both todos and self_applied_skills in a single read-modify-write.
/// Keeping these in one call prevents the second writer from overwriting the first's changes.
fn save_context_state(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    todos: &[TodoItem],
    self_applied_skills: &[String],
) {
    let todos_json = match serde_json::to_value(todos) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[tenex-agent] Failed to serialize todos: {e}");
            return;
        }
    };
    // Serialize as explicit empty array (not None) so future reads can distinguish
    // "never set" (None) from "user cleared all" (Some([])).
    let skills_json = serde_json::to_value(self_applied_skills).ok();

    let existing = store
        .get_agent_context_state(conversation_id, agent_pubkey)
        .ok()
        .flatten();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);

    let state = AgentContextState {
        conversation_id: conversation_id.to_string(),
        agent_pubkey: agent_pubkey.to_string(),
        next_prompt_sequence: existing.as_ref().map_or(0, |s| s.next_prompt_sequence),
        cache_anchored: existing.as_ref().is_some_and(|s| s.cache_anchored),
        seen_message_ids: existing
            .as_ref()
            .map(|s| s.seen_message_ids.clone())
            .unwrap_or_default(),
        compaction_state: existing.as_ref().and_then(|s| s.compaction_state.clone()),
        reminder_state: existing.as_ref().and_then(|s| s.reminder_state.clone()),
        reminder_delta_state: existing
            .as_ref()
            .and_then(|s| s.reminder_delta_state.clone()),
        todos: Some(todos_json),
        self_applied_skills: skills_json,
        meta_model_variant: existing.as_ref().and_then(|s| s.meta_model_variant.clone()),
        is_blocked: existing.as_ref().is_some_and(|s| s.is_blocked),
        todo_nudged: existing.as_ref().is_some_and(|s| s.todo_nudged),
        updated_at: now,
    };

    if let Err(e) = store.upsert_agent_context_state(&state) {
        eprintln!("[tenex-agent] Failed to save agent context state: {e}");
    }
}

/// Build the conversation reminders overlay for the system prompt.
///
/// Queries the conversation store for conversations active in the last hour
/// (by `last_activity` Unix seconds), excludes the current conversation, and
/// resolves the delegation parent title from the store when applicable.
fn build_conversation_reminders(
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

#[tokio::main]
async fn main() -> Result<()> {
    let telemetry = tenex_telemetry::init("tenex-agent");
    let root_span = info_span!("tenex.agent.process");
    if let Some(parent) = tenex_telemetry::parent_context_from_env() {
        let _ = root_span.set_parent(parent);
    }
    let result = run().instrument(root_span).await;
    telemetry.shutdown();
    result
}

async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        anyhow::bail!(
            "Usage: tenex-agent <agent.json>\n\nExample:\n  cargo run -p tenex-agent -- ~/.tenex/agents/<pubkey>.json < event.json"
        );
    }

    // Mandatory project context — the daemon sets this before spawning the agent.
    let project_id = std::env::var("TENEX_PROJECT_ID")
        .context("TENEX_PROJECT_ID environment variable is required")?;

    let agent_config = config::AgentConfig::load(&args[1])?;

    // Read triggering envelope from stdin
    let envelope = read_one_from_stdin()
        .await
        .context("Failed to parse triggering event from stdin")?;

    // Initialize channel (parses nsec, derives pubkey, signs to NDJSON-stdout).
    // Telegram delivery used to live here via CompositeChannel; that path is
    // now owned by `tenex-telegram`, which reads agent-emitted events off the
    // runtime control socket and renders them to the originating chat.
    let channel: Arc<dyn Channel> = Arc::new(
        NostrChannel::from_nsec(&agent_config.nsec, StdoutNdjsonSink::new())
            .context("Failed to initialize Nostr channel")?,
    );
    let pubkey_hex = match channel.identity() {
        PrincipalRef::Nostr { pubkey, .. } => pubkey.to_hex(),
    };

    // Resolve working directory and current branch.
    // The project_root is the canonical base path; working_dir may differ when
    // a worktree is created for the branch carried in the triggering event.
    let configured_working_dir = agent_config
        .working_directory
        .as_deref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        });
    let project_root = project_instructions::infer_project_root(&configured_working_dir);
    let (resolved_working_dir, resolved_current_branch) =
        if envelope.metadata.branch.as_deref().is_some() {
            tenex_project::resolve_working_dir(&project_root, envelope.metadata.branch.as_deref())
        } else {
            let current = tenex_project::current_branch(&configured_working_dir)
                .ok()
                .flatten()
                .or_else(|| tenex_project::current_branch(&project_root).ok().flatten());
            (configured_working_dir, current)
        };
    let working_dir = resolved_working_dir.display().to_string();
    let project_base_path = project_root.display().to_string();
    let current_branch = resolved_current_branch;
    let root_agents_md = project_instructions::read_root_agents_md(&project_root);

    // Open project and load context used for prompts + delegate tool.
    let project = Project::open_default(&project_id)
        .with_context(|| format!("Failed to open project for '{project_id}'"))?;
    let project_meta = project
        .metadata()
        .context("Failed to read project metadata")?
        .context("Project metadata is missing — has the project been ingested?")?;
    let project_agents = Arc::new(project.agents().context("Failed to read project agents")?);
    let is_pm_agent = project
        .project_agents()
        .context("Failed to read project membership")?
        .iter()
        .any(|pa| pa.agent_pubkey == pubkey_hex && pa.is_pm);

    let owner_pubkey_hex = project_meta
        .owner_pubkey
        .as_ref()
        .context("Project metadata has no owner_pubkey — cannot construct project ref")?;
    let project_ref = ProjectRef {
        author: nostr::PublicKey::from_hex(owner_pubkey_hex)
            .context("Failed to parse project owner pubkey")?,
        d_tag: project_meta.d_tag.clone(),
    };

    // Open the conversation store for todo persistence and history projection.
    let envelope_conversation_id = match &envelope.root {
        MessageRef::Nostr { event_id } => event_id.to_hex(),
    };
    let conversation_id = std::env::var("TENEX_CONVERSATION_ID")
        .ok()
        .filter(|id| nostr::EventId::from_hex(id).is_ok())
        .unwrap_or(envelope_conversation_id);
    let conv_store = (|| -> Option<ConversationStore> {
        let base_dir = tenex_conversations::paths::default_base_dir();
        let d_tag = tenex_conversations::normalize_project_id(&project_id).ok()?;
        let db_path = tenex_conversations::paths::conversation_db_path(&base_dir, &d_tag);
        match ConversationStore::open(&db_path) {
            Ok(store) => Some(store),
            Err(e) => {
                eprintln!("[tenex-agent] Conversation store unavailable: {e}");
                None
            }
        }
    })();

    // Ensure the conversation row exists so FK-dependent writes (agent_context_state,
    // agent_prompt_history) don't fail on the first invocation of a new conversation.
    if let Some(ref store) = conv_store {
        if let Err(e) = store.ensure_conversation(&conversation_id) {
            eprintln!("[tenex-agent] Failed to ensure conversation row: {e}");
        }
    }

    let conv_db_path = {
        let conv_base = tenex_conversations::paths::default_base_dir();
        tenex_conversations::paths::conversation_db_path(&conv_base, &project_meta.d_tag)
    };
    let execution_id =
        std::env::var("TENEX_EXECUTION_ID").unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
    let runtime_state = Some(RuntimeStateHandle::new(
        conv_db_path.clone(),
        conversation_id.clone(),
        pubkey_hex.clone(),
        execution_id.clone(),
    ));

    // Load TENEX configuration files for model/key resolution
    let llms = LlmsConfig::load();
    let providers = config::load_providers_config();

    // Check for a per-conversation model override stored by a prior change_model call.
    let model_override: Option<String> = conv_store
        .as_ref()
        .and_then(|s| {
            s.get_agent_context_state(&conversation_id, &pubkey_hex)
                .ok()
                .flatten()
        })
        .and_then(|state| state.meta_model_variant);

    // Resolve provider + model + API key (override takes precedence over static config).
    let resolved = ResolvedModel::resolve(
        model_override
            .as_deref()
            .or_else(|| agent_config.raw_model()),
        llms.as_ref(),
        providers.as_ref(),
    );
    let cassette_recorder = CassetteRecorder::from_env(
        agent_config.identity_name(),
        &resolved.provider,
        &resolved.model,
    );

    eprintln!(
        "[tenex-agent] {} ({}) @ {}",
        agent_config.identity_name(),
        &pubkey_hex[..8],
        working_dir,
    );
    eprintln!(
        "[tenex-agent] provider: {} | model: {}",
        resolved.provider, resolved.model
    );
    let trigger_pubkey_hex = match &envelope.principal {
        PrincipalRef::Nostr { pubkey, .. } => pubkey.to_hex(),
    };
    let trigger_event_id = match &envelope.message {
        MessageRef::Nostr { event_id } => event_id.to_hex(),
    };
    eprintln!(
        "[tenex-agent] Triggered by event {} from {}",
        &trigger_event_id[..8],
        &trigger_pubkey_hex[..8]
    );
    let injection_tracker = Arc::new(Mutex::new(MessageInjectionTracker::new(
        conv_db_path.clone(),
        conversation_id.clone(),
        pubkey_hex.clone(),
        trigger_event_id.clone(),
        is_pm_agent,
        runtime_state.clone(),
    )));

    // Load teams (global + project-specific) and compute the prompt fragment.
    let base_dir = tenex_project::paths::default_base_dir();
    let teams = Arc::new(tenex_project::load_teams(&base_dir, Some(&project_id)));
    let member_teams =
        tenex_project::teams_for_agent(&teams, agent_config.slug.as_deref().unwrap_or(""));
    let teams_fragment =
        tenex_project::render_teams_context(&member_teams, envelope.metadata.team.as_deref());

    // Set up agent home directory.
    let agent_home = home::agent_home_dir(&base_dir, &pubkey_hex);
    home::ensure_agent_home_dir(&agent_home);
    if let Err(e) = stdio_home::write_agent_env_file(&agent_home, &agent_config.nsec, &pubkey_hex) {
        eprintln!("[tenex-agent] Failed to write agent .env file: {e}");
    }

    // Build env vars for shell commands: parse agent .env + inject computed vars.
    let mut shell_env: Vec<(String, String)> = stdio_home::parse_dotenv(&agent_home.join(".env"))
        .into_iter()
        .filter(|(k, _)| k != "HOME") // never override the real HOME
        .collect();
    shell_env.push(("AGENT_HOME".to_string(), agent_home.display().to_string()));
    shell_env.push(("PUBKEY".to_string(), pubkey_hex.clone()));
    shell_env.push(("TENEX_BASE_DIR".to_string(), base_dir.display().to_string()));
    if let Ok(user_home) = std::env::var("HOME") {
        shell_env.push(("USER_HOME".to_string(), user_home));
    }
    shell_env.push(("PROJECT_BASE".to_string(), working_dir.clone()));
    shell_env.push(("PROJECT_ID".to_string(), project_id.clone()));

    let injected_files = home::get_injected_files(&agent_home);
    let file_count = home::count_home_files(&agent_home);
    let home_info = tenex_system_prompt::HomeDirectoryInfo {
        home_dir: &agent_home.display().to_string(),
        file_count: &file_count,
        injected_files: &injected_files,
    };

    // Build skill lookup context for discovery tools and preloading.
    let skill_ctx = Arc::new(skills::SkillLookupCtx {
        agent_pubkey: pubkey_hex.clone(),
        project_path: working_dir.clone(),
        base_dir: base_dir.clone(),
        agent_config_path: args[1].clone(),
    });

    // Load self-applied skills persisted from prior invocations of this conversation.
    let initial_self_applied: Vec<String> = conv_store
        .as_ref()
        .and_then(|s| {
            s.get_agent_context_state(&conversation_id, &pubkey_hex)
                .ok()
                .flatten()
        })
        .and_then(|state| state.self_applied_skills)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    // Merge always-on skills from agent config with conversation-scoped self-applied skills.
    let mut all_skill_ids: Vec<String> = agent_config
        .default
        .as_ref()
        .and_then(|d| d.skills.clone())
        .unwrap_or_default();
    for id in &initial_self_applied {
        if !all_skill_ids.contains(id) {
            all_skill_ids.push(id.clone());
        }
    }

    // Pre-fetch and render preloaded skills for the system prompt.
    let preloaded_skills = skills::fetch_skills(&all_skill_ids, &skill_ctx);

    // Determine which tool names are granted via skill frontmatter (tools: field).
    let granted_tools: std::collections::HashSet<String> = preloaded_skills
        .iter()
        .filter_map(|s| s.frontmatter.as_ref())
        .flat_map(|fm| fm.tools.iter().cloned())
        .collect();

    let preloaded_skills_block: Option<String> = if preloaded_skills.is_empty() {
        None
    } else {
        let user_home = std::env::var("HOME").unwrap_or_default();
        let agent_home_str = agent_home.display().to_string();
        let tenex_base_str = base_dir.display().to_string();
        let path_vars: Vec<(&str, &str)> = vec![
            ("$USER_HOME", &user_home),
            ("$AGENT_HOME", &agent_home_str),
            ("$TENEX_BASE_DIR", &tenex_base_str),
            ("$PROJECT_BASE", &working_dir),
        ];
        Some(skills::render_loaded_skills_block(
            &preloaded_skills,
            &path_vars,
        ))
    };

    // Shared self-applied skills state (pre-seeded from persistence; updated by skills_set tool).
    let self_applied_skills: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(initial_self_applied));

    // Load Telegram channel bindings for this agent so they appear in the system prompt.
    let telegram_channel_bindings: Vec<tenex_system_prompt::TelegramChannelBinding> = {
        let bindings_path = base_dir.join("data").join("transport-bindings.json");
        let store = tenex_telegram::binding::BindingStore::open(bindings_path);
        store
            .list_telegram_for_agent_project(&pubkey_hex, &project_meta.d_tag)
            .into_iter()
            .filter_map(|r| tenex_system_prompt::TelegramChannelBinding::parse(&r.channel_id))
            .collect()
    };

    // Fetch Telegram chat context for Fragment 33 when the triggering event
    // arrived via the Telegram transport.
    let telegram_chat_context: Option<tenex_system_prompt::TelegramChatContextForPrompt> =
        if let (Some(tg_meta), Some(tg_config)) =
            (&envelope.metadata.telegram, &agent_config.telegram)
        {
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
        } else {
            None
        };

    // Extract delegation parent conversation ID, if this agent was delegated to.
    let delegation_parent_id: Option<String> = envelope
        .metadata
        .delegation_parent_conversation
        .as_ref()
        .map(|conv_ref| match conv_ref {
            ConversationRef::Nostr { root_event_id } => root_event_id.to_hex(),
        });

    // Build conversation reminders overlay from the conversation store.
    let conversation_reminders: Option<tenex_system_prompt::ConversationRemindersForPrompt> =
        conv_store.as_ref().map(|store| {
            build_conversation_reminders(store, &conversation_id, delegation_parent_id.as_deref())
        });

    // Load scheduled tasks for Fragment 22.
    let scheduled_tasks_for_prompt: Vec<tenex_system_prompt::ScheduledTaskForPrompt> =
        match tenex_scheduler::storage::tasks_for_agent(&pubkey_hex) {
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
        };

    let git_worktrees: Vec<tenex_project::WorktreeInfo> =
        match tenex_project::list_worktrees(&project_root) {
            Ok(wts) => wts,
            Err(e) => {
                eprintln!("[tenex-agent] Failed to list worktrees: {e}");
                Vec::new()
            }
        };

    // Backfill category from the LLM when missing. Single field of truth —
    // the resolved category is persisted to the agent's `category` field
    // and used directly for this boot. Best-effort: failures log and the
    // agent boots without a category line in the prompt.
    let resolved_category_string: Option<String> = match agent_config.category.clone() {
        Some(c) => Some(c),
        None => {
            let metadata = tenex_agent_registry::AgentMetadata {
                name: agent_config.name.clone(),
                role: String::new(),
                description: None,
                instructions: agent_config.instructions.clone(),
                use_criteria: None,
            };
            match categorize::backfill_and_persist(&resolved, &metadata, &base_dir, &pubkey_hex)
                .await
            {
                Ok(cat) => Some(cat.as_str().to_owned()),
                Err(e) => {
                    eprintln!("[tenex-agent] category backfill failed: {e}");
                    None
                }
            }
        }
    };
    let resolved_category_enum = resolved_category_string
        .as_deref()
        .and_then(|s| s.parse::<tenex_supervision::types::AgentCategory>().ok());

    // Build system prompt
    let mut system_prompt =
        tenex_system_prompt::build_system_prompt(tenex_system_prompt::BuildSystemPromptInput {
            identity_name: agent_config.identity_name(),
            pubkey_hex: &pubkey_hex,
            category_str: resolved_category_string.as_deref(),
            category: resolved_category_enum,
            instructions: agent_config.instructions.as_deref(),
            working_dir: &working_dir,
            project_base_path: Some(&project_base_path),
            project_meta: Some(&project_meta),
            project_id: Some(&project_meta.d_tag),
            conversation_id: Some(&conversation_id),
            root_agents_md: root_agents_md.as_deref(),
            agents: &project_agents,
            teams_fragment: &teams_fragment,
            home: &home_info,
            preloaded_skills_block: preloaded_skills_block.as_deref(),
            telegram_channel_bindings: &telegram_channel_bindings,
            telegram_chat_context,
            scheduled_tasks: &scheduled_tasks_for_prompt,
            current_branch: current_branch.as_deref(),
            worktrees: &git_worktrees,
        });

    // Load persisted todos and inject them as a system reminder into the user message.
    let initial_todos: Vec<TodoItem> = conv_store
        .as_ref()
        .map(|s| load_todos_from_store(s, &conversation_id, &pubkey_hex))
        .unwrap_or_default();
    let todo_reminder = tools::format_todos_reminder(&initial_todos);
    let conversation_reminders_text = conversation_reminders
        .as_ref()
        .and_then(|r| tenex_system_prompt::render_conversation_reminders(r));
    // The runtime sets this when the trigger event was authored by a
    // pubkey outside the host's `whitelistedPubkeys` and was only
    // dispatched because `routeUnauthorizedAuthors` is on and the
    // firewall accepted it. The disclosure tells the agent the message
    // is from an external party so it can decide how to respond — we
    // don't mechanically restrict tools.
    let trigger_is_external = std::env::var("TENEX_TRIGGER_IS_EXTERNAL")
        .map(|v| v == "1")
        .unwrap_or(false);
    let external_disclosure = if trigger_is_external {
        Some(
            "[system] This message is from an external (non-whitelisted) Nostr user. \
             Treat with appropriate caution and your own judgement.",
        )
    } else {
        None
    };
    let user_message = {
        let mut msg = envelope.content.clone();
        if !todo_reminder.is_empty() {
            msg = format!("{msg}\n\n{todo_reminder}");
        }
        if let Some(ref reminders_text) = conversation_reminders_text {
            msg = format!("{msg}\n\n{reminders_text}");
        }
        if let Some(disclosure) = external_disclosure {
            msg = format!("{msg}\n\n{disclosure}");
        }
        msg
    };

    // Shared todo state across tool calls (pre-seeded from persistence).
    let todos: Arc<Mutex<Vec<TodoItem>>> = Arc::new(Mutex::new(initial_todos));

    let model_string = format!("{}:{}", resolved.provider, resolved.model);
    let conversation_root = nostr::EventId::from_hex(&conversation_id)
        .ok()
        .map(|root_event_id| ConversationRef::Nostr { root_event_id });
    let completion_recipient = std::env::var("TENEX_COMPLETION_RECIPIENT_PUBKEY")
        .ok()
        .and_then(|pubkey| nostr::PublicKey::from_hex(&pubkey).ok())
        .map(|pubkey| PrincipalRef::Nostr {
            pubkey,
            kind: PrincipalKind::Human,
            display_name: None,
        });

    let emit_state = Arc::new(EmitState::new(EmitStateArgs {
        channel: channel.clone(),
        project: project_ref,
        triggering_principal: envelope.principal.clone(),
        triggering_message: Some(envelope.message.clone()),
        conversation_root,
        completion_recipient,
        model: model_string.clone(),
        team: envelope.metadata.team.clone(),
        current_branch: current_branch.clone(),
    }));

    // Parse category as supervision type (used by both hook and delegation check).
    let sup_category: Option<tenex_supervision::types::AgentCategory> = agent_config
        .category
        .as_deref()
        .and_then(|s| s.parse().ok());
    let supervisor = Arc::new(Mutex::new(default_supervisor()));
    let supervisor_ref = supervisor.clone();
    let hook = EmitHook::new(
        emit_state.clone(),
        supervisor,
        todos.clone(),
        sup_category,
        runtime_state.clone(),
    );
    let allows_delegation = sup_category.map(|c| c.allows_delegation()).unwrap_or(true);
    let delegate_tool: Option<DelegateTool> = if allows_delegation {
        Some(DelegateTool::new(
            emit_state.clone(),
            project_agents.clone(),
            teams.clone(),
        ))
    } else {
        None
    };

    let skill_list_tool = SkillListTool::new(skill_ctx.clone());
    let skills_set_tool = SkillsSetTool::new(skill_ctx.clone(), self_applied_skills.clone());
    let mcp_proxy_tools = load_mcp_proxy_tools()?;

    // Initialize RAG store for the embedding tools.
    let embed_config: Option<EmbedConfig> = EmbedConfig::load_from_base_dir(&base_dir);
    let rag_store: Option<Arc<RagStore>> = embed_config.as_ref().and_then(|cfg| {
        let db_path = base_dir.join("embeddings.db");
        match RagStore::open(&db_path, cfg) {
            Ok(store) => Some(Arc::new(store)),
            Err(e) => {
                eprintln!("[tenex-agent] RAG store unavailable: {e}");
                None
            }
        }
    });

    let rag_add_documents =
        RagAddDocumentsTool::new(rag_store.clone(), project_id.clone(), pubkey_hex.clone());
    let rag_search = RagSearchTool::new(
        rag_store.clone(),
        project_id.clone(),
        pubkey_hex.clone(),
        Arc::new(resolved.clone()),
    );

    // Proactive context: search RAG before the LLM call so relevant past
    // knowledge appears in the system prompt without the agent needing to ask.
    // Uses an LLM query planner (for non-trivial messages) and LLM reranker
    // (when > 3 results pass the score threshold).
    if let Some(store) = &rag_store {
        let collections = [
            "conversations".to_string(),
            format!("project_{project_id}"),
            format!("agent_{pubkey_hex}"),
        ];
        let refs: Vec<&str> = collections.iter().map(|s| s.as_str()).collect();
        let relevant =
            context_discovery::discover_context(&envelope.content, store, &refs, &resolved).await;
        if !relevant.is_empty() {
            let mut block = String::from(
                "\n\n<proactive-context>\nPotentially relevant information retrieved based on your task:\n",
            );
            for (i, r) in relevant.iter().enumerate() {
                let snippet: String = r.content.chars().take(300).collect();
                let ellipsis = if r.content.len() > 300 { "…" } else { "" };
                block.push_str(&format!(
                    "\n[{}] score:{:.2} collection:{}{}\n{}{}\n",
                    i + 1,
                    r.score,
                    r.collection,
                    r.title
                        .as_deref()
                        .map(|t| format!(" title:{t}"))
                        .unwrap_or_default(),
                    snippet,
                    ellipsis,
                ));
            }
            block.push_str("</proactive-context>");
            system_prompt.push_str(&block);
        }
    }

    if let Some(state) = &runtime_state {
        if let Some(active_tools) = state.render_active_tools_reminder() {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(&active_tools);
        }
    }
    if let Some(active_shell_tasks) =
        render_active_shell_tasks_reminder(&project_id, &conversation_id, &pubkey_hex).await
    {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&active_shell_tasks);
    }

    // Project conversation history. The projection produces interleaved
    // assistant + tool-result messages; the system prompt is dropped here
    // because rig handles it via `preamble`.
    let history: Vec<RigMessage> = if let Some(store) = conv_store.as_ref() {
        let model_profile = ModelProfile {
            provider: resolved.provider.clone(),
            model_id: resolved.model.clone(),
            prompt_cache: resolved.provider == "anthropic",
            ephemeral_reminders: false,
            image_support: false,
            max_context_tokens: 200_000,
        };
        let tool_defs: Vec<ToolDef> = Vec::new();
        let summarizer: Option<Arc<dyn tenex_context::CompactionSummarizer>> = Some(Arc::new(
            compaction::LlmCompactionSummarizer::new(Arc::new(resolved.clone())),
        ));
        let name_resolver = identity_resolver::IdentityServiceResolver::new(&base_dir);
        match tenex_context::project(
            store,
            &conversation_id,
            &pubkey_hex,
            &system_prompt,
            &model_profile,
            &tool_defs,
            summarizer,
            Some(&name_resolver),
        )
        .await
        {
            Ok(projection) => projection
                .messages
                .into_iter()
                .filter(|m| !matches!(m, CtxMessage::System { .. }))
                .map(ctx_msg_to_rig)
                .collect(),
            Err(e) => {
                eprintln!("[tenex-agent] Context projection failed: {e}");
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    let initial_history = history;
    eprintln!(
        "[tenex-agent] Running agent (history: {} messages)...",
        initial_history.len()
    );

    let agent_slug = agent_config.identity_name().to_string();
    let escalation_pubkey = escalation::resolve_escalation_pubkey(&base_dir, &project_agents);
    let suppress_response = Arc::new(AtomicBool::new(false));
    let agents_md = Arc::new(tools::agents_md::AgentsMdReminderState::new(project_root));
    let tool_set = ToolSet {
        emit_state: emit_state.clone(),
        project_agents: project_agents.clone(),
        teams: teams.clone(),
        owner_pubkey: owner_pubkey_hex.to_string(),
        escalation_pubkey,
        base_dir: base_dir.clone(),
        allows_delegation,
        conv_db_path: conv_db_path.clone(),
        conversation_id: conversation_id.clone(),
        agent_pubkey: pubkey_hex.clone(),
        agent_nsec: agent_config.nsec.clone(),
        agent_home: agent_home.clone(),
        resolved_model: Arc::new(resolved.clone()),
        project_d_tag: project_meta.d_tag.clone(),
        agent_slug: agent_slug.clone(),
        project_id: project_id.clone(),
        execution_id: execution_id.clone(),
        suppress_response: suppress_response.clone(),
        rag_store: rag_store.clone(),
        embed_config: embed_config.clone(),
        working_dir: working_dir.clone(),
        agents_md,
        shell_env: shell_env.clone(),
        granted_tools,
        todos: todos.clone(),
        skill_list: skill_list_tool.clone(),
        skills_set: skills_set_tool.clone(),
        mcp_proxy_tools,
        delegate: delegate_tool.clone(),
        rag_add_documents: rag_add_documents.clone(),
        rag_search: rag_search.clone(),
        runtime_state: runtime_state.clone(),
        message_injections: injection_tracker.clone(),
        telegram_config: agent_config.telegram,
    };

    // Keep a handle with shared Arc refs so we can read the pending final turn
    // after the stream ends, even after `hook` is moved into the agent builder.
    let hook_handle = hook.clone();

    // Prefetch images from the inbound envelope content for vision-capable providers.
    // Fetched once so re-engagement turns (supervisor-generated text) do not trigger
    // additional network calls.
    let supports_vision = matches!(
        resolved.provider.as_str(),
        "anthropic" | "openai" | "openrouter"
    );
    // `file://` image URLs are only honoured when they live under one of these
    // trusted cache prefixes — otherwise an inbound event could read arbitrary
    // local files. The Telegram bridge writes inbound photos here; add new
    // trusted producers to this list.
    //
    // We pre-create the dir and canonicalize the physical path so the prefix
    // is absolute and matches whatever canonical form the poller emits, even
    // when the daemon and the agent run with different working directories
    // (the runtime spawns agents with cwd set to the project workspace, while
    // the poller runs with the daemon's cwd).
    let media_root = base_dir.join("data").join("telegram-media");
    let _ = std::fs::create_dir_all(&media_root);
    let allowed_file_prefixes = vec![media_root.canonicalize().unwrap_or(media_root)];
    let envelope_image_parts: Option<Vec<rig::completion::message::UserContent>> =
        if supports_vision {
            multimodal::prepare_multimodal_content(&envelope.content, &allowed_file_prefixes).await
        } else {
            None
        };

    // current_message starts as the inbound user prompt; supervision may replace it with a
    // re-engagement prompt after each turn if pending todos remain.
    let mut current_message = user_message;
    // extra history accumulated from re-engagement turns (user + assistant pairs).
    let mut re_engage_history: Vec<RigMessage> = Vec::new();

    'agent_loop: loop {
        suppress_response.store(false, Ordering::Release);
        let current_history: Vec<RigMessage> = {
            let mut h = initial_history.clone();
            h.extend(re_engage_history.iter().cloned());
            h
        };

        // Fresh recorder per turn. RecordingTool clones forward into every
        // tool call so the inner loop's invocations all land here.
        let recorder = ToolRecorder::new();
        let tools = tool_set.build_for_turn(recorder.clone());
        let injected = injection_tracker.lock().unwrap().take_new_messages();
        let turn_message = if let Some(ref injected) = injected {
            format!("{current_message}\n\n{injected}")
        } else {
            current_message.clone()
        };

        // Build a multipart prompt when the envelope contained images that were
        // successfully fetched. Images are prepended so vision providers see them
        // before the text (preferred order). This applies to every turn, including
        // re-engagement, so the original images remain visible as context.
        let turn_prompt: RigMessage = {
            use rig::completion::message::{Text, UserContent};
            use rig::OneOrMany;
            match &envelope_image_parts {
                Some(image_parts) => {
                    let mut parts: Vec<UserContent> = image_parts.clone();
                    parts.push(UserContent::Text(Text {
                        text: turn_message.clone(),
                    }));
                    RigMessage::User {
                        content: OneOrMany::many(parts).unwrap_or_else(|_| {
                            OneOrMany::one(UserContent::Text(Text {
                                text: turn_message.clone(),
                            }))
                        }),
                    }
                }
                None => RigMessage::User {
                    content: OneOrMany::one(UserContent::Text(Text {
                        text: turn_message.clone(),
                    })),
                },
            }
        };

        let turn_span = info_span!(
            "tenex.agent.turn",
            agent.slug = %agent_slug,
            agent.pubkey = %pubkey_hex,
            conversation.id = %conversation_id,
            project.id = %project_id,
            llm.provider = %resolved.provider,
            llm.model = %resolved.model,
            history.messages = initial_history.len(),
        );
        let final_response = async {
            let response = match resolved.provider.as_str() {
                "openrouter" => {
                    let key = resolved
                        .api_key
                        .clone()
                        .context("No OpenRouter API key found in ~/.tenex/providers.json")?;
                    let client = RecordingClient::new(
                        openrouter::Client::new(&key)?,
                        cassette_recorder.clone(),
                    );
                    run_agent!(
                        client,
                        &resolved.model,
                        &system_prompt,
                        turn_prompt.clone(),
                        current_history,
                        hook.clone(),
                        tools
                    )
                }
                "openai" => {
                    let key = resolved
                        .api_key
                        .clone()
                        .context("No OpenAI API key found in ~/.tenex/providers.json")?;
                    let client = RecordingClient::new(
                        openai::CompletionsClient::builder().api_key(&key).build()?,
                        cassette_recorder.clone(),
                    );
                    run_agent!(
                        client,
                        &resolved.model,
                        &system_prompt,
                        turn_prompt.clone(),
                        current_history,
                        hook.clone(),
                        tools
                    )
                }
                "ollama" => {
                    let mut builder = ollama::Client::builder().api_key(Nothing);
                    if let Some(url) = &resolved.base_url {
                        builder = builder.base_url(url);
                    }
                    let client = RecordingClient::new(builder.build()?, cassette_recorder.clone());
                    run_agent!(
                        client,
                        &resolved.model,
                        &system_prompt,
                        turn_prompt.clone(),
                        current_history,
                        hook.clone(),
                        tools
                    )
                }
                "mock" => {
                    let client = RecordingClient::new(
                        mock_llm::MockClient::from_env(&agent_slug)?,
                        cassette_recorder.clone(),
                    );
                    run_agent!(
                        client,
                        &resolved.model,
                        &system_prompt,
                        turn_prompt.clone(),
                        current_history,
                        hook.clone(),
                        tools
                    )
                }
                _ => {
                    let key = resolved.api_key.clone().with_context(|| {
                        format!(
                            "No API key found for provider '{}' in ~/.tenex/providers.json",
                            resolved.provider
                        )
                    })?;
                    if oauth_client::is_oauth_token(&key) {
                        let http_client = oauth_client::build_oauth_http_client(&key);
                        let client = RecordingClient::new(
                            anthropic::Client::builder()
                                .api_key(&key)
                                .anthropic_betas(oauth_client::OAUTH_BETAS)
                                .http_client(http_client)
                                .build()?,
                            cassette_recorder.clone(),
                        );
                        run_agent!(
                            client,
                            &resolved.model,
                            &system_prompt,
                            turn_prompt.clone(),
                            current_history,
                            hook.clone(),
                            tools,
                            |m: RecordingModel<
                                anthropic::completion::CompletionModel<
                                    reqwest_middleware::ClientWithMiddleware,
                                >,
                            >| m
                                .map_inner(|inner| inner.with_prompt_caching())
                        )
                    } else {
                        let client = RecordingClient::new(
                            anthropic::Client::new(&key)?,
                            cassette_recorder.clone(),
                        );
                        run_agent!(
                            client,
                            &resolved.model,
                            &system_prompt,
                            turn_prompt.clone(),
                            current_history,
                            hook.clone(),
                            tools,
                            |m: RecordingModel<anthropic::completion::CompletionModel>| {
                                m.map_inner(|inner| inner.with_prompt_caching())
                            }
                        )
                    }
                }
            };
            Ok::<_, anyhow::Error>(response)
        }
        .instrument(turn_span)
        .await?;

        if let Some(state) = &runtime_state {
            state.release_driver();
        }

        let recorded_calls = recorder.take_records();

        // Persist final todos and self-applied skills back to the conversation store.
        if let Some(ref store) = conv_store {
            let final_todos = todos.lock().unwrap();
            let final_skills = self_applied_skills.lock().unwrap();
            save_context_state(
                store,
                &conversation_id,
                &pubkey_hex,
                &final_todos,
                &final_skills,
            );
        }

        // Persist the tool calls captured during this turn into `tool_messages`.
        // These rows pair with `tool_calls` on the assistant prompt-history entry
        // below: projection re-emits them as `Message::ToolResult` immediately
        // after the assistant message that issued the calls.
        if let Some(ref store) = conv_store {
            for rec in &recorded_calls {
                let new_tool = NewToolMessage {
                    tool_call_id: rec.call_id.clone(),
                    parent_message_id: None,
                    agent_pubkey: pubkey_hex.clone(),
                    tool_name: rec.tool_name.clone(),
                    call_input: rec.args.clone(),
                    result_output: Some(rec.result.clone()),
                    is_error: rec.is_error,
                    timestamp: Some(rec.timestamp_ms),
                };
                if let Err(e) = store.record_tool_message(&conversation_id, &new_tool) {
                    eprintln!("[tenex-agent] Failed to persist tool message: {e}");
                }
            }
        }

        // Record this turn's messages into the conversation store for future history projection.
        if let Some(ref store) = conv_store {
            let stream_usage = final_response.usage();
            let assistant_tool_calls: Vec<CtxToolCall> = recorded_calls
                .iter()
                .map(|r| CtxToolCall {
                    id: r.call_id.clone(),
                    name: r.tool_name.clone(),
                    arguments: r.args.clone(),
                })
                .collect();
            let hit_tokens = stream_usage.cached_input_tokens as u64;
            accounting::record_turn(
                &resolved.provider,
                &resolved.model,
                "stream",
                Some(pubkey_hex.clone()),
                None,
                Some(conversation_id.clone()),
                None,
                Some(current_message.clone()),
                Some(final_response.response().to_string()),
                stream_usage.input_tokens as u64,
                stream_usage.output_tokens as u64,
                stream_usage.cached_input_tokens as u64,
                stream_usage.cache_creation_input_tokens as u64,
                stream_usage.cached_input_tokens as u64,
                0,
                Some(stream_usage.total_tokens as u64),
                None,
            );
            let messages_visible = vec![
                CtxMessage::User {
                    content: current_message.clone(),
                },
                CtxMessage::Assistant {
                    content: final_response.response().to_string(),
                    tool_calls: assistant_tool_calls,
                },
            ];
            // When the provider reports a cache hit, record the position of
            // the assistant response as the live cache anchor for this turn.
            let breakpoint_hints = if hit_tokens > 0 {
                vec![BreakpointHint {
                    position: 1,
                    kind: BreakpointKind::MessageStream,
                }]
            } else {
                Vec::new()
            };
            let turn = TurnRecord {
                messages_visible,
                reminders_applied: Vec::new(),
                compaction_decisions: Vec::new(),
                cache_observed: CacheObservation {
                    hit_tokens,
                    miss_tokens: 0,
                    written_tokens: stream_usage.cache_creation_input_tokens as u64,
                },
                breakpoint_hints,
            };
            if let Err(e) = tenex_context::record_turn(store, &conversation_id, &pubkey_hex, turn) {
                eprintln!("[tenex-agent] Failed to record turn: {e}");
            }
        }

        eprintln!("[tenex-agent] Agent completed.");

        let stream_usage = final_response.usage();
        let pending_final = hook_handle.take_pending();

        // Post-completion supervision: check if pending todos warrant re-engagement.
        let todos_snap: Vec<SupTodoEntry> = {
            let lock = todos.lock().unwrap();
            lock.iter()
                .map(|t| SupTodoEntry {
                    id: t.id.clone(),
                    status: match t.status {
                        TodoStatus::Pending => SupTodoStatus::Pending,
                        TodoStatus::InProgress => SupTodoStatus::InProgress,
                        TodoStatus::Done => SupTodoStatus::Done,
                        TodoStatus::Skipped => SupTodoStatus::Skipped,
                    },
                })
                .collect()
        };
        let outcome = {
            let mut sup = supervisor_ref.lock().unwrap();
            sup.check_post_completion(todos_snap, 0, envelope.content.clone())
        };
        match outcome {
            PostCompletionOutcome::Accept => {
                let suppressed = suppress_response.load(Ordering::Acquire);
                if let Some((final_content, final_ral)) = pending_final {
                    if !suppressed {
                        let final_ctx = emit_state.build_ctx(final_ral);
                        let usage = Some(LlmUsage {
                            input_tokens: Some(stream_usage.input_tokens),
                            output_tokens: Some(stream_usage.output_tokens),
                            total_tokens: Some(stream_usage.total_tokens),
                            cached_input_tokens: Some(stream_usage.cached_input_tokens),
                            ..Default::default()
                        });
                        if emit_state.has_pending_external_work() {
                            let intent = ConversationIntent {
                                content: final_content,
                                is_reasoning: false,
                                usage,
                                metadata: None,
                            };
                            channel
                                .send(Intent::Conversation(intent), &final_ctx)
                                .await
                                .context("Failed to emit pending-work conversation event")?;
                        } else {
                            let intent = CompletionIntent {
                                content: final_content,
                                usage,
                                metadata: None,
                            };
                            channel
                                .send(Intent::Completion(intent), &final_ctx)
                                .await
                                .context("Failed to emit final completion event")?;
                        }
                    }
                }
                break 'agent_loop;
            }
            PostCompletionOutcome::InjectMessage { message } => {
                eprintln!("[tenex-agent] Supervision nudge (no re-engage): {message}");
                let suppressed = suppress_response.load(Ordering::Acquire);
                if let Some((final_content, final_ral)) = pending_final {
                    if !suppressed {
                        let final_ctx = emit_state.build_ctx(final_ral);
                        let usage = Some(LlmUsage {
                            input_tokens: Some(stream_usage.input_tokens),
                            output_tokens: Some(stream_usage.output_tokens),
                            total_tokens: Some(stream_usage.total_tokens),
                            cached_input_tokens: Some(stream_usage.cached_input_tokens),
                            ..Default::default()
                        });
                        if emit_state.has_pending_external_work() {
                            let intent = ConversationIntent {
                                content: final_content,
                                is_reasoning: false,
                                usage,
                                metadata: None,
                            };
                            channel
                                .send(Intent::Conversation(intent), &final_ctx)
                                .await
                                .context("Failed to emit pending-work conversation event")?;
                        } else {
                            let intent = CompletionIntent {
                                content: final_content,
                                usage,
                                metadata: None,
                            };
                            channel
                                .send(Intent::Completion(intent), &final_ctx)
                                .await
                                .context("Failed to emit final completion event")?;
                        }
                    }
                }
                break 'agent_loop;
            }
            PostCompletionOutcome::ReEngage { message } => {
                use rig::completion::message::{Text, UserContent};
                use rig::completion::AssistantContent;
                use rig::OneOrMany;

                re_engage_history.push(RigMessage::User {
                    content: OneOrMany::one(UserContent::Text(Text {
                        text: current_message,
                    })),
                });
                re_engage_history.push(RigMessage::Assistant {
                    id: None,
                    content: OneOrMany::one(AssistantContent::Text(Text {
                        text: final_response.response().to_string(),
                    })),
                });
                current_message = message;
                eprintln!("[tenex-agent] Supervision: pending todos — re-engaging...");
            }
        }
    }

    Ok(())
}
