use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::future::Future;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

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
    fn apply(&mut self, message: &Value) -> Option<AcpUpdate> {
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

pub(crate) struct AcpProcess {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    permission_policy: AcpPermissionPolicy,
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
        Ok(Self {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout).lines(),
            next_id: 1,
            permission_policy: config.permission_policy,
        })
    }

    pub(crate) async fn request(
        &mut self,
        method: &str,
        params: Value,
        updates: &mut AcpUpdates,
    ) -> Result<Value> {
        self.request_with_update_handler(method, params, updates, |_| async {})
            .await
    }

    pub(crate) async fn request_with_update_handler<H, Fut>(
        &mut self,
        method: &str,
        params: Value,
        updates: &mut AcpUpdates,
        mut on_update: H,
    ) -> Result<Value>
    where
        H: FnMut(AcpUpdate) -> Fut,
        Fut: Future<Output = ()>,
    {
        let id = self.next_id;
        self.next_id += 1;
        self.write_json(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;

        loop {
            let message = self.read_json().await?;
            if message.get("method").is_some() && message.get("id").is_some() {
                self.handle_client_request(&message).await?;
                continue;
            }
            if message.get("method").and_then(Value::as_str) == Some("session/update") {
                if let Some(update) = updates.apply(&message) {
                    on_update(update).await;
                }
                continue;
            }
            if message.get("id") == Some(&json!(id)) {
                if let Some(error) = message.get("error") {
                    return Err(anyhow!("ACP request {method} failed: {error}"));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    async fn handle_client_request(&mut self, request: &Value) -> Result<()> {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        match request.get("method").and_then(Value::as_str) {
            Some("session/request_permission") => {
                let option = choose_permission_option(request, self.permission_policy);
                self.write_json(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {"outcome": option}
                }))
                .await
            }
            Some(method) => {
                self.write_json(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {"code": -32601, "message": format!("TENEX ACP client does not implement {method}")}
                }))
                .await
            }
            None => Ok(()),
        }
    }

    async fn write_json(&mut self, value: &Value) -> Result<()> {
        let mut line = serde_json::to_vec(value)?;
        line.push(b'\n');
        self.stdin.write_all(&line).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn read_json(&mut self) -> Result<Value> {
        let line = self
            .stdout
            .next_line()
            .await?
            .context("ACP backend closed stdout")?;
        serde_json::from_str(&line).with_context(|| format!("invalid ACP JSON-RPC line: {line}"))
    }

    pub(crate) async fn shutdown(&mut self) {
        if let Ok(Some(_)) = self.child.try_wait() {
            return;
        }
        let _ = self.child.kill().await;
    }
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
