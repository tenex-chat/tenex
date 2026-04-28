mod config;
mod hook;
mod nostr;
mod prompt;
mod tools;

use anyhow::{Context, Result};
use config::{LlmsConfig, ProvidersConfig, ResolvedModel};
use hook::NostrHook;
use nostr::{AgentSigner, InputEvent, LlmTags};
use rig::client::{CompletionClient, Nothing};
use rig::completion::Prompt;
use rig::providers::{anthropic, ollama, openai, openrouter};
use std::io::{self, Read};
use std::sync::{Arc, Mutex};
use tenex_project::Project;
use tools::{
    DelegateTool, FsEditTool, FsGlobTool, FsGrepTool, FsReadTool, FsWriteTool, ShellTool,
    TodoItem, TodoWriteTool,
};

/// Build and run the agent with all tools attached.
/// The macro avoids duplicating tool registration across provider branches
/// while still returning different concrete types per provider.
macro_rules! run_agent {
    ($client:expr, $model:expr, $system:expr, $message:expr, $wd:expr, $todos:expr, $hook:expr, $delegate:expr) => {{
        $client
            .agent($model)
            .preamble($system)
            .max_tokens(16384)
            .default_max_turns(25)
            .tool(ShellTool::new($wd.clone()))
            .tool(FsReadTool::new($wd.clone()))
            .tool(FsWriteTool::new($wd.clone()))
            .tool(FsEditTool::new($wd.clone()))
            .tool(FsGlobTool::new($wd.clone()))
            .tool(FsGrepTool::new($wd.clone()))
            .tool(TodoWriteTool::new($todos.clone()))
            .tool($delegate)
            .build()
            .prompt($message)
            .with_hook($hook)
            .await?
    }};
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

    // Read triggering event from stdin
    let mut stdin_content = String::new();
    io::stdin()
        .read_to_string(&mut stdin_content)
        .context("Failed to read from stdin")?;
    let input_event =
        InputEvent::from_json(stdin_content.trim()).context("Failed to parse input event")?;

    // Set up signer (parses nsec, derives pubkey)
    let signer = Arc::new(
        AgentSigner::new(&agent_config.nsec).context("Failed to initialize agent signer")?,
    );
    let pubkey_hex = signer.pubkey_hex();

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

    // Open project DB and load context used for prompts + delegate tool.
    let project = Project::open_default(&project_id)
        .with_context(|| format!("Failed to open project DB for '{project_id}'"))?;
    let project_meta = project.metadata().context("Failed to read project metadata")?;
    let project_agents = Arc::new(project.agents().context("Failed to read project agents")?);

    // Load TENEX configuration files for model/key resolution
    let llms = LlmsConfig::load();
    let providers = ProvidersConfig::load();

    // Resolve provider + model + API key
    let resolved = ResolvedModel::resolve(
        agent_config.raw_model(),
        llms.as_ref(),
        providers.as_ref(),
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
    eprintln!(
        "[tenex-agent] Triggered by event {} from {}",
        &input_event.id[..8],
        &input_event.pubkey[..8]
    );

    // Build system prompt
    let system_prompt = prompt::build_system_prompt(
        &agent_config,
        &pubkey_hex,
        &working_dir,
        project_meta.as_ref(),
        &project_agents,
    );

    // Shared todo state across tool calls
    let todos: Arc<Mutex<Vec<TodoItem>>> = Arc::new(Mutex::new(Vec::new()));

    let root_id = input_event.root_event_id().to_string();
    let reply_id = input_event.reply_event_id().map(String::from);
    let model_string = format!("{}:{}", resolved.provider, resolved.model);
    let (hook, agent_meta) =
        NostrHook::new(signer.clone(), root_id.clone(), reply_id.clone(), model_string.clone());
    let delegate_tool = DelegateTool::new(
        signer.clone(),
        root_id,
        reply_id,
        model_string.clone(),
        agent_meta.clone(),
        project_agents,
    );

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
                &input_event.content,
                working_dir,
                todos,
                hook.clone(),
                delegate_tool.clone()
            )
        }
        "openai" => {
            let key = resolved
                .api_key
                .context("No OpenAI API key found. Set OPENAI_API_KEY or add it to ~/.tenex/providers.json")?;
            let client = openai::CompletionsClient::builder()
                .api_key(&key)
                .build()?;
            run_agent!(
                client,
                &resolved.model,
                &system_prompt,
                &input_event.content,
                working_dir,
                todos,
                hook.clone(),
                delegate_tool.clone()
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
                &input_event.content,
                working_dir,
                todos,
                hook.clone(),
                delegate_tool.clone()
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
                &input_event.content,
                working_dir,
                todos,
                hook,
                delegate_tool
            )
        }
    };

    eprintln!("[tenex-agent] Agent completed. Emitting completion event.");

    let completion_llm = {
        let meta = agent_meta.lock().unwrap();
        LlmTags {
            model: model_string,
            ral: meta.ral,
            input_tokens: Some(meta.input_tokens),
            output_tokens: Some(meta.output_tokens),
            total_tokens: Some(meta.total_tokens),
            cached_input_tokens: Some(meta.cached_input_tokens),
        }
    };

    signer
        .emit_completion(&response, &input_event, &completion_llm)
        .context("Failed to emit completion event")?;

    Ok(())
}
