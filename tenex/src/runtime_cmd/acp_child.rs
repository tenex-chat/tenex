//! Persistent ACP child subprocess: one long-lived `tenex-agent-acp` per
//! `(agent_pubkey, conversation_id)`. Inbound events are streamed in as
//! [`AcpStdinFrame`]s; the child runs each through its own
//! `session/prompt` task on the SAME ACP session. The dispatch task for a
//! given event awaits a per-event prompt-done sentinel emitted by the
//! child at the end of every prompt task.
//!
//! The persistent model is what makes mid-turn injection work — sending a
//! second `session/prompt` while the first is still in flight pushes the
//! new user message onto the live `session.input` queue inside the ACP
//! backend, where the SDK injects it into the running turn.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use nostr_sdk::prelude::*;
use serde_json::Value;
use tenex_conversations::NewMessage;
use tenex_protocol::nostr::{AcpStdinFrame, ACP_PROMPT_DONE_SENTINEL_KEY};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::ChildStdin;
use tokio::sync::oneshot;
use tracing::warn;

use super::agent_subprocess::{should_persist_agent_message, DispatchJob};
use super::dispatch_coordinator::DispatchKey;
use super::event_routing::dispatch_project_agent_target;
use super::RuntimeShared;

pub(super) struct AcpChildHandle {
    stdin: tokio::sync::Mutex<BufWriter<ChildStdin>>,
    listeners: Arc<Mutex<HashMap<String, oneshot::Sender<Result<()>>>>>,
    /// Set by the stdout-drain task immediately before it drains and fails
    /// the pending listener map. Lets `dispatch_to_acp_child` detect the
    /// narrow race where the registry hands out a handle and the drain
    /// task removes it before we register our listener. Shared with the
    /// drain task via `Arc` because the task is spawned before the handle
    /// struct is constructed.
    is_dead: Arc<AtomicBool>,
}

pub(super) async fn dispatch_to_acp_child(
    shared: Arc<RuntimeShared>,
    job: &DispatchJob,
    key: &DispatchKey,
) -> Result<()> {
    let handle = get_or_spawn_child(shared.clone(), job, key).await?;
    let trigger_id = job.event.id.to_hex();
    let (tx, rx) = oneshot::channel::<Result<()>>();
    {
        let mut listeners = handle.listeners.lock().unwrap();
        if handle.is_dead.load(Ordering::Acquire) {
            return Err(anyhow!(
                "ACP child for this conversation exited before this prompt could be dispatched"
            ));
        }
        listeners.insert(trigger_id.clone(), tx);
    }

    let frame = AcpStdinFrame {
        event: job.event.clone(),
        traceparent: job
            .trace_carrier
            .as_ref()
            .map(|c| c.traceparent.clone()),
        tracestate: job
            .trace_carrier
            .as_ref()
            .and_then(|c| c.tracestate.clone()),
        baggage: job.trace_carrier.as_ref().and_then(|c| c.baggage.clone()),
        completion_recipient_pubkey: job.completion_recipient_pubkey.clone(),
    };
    let mut frame_line = serde_json::to_vec(&frame).context("serializing AcpStdinFrame")?;
    frame_line.push(b'\n');
    {
        let mut stdin = handle.stdin.lock().await;
        if let Err(err) = stdin.write_all(&frame_line).await {
            // Failed write: unregister listener so we don't leak it.
            handle.listeners.lock().unwrap().remove(&trigger_id);
            return Err(err.into());
        }
        if let Err(err) = stdin.flush().await {
            handle.listeners.lock().unwrap().remove(&trigger_id);
            return Err(err.into());
        }
    }

    match rx.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(anyhow!("ACP child closed before signalling completion")),
    }
}

async fn get_or_spawn_child(
    shared: Arc<RuntimeShared>,
    job: &DispatchJob,
    key: &DispatchKey,
) -> Result<Arc<AcpChildHandle>> {
    {
        let registry = shared.acp_children.lock().unwrap();
        if let Some(handle) = registry.get(key) {
            return Ok(handle.clone());
        }
    }

    let handle = spawn_child(shared.clone(), job, key).await?;
    let mut registry = shared.acp_children.lock().unwrap();
    // Another task may have raced us and inserted first; keep that one.
    Ok(registry
        .entry(key.clone())
        .or_insert_with(|| handle.clone())
        .clone())
}

