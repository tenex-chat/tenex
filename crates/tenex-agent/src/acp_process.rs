use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

use crate::acp_config::{AcpPermissionPolicy, AcpRuntimeConfig};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AcpUpdate {
    AgentMessageChunk { text: String },
    /// A new tool call began. The preceding text segment should be flushed and
    /// the tool name recorded; `ToolUseIntent` is NOT emitted yet — we wait for
    /// the companion `ToolCallArgs` that carries the actual `rawInput`.
    ToolCallStarted { segment_to_flush: String, tool_name: String },
    /// The first `tool_call_update` with non-empty `rawInput`. Emit
    /// `ToolUseIntent` now that we have the structured arguments.
    ToolCallArgs { tool_name: String, args_json: String },
}

#[derive(Default)]
pub(crate) struct AcpUpdates {
    pub(crate) visible_text: String,
    pub(crate) current_segment: String,
    /// Tool name saved from the most recent `tool_call`, waiting for args.
    pending_tool_name: Option<String>,
}

impl AcpUpdates {
    /// Apply a raw `session/update` JSON-RPC notification.
    pub(crate) fn apply(&mut self, message: &Value) -> Option<AcpUpdate> {
        let update = message
            .get("params")
            .and_then(|params| params.get("update"))?;
        let kind = update.get("sessionUpdate").and_then(Value::as_str)?;
        match kind {
            "agent_message_chunk" => {
                let text = update
                    .get("content")
                    .and_then(|content| content.get("text"))
                    .and_then(Value::as_str)?;
                self.visible_text.push_str(text);
                self.current_segment.push_str(text);
                Some(AcpUpdate::AgentMessageChunk {
                    text: text.to_string(),
                })
            }
            "tool_call" => {
                let segment_to_flush = std::mem::take(&mut self.current_segment);
                let tool_name = update
                    .get("_meta")
                    .and_then(|m| m.get("claudeCode"))
                    .and_then(|cc| cc.get("toolName"))
                    .and_then(Value::as_str)
                    .or_else(|| update.get("title").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string();
                self.pending_tool_name = Some(tool_name.clone());
                Some(AcpUpdate::ToolCallStarted { segment_to_flush, tool_name })
            }
            "tool_call_update" => {
                // Only produce an update on the first non-empty rawInput — that
                // is when we know the structured arguments for the pending tool.
                let raw_input = update.get("rawInput").and_then(Value::as_object)?;
                if raw_input.is_empty() {
                    return None;
                }
                let tool_name = self.pending_tool_name.take()?;
                let args_json = serde_json::to_string(update.get("rawInput").unwrap())
                    .unwrap_or_default();
                Some(AcpUpdate::ToolCallArgs { tool_name, args_json })
            }
            _ => None,
        }
    }
}

/// One in-flight prompt-style request: notifications arriving while this
/// request is at the head of the FIFO are routed to `notifications_tx`.
struct InFlight {
    id: u64,
    notifications_tx: mpsc::UnboundedSender<Value>,
}

#[derive(Default)]
struct MuxState {
    pending_responses: HashMap<u64, oneshot::Sender<Result<Value>>>,
    update_queue: VecDeque<InFlight>,
}

struct AcpInner {
    writer: tokio::sync::Mutex<BufWriter<ChildStdin>>,
    next_id: AtomicU64,
    state: Mutex<MuxState>,
    permission_policy: AcpPermissionPolicy,
}

pub(crate) struct AcpProcess {
    inner: Arc<AcpInner>,
    child: Mutex<Option<Child>>,
    reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl AcpProcess {
    pub(crate) async fn spawn(config: &AcpRuntimeConfig) -> Result<Self> {
        let mut command = Command::new(&config.command);
        command.args(&config.args);
        command.envs(std::env::vars());
        for (key, value) in &config.env {
            command.env(key, value);
        }
        if config.backend.contains("claude") {
            if let Some(model) = config.model.as_deref() {
                if !config.env.contains_key("ANTHROPIC_MODEL") {
                    command.env("ANTHROPIC_MODEL", model);
                }
            }
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .with_context(|| format!("failed to spawn ACP backend '{}'", config.command))?;
        let stdin = child.stdin.take().context("ACP backend has no stdin")?;
        let stdout = child.stdout.take().context("ACP backend has no stdout")?;

        let inner = Arc::new(AcpInner {
            writer: tokio::sync::Mutex::new(BufWriter::new(stdin)),
            next_id: AtomicU64::new(1),
            state: Mutex::new(MuxState::default()),
            permission_policy: config.permission_policy,
        });
        let reader_inner = inner.clone();
        let reader = tokio::spawn(async move {
            reader_loop(reader_inner, stdout).await;
        });

        Ok(Self {
            inner,
            child: Mutex::new(Some(child)),
            reader: Mutex::new(Some(reader)),
        })
    }

    /// Send a JSON-RPC request without a notification consumer. Useful for
    /// `initialize`, `session/new`, and one-shot config calls that don't emit
    /// `session/update` notifications.
    pub(crate) async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.send(method, params, None).await
    }

    /// Send a JSON-RPC request and route `session/update` notifications
    /// arriving while this request is at the head of the FIFO into
    /// `notifications_tx`. Used for `session/prompt`.
    pub(crate) async fn request_with_notifications(
        &self,
        method: &str,
        params: Value,
        notifications_tx: mpsc::UnboundedSender<Value>,
    ) -> Result<Value> {
        self.send(method, params, Some(notifications_tx)).await
    }

    async fn send(
        &self,
        method: &str,
        params: Value,
        notifications_tx: Option<mpsc::UnboundedSender<Value>>,
    ) -> Result<Value> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (response_tx, response_rx) = oneshot::channel();

        // Register response + (optional) notification handle, then write the
        // request body — all under the writer lock so the order in which
        // we register matches the order in which the ACP backend receives
        // (and therefore the SDK's pendingMessages.order).
        let mut writer = self.inner.writer.lock().await;
        {
            let mut state = self.inner.state.lock().unwrap();
            state.pending_responses.insert(id, response_tx);
            if let Some(tx) = notifications_tx {
                state.update_queue.push_back(InFlight {
                    id,
                    notifications_tx: tx,
                });
            }
        }
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_vec(&body)?;
        line.push(b'\n');
        if let Err(err) = writer.write_all(&line).await {
            self.cleanup_failed_send(id);
            return Err(err.into());
        }
        if let Err(err) = writer.flush().await {
            self.cleanup_failed_send(id);
            return Err(err.into());
        }
        drop(writer);

        match response_rx.await {
            Ok(result) => result,
            Err(_) => Err(anyhow!("ACP backend closed before responding to {method}")),
        }
    }

