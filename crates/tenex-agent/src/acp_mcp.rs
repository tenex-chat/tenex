use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tenex_protocol::{sink::EventSink, ConversationRef, MessageRef, PrincipalRef, ProjectRef};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;

use tenex_supervision::types::AgentCategory;

use crate::acp_config::AcpAgentConfig;

const SERVER_NAME: &str = "tenex";
const MCP_PROTOCOL_VERSION: &str = "2025-11-25";

#[path = "acp_mcp_server.rs"]
mod server;

#[derive(Clone)]
pub(crate) struct SharedStdoutEventSink {
    out: Arc<Mutex<tokio::io::Stdout>>,
}

impl SharedStdoutEventSink {
    pub(crate) fn new() -> Self {
        Self {
            out: Arc::new(Mutex::new(tokio::io::stdout())),
        }
    }

    async fn write_event_line(&self, line: &str) -> Result<()> {
        let mut out = self.out.lock().await;
        out.write_all(line.as_bytes()).await?;
        if !line.ends_with('\n') {
            out.write_all(b"\n").await?;
        }
        out.flush().await?;
        Ok(())
    }
}

#[async_trait::async_trait]
impl EventSink for SharedStdoutEventSink {
    async fn deliver(&self, event: nostr::Event) -> Result<()> {
        use nostr::JsonUtil;
        self.write_event_line(&event.as_json()).await
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AcpMcpContext {
    base_dir: PathBuf,
    agent_config_path: String,
    project_id: String,
    project: ProjectRef,
    conversation_root: Option<ConversationRef>,
    triggering_message: Option<MessageRef>,
    completion_recipient: Option<PrincipalRef>,
    triggering_principal: PrincipalRef,
    model: String,
    team: Option<String>,
    event_socket_path: PathBuf,
    /// Git project root (the main worktree, parent of `.worktrees/`). Used by
    /// the delegate tool to drive cross-host branch coordination.
    project_root: PathBuf,
}

pub(crate) struct AcpMcpBridge {
    base_dir: PathBuf,
    context_path: PathBuf,
    socket_path: PathBuf,
    forwarder: tokio::task::JoinHandle<()>,
}

pub(crate) struct AcpMcpBridgeInput {
    pub(crate) base_dir: PathBuf,
    pub(crate) agent_config_path: String,
    pub(crate) project_id: String,
    pub(crate) expose_delegation_tools: bool,
    pub(crate) project: ProjectRef,
    pub(crate) conversation_root: Option<ConversationRef>,
    pub(crate) triggering_message: Option<MessageRef>,
    pub(crate) completion_recipient: Option<PrincipalRef>,
    pub(crate) triggering_principal: PrincipalRef,
    pub(crate) model: String,
    pub(crate) team: Option<String>,
    pub(crate) stdout_sink: SharedStdoutEventSink,
    pub(crate) pending_external_work: Arc<AtomicBool>,
    pub(crate) project_root: PathBuf,
}

impl AcpMcpBridge {
    pub(crate) async fn start(input: AcpMcpBridgeInput) -> Result<Option<Self>> {
        if !input.expose_delegation_tools {
            return Ok(None);
        }

        let run_id = std::env::var("TENEX_EXECUTION_ID")
            .ok()
            .map(|id| {
                id.chars()
                    .filter(|ch| *ch != '-')
                    .take(16)
                    .collect::<String>()
            })
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string().replace('-', ""));
        let run_dir = input.base_dir.join("runtime").join("acp-mcp");
        tokio::fs::create_dir_all(&run_dir).await?;
        let context_path = run_dir.join(format!("{run_id}.context.json"));
        let socket_path = run_dir.join(format!("{run_id}.events.sock"));

        let context = AcpMcpContext {
            base_dir: input.base_dir.clone(),
            agent_config_path: input.agent_config_path,
            project_id: input.project_id,
            project: input.project,
            conversation_root: input.conversation_root,
            triggering_message: input.triggering_message,
            completion_recipient: input.completion_recipient,
            triggering_principal: input.triggering_principal,
            model: input.model,
            team: input.team,
            event_socket_path: socket_path.clone(),
            project_root: input.project_root,
        };

        write_private_json(&context_path, &context)?;
        let forwarder = start_event_forwarder(
            socket_path.clone(),
            input.stdout_sink,
            input.pending_external_work,
        )
        .await?;

        Ok(Some(Self {
            base_dir: input.base_dir,
            context_path,
            socket_path,
            forwarder,
        }))
    }

    pub(crate) fn session_server_config(&self) -> Result<Value> {
        let command = std::env::current_exe().context("resolving tenex-agent-acp executable")?;
        Ok(json!({
            "name": SERVER_NAME,
            "type": "stdio",
            "command": command.display().to_string(),
            "args": ["--mcp", self.context_path.display().to_string()],
            "env": [
                {"name": "TENEX_BASE_DIR", "value": self.base_dir.display().to_string()},
                {"name": "TENEX_ACP_MCP_CONTEXT", "value": self.context_path.display().to_string()}
            ]
        }))
    }

    pub(crate) async fn shutdown(self) {
        self.forwarder.abort();
        let _ = tokio::fs::remove_file(self.context_path).await;
        let _ = tokio::fs::remove_file(self.socket_path).await;
    }
}

pub(crate) fn session_new_params(
    working_dir: &str,
    bridge: Option<&AcpMcpBridge>,
    agent_category: Option<AgentCategory>,
) -> Result<Value> {
    let mcp_servers = match bridge {
        Some(bridge) => vec![bridge.session_server_config()?],
        None => Vec::new(),
    };
    let disallowed_tools = claude_code_disallowed_tools(agent_category);
    if mcp_servers.is_empty() && disallowed_tools.is_empty() {
        return Ok(json!({
            "cwd": working_dir,
            "mcpServers": []
        }));
    }

    Ok(json!({
        "cwd": working_dir,
        "mcpServers": mcp_servers,
        "_meta": {
            "claudeCode": {
                "options": {
                    "disallowedTools": disallowed_tools
                }
            }
        }
    }))
}

/// Compute the Claude Code `disallowedTools` list for an ACP session.
/// Workspace-restricted categories (orchestrator, principal) must not be
/// able to read or mutate the project workspace via the ACP backend's
/// native filesystem/shell tools — the same restriction the non-ACP
/// `ToolSet` enforces in `agent_tool_set.rs`.
fn claude_code_disallowed_tools(agent_category: Option<AgentCategory>) -> Vec<&'static str> {
    let mut disallowed = vec!["Task"];
    if matches!(
        agent_category,
        Some(AgentCategory::Orchestrator) | Some(AgentCategory::Principal)
    ) {
        disallowed.extend([
            "Bash",
            "Read",
            "Edit",
            "Write",
            "Glob",
            "Grep",
            "LS",
            "MultiEdit",
            "NotebookEdit",
            "NotebookRead",
            "WebFetch",
        ]);
    }
    disallowed
}

