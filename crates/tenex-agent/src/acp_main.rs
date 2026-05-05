mod acp_config;
mod acp_mcp;
mod acp_process;
#[path = "categorize.rs"]
mod categorize;
#[path = "llm_accounting.rs"]
mod llm_accounting;
// `config.rs` is shared with the main `tenex-agent` binary; ACP only
// uses the LLM-resolution helpers, so the agent-side structs read as dead from
// this binary's perspective.
#[allow(dead_code)]
#[path = "config.rs"]
mod config;
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
    ToolUseIntent,
};

#[tokio::main]
async fn main() -> Result<()> {
    // The `--mcp` mode is a self-contained stdio server that doesn't need
    // identity-aware Resource attributes, so initialise telemetry minimally
    // and short-circuit. The non-MCP path threads identity through into init.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--mcp") {
        let telemetry = tenex_telemetry::init(tenex_telemetry::TelemetryInit {
            service_name: "tenex-agent-acp".to_string(),
            base_dir: None,
            kind: tenex_telemetry::TelemetryKind::Subprocess,
            extra_resource: vec![],
        });
        let context_path = args
            .get(2)
            .context("Usage: tenex-agent-acp --mcp <context.json>")?
            .clone();
        let result = acp_mcp::run_stdio_server(&context_path).await;
        bounded_shutdown(telemetry).await;
        return result;
    }
    if args.len() < 2 {
        anyhow::bail!("Usage: tenex-agent-acp <agent.json>");
    }

    let project_id = std::env::var("TENEX_PROJECT_ID")
        .context("TENEX_PROJECT_ID environment variable is required")?;
    let agent_config = AcpAgentConfig::load(&args[1])?;
    let agent_keys =
        nostr::Keys::parse(&agent_config.nsec).context("Failed to parse agent nsec")?;
    let pubkey_hex = agent_keys.public_key().to_hex();
    let agent_slug = agent_config.identity_name().to_string();

    let extra_resource = vec![
        opentelemetry::KeyValue::new("service.instance.id", std::process::id().to_string()),
        opentelemetry::KeyValue::new("tenex.agent.pubkey", pubkey_hex.clone()),
        opentelemetry::KeyValue::new("tenex.agent.slug", agent_slug.clone()),
        opentelemetry::KeyValue::new("project.id", project_id.clone()),
    ];
    let telemetry = tenex_telemetry::init(tenex_telemetry::TelemetryInit {
        service_name: "tenex-agent-acp".to_string(),
        base_dir: None,
        kind: tenex_telemetry::TelemetryKind::Subprocess,
        extra_resource,
    });

    let shutdown_signal = async {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut sigint = signal(SignalKind::interrupt()).expect("install SIGINT handler");
        tokio::select! {
            _ = sigterm.recv() => (),
            _ = sigint.recv() => (),
        }
    };

    let result = tokio::select! {
        res = run(args, project_id, agent_config, pubkey_hex) => res,
        () = shutdown_signal => {
            eprintln!("[tenex-agent-acp] received shutdown signal");
            Ok(())
        }
    };

    bounded_shutdown(telemetry).await;
    result
}

async fn bounded_shutdown(telemetry: tenex_telemetry::TelemetryGuard) {
    // Mirrors the daemon-subprocess shutdown sequence in `tenex-agent`'s
    // main: flush off the tokio runtime so a wedged exporter cannot block,
    // bounded at 10s overall.
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::task::spawn_blocking(|| {
            if let Err(err) = tenex_telemetry::force_flush(std::time::Duration::from_secs(5)) {
                eprintln!("[tenex-agent-acp] telemetry flush: {err}");
            }
        }),
    )
    .await;
    telemetry.shutdown();
}

