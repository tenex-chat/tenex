//! Agent subprocess lifecycle: spawn the per-run `tenex-agent` (or
//! `tenex-agent-acp`) child process, drive its stdin/stdout/stderr, persist
//! and forward signed events emitted by the agent, and clean up MCP bridge
//! resources when the run finishes.
//!
//! The `DispatchJob` value type lives here because every step of the
//! subprocess pipeline operates on it. The coordinator stores `DispatchJob`s
//! in its queue but does not introspect the fields beyond what
//! `dispatch_inbound` / `finish_run` need.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use nostr_sdk::prelude::*;
use opentelemetry::baggage::BaggageExt;
use opentelemetry::{Context as OtelContext, KeyValue};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tracing::{info_span, warn, Instrument};
use tracing_opentelemetry::OpenTelemetrySpanExt;

use tenex_conversations::{ConversationStore, NewMessage};
use tenex_mcp::SocketServerConfig;
use tenex_project::Agent;

use super::dispatch_coordinator::DispatchKey;
use super::event_routing::dispatch_project_agent_target;
use super::transport;
use super::RuntimeShared;

#[derive(Clone)]
pub(super) struct DispatchJob {
    pub(super) event: Event,
    pub(super) agent: Agent,
    pub(super) conv_id: String,
    pub(super) agent_json: PathBuf,
    pub(super) allow_driver_preempt: bool,
    pub(super) completion_recipient_pubkey: Option<String>,
    /// True when the triggering event was authored by a pubkey outside
    /// trusted runtime authors and project agents, and only routed because
    /// `routeUnauthorizedAuthors` is enabled and the firewall passed.
    /// Surfaces to the agent process as `TENEX_TRIGGER_IS_EXTERNAL=1`,
    /// which the agent uses to inject a disclosure into the user message.
    pub(super) is_external: bool,
    /// True when the triggering event was authored by a project agent that
    /// this backend does not run locally — i.e., the requester lives in a
    /// different daemon process and (almost certainly) on a different
    /// filesystem. Surfaces to the agent process as
    /// `TENEX_TRIGGER_FROM_REMOTE_AGENT=1`, which the agent uses to inject
    /// a "no shared filesystem" disclosure into the user message.
    pub(super) is_remote_agent: bool,
    /// Set when this dispatch was triggered via the transport-bridge socket
    /// (`tenex-telegram` etc). Each event the agent emits is also forwarded
    /// to the bridge so it can render the reply on the originating channel.
    pub(super) response_tee: Option<transport::TransportTee>,
    /// W3C trace context captured at the moment this job was constructed,
    /// while still inside the `tenex.daemon.event_received` span scope.
    /// Used by `spawn_dispatch_job` to parent the `tenex.runtime.dispatch`
    /// span deterministically and by `run_agent` to populate the
    /// child agent's `TRACEPARENT` / `TRACESTATE` / `BAGGAGE` env vars.
    /// Bypassing ambient capture (`Span::current()` at spawn time) is
    /// what fixes the cross-turn parent-context bug.
    pub(super) trace_carrier: Option<tenex_telemetry::TraceCarrier>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AgentRuntimeKind {
    Tenex,
    Acp,
}

struct ActiveMcpBridge {
    manifest_path: PathBuf,
    socket_path: PathBuf,
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl ActiveMcpBridge {
    async fn shutdown(self) {
        let _ = self.shutdown.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), self.task).await;
        let _ = tokio::fs::remove_file(self.manifest_path).await;
        let _ = tokio::fs::remove_file(self.socket_path).await;
    }
}