fn agent_allows_delegation(agent_config: &AcpAgentConfig) -> bool {
    agent_config
        .resolved_category()
        .map(|category| category.allows_delegation())
        .unwrap_or(true)
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    #[cfg(unix)]
    {
        use std::fs::OpenOptions;
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("writing {}", path.display()))?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        Ok(())
    }

    #[cfg(not(unix))]
    {
        std::fs::write(path, [bytes, b"\n".to_vec()].concat())
            .with_context(|| format!("writing {}", path.display()))?;
        Ok(())
    }
}

async fn start_event_forwarder(
    socket_path: PathBuf,
    stdout_sink: SharedStdoutEventSink,
    pending_external_work: Arc<AtomicBool>,
) -> Result<tokio::task::JoinHandle<()>> {
    if let Some(parent) = socket_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let _ = tokio::fs::remove_file(&socket_path).await;
    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("binding ACP MCP event socket {}", socket_path.display()))?;

    Ok(tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let sink = stdout_sink.clone();
                    let pending = pending_external_work.clone();
                    tokio::spawn(async move {
                        if let Err(error) = forward_event_socket_client(stream, sink, pending).await
                        {
                            eprintln!(
                                "[tenex-agent-acp] warn: ACP MCP event forward failed: {error}"
                            );
                        }
                    });
                }
                Err(error) => {
                    eprintln!(
                        "[tenex-agent-acp] warn: ACP MCP event socket accept failed: {error}"
                    );
                    break;
                }
            }
        }
    }))
}

