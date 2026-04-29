mod acp_config;
mod acp_mcp;
mod acp_process;
mod emit;
#[path = "home.rs"]
mod home;
mod project_instructions;
mod tools {
    #[path = "../tools/delegate.rs"]
    pub mod delegate;
    #[path = "../tools/delegate_crossproject.rs"]
    pub mod delegate_crossproject;
    #[path = "../tools/delegate_followup.rs"]
    pub mod delegate_followup;
    #[path = "../tools/delegate_followup_resolution.rs"]
    pub mod delegate_followup_resolution;
    #[path = "../tools/self_delegate.rs"]
    pub mod self_delegate;
}

use acp_config::{load_acp_config, AcpAgentConfig};
use acp_mcp::{session_new_params, AcpMcpBridge, AcpMcpBridgeInput, SharedStdoutEventSink};
use acp_process::{AcpProcess, AcpUpdate, AcpUpdates};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tenex_context::{
    CacheObservation, Message as CtxMessage, ModelProfile, ToolCall as CtxToolCall, ToolDef,
    TurnRecord,
};
use tenex_conversations::ConversationStore;
use tenex_project::Project;
use tenex_protocol::{
    nostr::{read_one_from_stdin, NostrChannel},
    Channel, CompletionIntent, ConversationIntent, ConversationRef, EncodingContext, Intent,
    LlmMetadata, MessageRef, PrincipalKind, PrincipalRef, ProjectRef, StreamTextDeltaIntent,
};

#[tokio::main]
async fn main() -> Result<()> {
    let telemetry = tenex_telemetry::init("tenex-agent-acp");
    let result = run().await;
    telemetry.shutdown();
    result
}