async fn run(
    args: Vec<String>,
    project_id: String,
    agent_config: AcpAgentConfig,
    pubkey_hex: String,
) -> Result<()> {
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
    let trigger_event_id = match &envelope.message {
        MessageRef::Nostr { event_id } => event_id.to_hex(),
    };

    let stdout_sink = SharedStdoutEventSink::new();
    let pending_external_work = Arc::new(AtomicBool::new(false));
    // Telegram delivery used to live here via CompositeChannel; that path is
    // now owned by `tenex-telegram`.
    let channel: Arc<dyn Channel> = Arc::new(
        NostrChannel::from_nsec(&agent_config.nsec, stdout_sink.clone())
            .context("Failed to initialize Nostr channel")?,
    );
    debug_assert_eq!(
        match channel.identity() {
            PrincipalRef::Nostr { pubkey, .. } => pubkey.to_hex(),
        },
        pubkey_hex
    );

    let project_root = agent_config
        .working_directory
        .as_deref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        });
    let (resolved_working_dir, current_branch) = tenex_project::resolve_working_dir(
        &project_root,
        envelope.metadata.branch.as_deref(),
        envelope.metadata.commit.as_deref(),
    );
    let working_dir = resolved_working_dir.display().to_string();
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

    let acp_worktrees: Vec<tenex_project::WorktreeInfo> =
        match tenex_project::list_worktrees(&project_root) {
            Ok(wts) => wts,
            Err(e) => {
                eprintln!("[tenex-agent-acp] Failed to list worktrees: {e}");
                Vec::new()
            }
        };

    let resolved_category_string: Option<String> = match agent_config.category.clone() {
        Some(c) => Some(c),
        None => {
            let resolved = config::ResolvedModel::resolve(&base_dir, None)?;
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
                    eprintln!("[tenex-agent-acp] category backfill failed: {e}");
                    None
                }
            }
        }
    };
    let resolved_category_enum = resolved_category_string
        .as_deref()
        .and_then(|s| s.parse::<tenex_supervision::types::AgentCategory>().ok());
    let global_system_prompt = config::read_global_system_prompt(&base_dir);

    let system_prompt =
        tenex_system_prompt::build_system_prompt(tenex_system_prompt::BuildSystemPromptInput {
            identity_name: agent_config.identity_name(),
            pubkey_hex: &pubkey_hex,
            category_str: resolved_category_string.as_deref(),
            category: resolved_category_enum,
            global_system_prompt: global_system_prompt.as_deref(),
            instructions: agent_config.instructions.as_deref(),
            working_dir: &working_dir,
            project_base_path: Some(&working_dir),
            project_meta: Some(&project_meta),
            project_id: Some(&project_meta.d_tag),
            conversation_id: Some(&conversation_id),
            root_agents_md: root_agents_md.as_deref(),
            agents: &project_agents,
            teams: &teams,
            agent_slug: agent_config.slug.as_deref().unwrap_or(""),
            active_team: envelope.metadata.team.as_deref(),
            home: &home_info,
            preloaded_skills_block: None,
            workflows_fragment: None,
            telegram_channel_bindings: &telegram_channel_bindings,
            telegram_chat_context: None,
            scheduled_tasks: &[],
            current_branch: current_branch.as_deref(),
            worktrees: &acp_worktrees,
        });
    let history = render_history(
        conv_store.as_ref(),
        &conversation_id,
        &pubkey_hex,
        &system_prompt,
        &acp_config.backend,
        Some(&trigger_event_id),
    )
    .await;
    let prompt = render_acp_prompt(&system_prompt, &history, &envelope.content);
    let mcp_bridge = AcpMcpBridge::start(AcpMcpBridgeInput {
        base_dir: base_dir.clone(),
        agent_config_path: args[1].clone(),
        project_id: project_id.clone(),
        expose_delegation_tools: resolved_category_enum
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
        project_root: project_root.clone(),
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
    let current_project_addr = project_ref.coordinate();
    let completion_project_a_tags: Vec<String> = envelope
        .metadata
        .project_a_tags
        .iter()
        .filter(|addr| *addr != &current_project_addr)
        .cloned()
        .collect();
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
        completion_project_a_tags: completion_project_a_tags.clone(),
        branch: current_branch.clone(),
        team: envelope.metadata.team.clone(),
    };
    let mut stream_sequence = 0_u64;
    let stream_session_id = session_id.clone();
    // Carries the tool name from `ToolCallStarted` until `ToolCallArgs` arrives
    // with the actual arguments. Cleared each time args are received; any name
    // still set here after the loop gets emitted without args.
    let mut pending_tool_name: Option<String> = None;
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
                let thread_id = stream_session_id.clone();
                // Sync: update pending state and decide what to emit.
                let (flush_segment, tool_use): (Option<String>, Option<ToolUseIntent>) =
                    match &update {
                        AcpUpdate::AgentMessageChunk { .. } => (None, None),
                        AcpUpdate::ToolCallStarted { segment_to_flush, tool_name } => {
                            // If a previous tool never received args, emit it now without args.
                            let stale = pending_tool_name.replace(tool_name.clone());
                            let stale_intent = stale.filter(|n| !n.is_empty()).map(|n| {
                                ToolUseIntent {
                                    tool_name: n,
                                    content: String::new(),
                                    args_json: None,
                                    referenced_messages: Vec::new(),
                                    usage: None,
                                    extra_tags: Vec::new(),
                                }
                            });
                            (
                                if segment_to_flush.is_empty() {
                                    None
                                } else {
                                    Some(segment_to_flush.clone())
                                },
                                stale_intent,
                            )
                        }
                        AcpUpdate::ToolCallArgs { tool_name, args_json } => {
                            // Args arrived — clear pending and emit with full args.
                            pending_tool_name.take();
                            (
                                None,
                                Some(ToolUseIntent {
                                    tool_name: tool_name.clone(),
                                    content: String::new(),
                                    args_json: Some(args_json.clone()),
                                    referenced_messages: Vec::new(),
                                    usage: None,
                                    extra_tags: Vec::new(),
                                }),
                            )
                        }
                    };
                async move {
                    match update {
                        AcpUpdate::AgentMessageChunk { text } => {
                            let intent = StreamTextDeltaIntent { delta: text, sequence };
                            if let Err(err) =
                                channel.send(Intent::StreamTextDelta(intent), &ctx).await
                            {
                                eprintln!(
                                    "[tenex-agent-acp] warn: stream delta emit failed: {err}"
                                );
                            }
                        }
                        AcpUpdate::ToolCallStarted { .. } | AcpUpdate::ToolCallArgs { .. } => {
                            if let Some(segment) = flush_segment {
                                let intent = ConversationIntent {
                                    content: segment,
                                    is_reasoning: false,
                                    usage: None,
                                    metadata: Some(LlmMetadata {
                                        thread_id: Some(thread_id),
                                        ..Default::default()
                                    }),
                                };
                                if let Err(err) =
                                    channel.send(Intent::Conversation(intent), &ctx).await
                                {
                                    eprintln!(
                                        "[tenex-agent-acp] warn: tool-boundary flush failed: {err}"
                                    );
                                }
                            }
                            if let Some(intent) = tool_use {
                                if let Err(err) =
                                    channel.send(Intent::ToolUse(intent), &ctx).await
                                {
                                    eprintln!(
                                        "[tenex-agent-acp] warn: tool-use emit failed: {err}"
                                    );
                                }
                            }
                        }
                    }
                }
            },
        )
        .await?;
    // Any tool whose args never arrived (e.g. permission denied before tool_call_update).
    if let Some(tool_name) = pending_tool_name.take().filter(|n| !n.is_empty()) {
        let intent = ToolUseIntent {
            tool_name,
            content: String::new(),
            args_json: None,
            referenced_messages: Vec::new(),
            usage: None,
            extra_tags: Vec::new(),
        };
        if let Err(err) = channel.send(Intent::ToolUse(intent), &stream_ctx).await {
            eprintln!("[tenex-agent-acp] warn: post-loop tool-use emit failed: {err}");
        }
    }
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
            breakpoint_hints: Vec::new(),
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
        completion_project_a_tags,
        branch: current_branch,
        team: envelope.metadata.team.clone(),
    };
    let metadata = Some(LlmMetadata {
        thread_id: Some(session_id),
        ..Default::default()
    });
    let final_intent = if pending_external_work.load(Ordering::Acquire) {
        Intent::Conversation(ConversationIntent {
            content: updates.current_segment,
            is_reasoning: false,
            usage: None,
            metadata,
        })
    } else {
        Intent::Completion(CompletionIntent {
            content: updates.current_segment,
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

async fn render_history(
    store: Option<&ConversationStore>,
    conversation_id: &str,
    agent_pubkey: &str,
    system_prompt: &str,
    backend: &str,
    exclude_nostr_event_id: Option<&str>,
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
    match tenex_context::project_with_excluded_event(
        store,
        conversation_id,
        agent_pubkey,
        system_prompt,
        &profile,
        &tool_defs,
        None,
        None,
        exclude_nostr_event_id,
    )
    .await
    {
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
