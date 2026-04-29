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
}

#[derive(Default)]
pub(crate) struct AcpUpdates {
    pub(crate) visible_text: String,
}

impl AcpUpdates {
    fn apply(&mut self, message: &Value) -> Option<AcpUpdate> {
        let update = message
            .get("params")
            .and_then(|params| params.get("update"))?;
        let kind = update.get("sessionUpdate").and_then(Value::as_str)?;
        if kind != "agent_message_chunk" {
            return None;
        }
        let text = update
            .get("content")
            .and_then(|content| content.get("text"))
            .and_then(Value::as_str)?;
        self.visible_text.push_str(text);
        Some(AcpUpdate::AgentMessageChunk {
            text: text.to_string(),
        })
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
    }

    #[test]
    fn apply_ignores_non_visible_updates() {
        let mut updates = AcpUpdates::default();
        let ignored = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "tool_call",
                    "content": {"type": "text", "text": "hidden"}
                }
            }
        });

        assert_eq!(updates.apply(&ignored), None);
        assert!(updates.visible_text.is_empty());
    }
}