async fn spawn_child(
    shared: Arc<RuntimeShared>,
    job: &DispatchJob,
    key: &DispatchKey,
) -> Result<Arc<AcpChildHandle>> {
    let execution_id = uuid::Uuid::new_v4().to_string();
    let mut command = tokio::process::Command::new(&shared.agent_acp_binary);
    command
        .arg(&job.agent_json)
        .env("TENEX_PROJECT_ID", &shared.project_id)
        .env("TENEX_BASE_DIR", &shared.base_dir)
        .env("TENEX_EXECUTION_ID", &execution_id)
        .env("TENEX_RUNTIME_CONTROL_SOCKET", shared.control.socket_path())
        .env("TENEX_CONVERSATION_ID", &job.conv_id)
        .current_dir(&shared.project_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(false);
    if let Some(recipient) = job.completion_recipient_pubkey.as_deref() {
        command.env("TENEX_COMPLETION_RECIPIENT_PUBKEY", recipient);
    }
    // Trace context for this child's process-level spans (init / session/new)
    // is injected here. Per-prompt spans are reparented from the trace
    // carrier carried inside each `AcpStdinFrame`.
    if let Some(carrier) = tenex_telemetry::inject_current() {
        command.env("TRACEPARENT", &carrier.traceparent);
        if let Some(tracestate) = carrier.tracestate.as_deref() {
            command.env("TRACESTATE", tracestate);
        }
        if let Some(baggage) = carrier.baggage.as_deref() {
            command.env("BAGGAGE", baggage);
        }
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to spawn {}", shared.agent_acp_binary.display()))?;
    let pid = child.id().context("acp child has no pid")?;

    // Hand a long-lived run guard to the control socket so stop commands
    // can resolve this child's PID. Ownership transfers to the stdout
    // drain task below so it stays alive for the child's lifetime.
    let run_guard = shared.control.register_agent_run(
        job.conv_id.clone(),
        job.agent.pubkey.clone(),
        execution_id.clone(),
        pid,
    );

    let stdin = child.stdin.take().context("acp child has no stdin")?;
    let stdout = child.stdout.take().context("acp child has no stdout")?;
    let stderr = child.stderr.take().context("acp child has no stderr")?;

    let listeners: Arc<Mutex<HashMap<String, oneshot::Sender<Result<()>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let is_dead = Arc::new(AtomicBool::new(false));

    // Stderr drain — forward to our own stderr.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("{line}");
        }
    });

    // Stdout drain: parse signed Nostr events and prompt-done sentinels.
    let listeners_drain = listeners.clone();
    let shared_drain = shared.clone();
    let conv_id_drain = job.conv_id.clone();
    let key_drain = key.clone();
    let is_dead_drain = is_dead.clone();
    tokio::spawn(async move {
        // Hold the control-socket run guard for the entire child lifetime.
        // Dropped when the task exits (stdout closed → child gone).
        let _run_guard = run_guard;
        let mut lines = BufReader::new(stdout).lines();
        loop {
            let line = match lines.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(err) => {
                    warn!(error = %err, "acp stdout read error");
                    break;
                }
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                if let Some(trigger_id) = value
                    .get(ACP_PROMPT_DONE_SENTINEL_KEY)
                    .and_then(Value::as_str)
                {
                    let listener = listeners_drain.lock().unwrap().remove(trigger_id);
                    if let Some(tx) = listener {
                        let _ = tx.send(Ok(()));
                    }
                    continue;
                }
            }
            match Event::from_json(trimmed) {
                Ok(ev) => {
                    process_acp_event(&shared_drain, &conv_id_drain, &ev, &line).await;
                }
                Err(err) => {
                    warn!(error = %err, line = %trimmed, "ignoring unparseable acp stdout line");
                }
            }
        }
        // Mark the handle dead BEFORE draining listeners + removing from
        // the registry. `dispatch_to_acp_child` checks this flag under the
        // listeners lock immediately after acquiring it, so any future
        // dispatch task that races with us either sees the live handle and
        // registers (and we deliver Err below) or sees `is_dead` and bails
        // out immediately.
        is_dead_drain.store(true, Ordering::Release);
        let drained: Vec<(String, oneshot::Sender<Result<()>>)> = {
            let mut listeners = listeners_drain.lock().unwrap();
            listeners.drain().collect()
        };
        for (_, tx) in drained {
            let _ = tx.send(Err(anyhow!(
                "ACP child exited before completing this prompt"
            )));
        }
        // Remove from registry so future events spawn a fresh child.
        shared_drain.acp_children.lock().unwrap().remove(&key_drain);

        // Reap so we don't leave a zombie.
        match child.wait().await {
            Ok(status) if !status.success() => {
                warn!(code = ?status.code(), "tenex-agent-acp child exited non-zero");
            }
            Ok(_) => {}
            Err(err) => warn!(error = %err, "tenex-agent-acp wait failed"),
        }
    });

    let _ = pid;
    Ok(Arc::new(AcpChildHandle {
        stdin: tokio::sync::Mutex::new(BufWriter::new(stdin)),
        listeners,
        is_dead,
    }))
}

async fn process_acp_event(
    shared: &Arc<RuntimeShared>,
    conv_id: &str,
    ev: &Event,
    raw_line: &str,
) {
    let _ = raw_line; // reserved for future response-tee re-add
    if let Err(e) = dispatch_project_agent_target(shared.clone(), ev, None).await {
        warn!(error = %e, "failed to dispatch agent-targeted event");
    }
    if !should_persist_agent_message(ev, conv_id) {
        if let Err(e) = shared.client.send_event(ev).await {
            warn!(error = %e, "relay publish failed");
        }
        return;
    }
    {
        let s = shared.store.lock().unwrap();
        let agent_ts = ev.created_at.as_secs() as i64;
        if let Err(e) = s.append_message(
            conv_id,
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
    if let Err(e) = shared.client.send_event(ev).await {
        warn!(error = %e, "relay publish failed");
    }
}
