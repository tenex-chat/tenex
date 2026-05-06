//! Bootstrap for a single tenex-agent invocation.
//!
//! [`build`] reads the triggering envelope from stdin, opens the project and
//! conversation store, resolves the LLM provider/model, constructs the system
//! prompt, builds the tool set, and projects the conversation history. The
//! result is an [`AgentBootstrap`] containing every value the turn loop in
//! [`crate::turn_loop`] consumes.
//!
//! Only `pub(crate)` items leave this module. Helper sub-modules
//! ([`helpers`]) hold pure-function bootstrap stages.

mod assembly;
mod helpers;
mod stages;

use anyhow::{Context, Result};
use std::sync::{atomic::AtomicBool, Arc, Mutex};

use rig::completion::Message as RigMessage;
use tenex_conversations::ConversationStore;
use tenex_protocol::{
    nostr::{read_one_from_stdin, NostrChannel},
    sink::StdoutNdjsonSink,
    Channel, MessageRef, PrincipalRef,
};
use tenex_supervision::supervisor::Supervisor;

use crate::cassette::CassetteRecorder;
use crate::config::{self, ResolvedModel};
use crate::emit::EmitState;
use crate::hook::EmitHook;
use crate::injections::MessageInjectionTracker;
use crate::runtime_state::RuntimeStateHandle;
use crate::shell_task_reminder::render_active_shell_tasks_reminder;
use crate::tools::{
    self, RagAddDocumentsTool, RagSearchTool, SkillListTool, SkillsSetTool, TodoItem, ToolSet,
};
use crate::{escalation, home, stdio_home, workflows};

/// All state assembled by [`build`] that the turn loop subsequently reads or
/// mutates. Loop-local working values (`current_message`, accumulated
/// `re_engage_history`) live as locals inside `run_turn_loop`.
pub(crate) struct AgentBootstrap {
    pub channel: Arc<dyn Channel>,
    pub conv_store: Option<ConversationStore>,
    pub conversation_id: String,
    pub pubkey_hex: String,
    pub agent_slug: String,
    pub project_id: String,
    pub resolved: ResolvedModel,
    pub cassette_recorder: Option<CassetteRecorder>,
    pub system_prompt: String,
    pub user_message: String,
    pub initial_history: Vec<RigMessage>,
    pub envelope_image_parts: Option<Vec<rig::completion::message::UserContent>>,
    pub envelope_content: String,
    pub tool_set: ToolSet,
    pub emit_state: Arc<EmitState>,
    pub hook: EmitHook,
    pub hook_handle: EmitHook,
    pub supervisor_ref: Arc<Mutex<Supervisor>>,
    pub injection_tracker: Arc<Mutex<MessageInjectionTracker>>,
    pub runtime_state: Option<RuntimeStateHandle>,
    pub todos: Arc<Mutex<Vec<TodoItem>>>,
    pub self_applied_skills: Arc<Mutex<Vec<String>>>,
    pub suppress_response: Arc<AtomicBool>,
}

