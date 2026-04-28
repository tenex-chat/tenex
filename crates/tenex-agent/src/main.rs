mod config;
mod emit;
mod home;
mod hook;
mod prompt;
mod skills;
mod tools;

use anyhow::{Context, Result};
use config::{LlmsConfig, ResolvedModel};
use emit::{AgentMeta, EmitState};
use hook::EmitHook;
use rig::client::{CompletionClient, Nothing};
use rig::providers::{anthropic, ollama, openai, openrouter};
use std::sync::{Arc, Mutex};
use tenex_conversations::{AgentContextState, ConversationStore};
use tenex_project::Project;
use tenex_rag::{EmbedConfig, RagStore};
use tenex_supervision::heuristics::default_supervisor;
use tenex_protocol::{
    nostr::{read_one_from_stdin, NostrChannel},
    sink::StdoutNdjsonSink,
    Channel, ConversationIntent, ConversationRef, Intent, LlmUsage, MessageRef, PrincipalRef,
    ProjectRef,
};
use rig::tool::ToolDyn;
use tools::{
    DelegateTool, FsEditTool, FsGlobTool, FsGrepTool, FsReadTool, FsWriteTool,
    HomeFsEditTool, HomeFsGlobTool, HomeFsGrepTool, HomeFsReadTool, HomeFsWriteTool,
    RagIndexTool, RagSearchTool, ShellTool, SkillListTool, SkillsSetTool, TodoItem, TodoWriteTool,
};

