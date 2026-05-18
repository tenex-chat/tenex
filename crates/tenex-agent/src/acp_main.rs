mod acp_config;
mod acp_mcp;
mod acp_process;
mod acp_runtime_accounting;
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
#[allow(dead_code)]
#[path = "llm_retry.rs"]
mod llm_retry;
mod emit;
#[path = "escalation.rs"]
mod escalation;
#[path = "home.rs"]
mod home;
mod project_instructions;
#[path = "runtime_control.rs"]
mod runtime_control;
#[path = "runtime_tracker.rs"]
mod runtime_tracker;
#[path = "skills.rs"]
mod skills;
#[path = "workflows.rs"]
mod workflows;
#[path = "tools"]
mod tools {
    pub mod agents_write;
    pub mod ask;
    pub mod conversation_get;
    pub mod conversation_list;
    pub mod conversation_search;
    pub mod create_workflow;
    pub mod delegate;
    pub mod delegate_crossproject;
    pub mod delegate_followup;
    pub mod delegate_followup_resolution;
    pub mod mcp_resources;
    pub mod project_list;
    pub mod rag_add_documents;
    pub mod rag_search;
    pub mod run_workflow;
    pub mod self_delegate;
    pub mod sign_as_user;
    pub mod skill_list;
    pub mod skills_set;
    pub mod todo;
}