    fn cleanup_failed_send(&self, id: u64) {
        let mut state = self.inner.state.lock().unwrap();
        state.pending_responses.remove(&id);
        state.update_queue.retain(|in_flight| in_flight.id != id);
    }

    pub(crate) async fn shutdown(&self) {
        let child = self.child.lock().unwrap().take();
        if let Some(mut child) = child {
            if let Ok(Some(_)) = child.try_wait() {
                // already exited
            } else {
                let _ = child.kill().await;
            }
            let _ = child.wait().await;
        }
        let reader = self.reader.lock().unwrap().take();
        if let Some(handle) = reader {
            let _ = handle.await;
        }
    }
}

async fn reader_loop(inner: Arc<AcpInner>, stdout: ChildStdout) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(err) => {
                eprintln!("[tenex-agent-acp] ACP read error: {err}");
                break;
            }
        };
        let message: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(err) => {
                eprintln!("[tenex-agent-acp] invalid ACP JSON-RPC line: {err}: {line}");
                continue;
            }
        };
        dispatch_message(&inner, message).await;
    }
    fail_all_pending(&inner, "ACP backend stdout closed");
}

async fn dispatch_message(inner: &Arc<AcpInner>, message: Value) {
    // Client-initiated request: has both `method` and `id`. The ACP backend
    // is asking us something (e.g. permission). We answer inline.
    if message.get("method").is_some() && message.get("id").is_some() {
        if let Err(err) = handle_client_request(inner, &message).await {
            eprintln!("[tenex-agent-acp] ACP client request handler failed: {err}");
        }
        return;
    }

    // Server-initiated notification: `method` present, no `id`.
    if let Some(method) = message.get("method").and_then(Value::as_str) {
        if method == "session/update" {
            let head_tx = {
                let state = inner.state.lock().unwrap();
                state
                    .update_queue
                    .front()
                    .map(|in_flight| in_flight.notifications_tx.clone())
            };
            if let Some(tx) = head_tx {
                let _ = tx.send(message);
            }
        }
        return;
    }

    // Response: has `id`, has `result` or `error`.
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        let response_tx = {
            let mut state = inner.state.lock().unwrap();
            state.update_queue.retain(|in_flight| in_flight.id != id);
            state.pending_responses.remove(&id)
        };
        let Some(response_tx) = response_tx else {
            return;
        };
        if let Some(error) = message.get("error") {
            let _ = response_tx.send(Err(anyhow!("ACP request failed: {error}")));
        } else {
            let result = message.get("result").cloned().unwrap_or(Value::Null);
            let _ = response_tx.send(Ok(result));
        }
    }
}