pub(super) fn spawn_dispatch_job(shared: Arc<RuntimeShared>, job: DispatchJob) {
    let key = DispatchKey::new(job.agent.pubkey.clone(), job.conv_id.clone());
    tokio::spawn(async move {
        let dispatch_span = info_span!(
            "tenex.runtime.dispatch",
            event.id = %job.event.id.to_hex(),
            event.pubkey = %job.event.pubkey.to_hex(),
            agent.slug = %job.agent.slug,
            agent.pubkey = %job.agent.pubkey,
        );

        // Parent the dispatch span deterministically from the carrier
        // captured inside `tenex.daemon.event_received`. Layer baggage
        // back on so descendant spans (`tenex.agent.turn` and below)
        // pick up `conversation.id` / `project.id` via the
        // `BaggageSpanProcessor`, since `tokio::spawn` does not carry
        // the daemon-side context guard across the spawn boundary.
        let parent_ctx = job
            .trace_carrier
            .as_ref()
            .and_then(tenex_telemetry::extract)
            .unwrap_or_else(OtelContext::current)
            .with_baggage([
                KeyValue::new("conversation.id", job.conv_id.clone()),
                KeyValue::new("project.id", shared.project_id.clone()),
            ]);
        if let Err(err) = dispatch_span.set_parent(parent_ctx) {
            warn!(error = %err, "failed to set dispatch span parent");
        }

        let run_result = async {
            match run_agent(shared.clone(), job.clone(), key.clone()).await {
                Ok(()) => Ok(()),
                Err(e) => {
                    tenex_telemetry::record_current_error(&e);
                    warn!(
                        event_id = %tenex_ids::shorten_full_event_id(&job.event.id.to_hex()),
                        agent = %job.agent.slug,
                        error = %e,
                        "agent run failed"
                    );
                    publish_agent_error(&shared, &job, &format!("{e:#}")).await;
                    Err(e)
                }
            }
        }
        .instrument(dispatch_span)
        .await;
        let _ = run_result;

        let consumed = consumed_message_event_ids(&shared.store, &job.conv_id, &job.agent.pubkey);
        let maybe_next = {
            let mut coordinator = shared.coordinator.lock().unwrap();
            coordinator
                .drop_queued_matching(&key, |queued| consumed.contains(&queued.event.id.to_hex()));
            coordinator.finish_run(&key)
        };
        super::dispatch_pipeline::publish_active_status(&shared, &job.conv_id).await;
        if let Some(next) = maybe_next {
            super::dispatch_pipeline::publish_active_status(&shared, &next.conv_id).await;
            spawn_dispatch_job(shared, next);
        }
    });
}