async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--mcp") {
        let context_path = args
            .get(2)
            .context("Usage: tenex-agent-acp --mcp <context.json>")?;
        return acp_mcp::run_stdio_server(context_path).await;
    }
    if args.len() < 2 {
        anyhow::bail!("Usage: tenex-agent-acp <agent.json>");
    }

    let project_id = std::env::var("TENEX_PROJECT_ID")
        .context("TENEX_PROJECT_ID environment variable is required")?;
    let agent_config = AcpAgentConfig::load(&args[1])?;
    let default_model = agent_config
        .default_model()
        .ok_or_else(|| anyhow::anyhow!(
            "agent '{}' has no default.model; tenex-agent-acp requires a named ACP config in llms.json",
            agent_config.identity_name()
        ))?;
    let base_dir = tenex_project::paths::default_base_dir();
    let acp_config = load_acp_config(&base_dir, default_model)
        .with_context(|| format!("loading ACP config '{default_model}'"))?;

    let envelope = read_one_from_stdin()
        .await
        .context("Failed to parse triggering event from stdin")?;

    let stdout_sink = SharedStdoutEventSink::new();
    let pending_external_work = Arc::new(AtomicBool::new(false));
    // Telegram delivery used to live here via CompositeChannel; that path is
    // now owned by `tenex-telegram`.
    let channel: Arc<dyn Channel> = Arc::new(
        NostrChannel::from_nsec(&agent_config.nsec, stdout_sink.clone())
            .context("Failed to initialize Nostr channel")?,
    );
    let pubkey_hex = match channel.identity() {
        PrincipalRef::Nostr { pubkey, .. } => pubkey.to_hex(),
    };

    let working_dir = agent_config
        .working_directory
        .as_deref()
        .map(String::from)
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| ".".to_string())
        });
    let project_root =
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(&working_dir));
    let root_agents_md = project_instructions::read_root_agents_md(&project_root);

    let project = Project::open_default(&project_id)
        .with_context(|| format!("Failed to open project for '{project_id}'"))?;
    let project_meta = project
        .metadata()
        .context("Failed to read project metadata")?
        .context("Project metadata is missing")?;
    let project_agents = project.agents().context("Failed to read project agents")?;
    let owner_pubkey_hex = project_meta
        .owner_pubkey
        .as_ref()
        .context("Project metadata has no owner_pubkey")?;
    let project_ref = ProjectRef {
        author: nostr::PublicKey::from_hex(owner_pubkey_hex)
            .context("Failed to parse project owner pubkey")?,
        d_tag: project_meta.d_tag.clone(),
    };

    let envelope_conversation_id = match &envelope.root {
        MessageRef::Nostr { event_id } => event_id.to_hex(),
    };
    let conversation_id = std::env::var("TENEX_CONVERSATION_ID")
        .ok()
        .filter(|id| nostr::EventId::from_hex(id).is_ok())
        .unwrap_or(envelope_conversation_id);
    let conv_store = open_conversation_store(&project_id, &conversation_id);
    let completion_recipient = std::env::var("TENEX_COMPLETION_RECIPIENT_PUBKEY")
        .ok()
        .and_then(|pubkey| nostr::PublicKey::from_hex(&pubkey).ok())
        .map(|pubkey| PrincipalRef::Nostr {
            pubkey,
            kind: PrincipalKind::Human,
            display_name: None,
        });
    let conversation_root = nostr::EventId::from_hex(&conversation_id)
        .ok()
        .map(|root_event_id| ConversationRef::Nostr { root_event_id });
    let acp_model = format!("acp:{}", acp_config.backend);

    let base_dir = tenex_project::paths::default_base_dir();
    let teams = tenex_project::load_teams(&base_dir, Some(&project_id));
    let member_teams =
        tenex_project::teams_for_agent(&teams, agent_config.slug.as_deref().unwrap_or(""));
    let teams_fragment =
        tenex_project::render_teams_context(&member_teams, envelope.metadata.team.as_deref());

    let agent_home = home::agent_home_dir(&base_dir, &pubkey_hex);
    home::ensure_agent_home_dir(&agent_home);
    let injected_files = home::get_injected_files(&agent_home);
    let file_count = home::count_home_files(&agent_home);
    let home_dir = agent_home.display().to_string();
    let home_info = tenex_system_prompt::HomeDirectoryInfo {
        home_dir: &home_dir,
        file_count: &file_count,
        injected_files: &injected_files,
    };
    let telegram_channel_bindings: Vec<tenex_system_prompt::TelegramChannelBinding> = {
        let bindings_path = base_dir.join("data").join("transport-bindings.json");
        let store = tenex_telegram::binding::BindingStore::open(bindings_path);
        store
            .list_telegram_for_agent_project(&pubkey_hex, &project_meta.d_tag)
            .into_iter()
            .filter_map(|r| tenex_system_prompt::TelegramChannelBinding::parse(&r.channel_id))
            .collect()
    };

    let system_prompt =
        tenex_system_prompt::build_system_prompt(tenex_system_prompt::BuildSystemPromptInput {
            identity_name: agent_config.identity_name(),
            pubkey_hex: &pubkey_hex,
            category_str: agent_config.category.as_deref(),
            category: agent_config.resolved_category(),
            instructions: agent_config.instructions.as_deref(),
            working_dir: &working_dir,
            project_base_path: Some(&working_dir),
            project_meta: Some(&project_meta),
            project_id: Some(&project_meta.d_tag),
            conversation_id: Some(&conversation_id),
            root_agents_md: root_agents_md.as_deref(),
            agents: &project_agents,
            teams_fragment: &teams_fragment,
            home: &home_info,
            preloaded_skills_block: None,
            telegram_channel_bindings: &telegram_channel_bindings,
        });
    let history = render_history(
        conv_store.as_ref(),
        &conversation_id,
        &pubkey_hex,
        &system_prompt,
        &acp_config.backend,
    );
    let prompt = render_acp_prompt(&system_prompt, &history, &envelope.content);
    let mcp_bridge = AcpMcpBridge::start(AcpMcpBridgeInput {
        base_dir: base_dir.clone(),
        agent_config_path: args[1].clone(),
        project_id: project_id.clone(),
        expose_delegation_tools: agent_config
            .resolved_category()
            .map(|category| category.allows_delegation())
            .unwrap_or(true),
        project: project_ref.clone(),
        conversation_root: conversation_root.clone(),
        triggering_message: Some(envelope.message.clone()),
        completion_recipient: completion_recipient.clone(),
        triggering_principal: envelope.principal.clone(),
        model: acp_model.clone(),
        team: envelope.metadata.team.clone(),
        stdout_sink: stdout_sink.clone(),
        pending_external_work: pending_external_work.clone(),
    })
    .await?;

    eprintln!(
        "[tenex-agent-acp] {} ({}) backend={} command={} model={}",
        agent_config.identity_name(),
        &pubkey_hex[..8],
        acp_config.backend,
        acp_config.command,
        acp_config.model.as_deref().unwrap_or("default")
    );

    let mut acp = AcpProcess::spawn(&acp_config).await?;
    let mut updates = AcpUpdates::default();
    acp.request(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": {
                "name": "tenex-agent-acp",
                "title": "TENEX ACP Worker Runner",
                "version": env!("CARGO_PKG_VERSION")
            }
        }),
        &mut updates,
    )
    .await?;

    let session_result = acp
        .request(
            "session/new",
            session_new_params(&working_dir, mcp_bridge.as_ref())?,
            &mut updates,
        )
        .await?;
    let session_id = session_result
        .get("sessionId")
        .and_then(Value::as_str)
        .context("ACP session/new response missing sessionId")?
        .to_string();

    if let Some(model) = acp_config.model.as_deref() {
        if let Some(config_id) = find_model_config_id(&session_result) {
            if let Err(err) = acp
                .request(
                    "session/set_config_option",
                    json!({
                        "sessionId": session_id,
                        "configId": config_id,
                        "value": model
                    }),
                    &mut updates,
                )
                .await
            {
                eprintln!("[tenex-agent-acp] warn: failed to set ACP model option: {err}");
            }
        }
    }
    let stream_ctx = EncodingContext {
        project: project_ref.clone(),
        conversation_root: conversation_root.clone(),
        triggering_message: Some(envelope.message.clone()),
        completion_recipient: completion_recipient.clone(),
        triggering_principal: envelope.principal.clone(),
        ral: 0,
        model: Some(acp_model.clone()),
        cost_usd: None,
        execution_time_ms: None,
        llm_runtime_ms: None,
        llm_runtime_total_ms: None,
        branch: None,
        team: envelope.metadata.team.clone(),
    };
    let mut stream_sequence = 0_u64;
    let prompt_result = acp
        .request_with_update_handler(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": prompt}]
            }),
            &mut updates,
            |update| {
                stream_sequence += 1;
                let sequence = stream_sequence;
                let channel = channel.clone();
                let ctx = stream_ctx.clone();
                async move {
                    match update {
                        AcpUpdate::AgentMessageChunk { text } => {
                            let intent = StreamTextDeltaIntent {
                                delta: text,
                                sequence,
                            };
                            if let Err(err) =
                                channel.send(Intent::StreamTextDelta(intent), &ctx).await
                            {
                                eprintln!(
                                    "[tenex-agent-acp] warn: stream delta emit failed: {err}"
                                );
                            }
                        }
                    }
                }
            },
        )
        .await?;
    let stop_reason = prompt_result
        .get("stopReason")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    acp.shutdown().await;
    if let Some(bridge) = mcp_bridge {
        bridge.shutdown().await;
    }

    if let Some(store) = conv_store.as_ref() {
        let turn = TurnRecord {
            messages_visible: vec![
                CtxMessage::User {
                    content: envelope.content.clone(),
                },
                CtxMessage::Assistant {
                    content: updates.visible_text.clone(),
                    tool_calls: Vec::<CtxToolCall>::new(),
                },
            ],
            reminders_applied: Vec::new(),
            compaction_decisions: Vec::new(),
            cache_observed: CacheObservation::default(),
        };
        if let Err(err) = tenex_context::record_turn(store, &conversation_id, &pubkey_hex, turn) {
            eprintln!("[tenex-agent-acp] warn: failed to record ACP turn: {err}");
        }
    }

    let ctx = EncodingContext {
        project: project_ref,
        conversation_root,
        triggering_message: Some(envelope.message.clone()),
        completion_recipient,
        triggering_principal: envelope.principal.clone(),
        ral: 1,
        model: Some(format!("acp:{}:{}", acp_config.backend, stop_reason)),
        cost_usd: None,
        execution_time_ms: None,
        llm_runtime_ms: None,
        llm_runtime_total_ms: None,
        branch: None,
        team: envelope.metadata.team.clone(),
    };
    let metadata = Some(LlmMetadata {
        thread_id: Some(session_id),
        ..Default::default()
    });
    let final_intent = if pending_external_work.load(Ordering::Acquire) {
        Intent::Conversation(ConversationIntent {
            content: updates.visible_text,
            is_reasoning: false,
            usage: None,
            metadata,
        })
    } else {
        Intent::Completion(CompletionIntent {
            content: updates.visible_text,
            usage: None,
            metadata,
        })
    };
    channel
        .send(final_intent, &ctx)
        .await
        .context("Failed to emit ACP completion")?;
    Ok(())
}

