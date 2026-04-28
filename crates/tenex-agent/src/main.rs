mod config;
mod emit;
mod home;
mod hook;
mod prompt;
mod tools;

use anyhow::{Context, Result};
use config::{LlmsConfig, ResolvedModel};
use emit::{AgentMeta, EmitState};
use hook::EmitHook;
use rig::client::{CompletionClient, Nothing};
use rig::completion::Prompt;
use rig::providers::{anthropic, ollama, openai, openrouter};
use std::sync::{Arc, Mutex};
use tenex_conversations::{AgentContextState, ConversationStore};
use tenex_project::Project;
use tenex_rag::{EmbedConfig, RagStore};
use tenex_supervision::heuristics::default_supervisor;
use tenex_protocol::{
    nostr::{read_one_from_stdin, NostrChannel},
    sink::StdoutNdjsonSink,
    Channel, CompletionIntent, ConversationRef, Intent, LlmUsage, MessageRef, PrincipalRef,
    ProjectRef,
};
use tools::{
    DelegateTool, FsEditTool, FsGlobTool, FsGrepTool, FsReadTool, FsWriteTool, RagIndexTool,
    RagSearchTool, ShellTool, TodoItem, TodoWriteTool,
};

/// Build and run the agent with all tools attached.
/// The macro avoids duplicating tool registration across provider branches
/// while still returning different concrete types per provider.
/// $delegate is Option<DelegateTool> — None for categories that cannot delegate.
macro_rules! run_agent {
    ($client:expr, $model:expr, $system:expr, $message:expr, $wd:expr, $env:expr, $todos:expr, $hook:expr, $delegate:expr, $rag_index:expr, $rag_search:expr) => {{
        let __base = $client
            .agent($model)
            .preamble($system)
            .max_tokens(16384)
            .default_max_turns(25)
            .tool(ShellTool::new($wd.clone(), $env.clone()))
            .tool(FsReadTool::new($wd.clone()))
            .tool(FsWriteTool::new($wd.clone()))
            .tool(FsEditTool::new($wd.clone()))
            .tool(FsGlobTool::new($wd.clone()))
            .tool(FsGrepTool::new($wd.clone()))
            .tool(TodoWriteTool::new($todos.clone()));

        let __base = if let Some(__d) = $delegate {
            __base.tool(__d)
        } else {
            __base
        };

        __base
            .tool($rag_index)
            .tool($rag_search)
            .build()
            .prompt($message)
            .with_hook($hook)
            .await?
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

fn save_todos_to_store(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    todos: &[TodoItem],
) {
    let todos_json = match serde_json::to_value(todos) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[tenex-agent] Failed to serialize todos: {e}");
            return;
        }
    };

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
        self_applied_skills: existing.as_ref().and_then(|s| s.self_applied_skills.clone()),
        meta_model_variant: existing.as_ref().and_then(|s| s.meta_model_variant.clone()),
        is_blocked: existing.as_ref().map(|s| s.is_blocked).unwrap_or(false),
        todo_nudged: existing.as_ref().map(|s| s.todo_nudged).unwrap_or(false),
        updated_at: now,
    };

    if let Err(e) = store.upsert_agent_context_state(&state) {
        eprintln!("[tenex-agent] Failed to save todos: {e}");
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

    // Build system prompt
    let mut system_prompt = prompt::build_system_prompt(
        &agent_config,
        &pubkey_hex,
        &working_dir,
        Some(&project_meta),
        &project_agents,
        &teams_fragment,
        &home_info,
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

    let response: String = match resolved.provider.as_str() {
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
                rag_search.clone()
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
                rag_search.clone()
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
                rag_search.clone()
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
                rag_search
            )
        }
    };

    // Persist final todo state back to the conversation store.
    if let Some(ref store) = conv_store {
        let final_todos = todos.lock().unwrap();
        save_todos_to_store(store, &conversation_id, &pubkey_hex, &final_todos);
    }

    eprintln!("[tenex-agent] Agent completed. Emitting completion event.");

    let (final_ral, completion_usage) = {
        let meta = emit_state.meta.lock().unwrap();
        (
            meta.ral,
            LlmUsage {
                input_tokens: Some(meta.input_tokens),
                output_tokens: Some(meta.output_tokens),
                total_tokens: Some(meta.total_tokens),
                cached_input_tokens: Some(meta.cached_input_tokens),
                ..Default::default()
            },
        )
    };
    let final_ctx = emit_state.build_ctx(final_ral);
    let completion = CompletionIntent {
        content: response,
        usage: Some(completion_usage),
        metadata: None,
    };
    channel
        .send(Intent::Completion(completion), &final_ctx)
        .await
        .context("Failed to emit completion event")?;

    Ok(())
}
