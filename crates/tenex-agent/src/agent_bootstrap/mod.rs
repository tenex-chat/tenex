//! Bootstrap for a single tenex-agent invocation.
//!
//! [`build`] reads the triggering envelope from stdin, opens the project and
//! conversation store, resolves the LLM provider/model, constructs the system
//! prompt, and builds the tool set. The result is an [`AgentBootstrap`]
//! containing every value the turn loop in [`crate::turn_loop`] consumes.
//!
//! Only `pub(crate)` items leave this module. Helper sub-modules
//! ([`helpers`]) hold pure-function bootstrap stages.

mod assembly;
mod helpers;
mod stages;

use anyhow::{Context, Result};
use std::sync::{Arc, Mutex, atomic::AtomicBool};

use tenex_conversations::ConversationStore;
use tenex_protocol::{
    Channel, MessageRef, PrincipalRef,
    nostr::{NostrChannel, read_one_from_stdin},
    sink::StdoutNdjsonSink,
};
use tenex_supervision::supervisor::Supervisor;

use crate::cassette::CassetteRecorder;
use crate::config::{self, ResolvedModel};
use crate::emit::EmitState;
use crate::hook::EmitHook;
use crate::injections::MessageInjectionTracker;
use crate::runtime_state::RuntimeStateHandle;
use crate::shell_task_reminder::render_active_shell_tasks_reminder;
use crate::tools::agent_tool_set::ToolSet;
use crate::tools::{
    self, RagAddDocumentsTool, RagSearchTool, SkillListTool, SkillsSetTool, TodoItem,
};
use crate::{escalation, home, stdio_home, workflows};