fn open_conversation_store(project_id: &str, conversation_id: &str) -> Option<ConversationStore> {
    let base_dir = tenex_conversations::paths::default_base_dir();
    let d_tag = tenex_conversations::normalize_project_id(project_id).ok()?;
    let db_path = tenex_conversations::paths::conversation_db_path(&base_dir, &d_tag);
    match ConversationStore::open(&db_path) {
        Ok(store) => {
            if let Err(err) = store.ensure_conversation(conversation_id) {
                eprintln!("[tenex-agent-acp] warn: failed to ensure conversation row: {err}");
            }
            Some(store)
        }
        Err(err) => {
            eprintln!("[tenex-agent-acp] warn: conversation store unavailable: {err}");
            None
        }
    }
}

fn render_history(
    store: Option<&ConversationStore>,
    conversation_id: &str,
    agent_pubkey: &str,
    system_prompt: &str,
    backend: &str,
) -> String {
    let Some(store) = store else {
        return String::new();
    };
    let profile = ModelProfile {
        provider: "acp".to_string(),
        model_id: backend.to_string(),
        prompt_cache: false,
        ephemeral_reminders: false,
        image_support: false,
        max_context_tokens: 200_000,
    };
    let tool_defs: Vec<ToolDef> = Vec::new();
    match tenex_context::project(
        store,
        conversation_id,
        agent_pubkey,
        system_prompt,
        &profile,
        &tool_defs,
    ) {
        Ok(projection) => projection
            .messages
            .into_iter()
            .filter_map(format_context_message)
            .collect::<Vec<_>>()
            .join("\n\n"),
        Err(err) => {
            eprintln!("[tenex-agent-acp] warn: context projection failed: {err}");
            String::new()
        }
    }
}