pub(crate) async fn build(
    args: &[String],
    project_id: String,
    agent_config: config::AgentConfig,
    agent_keys: nostr::Keys,
    pubkey_hex: String,
    agent_slug: String,
) -> Result<AgentBootstrap> {
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
    debug_assert_eq!(
        match channel.identity() {
            PrincipalRef::Nostr { pubkey, .. } => pubkey.to_hex(),
        },
        pubkey_hex
    );

    // Resolve working directory and current branch.
    // The project_root is the canonical base path; working_dir may differ when
    // a worktree is created for the branch carried in the triggering event.
    let stages::WorkspacePaths {
        project_root,
        working_dir,
        project_base_path,
        current_branch,
        root_agents_md,
    } = stages::resolve_workspace(
        &agent_config,
        envelope.metadata.branch.as_deref(),
        envelope.metadata.commit.as_deref(),
    );

    // Open project and load context used for prompts + delegate tool.
    let stages::OpenedProject {
        project_meta,
        project_agents,
        is_pm_agent,
        project_ref,
        owner_pubkey_hex,
    } = stages::open_project(&project_id, &pubkey_hex)?;

    // Open the conversation store for todo persistence and history projection.
    let envelope_conversation_id = match &envelope.root {
        MessageRef::Nostr { event_id } => event_id.to_hex(),
    };
    let conversation_id = std::env::var("TENEX_CONVERSATION_ID")
        .ok()
        .filter(|id| nostr::EventId::from_hex(id).is_ok())
        .unwrap_or(envelope_conversation_id);
    let conv_store = stages::open_conversation_store(&project_id, &conversation_id);

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
    let base_dir = tenex_project::paths::default_base_dir();

    // Resolve provider + model + API key. Precedence (highest first):
    // 1. `variant` tag on the triggering event (per-invocation override from
    //    self_delegate's `variant` parameter or any other delegation), applied
    //    against the agent's base meta config.
    // 2. Agent's static default model.
    // 3. Global default in llms.json (resolved by ConfigStore).
    let resolved = ResolvedModel::resolve_with_variant(
        &base_dir,
        agent_config.raw_model(),
        envelope.metadata.variant_override.as_deref(),
    )?;
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
    let summarization_model =
        Arc::new(match ResolvedModel::resolve_role(&base_dir, "summarization") {
            Ok(model) => {
                eprintln!(
                    "[tenex-agent] summarization model: {} | {}",
                    model.provider, model.model
                );
                model
            }
            Err(e) => {
                eprintln!(
                    "[tenex-agent] summarization role unavailable ({e}); using agent's resolved model"
                );
                resolved.clone()
            }
        });
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

    // Load teams (global + project-specific). The system-prompt builder
    // filters `<available-agents>` against this list.
    let teams = Arc::new(tenex_project::load_teams(&base_dir, Some(&project_id)));

    // Set up agent home directory.
    let agent_home = home::agent_home_dir(&base_dir, &pubkey_hex);
    home::ensure_agent_home_dir(&agent_home);
    if let Err(e) = stdio_home::write_agent_env_file(&agent_home, &agent_config.nsec, &pubkey_hex) {
        eprintln!("[tenex-agent] Failed to write agent .env file: {e}");
    }

    // Build env vars for shell commands: parse agent .env + inject computed vars.
    let shell_env = stages::build_shell_env(
        &agent_home,
        &pubkey_hex,
        &base_dir,
        &working_dir,
        &project_id,
    );

    let injected_files = home::get_injected_files(&agent_home);
    let file_count = home::count_home_files(&agent_home);
    let home_info = tenex_system_prompt::HomeDirectoryInfo {
        home_dir: &agent_home.display().to_string(),
        file_count: &file_count,
        injected_files: &injected_files,
    };

    let agent_workflows = workflows::list_workflows(&agent_home);
    let workflows_fragment = workflows::render_workflows_fragment(&agent_workflows);

    // Resolve the agent's category once. When the static config has no
    // category, this backfills via LLM and persists to the registry. The
    // resolved value drives skill auto-enable, system prompt restrictions,
    // supervisor policy, delegation gating, and ToolSet category gating —
    // all downstream consumers must use this single source of truth.
    let resolved_category_string =
        helpers::resolve_agent_category(&agent_config, &resolved, &base_dir, &pubkey_hex).await;
    let resolved_category_enum = resolved_category_string
        .as_deref()
        .and_then(|s| s.parse::<tenex_supervision::types::AgentCategory>().ok());

    // Resolve skill context: persisted self-applied skills, always-on config
    // skills, preloaded-skills system-prompt block, and skill-granted tools.
    let stages::SkillContextOutputs {
        skill_ctx,
        initial_self_applied,
        granted_tools,
        preloaded_skills_block,
    } = stages::build_skill_context(stages::SkillContextInputs {
        agent_pubkey: &pubkey_hex,
        working_dir: &working_dir,
        base_dir: &base_dir,
        agent_home: &agent_home,
        agent_config_path: &args[1],
        conv_store: conv_store.as_ref(),
        conversation_id: &conversation_id,
        agent_default_skills: agent_config.default.as_ref().and_then(|d| d.skills.clone()),
        envelope_skills: envelope.metadata.skills.clone(),
        agent_category: resolved_category_enum,
    });

    // Shared self-applied skills state (pre-seeded from persistence; updated by skills_set tool).
    let self_applied_skills: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(initial_self_applied));

    let telegram_channel_bindings =
        helpers::load_telegram_channel_bindings(&base_dir, &pubkey_hex, &project_meta.d_tag);
    let telegram_chat_context =
        helpers::fetch_telegram_chat_context(&envelope, &agent_config).await;
    let delegation_parent_id = helpers::delegation_parent_id(&envelope);
    let conversation_reminders: Option<tenex_system_prompt::ConversationRemindersForPrompt> =
        conv_store.as_ref().map(|store| {
            helpers::build_conversation_reminders(
                store,
                &conversation_id,
                delegation_parent_id.as_deref(),
            )
        });
    let scheduled_tasks_for_prompt = helpers::load_scheduled_tasks_for_prompt(&pubkey_hex);
    let git_worktrees = helpers::list_worktrees_safe(&project_root);
    let global_system_prompt = config::read_global_system_prompt(&base_dir);

    // Build system prompt
    let mut system_prompt = assembly::compose_system_prompt(assembly::SystemPromptInputs {
        agent_config: &agent_config,
        pubkey_hex: &pubkey_hex,
        conversation_id: &conversation_id,
        working_dir: &working_dir,
        project_base_path: &project_base_path,
        project_meta: &project_meta,
        project_agents: &project_agents,
        teams: &teams,
        agent_slug: agent_config.slug.as_deref().unwrap_or(""),
        active_team: envelope.metadata.team.as_deref(),
        home: &home_info,
        root_agents_md: root_agents_md.as_deref(),
        preloaded_skills_block: preloaded_skills_block.as_deref(),
        workflows_fragment: workflows_fragment.as_deref(),
        telegram_channel_bindings: &telegram_channel_bindings,
        telegram_chat_context,
        scheduled_tasks: &scheduled_tasks_for_prompt,
        current_branch: current_branch.as_deref(),
        worktrees: &git_worktrees,
        category_str: resolved_category_string.as_deref(),
        category: resolved_category_enum,
        global_system_prompt: global_system_prompt.as_deref(),
    });

    // Load persisted todos and inject them as a system reminder into the user message.
    let initial_todos: Vec<TodoItem> = conv_store
        .as_ref()
        .map(|s| helpers::load_todos_from_store(s, &conversation_id, &pubkey_hex))
        .unwrap_or_default();
    let todo_reminder = tools::format_todos_reminder(&initial_todos);
    let conversation_reminders_text = conversation_reminders
        .as_ref()
        .and_then(tenex_system_prompt::render_conversation_reminders);
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
    // The runtime sets this when the trigger event was authored by a
    // project agent that this backend does not run locally — i.e., the
    // requester lives in a different daemon process and almost certainly
    // on a different host. The disclosure tells the agent there is no
    // shared filesystem with the requester so it can avoid local-path
    // assumptions when coordinating.
    let trigger_from_remote_agent = std::env::var("TENEX_TRIGGER_FROM_REMOTE_AGENT")
        .map(|v| v == "1")
        .unwrap_or(false);
    let remote_agent_disclosure = if trigger_from_remote_agent {
        Some(
            "[system] This message is from another project agent running on a different \
             backend. You do not share a filesystem or workspace with the requester — do not \
             reference local paths or assume access to the same files. Coordinate via the \
             conversation, not via the filesystem.",
        )
    } else {
        None
    };
    let user_message = helpers::compose_user_message(
        &envelope.content,
        &todo_reminder,
        conversation_reminders_text.as_deref(),
        external_disclosure,
        remote_agent_disclosure,
    );

    // Shared todo state across tool calls (pre-seeded from persistence).
    let todos: Arc<Mutex<Vec<TodoItem>>> = Arc::new(Mutex::new(initial_todos));

    let emit_state = assembly::assemble_emit_state(assembly::EmitStateInputs {
        channel: channel.clone(),
        project_ref,
        envelope: &envelope,
        conversation_id: &conversation_id,
        provider: &resolved.provider,
        model: &resolved.model,
        current_branch: current_branch.as_deref(),
    });

    let assembly::SupervisorComponents {
        supervisor_ref,
        hook,
        allows_delegation,
        delegate_tool,
        agent_category,
    } = assembly::init_supervisor_and_hook(
        resolved_category_enum,
        emit_state.clone(),
        todos.clone(),
        runtime_state.clone(),
        project_agents.clone(),
        teams.clone(),
        project_root.clone(),
    );

    let skill_list_tool = SkillListTool::new(skill_ctx.clone());
    let skills_set_tool = SkillsSetTool::new(skill_ctx.clone(), self_applied_skills.clone());
    let mcp_proxy_tools = helpers::load_mcp_proxy_tools()?;

    // Initialize RAG store for the embedding tools.
    let rag_store = stages::open_rag_store(&base_dir);

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
    if let Some(block) = stages::proactive_context_block(
        rag_store.as_ref(),
        &envelope.content,
        &project_id,
        &pubkey_hex,
        &conversation_id,
        &resolved,
    )
    .await
    {
        system_prompt.push_str(&block);
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
    let initial_history: Vec<RigMessage> = stages::project_history(
        conv_store.as_ref(),
        &conversation_id,
        &pubkey_hex,
        &project_id,
        &system_prompt,
        &resolved,
        &base_dir,
        Some(&trigger_event_id),
    )
    .await;
    eprintln!(
        "[tenex-agent] Running agent (history: {} messages)...",
        initial_history.len()
    );

    let escalation_pubkey = escalation::resolve_escalation_pubkey(&base_dir, &project_agents)
        .filter(|pk| pk != &pubkey_hex);
    let blossom_url = helpers::read_blossom_server_url(&base_dir)
        .unwrap_or_else(|| "https://blossom.primal.net".to_string());
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
        agent_category,
        conv_db_path: conv_db_path.clone(),
        conversation_id: conversation_id.clone(),
        agent_pubkey: pubkey_hex.clone(),
        agent_nsec: agent_config.nsec.clone(),
        agent_home: agent_home.clone(),
        resolved_model: Arc::new(resolved.clone()),
        summarization_model: summarization_model.clone(),
        project_d_tag: project_meta.d_tag.clone(),
        agent_slug: agent_slug.clone(),
        project_id: project_id.clone(),
        execution_id: execution_id.clone(),
        suppress_response: suppress_response.clone(),
        rag_store: rag_store.clone(),
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
        blossom_url,
        agent_keys,
    };

    // Keep a handle with shared Arc refs so we can read the pending final turn
    // after the stream ends, even after `hook` is moved into the agent builder.
    let hook_handle = hook.clone();

    // Prefetch images from the inbound envelope for vision-capable providers.
    // Fetched once so re-engagement turns (supervisor-generated text) do not
    // trigger additional network calls.
    let envelope_image_parts =
        stages::prepare_envelope_image_parts(&resolved.provider, &base_dir, &envelope.content)
            .await;

    Ok(AgentBootstrap {
        channel,
        conv_store,
        conversation_id,
        pubkey_hex,
        agent_slug,
        project_id,
        resolved,
        cassette_recorder,
        system_prompt,
        user_message,
        initial_history,
        envelope_image_parts,
        envelope_content: envelope.content,
        tool_set,
        emit_state,
        hook,
        hook_handle,
        supervisor_ref,
        injection_tracker,
        runtime_state,
        todos,
        self_applied_skills,
        suppress_response,
    })
}