async fn run_agent(shared: Arc<RuntimeShared>, job: DispatchJob, key: DispatchKey) -> Result<()> {
    let job = refresh_job_agent(&shared, job)?;
    if !job.agent_json.exists() {
        anyhow::bail!("agent JSON not found: {}", job.agent_json.display());
    }

    let runtime_kind = agent_runtime_kind(&job.agent, &shared.base_dir)?;
    if runtime_kind == AgentRuntimeKind::Acp {
        // ACP runs against a persistent per-conversation child. Each
        // inbound event is streamed into that child as an `AcpStdinFrame`;
        // this task awaits the child's prompt-done sentinel.
        return super::acp_child::dispatch_to_acp_child(shared, &job, &key).await;
    }
    let binary = &shared.agent_binary;
    let execution_id = uuid::Uuid::new_v4().to_string();
    let mut command = tokio::process::Command::new(binary);
    command
        .arg(&job.agent_json)
        .env("TENEX_PROJECT_ID", &shared.project_id)
        .env("TENEX_BASE_DIR", &shared.base_dir)
        .env("TENEX_EXECUTION_ID", &execution_id)
        .env("TENEX_RUNTIME_CONTROL_SOCKET", shared.control.socket_path())
        .current_dir(&shared.project_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(false);
    command.env("TENEX_CONVERSATION_ID", &job.conv_id);
    if let Some(recipient) = job.completion_recipient_pubkey.as_deref() {
        command.env("TENEX_COMPLETION_RECIPIENT_PUBKEY", recipient);
    }
    if job.allow_driver_preempt {
        command.env("TENEX_RUNTIME_DRIVER_PREEMPT", "1");
    }
    if job.is_external {
        command.env("TENEX_TRIGGER_IS_EXTERNAL", "1");
    }
    if job.is_remote_agent {
        command.env("TENEX_TRIGGER_FROM_REMOTE_AGENT", "1");
    }
    if let Some(carrier) = tenex_telemetry::inject_current() {
        command.env("TRACEPARENT", &carrier.traceparent);
        if let Some(tracestate) = carrier.tracestate.as_deref() {
            command.env("TRACESTATE", tracestate);
        }
        if let Some(baggage) = carrier.baggage.as_deref() {
            command.env("BAGGAGE", baggage);
        }
    }
    // Tenex-runtime only path from here down. ACP returned above.
    let mcp_bridge =
        start_mcp_bridge_for_run(&shared, &job, &execution_id, &mut command).await?;

    let agent_result: Result<()> = async {
        let mut child = command
            .spawn()
            .with_context(|| format!("failed to spawn {}", binary.display()))?;
        let pid = child.id().context("agent child has no pid")?;
        let _run_guard = shared.control.register_agent_run(
            job.conv_id.clone(),
            job.agent.pubkey.clone(),
            execution_id.clone(),
            pid,
        );

        // Write the triggering event JSON to stdin; closing stdin signals EOF to the agent.
        {
            let stdin = child.stdin.take().context("child has no stdin")?;
            let mut w = BufWriter::new(stdin);
            w.write_all(job.event.as_json().as_bytes()).await?;
            w.write_all(b"\n").await?;
            w.flush().await?;
        }

        // Drain stderr in background, forwarding each line to our own stderr
        // so nothing is lost on screen. Lines are also collected so we can
        // surface them in the error event if the agent exits non-zero.
        let stderr_collector = {
            let stderr = child.stderr.take().context("child has no stderr")?;
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                let mut collected: Vec<String> = Vec::new();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("{line}");
                    collected.push(line);
                }
                collected
            })
        };

        // Forward each signed event from the agent's stdout to the relay,
        // and persist it to the conversation store.
        let stdout = child.stdout.take().context("child has no stdout")?;
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await? {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            match Event::from_json(&line) {
                Ok(ev) => {
                    if let Some(tee) = job.response_tee.as_ref() {
                        tee.send_event(line.clone());
                    }
                    handle_agent_runtime_signal(shared.clone(), &key, &ev).await;
                    if let Err(e) =
                        dispatch_project_agent_target(shared.clone(), &ev, Some(&job)).await
                    {
                        warn!(error = %e, "failed to dispatch agent-targeted event");
                    }

                    if !should_persist_agent_message(&ev, &job.conv_id) {
                        if let Err(e) = shared.client.send_event(&ev).await {
                            warn!(error = %e, "relay publish failed");
                        }
                        continue;
                    }
                    {
                        let s = shared.store.lock().unwrap();
                        let agent_ts = ev.created_at.as_secs() as i64;
                        if let Err(e) = s.append_message(
                            &job.conv_id,
                            &NewMessage {
                                record_id: format!("event:{}", ev.id.to_hex()),
                                nostr_event_id: Some(ev.id.to_hex()),
                                author_pubkey: ev.pubkey.to_hex(),
                                sender_pubkey: None,
                                ral: None,
                                message_type: "text".to_string(),
                                role: Some("assistant".to_string()),
                                content: ev.content.clone(),
                                timestamp: Some(agent_ts),
                                targeted_pubkeys: None,
                                sender_principal: None,
                                targeted_principals: None,
                                tool_data: None,
                                delegation_marker: None,
                                human_readable: None,
                                transcript_tool_attributes: None,
                            },
                        ) {
                            warn!(error = %e, "failed to persist agent event");
                        }
                    }
                    if let Err(e) = shared.client.send_event(&ev).await {
                        warn!(error = %e, "relay publish failed");
                    }
                }
                Err(e) => {
                    warn!(error = %e, "ignoring unparseable agent output line");
                }
            }
        }

        let status = child.wait().await?;
        let stderr_lines = stderr_collector.await.unwrap_or_default();
        if !status.success() {
            let error_msg = extract_agent_error_message(&stderr_lines);
            warn!(code = ?status.code(), error = %error_msg, "tenex-agent exited non-zero");
            publish_agent_error(&shared, &job, &error_msg).await;
        }

        Ok(())
    }
    .await;

    if let Some(bridge) = mcp_bridge {
        bridge.shutdown().await;
    }

    if let Some(tee) = job.response_tee.as_ref() {
        match agent_result.as_ref() {
            Ok(()) => tee.send_done(),
            Err(e) => tee.send_error(e.to_string()),
        }
    }

    agent_result
}