fn format_context_message(message: CtxMessage) -> Option<String> {
    match message {
        CtxMessage::System { .. } => None,
        CtxMessage::User { content } => Some(format!("User:\n{content}")),
        CtxMessage::Assistant { content, .. } => Some(format!("Assistant:\n{content}")),
        CtxMessage::ToolResult { content, .. } => Some(format!("Tool result:\n{content}")),
    }
}

fn render_acp_prompt(system_prompt: &str, history: &str, current_task: &str) -> String {
    let history_block = if history.is_empty() {
        "No prior conversation history is available.".to_string()
    } else {
        history.to_string()
    };
    format!(
         "<tenex-context>\n{system_prompt}\n</tenex-context>\n\n\
         <worker-runtime>\n\
         You are running as an external ACP worker inside TENEX. TENEX coordination tools may be available through \
         the tenex MCP server. Use those MCP tools for TENEX actions such as delegate, delegate_followup, \
         self_delegate, and delegate_crossproject instead of backend-native delegation tools. After delegating, \
         stop and return a concise status for TENEX to publish.\n\
         </worker-runtime>\n\n\
         <conversation-history>\n{history_block}\n</conversation-history>\n\n\
         <current-task>\n{current_task}\n</current-task>"
    )
}

fn find_model_config_id(session_result: &Value) -> Option<String> {
    session_result
        .get("configOptions")
        .and_then(Value::as_array)?
        .iter()
        .find(|option| {
            option.get("category").and_then(Value::as_str) == Some("model")
                || matches!(
                    option.get("id").and_then(Value::as_str),
                    Some("model" | "models")
                )
        })
        .and_then(|option| option.get("id").and_then(Value::as_str))
        .map(str::to_string)
}