/// All state assembled by [`build`] that the turn loop subsequently reads or
/// mutates. Loop-local working values such as `current_message` live as locals
/// inside `run_turn_loop`.
pub(crate) struct AgentBootstrap {
    pub channel: Arc<dyn Channel>,
    pub conv_store: Option<ConversationStore>,
    pub conversation_id: String,
    pub pubkey_hex: String,
    pub agent_slug: String,
    pub project_id: String,
    /// Per-process invocation id, sourced from `TENEX_EXECUTION_ID` set
    /// by the runtime before spawning the subprocess. Used to build
    /// invocation-scoped record_ids that are guaranteed not to collide
    /// across re-invocations of the same agent in the same conversation.
    pub execution_id: String,
    pub base_dir: std::path::PathBuf,
    pub resolved: ResolvedModel,
    pub cassette_recorder: Option<CassetteRecorder>,
    pub system_prompt: String,
    pub user_message: String,
    pub envelope_image_parts: Option<Vec<rig_core::completion::message::UserContent>>,
    /// The content of the conversation's root user message — what the human
    /// originally asked. Sourced from the conversation store at bootstrap
    /// and threaded into supervision so the "Your original task was: …"
    /// nudge always references the *real* original task, not the envelope
    /// of whichever event re-triggered this subprocess (e.g. a delegatee's
    /// reply, which would mis-name the task as "Black — RGB(0,0,0)").
    pub original_task: String,
    /// Pre-computed `<proactive-context>` block (RAG output against the
    /// trigger event). Threaded into every step's projection via the
    /// `project(… proactive_context …)` parameter so [`ProactiveContextStrategy`]
    /// overlays it onto the last visible message. Stable across the entire
    /// invocation so the system prompt remains cacheable.
    ///
    /// [`ProactiveContextStrategy`]: tenex_context::ProactiveContextStrategy
    pub proactive_context: Option<String>,
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
    // One health tracker per agent process — shared by every ResolvedModel
    // built during this invocation (main model, summarization role, any
    // future role resolutions) so a key failure observed by one call site
    // is honoured by every subsequent LLM request.
    let key_health = Arc::new(tenex_llm_config::key_health::KeyHealthTracker::new());
    let resolved = ResolvedModel::resolve_with_variant(
        &base_dir,
        agent_config.raw_model(),
        envelope.metadata.variant_override.as_deref(),
        key_health.clone(),
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
    let summarization_model = Arc::new(
        match ResolvedModel::resolve_role(&base_dir, "summarization", key_health.clone()) {
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
        },
    );
    let trigger_pubkey_hex = match &envelope.principal {
        PrincipalRef::Nostr { pubkey, .. } => pubkey.to_hex(),
    };
    let trigger_event_id = match &envelope.message {
        MessageRef::Nostr { event_id } => event_id.to_hex(),
    };
    eprintln!(
        "[tenex-agent] Triggered by event {} from {}",
        tenex_utils::ids::shorten_full_event_id(&trigger_event_id),
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
        conv_db_path.clone(),
    );

    let skill_list_tool = SkillListTool::new(skill_ctx.clone());
    let skills_set_tool = SkillsSetTool::new(skill_ctx.clone(), self_applied_skills.clone());
    let image_support =
        helpers::detect_image_support(&base_dir, &resolved.provider, &resolved.model);
    let mcp_proxy_tools = helpers::load_mcp_proxy_tools(image_support)?;

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
    // knowledge appears in the projection without the agent needing to ask.
    // Uses an LLM query planner (for non-trivial messages) and LLM reranker
    // (when > 3 results pass the score threshold).
    //
    // The block lives on `boot.proactive_context` and is overlaid onto the
    // last non-system message by `ProactiveContextStrategy` at projection
    // time — *not* concatenated onto `system_prompt`, because the system
    // prompt must remain stable across invocations to keep the prompt
    // cache warm. (Previously this push_str() was the root cause of
    // 0% cache-hit rate observed across delegation callback chains.)
    let proactive_resolver = crate::identity_resolver::IdentityServiceResolver::new(&base_dir);
    let proactive_context: Option<String> = stages::proactive_context_block(
        rag_store.as_ref(),
        conv_store.as_ref(),
        &proactive_resolver,
        &envelope.content,
        &project_id,
        &pubkey_hex,
        &conversation_id,
        &resolved,
    )
    .await;

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
    eprintln!("[tenex-agent] Running agent...");

    // Keep a handle with shared Arc refs so we can read the pending final turn
    // after the stream ends, even after `hook` is moved into the agent builder.
    let hook_handle = hook.clone();

    // Prefetch images from the inbound envelope for vision-capable providers.
    // Fetched once so re-engagement turns (supervisor-generated text) do not
    // trigger additional network calls.
    let fetched_attachments =
        stages::fetch_envelope_attachments(&resolved.provider, &base_dir, &envelope.content).await;

    // Persist attachments to the conversation store, hanging them off the
    // trigger event row that the runtime already materialized before
    // spawning this subprocess (see tenex/src/runtime_cmd/dispatch_pipeline.rs
    // and event_routing.rs). The post-refactor projection reads from this
    // sidecar; the dual-write path below keeps the in-memory `turn_prompt`
    // path working for now.
    if let Some(store) = conv_store.as_ref() {
        if let Ok(Some(trigger_row_id)) = store.find_message_id_by_event(&trigger_event_id) {
            for (ordinal, att) in fetched_attachments.iter().enumerate() {
                if let Err(e) = store.record_attachment(
                    trigger_row_id,
                    ordinal as i64,
                    &att.media_type,
                    &att.data,
                    Some(att.source_url.as_str()),
                ) {
                    eprintln!(
                        "[tenex-agent] failed to persist attachment {} for trigger row {}: {}",
                        att.source_url, trigger_row_id, e
                    );
                }
            }
        } else if !fetched_attachments.is_empty() {
            eprintln!(
                "[tenex-agent] warn: trigger row for event {} not found in store; \
                 {} attachments could not be persisted (will fall back to in-memory path)",
                trigger_event_id,
                fetched_attachments.len()
            );
        }
    }

    let envelope_image_parts = if fetched_attachments.is_empty() {
        None
    } else {
        Some(
            fetched_attachments
                .into_iter()
                .map(crate::multimodal::FetchedAttachment::into_user_content)
                .collect::<Vec<_>>(),
        )
    };

    // Source the "original task" string from the conversation store: the
    // user-role row whose `nostr_event_id` matches the conversation root
    // event id. The conversation_id IS the root event id in our
    // Nostr-rooted conversation model. Fallback to envelope.content if
    // the conversation root row is not yet materialized (race or fresh
    // conversation with no prior turn — in which case envelope.content
    // *is* the root). Reading from storage is what fixes Bug B on
    // delegation callbacks, where the envelope carries the delegatee's
    // reply, not the original task.
    let original_task: String = conv_store
        .as_ref()
        .and_then(|store| store.get_message_by_event(&conversation_id).ok().flatten())
        .map(|row| row.content)
        .unwrap_or_else(|| envelope.content.clone());

    let execution_id =
        std::env::var("TENEX_EXECUTION_ID").unwrap_or_else(|_| format!("local-{}", std::process::id()));

    Ok(AgentBootstrap {
        channel,
        conv_store,
        conversation_id,
        pubkey_hex,
        agent_slug,
        project_id,
        execution_id,
        base_dir,
        resolved,
        cassette_recorder,
        system_prompt,
        user_message,
        envelope_image_parts,
        original_task,
        proactive_context,
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