async fn forward_event_socket_client(
    stream: UnixStream,
    stdout_sink: SharedStdoutEventSink,
    pending_external_work: Arc<AtomicBool>,
) -> Result<()> {
    use nostr::JsonUtil;

    let mut lines = BufReader::new(stream).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let event = nostr::Event::from_json(&line)
            .with_context(|| "ACP MCP event socket received invalid Nostr event")?;
        if is_pending_external_work_event(&event) {
            pending_external_work.store(true, Ordering::Release);
        }
        stdout_sink.write_event_line(&event.as_json()).await?;
    }
    Ok(())
}

fn is_pending_external_work_event(event: &nostr::Event) -> bool {
    event.kind == nostr::Kind::TextNote
        && (has_tag(event, "delegation") || has_tag_value_prefix(event, "tool", "delegate"))
}

fn has_tag(event: &nostr::Event, name: &str) -> bool {
    event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().is_some_and(|head| head == name))
}

fn has_tag_value_prefix(event: &nostr::Event, name: &str, prefix: &str) -> bool {
    event.tags.iter().any(|tag| {
        let parts = tag.as_slice();
        parts.first().is_some_and(|head| head == name)
            && parts.get(1).is_some_and(|value| value.starts_with(prefix))
    })
}

pub(crate) async fn run_stdio_server(context_path: &str) -> Result<()> {
    server::run_stdio_server(context_path).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn event(tags: Vec<Tag>) -> nostr::Event {
        EventBuilder::new(Kind::TextNote, "content")
            .tags(tags)
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    #[test]
    fn detects_delegation_events_as_pending_external_work() {
        let ev = event(vec![Tag::parse(["delegation", "root"]).unwrap()]);

        assert!(is_pending_external_work_event(&ev));
    }

    #[test]
    fn detects_delegate_tool_use_as_pending_external_work() {
        let ev = event(vec![Tag::parse(["tool", "delegate"]).unwrap()]);

        assert!(is_pending_external_work_event(&ev));
    }

    #[test]
    fn ignores_non_delegation_tool_use() {
        let ev = event(vec![Tag::parse(["tool", "todo_write"]).unwrap()]);

        assert!(!is_pending_external_work_event(&ev));
    }

    fn disallowed_tools_for(
        category: Option<AgentCategory>,
    ) -> Vec<String> {
        let params = session_new_params("/tmp", None, category).unwrap();
        params
            .pointer("/_meta/claudeCode/options/disallowedTools")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn orchestrator_session_disallows_workspace_tools() {
        let disallowed = disallowed_tools_for(Some(AgentCategory::Orchestrator));
        for tool in [
            "Task",
            "Bash",
            "Read",
            "Edit",
            "Write",
            "Glob",
            "Grep",
            "LS",
            "MultiEdit",
            "NotebookEdit",
            "NotebookRead",
            "WebFetch",
        ] {
            assert!(
                disallowed.iter().any(|t| t == tool),
                "{tool} must be disallowed for orchestrator, got: {disallowed:?}"
            );
        }
    }

    #[test]
    fn principal_session_disallows_workspace_tools() {
        let disallowed = disallowed_tools_for(Some(AgentCategory::Principal));
        for tool in [
            "Task",
            "Bash",
            "Read",
            "Edit",
            "Write",
            "Glob",
            "Grep",
            "LS",
            "MultiEdit",
            "NotebookEdit",
            "NotebookRead",
            "WebFetch",
        ] {
            assert!(
                disallowed.iter().any(|t| t == tool),
                "{tool} must be disallowed for principal, got: {disallowed:?}"
            );
        }
    }

    #[test]
    fn worker_session_keeps_workspace_tools() {
        // Worker still loses Task (the Claude Code subagent tool), since
        // delegation is owned by the tenex MCP bridge. But filesystem and
        // shell tools must remain available.
        let disallowed = disallowed_tools_for(Some(AgentCategory::Worker));
        assert!(disallowed.iter().any(|t| t == "Task"));
        for tool in [
            "Bash",
            "Read",
            "Edit",
            "Write",
            "Glob",
            "Grep",
            "LS",
            "MultiEdit",
            "NotebookRead",
        ] {
            assert!(
                !disallowed.iter().any(|t| t == tool),
                "{tool} must NOT be disallowed for worker, got: {disallowed:?}"
            );
        }
    }
}
