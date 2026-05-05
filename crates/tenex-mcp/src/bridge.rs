use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;
use tracing::warn;

use crate::manifest::{McpToolCallRequest, McpToolCallResponse};
use crate::runtime::ProjectMcpRuntime;

pub struct SocketServerConfig {
    pub socket_path: PathBuf,
    pub allowed_tools: Vec<String>,
}

pub struct BoundSocketServer {
    socket_path: PathBuf,
    allowed_tools: Arc<HashSet<String>>,
    listener: UnixListener,
}

pub async fn bind_socket(config: SocketServerConfig) -> Result<BoundSocketServer> {
    if let Some(parent) = config.socket_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let _ = tokio::fs::remove_file(&config.socket_path).await;
    let listener = UnixListener::bind(&config.socket_path)
        .with_context(|| format!("binding MCP socket {}", config.socket_path.display()))?;
    Ok(BoundSocketServer {
        socket_path: config.socket_path,
        allowed_tools: Arc::new(config.allowed_tools.into_iter().collect()),
        listener,
    })
}

pub async fn serve_socket(
    config: SocketServerConfig,
    project_runtime: Arc<ProjectMcpRuntime>,
    agent_runtime: Option<Arc<ProjectMcpRuntime>>,
    shutdown: oneshot::Receiver<()>,
) -> Result<()> {
    bind_socket(config)
        .await?
        .serve(project_runtime, agent_runtime, shutdown)
        .await
}

impl BoundSocketServer {
    /// Serve MCP tool calls from a connected agent subprocess.
    ///
    /// `project_runtime` is the shared project-level pool; `agent_runtime` is
    /// an optional per-run pool for servers the agent carries with it.
    /// Dispatch is based on the server slug embedded in the namespaced tool
    /// name (`mcp__<server>__<tool>`): agent-owned servers take priority.
    pub async fn serve(
        self,
        project_runtime: Arc<ProjectMcpRuntime>,
        agent_runtime: Option<Arc<ProjectMcpRuntime>>,
        mut shutdown: oneshot::Receiver<()>,
    ) -> Result<()> {
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                accepted = self.listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => {
                            let project_runtime = project_runtime.clone();
                            let agent_runtime = agent_runtime.clone();
                            let allowed_tools = self.allowed_tools.clone();
                            tokio::spawn(async move {
                                if let Err(error) =
                                    handle_client(stream, project_runtime, agent_runtime, allowed_tools).await
                                {
                                    warn!(error = %error, "MCP socket client failed");
                                }
                            });
                        }
                        Err(error) => {
                            warn!(error = %error, "MCP socket accept failed");
                        }
                    }
                }
            }
        }

        let _ = tokio::fs::remove_file(&self.socket_path).await;
        Ok(())
    }
}

async fn handle_client(
    stream: UnixStream,
    project_runtime: Arc<ProjectMcpRuntime>,
    agent_runtime: Option<Arc<ProjectMcpRuntime>>,
    allowed_tools: Arc<HashSet<String>>,
) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    let response = match lines.next_line().await? {
        Some(line) => match serde_json::from_str::<McpToolCallRequest>(&line) {
            Ok(request) => {
                if !allowed_tools.contains(&request.tool_name) {
                    McpToolCallResponse::error(format!(
                        "MCP tool '{}' is not available to this agent run",
                        request.tool_name
                    ))
                } else {
                    let runtime = pick_runtime(&request.tool_name, &project_runtime, &agent_runtime);
                    match runtime.call_tool(&request.tool_name, request.arguments).await {
                        Ok(result) => McpToolCallResponse::ok(result),
                        Err(error) => McpToolCallResponse::error(error.to_string()),
                    }
                }
            }
            Err(error) => McpToolCallResponse::error(format!("invalid MCP call request: {error}")),
        },
        None => McpToolCallResponse::error("empty MCP call request"),
    };

    let mut bytes = serde_json::to_vec(&response)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

/// Route a tool call to the agent-owned runtime when the server slug belongs
/// to it; otherwise fall back to the shared project runtime.
fn pick_runtime<'a>(
    tool_name: &str,
    project: &'a Arc<ProjectMcpRuntime>,
    agent: &'a Option<Arc<ProjectMcpRuntime>>,
) -> &'a Arc<ProjectMcpRuntime> {
    if let Some(ar) = agent {
        // Parse the server slug from `mcp__<server>__<tool>`.
        if let Some(rest) = tool_name.strip_prefix("mcp__") {
            if let Some((server, _)) = rest.split_once("__") {
                if ar.has_server(server) {
                    return ar;
                }
            }
        }
    }
    project
}