/// Build and run the agent with all tools attached, streaming the response.
/// Returns a `rig::agent::FinalResponse` containing the final turn text and
/// aggregated token usage across all turns.
/// $delegate is Option<DelegateTool> — None for categories that cannot delegate.
macro_rules! run_agent {
    ($client:expr, $model:expr, $system:expr, $message:expr, $wd:expr, $env:expr, $todos:expr, $hook:expr, $delegate:expr, $rag_index:expr, $rag_search:expr, $skill_list:expr, $skills_set:expr, $fs_tools:expr) => {{
        use ::futures::StreamExt as _;
        use ::rig::streaming::StreamingPrompt as _;

        let __base = $client
            .agent($model)
            .preamble($system)
            .max_tokens(16384)
            .default_max_turns(25)
            .tool(ShellTool::new($wd.clone(), $env.clone()))
            .tools($fs_tools)
            .tool(TodoWriteTool::new($todos.clone()))
            .tool($skill_list)
            .tool($skills_set);

        let __base = if let Some(__d) = $delegate {
            __base.tool(__d)
        } else {
            __base
        };

        let mut __stream = __base
            .tool($rag_index)
            .tool($rag_search)
            .build()
            .stream_prompt($message)
            .with_hook($hook)
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

fn build_fs_tools(
    granted_tools: &std::collections::HashSet<String>,
    working_dir: &str,
    home_dir: &str,
) -> Vec<Box<dyn ToolDyn>> {
    let mut tools: Vec<Box<dyn ToolDyn>> = Vec::new();

    if granted_tools.contains("fs_read") {
        tools.push(Box::new(FsReadTool::new(working_dir.to_string())));
    } else {
        tools.push(Box::new(HomeFsReadTool::new(home_dir.to_string())));
    }

    if granted_tools.contains("fs_write") {
        tools.push(Box::new(FsWriteTool::new(working_dir.to_string())));
        tools.push(Box::new(FsEditTool::new(working_dir.to_string())));
    } else {
        tools.push(Box::new(HomeFsWriteTool::new(home_dir.to_string())));
        tools.push(Box::new(HomeFsEditTool::new(home_dir.to_string())));
    }

    if granted_tools.contains("fs_glob") {
        tools.push(Box::new(FsGlobTool::new(working_dir.to_string())));
    } else {
        tools.push(Box::new(HomeFsGlobTool::new(home_dir.to_string())));
    }

    if granted_tools.contains("fs_grep") {
        tools.push(Box::new(FsGrepTool::new(working_dir.to_string())));
    } else {
        tools.push(Box::new(HomeFsGrepTool::new(home_dir.to_string())));
    }

    tools
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
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let state = AgentContextState {
        conversation_id: conversation_id.to_string(),
        agent_pubkey: agent_pubkey.to_string(),
        next_prompt_sequence: existing.as_ref().map(|s| s.next_prompt_sequence).unwrap_or(0),
        cache_anchored: existing.as_ref().map(|s| s.cache_anchored).unwrap_or(false),
        seen_message_ids: existing
            .as_ref()
            .map(|s| s.seen_message_ids.clone())
            .unwrap_or_default(),
        compaction_state: existing.as_ref().and_then(|s| s.compaction_state.clone()),
        reminder_state: existing.as_ref().and_then(|s| s.reminder_state.clone()),
        reminder_delta_state: existing.as_ref().and_then(|s| s.reminder_delta_state.clone()),
        todos: Some(todos_json),
        self_applied_skills: skills_json,
        meta_model_variant: existing.as_ref().and_then(|s| s.meta_model_variant.clone()),
        is_blocked: existing.as_ref().map(|s| s.is_blocked).unwrap_or(false),
        todo_nudged: existing.as_ref().map(|s| s.todo_nudged).unwrap_or(false),
        updated_at: now,
    };

    if let Err(e) = store.upsert_agent_context_state(&state) {
        eprintln!("[tenex-agent] Failed to save agent context state: {e}");
    }
}

#[tokio::main]
async fn main() -> Result<()> {
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

    // Initialize channel (parses nsec, derives pubkey, signs to NDJSON-stdout)
    let channel: Arc<dyn Channel> = Arc::new(
        NostrChannel::from_nsec(&agent_config.nsec, StdoutNdjsonSink::new())
            .context("Failed to initialize Nostr channel")?,
    );
    let pubkey_hex = match channel.identity() {
        PrincipalRef::Nostr { pubkey, .. } => pubkey.to_hex(),
    };

    // Resolve working directory
    let working_dir = agent_config
        .working_directory
        .as_deref()
        .map(String::from)
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| ".".to_string())
        });

    // Open project and load context used for prompts + delegate tool.
    let project = Project::open_default(&project_id)
        .with_context(|| format!("Failed to open project for '{project_id}'"))?;
    let project_meta = project
        .metadata()
        .context("Failed to read project metadata")?
        .context("Project metadata is missing — has the project been ingested?")?;
    let project_agents = Arc::new(project.agents().context("Failed to read project agents")?);

    let owner_pubkey_hex = project_meta
        .owner_pubkey
        .as_ref()
        .context("Project metadata has no owner_pubkey — cannot construct project ref")?;
    let project_ref = ProjectRef {
        author: nostr::PublicKey::from_hex(owner_pubkey_hex)
            .context("Failed to parse project owner pubkey")?,
        d_tag: project_meta.d_tag.clone(),
    };

    // Open the conversation store for todo persistence.
    let conversation_id = match &envelope.root {
        MessageRef::Nostr { event_id } => event_id.to_hex(),
    };
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

    // Load TENEX configuration files for model/key resolution
    let llms = LlmsConfig::load();
    let providers = config::load_providers_config();

    // Resolve provider + model + API key
    let resolved =
        ResolvedModel::resolve(agent_config.raw_model(), llms.as_ref(), providers.as_ref());

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
    if let Err(e) = home::write_agent_env_file(&agent_home, &agent_config.nsec, &pubkey_hex) {
        eprintln!("[tenex-agent] Failed to write agent .env file: {e}");
    }

    // Build env vars for shell commands: parse agent .env + inject computed vars.
    let mut shell_env: Vec<(String, String)> =
        home::parse_dotenv(&agent_home.join(".env"))
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
    let home_info = prompt::HomeDirectoryInfo {
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

    // Determine which fs_* tools are granted via skill frontmatter (tools: field).
    // Mirrors the TypeScript HOME_FS_FALLBACKS pattern: any fs_* tool not granted
    // will fall back to the equivalent home_fs_* variant scoped to agent home dir.
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
        Some(skills::render_loaded_skills_block(&preloaded_skills, &path_vars))
    };

    // Shared self-applied skills state (pre-seeded from persistence; updated by skills_set tool).
    let self_applied_skills: Arc<Mutex<Vec<String>>> =
        Arc::new(Mutex::new(initial_self_applied));

    // Build system prompt
    let mut system_prompt = prompt::build_system_prompt(
        &agent_config,
        &pubkey_hex,
        &working_dir,
        Some(&project_meta),
        &project_agents,
        &teams_fragment,
        &home_info,
        preloaded_skills_block.as_deref(),
    );

    // Load persisted todos and inject them as a system reminder into the user message.
    let initial_todos: Vec<TodoItem> = conv_store
        .as_ref()
        .map(|s| load_todos_from_store(s, &conversation_id, &pubkey_hex))
        .unwrap_or_default();
    let todo_reminder = tools::format_todos_reminder(&initial_todos);
    let user_message = if todo_reminder.is_empty() {
        envelope.content.clone()
    } else {
        format!("{}\n\n{}", envelope.content, todo_reminder)
    };

    // Shared todo state across tool calls (pre-seeded from persistence).
    let todos: Arc<Mutex<Vec<TodoItem>>> = Arc::new(Mutex::new(initial_todos));

    let model_string = format!("{}:{}", resolved.provider, resolved.model);
    let conversation_root = match &envelope.root {
        MessageRef::Nostr { event_id } => Some(ConversationRef::Nostr {
            root_event_id: event_id.clone(),
        }),
    };

    let emit_state = Arc::new(EmitState {
        channel: channel.clone(),
        project: project_ref,
        triggering_principal: envelope.principal.clone(),
        triggering_message: Some(envelope.message.clone()),
        conversation_root,
        model: model_string.clone(),
        team: envelope.metadata.team.clone(),
        meta: Arc::new(Mutex::new(AgentMeta::new())),
    });

    // Parse category as supervision type (used by both hook and delegation check).
    let sup_category: Option<tenex_supervision::types::AgentCategory> =
        agent_config.category.as_deref().and_then(|s| s.parse().ok());
    let supervisor = Arc::new(Mutex::new(default_supervisor()));
    let hook = EmitHook::new(emit_state.clone(), supervisor, todos.clone(), sup_category);
    let delegate_tool: Option<DelegateTool> =
        if sup_category.map(|c| c.allows_delegation()).unwrap_or(true) {
            Some(DelegateTool::new(emit_state.clone(), project_agents, teams))
        } else {
            None
        };

    let skill_list_tool = SkillListTool::new(skill_ctx.clone());
    let skills_set_tool = SkillsSetTool::new(skill_ctx.clone(), self_applied_skills.clone());

    // Initialize RAG store for the embedding tools. If embedding is not configured
    // or initialization fails, the tools remain available but return an error message.
    let rag_store: Option<Arc<RagStore>> = (|| -> Option<Arc<RagStore>> {
        let embed_config = EmbedConfig::load()?;
        let base_dir = dirs_next::home_dir()?.join(".tenex");
        let db_path = base_dir.join("projects").join(&project_id).join("embeddings.db");
        match RagStore::open(&db_path, &embed_config) {
            Ok(store) => Some(Arc::new(store)),
            Err(e) => {
                eprintln!("[tenex-agent] RAG store unavailable: {e}");
                None
            }
        }
    })();

    let rag_index = RagIndexTool::new(rag_store.clone(), project_id.clone(), pubkey_hex.clone());
    let rag_search = RagSearchTool::new(rag_store.clone(), project_id.clone(), pubkey_hex.clone());

    // Proactive context: search RAG before the LLM call so relevant past
    // knowledge appears in the system prompt without the agent needing to ask.
    if let Some(store) = &rag_store {
        let collections = [
            "conversations".to_string(),
            format!("project_{project_id}"),
            format!("agent_{pubkey_hex}"),
        ];
        let refs: Vec<&str> = collections.iter().map(|s| s.as_str()).collect();
        match store.search(&envelope.content, &refs, 5).await {
            Ok(results) => {
                let relevant: Vec<_> =
                    results.into_iter().filter(|r| r.score >= 0.65).collect();
                if !relevant.is_empty() {
                    let mut block = String::from("\n\n<proactive-context>\nPotentially relevant information retrieved based on your task:\n");
                    for (i, r) in relevant.iter().enumerate() {
                        let snippet: String = r.content.chars().take(300).collect();
                        let ellipsis = if r.content.len() > 300 { "…" } else { "" };
                        block.push_str(&format!(
                            "\n[{}] score:{:.2} collection:{}{}\n{}{}\n",
                            i + 1,
                            r.score,
                            r.collection,
                            r.title.as_deref().map(|t| format!(" title:{t}")).unwrap_or_default(),
                            snippet,
                            ellipsis,
                        ));
                    }
                    block.push_str("</proactive-context>");
                    system_prompt.push_str(&block);
                }
            }
            Err(e) => eprintln!("[tenex-agent] Proactive context search failed: {e}"),
        }
    }

    eprintln!("[tenex-agent] Running agent...");

    let agent_home_str = agent_home.display().to_string();

    // Keep a handle with shared Arc refs so we can read the pending final turn
    // after the stream ends, even after `hook` is moved into the agent builder.
    let hook_handle = hook.clone();

    let final_response = match resolved.provider.as_str() {
        "openrouter" => {
            let key = resolved
                .api_key
                .context("No OpenRouter API key found. Set OPENROUTER_API_KEY or add it to ~/.tenex/providers.json")?;
            let client = openrouter::Client::new(&key)?;
            run_agent!(
                client,
                &resolved.model,
                &system_prompt,
                &user_message,
                working_dir,
                shell_env,
                todos,
                hook.clone(),
                delegate_tool.clone(),
                rag_index.clone(),
                rag_search.clone(),
                skill_list_tool.clone(),
                skills_set_tool.clone(),
                build_fs_tools(&granted_tools, &working_dir, &agent_home_str)
            )
        }
        "openai" => {
            let key = resolved
                .api_key
                .context("No OpenAI API key found. Set OPENAI_API_KEY or add it to ~/.tenex/providers.json")?;
            let client = openai::CompletionsClient::builder().api_key(&key).build()?;
            run_agent!(
                client,
                &resolved.model,
                &system_prompt,
                &user_message,
                working_dir,
                shell_env,
                todos,
                hook.clone(),
                delegate_tool.clone(),
                rag_index.clone(),
                rag_search.clone(),
                skill_list_tool.clone(),
                skills_set_tool.clone(),
                build_fs_tools(&granted_tools, &working_dir, &agent_home_str)
            )
        }
        "ollama" => {
            let mut builder = ollama::Client::builder().api_key(Nothing);
            if let Some(url) = &resolved.base_url {
                builder = builder.base_url(url);
            }
            let client = builder.build()?;
            run_agent!(
                client,
                &resolved.model,
                &system_prompt,
                &user_message,
                working_dir,
                shell_env,
                todos,
                hook.clone(),
                delegate_tool.clone(),
                rag_index.clone(),
                rag_search.clone(),
                skill_list_tool.clone(),
                skills_set_tool.clone(),
                build_fs_tools(&granted_tools, &working_dir, &agent_home_str)
            )
        }
        _ => {
            // Default: anthropic
            let key = resolved.api_key.with_context(|| {
                format!(
                    "No API key found for provider '{}'. Set {}_API_KEY or add it to ~/.tenex/providers.json",
                    resolved.provider,
                    resolved.provider.to_uppercase().replace('-', "_")
                )
            })?;
            let client = anthropic::Client::new(&key)?;
            run_agent!(
                client,
                &resolved.model,
                &system_prompt,
                &user_message,
                working_dir,
                shell_env,
                todos,
                hook,
                delegate_tool,
                rag_index,
                rag_search,
                skill_list_tool,
                skills_set_tool,
                build_fs_tools(&granted_tools, &working_dir, &agent_home_str)
            )
        }
    };

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

    eprintln!("[tenex-agent] Agent completed.");

    let stream_usage = final_response.usage();
    if let Some((final_content, final_ral)) = hook_handle.take_pending() {
        let final_ctx = emit_state.build_ctx(final_ral);
        let intent = ConversationIntent {
            content: final_content,
            is_reasoning: false,
            usage: Some(LlmUsage {
                input_tokens: Some(stream_usage.input_tokens),
                output_tokens: Some(stream_usage.output_tokens),
                total_tokens: Some(stream_usage.total_tokens),
                cached_input_tokens: Some(stream_usage.cached_input_tokens),
                ..Default::default()
            }),
            metadata: None,
        };
        channel
            .send(Intent::Conversation(intent), &final_ctx)
            .await
            .context("Failed to emit final conversation event")?;
    }

    Ok(())
}