fn refresh_job_agent(shared: &RuntimeShared, mut job: DispatchJob) -> Result<DispatchJob> {
    let snapshot = shared.agent_snapshot();
    let Some(agent) = snapshot
        .agents
        .iter()
        .find(|agent| agent.pubkey == job.agent.pubkey)
    else {
        anyhow::bail!(
            "agent '{}' is no longer available in project '{}'",
            job.agent.slug,
            shared.project_id
        );
    };
    job.agent = agent.clone();
    Ok(job)
}

pub(super) fn agent_runtime_kind(agent: &Agent, base_dir: &std::path::Path) -> Result<AgentRuntimeKind> {
    let Some(default_json) = agent.default_config_json.as_deref() else {
        return Ok(AgentRuntimeKind::Tenex);
    };
    let default: Value = serde_json::from_str(default_json)
        .with_context(|| format!("parsing default config for {}", agent.slug))?;
    let Some(model_name) = default.get("model").and_then(Value::as_str) else {
        return Ok(AgentRuntimeKind::Tenex);
    };
    let llms =
        tenex_llm_config::resolver::load_llms(base_dir).with_context(|| "loading llms.json")?;
    let Some(config) = llms.configurations.get(model_name) else {
        return Ok(AgentRuntimeKind::Tenex);
    };
    if config.get("provider").and_then(Value::as_str) == Some("acp") {
        Ok(AgentRuntimeKind::Acp)
    } else {
        Ok(AgentRuntimeKind::Tenex)
    }
}

async fn start_mcp_bridge_for_run(
    shared: &Arc<RuntimeShared>,
    job: &DispatchJob,
    execution_id: &str,
    command: &mut tokio::process::Command,
) -> Result<Option<ActiveMcpBridge>> {
    let project_slugs =
        tenex_mcp::mcp_access_from_default_json(job.agent.default_config_json.as_deref())
            .with_context(|| format!("reading MCP access for agent '{}'", job.agent.slug))?;

    // Parse agent-owned servers from mcp_servers_json (inner-map format:
    // `{"slug": {config}}` without the outer `mcpServers` wrapper).
    let agent_mcp_config = match job.agent.mcp_servers_json.as_deref() {
        Some(json) => tenex_mcp::ProjectMcpConfig::from_agent_json(json)
            .with_context(|| format!("parsing agent MCP servers for '{}'", job.agent.slug))?,
        None => tenex_mcp::ProjectMcpConfig::default(),
    };

    if project_slugs.is_empty() && agent_mcp_config.is_empty() {
        return Ok(None);
    }

    // Agent-owned servers take precedence: skip any project slug that the
    // agent owns itself so the agent version is always the one that runs.
    let effective_project_slugs: Vec<String> = project_slugs
        .into_iter()
        .filter(|slug| !agent_mcp_config.servers.contains_key(slug.as_str()))
        .collect();

    let project_manifest = shared
        .mcp_runtime
        .prepare_manifest(&effective_project_slugs)
        .await
        .with_context(|| format!("preparing project MCP tools for agent '{}'", job.agent.slug))?;

    // Build a per-run runtime for agent-owned servers and collect their tools.
    let (agent_runtime, agent_manifest) = if !agent_mcp_config.is_empty() {
        let agent_slugs: Vec<String> = agent_mcp_config.servers.keys().cloned().collect();
        let runtime = tenex_mcp::ProjectMcpRuntime::from_config(
            &shared.project_dir,
            agent_mcp_config,
        );
        let manifest = runtime
            .prepare_manifest(&agent_slugs)
            .await
            .with_context(|| {
                format!("preparing agent MCP tools for '{}'", job.agent.slug)
            })?;
        (Some(runtime), manifest)
    } else {
        (None, tenex_mcp::ToolManifest::empty())
    };

    let mut combined_manifest = project_manifest;
    combined_manifest.tools.extend(agent_manifest.tools);

    let run_id: String = execution_id
        .chars()
        .filter(|ch| *ch != '-')
        .take(16)
        .collect();
    let run_dir = shared.base_dir.join("runtime").join("mcp");
    tokio::fs::create_dir_all(&run_dir).await?;
    let manifest_path = run_dir.join(format!("{run_id}.manifest.json"));
    let socket_path = run_dir.join(format!("{run_id}.sock"));
    tokio::fs::write(&manifest_path, serde_json::to_vec(&combined_manifest)?).await?;

    let server = match tenex_mcp::bind_socket(SocketServerConfig {
        socket_path: socket_path.clone(),
        allowed_tools: combined_manifest.tool_names(),
    })
    .await
    {
        Ok(server) => server,
        Err(error) => {
            let _ = tokio::fs::remove_file(&manifest_path).await;
            return Err(error);
        }
    };

    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
    let project_runtime = shared.mcp_runtime.clone();
    let task = tokio::spawn(async move {
        if let Err(error) = server.serve(project_runtime, agent_runtime, shutdown_rx).await {
            warn!(error = %error, "MCP bridge socket stopped with error");
        }
    });

    command
        .env("TENEX_MCP_MANIFEST", &manifest_path)
        .env("TENEX_MCP_SOCKET", &socket_path);

    Ok(Some(ActiveMcpBridge {
        manifest_path,
        socket_path,
        shutdown,
        task,
    }))
}