use acp_config::{load_acp_config, AcpAgentConfig, AcpRuntimeConfig};
use acp_mcp::{session_new_params, AcpMcpBridge, AcpMcpBridgeInput, SharedStdoutEventSink};
use tenex_protocol::nostr::ACP_PROMPT_DONE_SENTINEL_KEY;
use acp_process::{AcpProcess, AcpUpdate, AcpUpdates};
use acp_runtime_accounting::AcpRuntimeAccounting;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tenex_context::{
    CacheObservation, Message as CtxMessage, ModelProfile, ToolCall as CtxToolCall, ToolDef,
    ProjectionOptions, TurnRecord,
};
use tenex_conversations::ConversationStore;
use tenex_project::{Project, ProjectMetadata};
use tenex_protocol::{
    nostr::{AcpStdinFrame, NostrChannel},
    Channel, CompletionIntent, ConversationIntent, ConversationRef, EncodingContext, Intent,
    LlmMetadata, MessageRef, PrincipalRef, ProjectRef, StreamTextDeltaIntent, ToolUseIntent,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tracing::{info_span, Instrument};
use tracing_opentelemetry::OpenTelemetrySpanExt;

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

/// State established once at process startup and shared across every
/// `session/prompt` invocation on this ACP child's single session.
struct SessionContext {
    project_id: String,
    conversation_id: String,
    pubkey_hex: String,
    project_ref: ProjectRef,
    conversation_root: Option<ConversationRef>,
    working_dir: String,
    current_branch: Option<String>,
    project_meta: ProjectMetadata,
    acp_config: AcpRuntimeConfig,
    acp_model: String,
    session_id: String,
    system_prompt: String,
    backend: String,
    /// True once the first prompt has been sent. Subsequent prompts skip the
    /// system-prompt and history block — the ACP backend retains that
    /// context inside its `session.input` stream.
    first_prompt_pending: std::sync::atomic::AtomicBool,
    stdout_sink: SharedStdoutEventSink,
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

    // Read the bootstrap stdin frame (the first inbound event for this
    // conversation). The persistent stdin loop kicks in once setup is done.
    let mut stdin_lines = BufReader::new(tokio::io::stdin()).lines();
    let bootstrap_frame = read_next_frame(&mut stdin_lines)
        .await?
        .context("no bootstrap event on stdin")?;
    let bootstrap_envelope = tenex_protocol::nostr::decode(&bootstrap_frame.event)
        .context("decoding bootstrap event")?;
    let trigger_event_id = match &bootstrap_envelope.message {
        MessageRef::Nostr { event_id } => event_id.to_hex(),
    };

    let stdout_sink = SharedStdoutEventSink::new();
    let pending_external_work = Arc::new(AtomicBool::new(false));
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
        bootstrap_envelope.metadata.branch.as_deref(),
        bootstrap_envelope.metadata.commit.as_deref(),
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

    let envelope_conversation_id = match &bootstrap_envelope.root {
        MessageRef::Nostr { event_id } => event_id.to_hex(),
    };
    let conversation_id = std::env::var("TENEX_CONVERSATION_ID")
        .ok()
        .filter(|id| nostr::EventId::from_hex(id).is_ok())
        .unwrap_or(envelope_conversation_id);
    let conv_store: Option<Arc<Mutex<ConversationStore>>> =
        open_conversation_store(&project_id, &conversation_id).map(|s| Arc::new(Mutex::new(s)));
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
            let resolved = config::ResolvedModel::resolve(
                &base_dir,
                None,
                Arc::new(tenex_llm_config::key_health::KeyHealthTracker::new()),
            )?;
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
            active_team: bootstrap_envelope.metadata.team.as_deref(),
            home: &home_info,
            preloaded_skills_block: None,
            workflows_fragment: None,
            telegram_channel_bindings: &telegram_channel_bindings,
            telegram_chat_context: None,
            scheduled_tasks: &[],
            current_branch: current_branch.as_deref(),
            worktrees: &acp_worktrees,
        });

    // The MCP bridge is started once per ACP child and carries the
    // bootstrap event's `triggering_message`/`completion_recipient`/
    // `triggering_principal` for the lifetime of the session. Delegation
    // tools invoked from any prompt-task (including ones injected mid-turn
    // by later inbound events) will be tagged against the bootstrap event.
    // See README — this is the v1 limitation; full per-prompt MCP context
    // requires a dynamic-context follow-up.
    let bootstrap_completion_recipient = bootstrap_frame
        .completion_recipient_pubkey
        .clone()
        .or_else(|| std::env::var("TENEX_COMPLETION_RECIPIENT_PUBKEY").ok())
        .and_then(|pubkey| nostr::PublicKey::from_hex(&pubkey).ok())
        .map(|pubkey| PrincipalRef::Nostr {
            pubkey,
            kind: tenex_protocol::PrincipalKind::Human,
            display_name: None,
        });
    let escalation_pubkey = escalation::resolve_escalation_pubkey(&base_dir, &project_agents);
    let mcp_bridge = AcpMcpBridge::start(AcpMcpBridgeInput {
        base_dir: base_dir.clone(),
        agent_config_path: args[1].clone(),
        project_id: project_id.clone(),
        expose_delegation_tools: resolved_category_enum
            .map(|category| category.allows_delegation())
            .unwrap_or(true),
        project: project_ref.clone(),
        conversation_root: conversation_root.clone(),
        conversation_id: conversation_id.clone(),
        triggering_message: Some(bootstrap_envelope.message.clone()),
        completion_recipient: bootstrap_completion_recipient,
        triggering_principal: bootstrap_envelope.principal.clone(),
        model: acp_model.clone(),
        team: bootstrap_envelope.metadata.team.clone(),
        stdout_sink: stdout_sink.clone(),
        pending_external_work: pending_external_work.clone(),
        project_root: project_root.clone(),
        agent_pubkey: pubkey_hex.clone(),
        agent_nsec: agent_config.nsec.clone(),
        agent_slug: agent_config.identity_name().to_string(),
        owner_pubkey: owner_pubkey_hex.clone(),
        escalation_pubkey,
        agent_home: agent_home.clone(),
        working_dir: working_dir.clone(),
        agent_category: resolved_category_string.clone(),
        default_skills: agent_config.default_skills(),
        envelope_skills: bootstrap_envelope.metadata.skills.clone(),
    })
    .await?;

    eprintln!(
        "[tenex-agent-acp] {} ({}) backend={} command={} model={} (persistent)",
        agent_config.identity_name(),
        &pubkey_hex[..8],
        acp_config.backend,
        acp_config.command,
        acp_config.model.as_deref().unwrap_or("default")
    );

    let acp = Arc::new(AcpProcess::spawn(&acp_config).await?);
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
    )
    .await?;

    let session_result = acp
        .request(
            "session/new",
            session_new_params(&working_dir, &mcp_bridge, resolved_category_enum)?,
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
                )
                .await
            {
                eprintln!("[tenex-agent-acp] warn: failed to set ACP model option: {err}");
            }
        }
    }

    let history = render_history(
        conv_store.clone(),
        &conversation_id,
        &pubkey_hex,
        &system_prompt,
        &acp_config.backend,
        Some(&trigger_event_id),
    )
    .await;

    let ctx = Arc::new(SessionContext {
        project_id: project_id.clone(),
        conversation_id: conversation_id.clone(),
        pubkey_hex: pubkey_hex.clone(),
        project_ref: project_ref.clone(),
        conversation_root,
        working_dir,
        current_branch,
        project_meta,
        acp_config: acp_config.clone(),
        acp_model,
        session_id,
        system_prompt,
        backend: acp_config.backend.clone(),
        first_prompt_pending: std::sync::atomic::AtomicBool::new(true),
        stdout_sink: stdout_sink.clone(),
    });

    let mut tasks = JoinSet::new();
    let stream_sequence = Arc::new(AtomicU64::new(0));

    // Dispatch the bootstrap prompt with the rendered history. Subsequent
    // prompts run with bare content (the SDK retains conversation context).
    {
        let acp = acp.clone();
        let ctx = ctx.clone();
        let channel = channel.clone();
        let stream_sequence = stream_sequence.clone();
        let pending_external_work = pending_external_work.clone();
        let conv_store = conv_store.clone();
        let history = Some(history);
        let bootstrap_completion_recipient_pubkey = bootstrap_frame
            .completion_recipient_pubkey
            .clone()
            .or_else(|| std::env::var("TENEX_COMPLETION_RECIPIENT_PUBKEY").ok());
        tasks.spawn(async move {
            handle_prompt(
                acp,
                ctx,
                channel,
                stream_sequence,
                pending_external_work,
                conv_store,
                bootstrap_envelope,
                bootstrap_frame.traceparent,
                bootstrap_frame.tracestate,
                bootstrap_frame.baggage,
                bootstrap_completion_recipient_pubkey,
                history,
            )
            .await
        });
    }

    // Loop: read additional inbound frames until stdin closes, spawning a
    // task per event.
    loop {
        match read_next_frame(&mut stdin_lines).await {
            Ok(Some(frame)) => {
                let envelope = match tenex_protocol::nostr::decode(&frame.event) {
                    Ok(env) => env,
                    Err(err) => {
                        eprintln!("[tenex-agent-acp] warn: decoding stdin event: {err}");
                        continue;
                    }
                };
                let acp = acp.clone();
                let ctx = ctx.clone();
                let channel = channel.clone();
                let stream_sequence = stream_sequence.clone();
                let pending_external_work = pending_external_work.clone();
                let conv_store = conv_store.clone();
                let completion_recipient_pubkey = frame.completion_recipient_pubkey.clone();
                tasks.spawn(async move {
                    handle_prompt(
                        acp,
                        ctx,
                        channel,
                        stream_sequence,
                        pending_external_work,
                        conv_store,
                        envelope,
                        frame.traceparent,
                        frame.tracestate,
                        frame.baggage,
                        completion_recipient_pubkey,
                        None,
                    )
                    .await
                });
            }
            Ok(None) => break,
            Err(err) => {
                eprintln!("[tenex-agent-acp] warn: reading stdin frame: {err}");
                break;
            }
        }
    }

    // Drain all in-flight prompt tasks before tearing down the ACP session.
    while let Some(joined) = tasks.join_next().await {
        if let Err(err) = joined {
            eprintln!("[tenex-agent-acp] warn: prompt task join failed: {err}");
        }
    }

    acp.shutdown().await;
    mcp_bridge.shutdown().await;
    Ok(())
}

