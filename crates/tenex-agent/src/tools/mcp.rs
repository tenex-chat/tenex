use std::path::PathBuf;

use rig::completion::ToolDefinition;
use rig::tool::{ToolDyn, ToolError};
use rig::wasm_compat::WasmBoxedFuture;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

#[derive(Clone)]
pub struct McpProxyTool {
    definition: tenex_mcp::ToolManifestEntry,
    socket_path: PathBuf,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct McpProxyError(String);

impl McpProxyTool {
    pub fn new(definition: tenex_mcp::ToolManifestEntry, socket_path: PathBuf) -> Self {
        Self {
            definition,
            socket_path,
        }
    }
}

impl ToolDyn for McpProxyTool {
    fn name(&self) -> String {
        self.definition.name.clone()
    }

    fn definition<'a>(&'a self, _prompt: String) -> WasmBoxedFuture<'a, ToolDefinition> {
        Box::pin(async move {
            ToolDefinition {
                name: self.definition.name.clone(),
                description: self.definition.description.clone(),
                parameters: self.definition.input_schema.clone(),
            }
        })
    }

    fn call<'a>(&'a self, args: String) -> WasmBoxedFuture<'a, Result<String, ToolError>> {
        Box::pin(async move {
            let arguments = serde_json::from_str(&args).map_err(ToolError::JsonError)?;
            let request = tenex_mcp::McpToolCallRequest {
                tool_name: self.definition.name.clone(),
                arguments,
            };
            let mut stream = UnixStream::connect(&self.socket_path)
                .await
                .map_err(|e| tool_error(format!("connect MCP bridge: {e}")))?;
            let mut bytes = serde_json::to_vec(&request).map_err(|e| tool_error(format!("{e}")))?;
            bytes.push(b'\n');
            stream
                .write_all(&bytes)
                .await
                .map_err(|e| tool_error(format!("write MCP request: {e}")))?;
            stream
                .flush()
                .await
                .map_err(|e| tool_error(format!("flush MCP request: {e}")))?;

            let mut lines = BufReader::new(stream).lines();
            let line = lines
                .next_line()
                .await
                .map_err(|e| tool_error(format!("read MCP response: {e}")))?
                .ok_or_else(|| tool_error("MCP bridge closed without a response"))?;
            let response: tenex_mcp::McpToolCallResponse =
                serde_json::from_str(&line).map_err(|e| tool_error(format!("{e}")))?;
            if let Some(error) = response.error {
                // Return Ok so the LLM receives the verbatim error text without
                // rig's "ToolCallError: " prefix wrapping, and so on_tool_result
                // fires and can emit an observable Nostr event for the failure.
                return Ok(format!("Error: {error}"));
            }
            Ok(response.result.unwrap_or_default())
        })
    }
}

fn tool_error(message: impl Into<String>) -> ToolError {
    ToolError::ToolCallError(Box::new(McpProxyError(message.into())))
}