fn extract_agent_error_message(stderr_lines: &[String]) -> String {
    // Prefer the last line that looks like an application-level error.
    stderr_lines
        .iter()
        .rev()
        .find(|l| l.starts_with("Error:") || l.starts_with("error:"))
        .or_else(|| stderr_lines.iter().rev().find(|l| !l.trim().is_empty()))
        .cloned()
        .unwrap_or_else(|| "agent process exited with non-zero status".to_string())
}

async fn publish_agent_error(shared: &RuntimeShared, job: &DispatchJob, error_msg: &str) {
    let content = format!("⚠️ {}: {error_msg}", job.agent.slug);
    let triggering_id = job.event.id.to_hex();
    let user_pubkey = job.event.pubkey.to_hex();
    let tags: Vec<Tag> = [
        ["e", triggering_id.as_str()],
        ["p", user_pubkey.as_str()],
        ["a", shared.project_addr.as_str()],
    ]
    .iter()
    .filter_map(|parts| Tag::parse(*parts).ok())
    .collect();

    match EventBuilder::new(Kind::TextNote, content)
        .tags(tags)
        .sign_with_keys(&shared.backend_keys)
    {
        Ok(event) => {
            if let Err(e) = shared.client.send_event(&event).await {
                warn!(error = %e, "failed to publish agent error event");
            }
        }
        Err(e) => warn!(error = %e, "failed to sign agent error event"),
    }
}

pub(super) fn should_persist_agent_message(event: &Event, conversation_id: &str) -> bool {
    if event.kind != Kind::TextNote {
        return false;
    }
    if event.content.trim().is_empty() {
        return false;
    }

    let mut has_conversation_ref = false;
    let mut has_completed_status = false;

    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        let head = parts.first().map(|s| s.as_str()).unwrap_or("");
        match head {
            "e" => {
                let tagged_event = parts.get(1).map(|s| s.as_str());
                let marker = parts.get(3).map(|s| s.as_str());
                if tagged_event == Some(conversation_id)
                    && matches!(marker, Some("root") | Some("reply") | None | Some(""))
                {
                    has_conversation_ref = true;
                }
            }
            "status" => {
                if parts.get(1).map(|s| s.as_str()) == Some("completed") {
                    has_completed_status = true;
                }
            }
            "tool" | "intent" | "reasoning" | "error" => return false,
            _ => {}
        }
    }

    has_conversation_ref && has_completed_status
}