async fn handle_client_request(inner: &Arc<AcpInner>, request: &Value) -> Result<()> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str);
    let response = match method {
        Some("session/request_permission") => {
            let option = choose_permission_option(request, inner.permission_policy);
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {"outcome": option},
            })
        }
        Some(other) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32601,
                "message": format!("TENEX ACP client does not implement {other}"),
            },
        }),
        None => return Ok(()),
    };
    let mut writer = inner.writer.lock().await;
    let mut line = serde_json::to_vec(&response)?;
    line.push(b'\n');
    writer.write_all(&line).await?;
    writer.flush().await?;
    Ok(())
}

fn fail_all_pending(inner: &Arc<AcpInner>, reason: &str) {
    let (pending, queue) = {
        let mut state = inner.state.lock().unwrap();
        let pending: Vec<(u64, oneshot::Sender<Result<Value>>)> =
            state.pending_responses.drain().collect();
        let queue: Vec<InFlight> = state.update_queue.drain(..).collect();
        (pending, queue)
    };
    for (_, tx) in pending {
        let _ = tx.send(Err(anyhow!("{reason}")));
    }
    drop(queue); // dropping closes mpsc senders → receivers see disconnect
}

fn choose_permission_option(request: &Value, policy: AcpPermissionPolicy) -> Value {
    let options = request
        .get("params")
        .and_then(|params| params.get("options"))
        .and_then(Value::as_array);
    let preferred_kind = match policy {
        AcpPermissionPolicy::Allow => "allow",
        AcpPermissionPolicy::Deny => "reject",
    };
    let option_id = options.and_then(|items| {
        items
            .iter()
            .find(|item| {
                item.get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind.starts_with(preferred_kind))
            })
            .or_else(|| items.first())
            .and_then(|item| item.get("optionId").and_then(Value::as_str))
    });
    match option_id {
        Some(option_id) => json!({"outcome": "selected", "optionId": option_id}),
        None => json!({"outcome": "cancelled"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_agent_message_chunk_accumulates_and_returns_delta() {
        let mut updates = AcpUpdates::default();
        let first = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "hello "}
                }
            }
        });
        let second = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "world"}
                }
            }
        });

        assert_eq!(
            updates.apply(&first),
            Some(AcpUpdate::AgentMessageChunk {
                text: "hello ".to_string()
            })
        );
        assert_eq!(
            updates.apply(&second),
            Some(AcpUpdate::AgentMessageChunk {
                text: "world".to_string()
            })
        );
        assert_eq!(updates.visible_text, "hello world");
        assert_eq!(updates.current_segment, "hello world");
    }

    #[test]
    fn apply_tool_call_flushes_current_segment_and_resets() {
        let mut updates = AcpUpdates::default();
        let chunk = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "thinking..."}
                }
            }
        });
        let tool = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "abc",
                    "title": "do thing",
                    "kind": "read",
                    "status": "in_progress"
                }
            }
        });

        updates.apply(&chunk);
        assert_eq!(
            updates.apply(&tool),
            Some(AcpUpdate::ToolCallStarted {
                segment_to_flush: "thinking...".to_string(),
                tool_name: "do thing".to_string(),
            })
        );
        assert_eq!(updates.visible_text, "thinking...");
        assert!(updates.current_segment.is_empty());

        let trailing = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "done."}
                }
            }
        });
        updates.apply(&trailing);
        assert_eq!(updates.visible_text, "thinking...done.");
        assert_eq!(updates.current_segment, "done.");
    }

    #[test]
    fn apply_back_to_back_tool_calls_emit_empty_flushes() {
        let mut updates = AcpUpdates::default();
        let tool = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "abc"
                }
            }
        });

        assert_eq!(
            updates.apply(&tool),
            Some(AcpUpdate::ToolCallStarted {
                segment_to_flush: String::new(),
                tool_name: String::new(),
            })
        );
        assert_eq!(
            updates.apply(&tool),
            Some(AcpUpdate::ToolCallStarted {
                segment_to_flush: String::new(),
                tool_name: String::new(),
            })
        );
    }

    #[test]
    fn apply_tool_call_prefers_meta_tool_name_over_title() {
        let mut updates = AcpUpdates::default();
        let tool = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "_meta": {"claudeCode": {"toolName": "Read"}},
                    "sessionUpdate": "tool_call",
                    "toolCallId": "abc",
                    "title": "Read File",
                    "kind": "read",
                    "status": "pending"
                }
            }
        });
        assert_eq!(
            updates.apply(&tool),
            Some(AcpUpdate::ToolCallStarted {
                segment_to_flush: String::new(),
                tool_name: "Read".to_string(),
            })
        );
    }

    #[test]
    fn apply_tool_call_update_with_args_produces_tool_call_args() {
        let mut updates = AcpUpdates::default();
        // First, a tool_call to set up pending state.
        let tool_call = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "_meta": {"claudeCode": {"toolName": "Read"}},
                    "sessionUpdate": "tool_call",
                    "toolCallId": "abc",
                    "rawInput": {}
                }
            }
        });
        updates.apply(&tool_call);

        let update = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "_meta": {"claudeCode": {"toolName": "Read"}},
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "abc",
                    "rawInput": {"file_path": "/etc/hostname"}
                }
            }
        });
        assert_eq!(
            updates.apply(&update),
            Some(AcpUpdate::ToolCallArgs {
                tool_name: "Read".to_string(),
                args_json: r#"{"file_path":"/etc/hostname"}"#.to_string(),
            })
        );
        // Pending is consumed — second update produces nothing.
        assert_eq!(updates.apply(&update), None);
    }

    #[test]
    fn apply_tool_call_update_ignores_empty_raw_input() {
        let mut updates = AcpUpdates::default();
        let tool_call = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "_meta": {"claudeCode": {"toolName": "Bash"}},
                    "sessionUpdate": "tool_call",
                    "toolCallId": "xyz",
                    "rawInput": {}
                }
            }
        });
        updates.apply(&tool_call);

        let empty_update = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "xyz",
                    "rawInput": {}
                }
            }
        });
        assert_eq!(updates.apply(&empty_update), None);
        // Pending tool name should still be set.
        assert_eq!(updates.pending_tool_name, Some("Bash".to_string()));
    }

    #[test]
    fn apply_ignores_unknown_session_updates() {
        let mut updates = AcpUpdates::default();
        let ignored = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": {"type": "text", "text": "hidden"}
                }
            }
        });

        assert_eq!(updates.apply(&ignored), None);
        assert!(updates.visible_text.is_empty());
        assert!(updates.current_segment.is_empty());
    }
}