async fn read_next_frame(
    lines: &mut tokio::io::Lines<BufReader<tokio::io::Stdin>>,
) -> Result<Option<AcpStdinFrame>> {
    loop {
        let line = lines.next_line().await.context("reading ACP stdin")?;
        let Some(line) = line else {
            return Ok(None);
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let frame: AcpStdinFrame = serde_json::from_str(trimmed)
            .with_context(|| format!("parsing ACP stdin frame: {trimmed}"))?;
        return Ok(Some(frame));
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_prompt(
    acp: Arc<AcpProcess>,
    ctx: Arc<SessionContext>,
    channel: Arc<dyn Channel>,
    stream_sequence: Arc<AtomicU64>,
    pending_external_work: Arc<AtomicBool>,
    conv_store: Option<Arc<Mutex<ConversationStore>>>,
    envelope: tenex_protocol::channel::InboundEnvelope,
    traceparent: Option<String>,
    tracestate: Option<String>,
    baggage: Option<String>,
    completion_recipient_pubkey: Option<String>,
    rendered_history: Option<String>,
) {
    let trigger_event_id = match &envelope.message {
        MessageRef::Nostr { event_id } => event_id.to_hex(),
    };
    let dispatch_span = info_span!(
        "tenex.agent.prompt",
        event.id = %trigger_event_id,
        agent.pubkey = %ctx.pubkey_hex,
        conversation.id = %ctx.conversation_id,
    );
    if let Some(trace) = build_trace_carrier(traceparent, tracestate, baggage) {
        if let Some(parent_ctx) = tenex_telemetry::extract(&trace) {
            if let Err(err) = dispatch_span.set_parent(parent_ctx) {
                eprintln!("[tenex-agent-acp] warn: trace parent attach failed: {err}");
            }
        }
    }

    let stdout_sink = ctx.stdout_sink.clone();
    if let Err(err) = run_prompt(
        acp,
        ctx,
        channel,
        stream_sequence,
        pending_external_work,
        conv_store,
        envelope,
        completion_recipient_pubkey,
        rendered_history,
    )
    .instrument(dispatch_span)
    .await
    {
        eprintln!("[tenex-agent-acp] prompt failed: {err:#}");
    }
    // Signal "this prompt task is done" to the parent daemon. Emitted on
    // every prompt-task exit, regardless of completion vs pending-external
    // disposition. The daemon's per-child stdout reader matches this to
    // resolve the per-event dispatch span.
    let sentinel = format!("{{\"{}\":\"{}\"}}", ACP_PROMPT_DONE_SENTINEL_KEY, trigger_event_id);
    if let Err(err) = stdout_sink.write_line(&sentinel).await {
        eprintln!("[tenex-agent-acp] warn: failed to emit prompt-done sentinel: {err}");
    }
}

fn build_trace_carrier(
    traceparent: Option<String>,
    tracestate: Option<String>,
    baggage: Option<String>,
) -> Option<tenex_telemetry::TraceCarrier> {
    let traceparent = traceparent?;
    Some(tenex_telemetry::TraceCarrier {
        traceparent,
        tracestate,
        baggage,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_prompt(
    acp: Arc<AcpProcess>,
    ctx: Arc<SessionContext>,
    channel: Arc<dyn Channel>,
    stream_sequence: Arc<AtomicU64>,
    pending_external_work: Arc<AtomicBool>,
    conv_store: Option<Arc<Mutex<ConversationStore>>>,
    envelope: tenex_protocol::channel::InboundEnvelope,
    completion_recipient_pubkey: Option<String>,
    rendered_history: Option<String>,
) -> Result<()> {
    let is_first = ctx.first_prompt_pending.swap(false, Ordering::AcqRel);

    let completion_recipient = completion_recipient_pubkey
        .as_deref()
        .and_then(|pubkey| nostr::PublicKey::from_hex(pubkey).ok())
        .map(|pubkey| PrincipalRef::Nostr {
            pubkey,
            kind: tenex_protocol::PrincipalKind::Human,
            display_name: None,
        })
        .or_else(|| Some(envelope.principal.clone()));
    let current_project_addr = ctx.project_ref.coordinate();
    let completion_project_a_tags: Vec<String> = envelope
        .metadata
        .project_a_tags
        .iter()
        .filter(|addr| *addr != &current_project_addr)
        .cloned()
        .collect();

    let stream_ctx = EncodingContext {
        project: ctx.project_ref.clone(),
        conversation_root: ctx.conversation_root.clone(),
        triggering_message: Some(envelope.message.clone()),
        completion_recipient: completion_recipient.clone(),
        triggering_principal: envelope.principal.clone(),
        ral: 0,
        model: Some(ctx.acp_model.clone()),
        cost_usd: None,
        execution_time_ms: None,
        llm_runtime_ms: None,
        llm_runtime_total_ms: None,
        completion_project_a_tags: completion_project_a_tags.clone(),
        branch: ctx.current_branch.clone(),
        team: envelope.metadata.team.clone(),
    };

    let prompt_text = if is_first {
        let history = rendered_history.unwrap_or_default();
        render_acp_prompt(&ctx.system_prompt, &history, &envelope.content)
    } else {
        format!("<current-task>\n{}\n</current-task>", envelope.content)
    };

    let accounting = Arc::new(AcpRuntimeAccounting::started_now());
    let updates = Arc::new(std::sync::Mutex::new(AcpUpdates::default()));
    let pending_tool_name = Arc::new(std::sync::Mutex::new(Option::<String>::None));
    let thread_id = ctx.session_id.clone();

    let (notifications_tx, mut notifications_rx) = mpsc::unbounded_channel::<Value>();

    let drain_handle = {
        let stream_ctx = stream_ctx.clone();
        let channel = channel.clone();
        let stream_sequence = stream_sequence.clone();
        let accounting = accounting.clone();
        let updates = updates.clone();
        let pending_tool_name = pending_tool_name.clone();
        let thread_id = thread_id.clone();
        tokio::spawn(async move {
            while let Some(notification) = notifications_rx.recv().await {
                let parsed = {
                    let mut updates_state = updates.lock().unwrap();
                    updates_state.apply(&notification)
                };
                let Some(update) = parsed else { continue };
                handle_update(
                    update,
                    &channel,
                    &stream_ctx,
                    &stream_sequence,
                    &accounting,
                    &pending_tool_name,
                    &thread_id,
                )
                .await;
            }
        })
    };

    let prompt_result = acp
        .request_with_notifications(
            "session/prompt",
            json!({
                "sessionId": ctx.session_id,
                "prompt": [{"type": "text", "text": prompt_text}]
            }),
            notifications_tx,
        )
        .await;

    // The mpsc sender is dropped now that request_with_notifications has
    // returned. The drain task will see disconnect and exit.
    drain_handle.await.ok();

    let prompt_result = prompt_result?;

    // Any tool whose args never arrived (e.g. permission denied before tool_call_update).
    let trailing_tool = pending_tool_name.lock().unwrap().take();
    if let Some(tool_name) = trailing_tool.filter(|n| !n.is_empty()) {
        let intent = ToolUseIntent {
            tool_name,
            content: String::new(),
            args_json: None,
            referenced_messages: Vec::new(),
            usage: None,
            extra_tags: Vec::new(),
        };
        let mut post_ctx = stream_ctx.clone();
        post_ctx.llm_runtime_ms = accounting.take_delta();
        if let Err(err) = channel.send(Intent::ToolUse(intent), &post_ctx).await {
            eprintln!("[tenex-agent-acp] warn: post-loop tool-use emit failed: {err}");
        }
    }

    let (final_runtime_delta, session_total_ms) = accounting.take_final();
    let stop_reason = prompt_result
        .get("stopReason")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    let (visible_text, current_segment) = {
        let updates_state = updates.lock().unwrap();
        (
            updates_state.visible_text.clone(),
            updates_state.current_segment.clone(),
        )
    };

    if let Some(store) = conv_store.as_ref() {
        let turn = TurnRecord {
            messages_visible: vec![
                CtxMessage::User {
                    content: envelope.content.clone(),
                },
                CtxMessage::Assistant {
                    content: visible_text.clone(),
                    reasoning: Vec::new(),
                    tool_calls: Vec::<CtxToolCall>::new(),
                },
            ],
            reminders_applied: Vec::new(),
            compaction_decisions: Vec::new(),
            cache_observed: CacheObservation::default(),
            breakpoint_hints: Vec::new(),
        };
        let result = {
            let store = store.lock().unwrap();
            tenex_context::record_turn(&store, &ctx.conversation_id, &ctx.pubkey_hex, turn)
        };
        if let Err(err) = result {
            eprintln!("[tenex-agent-acp] warn: failed to record ACP turn: {err}");
        }
    }

    let pending_external = pending_external_work.load(Ordering::Acquire);
    let final_ctx = EncodingContext {
        project: ctx.project_ref.clone(),
        conversation_root: ctx.conversation_root.clone(),
        triggering_message: Some(envelope.message.clone()),
        completion_recipient,
        triggering_principal: envelope.principal.clone(),
        ral: 1,
        model: Some(format!("acp:{}:{}", ctx.backend, stop_reason)),
        cost_usd: None,
        execution_time_ms: None,
        llm_runtime_ms: final_runtime_delta,
        llm_runtime_total_ms: if !pending_external && session_total_ms > 0 {
            Some(session_total_ms)
        } else {
            None
        },
        completion_project_a_tags,
        branch: ctx.current_branch.clone(),
        team: envelope.metadata.team.clone(),
    };
    let metadata = Some(LlmMetadata {
        thread_id: Some(thread_id),
        ..Default::default()
    });
    let final_intent = if pending_external {
        Intent::Conversation(ConversationIntent {
            content: current_segment,
            is_reasoning: false,
            usage: None,
            metadata,
        })
    } else {
        Intent::Completion(CompletionIntent {
            content: current_segment,
            usage: None,
            metadata,
        })
    };
    channel
        .send(final_intent, &final_ctx)
        .await
        .context("Failed to emit ACP completion")?;
    // Suppress unused-field warning when the field is set but never read
    // outside this struct.
    let _ = &ctx.project_meta;
    let _ = &ctx.acp_config;
    let _ = &ctx.working_dir;
    let _ = &ctx.project_id;
    Ok(())
}

async fn handle_update(
    update: AcpUpdate,
    channel: &Arc<dyn Channel>,
    stream_ctx: &EncodingContext,
    stream_sequence: &AtomicU64,
    accounting: &Arc<AcpRuntimeAccounting>,
    pending_tool_name: &Arc<std::sync::Mutex<Option<String>>>,
    thread_id: &str,
) {
    match update {
        AcpUpdate::AgentMessageChunk { text } => {
            let sequence = stream_sequence.fetch_add(1, Ordering::Relaxed) + 1;
            let mut ctx = stream_ctx.clone();
            ctx.llm_runtime_ms = accounting.take_delta();
            let intent = StreamTextDeltaIntent { delta: text, sequence };
            if let Err(err) = channel.send(Intent::StreamTextDelta(intent), &ctx).await {
                eprintln!("[tenex-agent-acp] warn: stream delta emit failed: {err}");
            }
        }
        AcpUpdate::ToolCallStarted { segment_to_flush, tool_name } => {
            let stale = {
                let mut slot = pending_tool_name.lock().unwrap();
                slot.replace(tool_name.clone())
            };
            let mut delta = accounting.take_delta();
            if !segment_to_flush.is_empty() {
                let mut ctx = stream_ctx.clone();
                ctx.llm_runtime_ms = delta.take();
                let intent = ConversationIntent {
                    content: segment_to_flush,
                    is_reasoning: false,
                    usage: None,
                    metadata: Some(LlmMetadata {
                        thread_id: Some(thread_id.to_string()),
                        ..Default::default()
                    }),
                };
                if let Err(err) = channel.send(Intent::Conversation(intent), &ctx).await {
                    eprintln!("[tenex-agent-acp] warn: tool-boundary flush failed: {err}");
                }
            }
            if let Some(n) = stale.filter(|n| !n.is_empty()) {
                let intent = ToolUseIntent {
                    tool_name: n,
                    content: String::new(),
                    args_json: None,
                    referenced_messages: Vec::new(),
                    usage: None,
                    extra_tags: Vec::new(),
                };
                let mut ctx = stream_ctx.clone();
                ctx.llm_runtime_ms = delta.take();
                if let Err(err) = channel.send(Intent::ToolUse(intent), &ctx).await {
                    eprintln!("[tenex-agent-acp] warn: stale tool-use emit failed: {err}");
                }
            }
        }
        AcpUpdate::ToolCallArgs { tool_name, args_json } => {
            pending_tool_name.lock().unwrap().take();
            let mut ctx = stream_ctx.clone();
            ctx.llm_runtime_ms = accounting.take_delta();
            let intent = ToolUseIntent {
                tool_name,
                content: String::new(),
                args_json: Some(args_json),
                referenced_messages: Vec::new(),
                usage: None,
                extra_tags: Vec::new(),
            };
            if let Err(err) = channel.send(Intent::ToolUse(intent), &ctx).await {
                eprintln!("[tenex-agent-acp] warn: tool-use emit failed: {err}");
            }
        }
    }
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
    store: Option<Arc<Mutex<ConversationStore>>>,
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
    // `project_with_options` is async but drives a synchronous
    // SQLite read; held across `.await` only because `ConversationStore`
    // is `!Send`, requiring `std::sync::Mutex` and locking before the
    // future is awaited. render_history runs once at child startup before
    // prompt-tasks are spawned, so contention is impossible.
    #[allow(clippy::await_holding_lock)]
    let projection_result = {
        let store_guard = store.lock().unwrap();
        tenex_context::project_with_options(
            &store_guard,
            conversation_id,
            agent_pubkey,
            system_prompt,
            &profile,
            &tool_defs,
            None,
            None,
            ProjectionOptions {
                excluded_event_id: exclude_nostr_event_id.map(str::to_string),
                in_turn_tail: Vec::new(),
                compaction_override: None,
            },
        )
        .await
    };
    match projection_result {
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