pub(super) fn consumed_message_event_ids(
    store: &Arc<std::sync::Mutex<ConversationStore>>,
    conv_id: &str,
    agent_pubkey: &str,
) -> std::collections::HashSet<String> {
    let Ok(conversation) = store.lock().unwrap().get_conversation(conv_id) else {
        return std::collections::HashSet::new();
    };
    let Some(conversation) = conversation else {
        return std::collections::HashSet::new();
    };
    conversation
        .runtime_state
        .get("rustRuntime")
        .and_then(|v| v.get("consumedMessages"))
        .and_then(serde_json::Value::as_object)
        .map(|messages| {
            messages
                .iter()
                .filter_map(|(event_id, meta)| {
                    let same_agent = meta.get("agentPubkey").and_then(serde_json::Value::as_str)
                        == Some(agent_pubkey);
                    let same_conversation = meta
                        .get("conversationId")
                        .and_then(serde_json::Value::as_str)
                        == Some(conv_id);
                    if same_agent && same_conversation {
                        Some(event_id.clone())
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn handle_agent_runtime_signal(shared: Arc<RuntimeShared>, key: &DispatchKey, event: &Event) {
    if event.kind == Kind::Custom(24135) {
        let mut coordinator = shared.coordinator.lock().unwrap();
        coordinator.mark_driver_busy(key);
        return;
    }

    if event_has_tag(event, "tool") {
        let mut coordinator = shared.coordinator.lock().unwrap();
        coordinator.mark_driver_free(key);
    }
}

fn event_has_tag(event: &Event, tag_name: &str) -> bool {
    event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().is_some_and(|head| head == tag_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_event(kind: Kind, content: &str, tags: Vec<Tag>) -> Event {
        let keys = Keys::generate();
        EventBuilder::new(kind, content)
            .tags(tags)
            .sign_with_keys(&keys)
            .unwrap()
    }

    fn root_id() -> String {
        signed_event(Kind::TextNote, "root", Vec::new()).id.to_hex()
    }

    fn tag(parts: &[&str]) -> Tag {
        Tag::parse(parts.iter().copied()).unwrap()
    }

    /// A kind:1 event that references the conversation root but has no
    /// `["status", "completed"]` tag is an intermediate `ConversationIntent`
    /// (streaming text flushed before tool execution). It must NOT be persisted:
    /// the corresponding `record_step_assistant` call already writes the step row,
    /// and persisting the event too would produce a duplicate assistant message in
    /// the next step's projection.
    #[test]
    fn rejects_intermediate_stream_text_without_completed_status() {
        let root = root_id();
        let event = signed_event(
            Kind::TextNote,
            "streaming partial text",
            vec![tag(&["e", &root, "", "root"])],
        );

        assert!(
            !should_persist_agent_message(&event, &root),
            "intermediate ConversationIntent must not be persisted"
        );
    }

    #[test]
    fn rejects_stream_delta_events() {
        let root = root_id();
        let event = signed_event(
            Kind::Custom(24135),
            "partial",
            vec![tag(&["e", &root, "", "root"])],
        );

        assert!(!should_persist_agent_message(&event, &root));
    }

    #[test]
    fn rejects_tool_use_events() {
        let root = root_id();
        let event = signed_event(
            Kind::TextNote,
            "tool call",
            vec![tag(&["e", &root, "", "root"]), tag(&["tool", "shell"])],
        );

        assert!(!should_persist_agent_message(&event, &root));
    }

    #[test]
    fn persists_completion_events_with_recipients() {
        let root = root_id();
        let recipient = Keys::generate().public_key().to_hex();
        let event = signed_event(
            Kind::TextNote,
            "The worker picked blue.",
            vec![
                tag(&["e", &root, "", "root"]),
                tag(&["p", recipient.as_str()]),
                tag(&["status", "completed"]),
            ],
        );

        assert!(should_persist_agent_message(&event, &root));
    }

    #[test]
    fn rejects_fresh_delegation_events_without_current_root() {
        let parent_root = root_id();
        let recipient = Keys::generate().public_key().to_hex();
        let event = signed_event(
            Kind::TextNote,
            "@worker do this",
            vec![
                tag(&["delegation", &parent_root]),
                tag(&["p", recipient.as_str()]),
            ],
        );

        assert!(!should_persist_agent_message(&event, &parent_root));
    }

    #[test]
    fn rejects_empty_conversation_events() {
        let root = root_id();
        let event = signed_event(Kind::TextNote, "   ", vec![tag(&["e", &root, "", "root"])]);

        assert!(!should_persist_agent_message(&event, &root));
    }
}
