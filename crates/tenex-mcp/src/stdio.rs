use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::config::ProjectMcpServerConfig;
use crate::manifest::ToolManifestEntry;

const PROTOCOL_VERSION: &str = "2025-11-25";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

pub struct StdioMcpClient {
    server_name: String,
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    id: Option<Value>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ListToolsResult {
    tools: Vec<McpToolSpec>,
    #[serde(default, rename = "nextCursor")]
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct McpToolSpec {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "inputSchema")]
    input_schema: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct CallToolResult {
    #[serde(default)]
    content: Vec<McpContent>,
    #[serde(default, rename = "isError")]
    is_error: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum McpContent {
    Text {
        text: String,
    },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    Audio {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    Resource {
        resource: Value,
    },
    #[serde(other)]
    Unknown,
}

impl StdioMcpClient {
    pub async fn start(
        server_name: String,
        config: ProjectMcpServerConfig,
        project_dir: &std::path::Path,
    ) -> Result<Self> {
        let mut command = Command::new(&config.command);
        command
            .args(&config.args)
            .current_dir(project_dir)
            .envs(inherited_env(&config.env))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        let mut child = command
            .spawn()
            .with_context(|| format!("starting MCP server '{server_name}'"))?;
        let stdin = child
            .stdin
            .take()
            .with_context(|| format!("MCP server '{server_name}' has no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .with_context(|| format!("MCP server '{server_name}' has no stdout"))?;

        let mut client = Self {
            server_name,
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
            next_id: 1,
        };
        client.initialize().await?;
        Ok(client)
    }

    pub async fn list_tools(&mut self) -> Result<Vec<ToolManifestEntry>> {
        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let params = cursor
                .as_ref()
                .map(|cursor| json!({ "cursor": cursor }))
                .unwrap_or_else(|| json!({}));
            let value = self.request("tools/list", params).await?;
            let result: ListToolsResult = serde_json::from_value(value)
                .with_context(|| format!("decoding tools/list from '{}'", self.server_name))?;

            for tool in result.tools {
                entries.push(ToolManifestEntry {
                    name: format!("mcp__{}__{}", self.server_name, tool.name),
                    server: self.server_name.clone(),
                    tool: tool.name,
                    description: tool.description.unwrap_or_default(),
                    input_schema: tool.input_schema.unwrap_or_else(default_schema),
                });
            }

            cursor = result.next_cursor;
            if cursor.is_none() {
                break;
            }
        }

        Ok(entries)
    }

    pub async fn call_tool(&mut self, tool_name: &str, arguments: Value) -> Result<String> {
        let value = self
            .request(
                "tools/call",
                json!({
                    "name": tool_name,
                    "arguments": arguments,
                }),
            )
            .await?;
        let result: CallToolResult = serde_json::from_value(value)
            .with_context(|| format!("decoding tools/call from '{}'", self.server_name))?;
        let output = format_call_tool_result(&result);
        if result.is_error == Some(true) {
            bail!(output);
        }
        Ok(output)
    }

    pub async fn shutdown(&mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }

    async fn initialize(&mut self) -> Result<()> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": "tenex-runtime",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )
        .await?;
        self.notify("notifications/initialized", json!({})).await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.write_frame(&frame).await?;
        tokio::time::timeout(REQUEST_TIMEOUT, self.read_response(id))
            .await
            .with_context(|| {
                format!("MCP request '{method}' to '{}' timed out", self.server_name)
            })?
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        let frame = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_frame(&frame).await
    }

    async fn write_frame(&mut self, frame: &Value) -> Result<()> {
        let mut encoded = serde_json::to_vec(frame)?;
        encoded.push(b'\n');
        self.stdin.write_all(&encoded).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn read_response(&mut self, wanted_id: u64) -> Result<Value> {
        loop {
            let Some(line) = self.stdout.next_line().await? else {
                bail!("MCP server '{}' closed stdout", self.server_name);
            };
            if line.trim().is_empty() {
                continue;
            }
            let response: JsonRpcResponse = serde_json::from_str(&line)
                .with_context(|| format!("parsing JSON-RPC from '{}'", self.server_name))?;
            if response.id.as_ref().and_then(Value::as_u64) != Some(wanted_id) {
                continue;
            }
            if let Some(error) = response.error {
                bail!(
                    "MCP server '{}' returned error {}: {}",
                    self.server_name,
                    error.code,
                    error.message
                );
            }
            return response.result.with_context(|| {
                format!("MCP server '{}' response had no result", self.server_name)
            });
        }
    }
}

fn inherited_env(overrides: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    env.extend(overrides.clone());
    env
}

fn default_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
    })
}

fn format_call_tool_result(result: &CallToolResult) -> String {
    let mut chunks = Vec::new();
    for content in &result.content {
        match content {
            McpContent::Text { text } => chunks.push(text.clone()),
            McpContent::Image { data, mime_type } => {
                chunks.push(format!("data:{mime_type};base64,{data}"));
            }
            McpContent::Audio { .. } => chunks.push("[MCP audio content omitted]".to_string()),
            McpContent::Resource { resource } => chunks.push(resource.to_string()),
            McpContent::Unknown => chunks.push("[Unsupported MCP content]".to_string()),
        }
    }
    chunks.join("\n")
}
