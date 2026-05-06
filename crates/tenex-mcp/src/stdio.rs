use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;

use crate::config::ProjectMcpServerConfig;
use crate::manifest::{
    McpResourceContentEntry, McpResourceEntry, McpResourceReadResult, McpResourceTemplateEntry,
    ToolManifestEntry,
};
use crate::stdio_reader::{spawn_reader, PendingResponses};

const PROTOCOL_VERSION: &str = "2025-11-25";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

pub struct StdioMcpClient {
    server_name: String,
    child: Child,
    stdin: ChildStdin,
    next_id: u64,
    pending: PendingResponses,
    resource_updates: broadcast::Sender<String>,
    reader_task: JoinHandle<()>,
    stderr_lines: Arc<StdMutex<Vec<String>>>,
    stderr_task: JoinHandle<()>,
}

#[derive(Debug, Deserialize)]
struct ListToolsResult {
    tools: Vec<McpToolSpec>,
    #[serde(default, rename = "nextCursor")]
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListResourcesResult {
    #[serde(default)]
    resources: Vec<McpResourceSpec>,
    #[serde(default, rename = "nextCursor")]
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListResourceTemplatesResult {
    #[serde(default, rename = "resourceTemplates")]
    resource_templates: Vec<McpResourceTemplateSpec>,
    #[serde(default, rename = "nextCursor")]
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct McpResourceSpec {
    uri: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "mimeType")]
    mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct McpResourceTemplateSpec {
    #[serde(rename = "uriTemplate")]
    uri_template: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "mimeType")]
    mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReadResourceResult {
    #[serde(default)]
    contents: Vec<McpResourceContentSpec>,
}

#[derive(Debug, Deserialize)]
struct McpResourceContentSpec {
    #[serde(default)]
    uri: Option<String>,
    #[serde(default, rename = "mimeType")]
    mime_type: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    blob: Option<String>,
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
            .stderr(Stdio::piped());

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
        let stderr = child
            .stderr
            .take()
            .with_context(|| format!("MCP server '{server_name}' has no stderr"))?;

        let stderr_lines: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let stderr_lines_clone = stderr_lines.clone();
        let stderr_task = tokio::spawn(async move {
            let mut reader = AsyncBufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                eprintln!("{line}");
                stderr_lines_clone.lock().unwrap().push(line);
            }
        });

        let pending = Arc::new(StdMutex::new(HashMap::new()));
        let (resource_updates, _) = broadcast::channel(256);
        let reader_task = spawn_reader(
            server_name.clone(),
            stdout,
            pending.clone(),
            resource_updates.clone(),
        );

        let mut client = Self {
            server_name,
            child,
            stdin,
            next_id: 1,
            pending,
            resource_updates,
            reader_task,
            stderr_lines,
            stderr_task,
        };
        if let Err(init_err) = client.initialize().await {
            // Give the server process a moment to flush stderr, then collect it.
            let _ = tokio::time::timeout(
                Duration::from_millis(500),
                client.child.wait(),
            )
            .await;
            client.stderr_task.abort();
            let output = client.stderr_lines.lock().unwrap().join("\n");
            if output.is_empty() {
                return Err(init_err);
            }
            return Err(init_err.context(format!("server output:\n{output}")));
        }
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

    pub async fn list_resources(&mut self) -> Result<Vec<McpResourceEntry>> {
        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let params = cursor
                .as_ref()
                .map(|cursor| json!({ "cursor": cursor }))
                .unwrap_or_else(|| json!({}));
            let value = self.request("resources/list", params).await?;
            let result: ListResourcesResult = serde_json::from_value(value)
                .with_context(|| format!("decoding resources/list from '{}'", self.server_name))?;

            for resource in result.resources {
                entries.push(McpResourceEntry {
                    server: self.server_name.clone(),
                    name: resource.name.unwrap_or_else(|| resource.uri.clone()),
                    uri: resource.uri,
                    description: resource.description,
                    mime_type: resource.mime_type,
                });
            }

            cursor = result.next_cursor;
            if cursor.is_none() {
                break;
            }
        }

        Ok(entries)
    }

    pub async fn list_resource_templates(&mut self) -> Result<Vec<McpResourceTemplateEntry>> {
        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let params = cursor
                .as_ref()
                .map(|cursor| json!({ "cursor": cursor }))
                .unwrap_or_else(|| json!({}));
            let value = self.request("resources/templates/list", params).await?;
            let result: ListResourceTemplatesResult =
                serde_json::from_value(value).with_context(|| {
                    format!(
                        "decoding resources/templates/list from '{}'",
                        self.server_name
                    )
                })?;

            for template in result.resource_templates {
                entries.push(McpResourceTemplateEntry {
                    server: self.server_name.clone(),
                    name: template
                        .name
                        .unwrap_or_else(|| template.uri_template.clone()),
                    uri_template: template.uri_template,
                    description: template.description,
                    mime_type: template.mime_type,
                });
            }

            cursor = result.next_cursor;
            if cursor.is_none() {
                break;
            }
        }

        Ok(entries)
    }

    pub async fn read_resource(&mut self, uri: &str) -> Result<McpResourceReadResult> {
        let value = self
            .request("resources/read", json!({ "uri": uri }))
            .await?;
        let result: ReadResourceResult = serde_json::from_value(value)
            .with_context(|| format!("decoding resources/read from '{}'", self.server_name))?;
        Ok(McpResourceReadResult {
            contents: result
                .contents
                .into_iter()
                .map(|content| McpResourceContentEntry {
                    uri: content.uri,
                    mime_type: content.mime_type,
                    text: content.text,
                    blob: content.blob,
                })
                .collect(),
        })
    }

    pub async fn subscribe_resource(&mut self, uri: &str) -> Result<()> {
        self.request("resources/subscribe", json!({ "uri": uri }))
            .await?;
        Ok(())
    }

    pub async fn unsubscribe_resource(&mut self, uri: &str) -> Result<()> {
        self.request("resources/unsubscribe", json!({ "uri": uri }))
            .await?;
        Ok(())
    }

    pub fn resource_updates(&self) -> broadcast::Receiver<String> {
        self.resource_updates.subscribe()
    }

    pub async fn shutdown(&mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        self.reader_task.abort();
        self.stderr_task.abort();
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
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.write_frame(&frame).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }

        let response = tokio::time::timeout(REQUEST_TIMEOUT, rx)
            .await
            .with_context(|| {
                format!("MCP request '{method}' to '{}' timed out", self.server_name)
            })?;
        match response {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => bail!(message),
            Err(_) => bail!("MCP response reader for '{}' stopped", self.server_name),
        }
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
