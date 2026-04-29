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
    runtime: Arc<ProjectMcpRuntime>,
    shutdown: oneshot::Receiver<()>,
) -> Result<()> {
    bind_socket(config).await?.serve(runtime, shutdown).await
}

impl BoundSocketServer {
    pub async fn serve(
        self,
        runtime: Arc<ProjectMcpRuntime>,
        mut shutdown: oneshot::Receiver<()>,
    ) -> Result<()> {
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                accepted = self.listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => {
                            let runtime = runtime.clone();
                            let allowed_tools = self.allowed_tools.clone();
                            tokio::spawn(async move {
                                if let Err(error) = handle_client(stream, runtime, allowed_tools).await {
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
    runtime: Arc<ProjectMcpRuntime>,
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
                    match runtime
                        .call_tool(&request.tool_name, request.arguments)
                        .await
                    {
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
