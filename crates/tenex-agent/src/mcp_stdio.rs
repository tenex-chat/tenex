//! Shared MCP JSON-RPC stdio server. Drives the line-delimited JSON-RPC 2.0
//! protocol expected by ACP-compatible runtimes (Claude Code, Codex) and
//! dispatches `tools/list` / `tools/call` against a pre-built tool set.
//!
//! Used by both the standalone `tenex mcp agent` command and the in-process
//! ACP MCP server; callers supply their own server name and crate version
//! since `env!("CARGO_PKG_VERSION")` resolves at the call site.

use anyhow::Result;
use rig_core::completion::ToolDefinition;
use rig_core::tool::ToolDyn;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub const MCP_PROTOCOL_VERSION: &str = "2025-11-25";

#[derive(Clone, Copy)]
pub struct ServerInfo {
    pub name: &'static str,
    pub version: &'static str,
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Value,
}

pub async fn serve_stdio(info: ServerInfo, tools: Vec<Box<dyn ToolDyn>>) -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<JsonRpcRequest>(&line) {
            Ok(request) => handle_request(info, request, &tools).await,
            Err(error) => Some(json_rpc_error(
                Value::Null,
                -32700,
                format!("parse error: {error}"),
            )),
        };
        if let Some(response) = response {
            let mut bytes = serde_json::to_vec(&response)?;
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
    }
    Ok(())
}

async fn handle_request(
    info: ServerInfo,
    request: JsonRpcRequest,
    tools: &[Box<dyn ToolDyn>],
) -> Option<Value> {
    let id = request.id.clone().unwrap_or(Value::Null);
    let Some(method) = request.method.as_deref() else {
        return Some(json_rpc_error(id, -32600, "missing method"));
    };

    match method {
        "notifications/initialized" => None,
        "initialize" => Some(json_rpc_result(
            id,
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": info.name,
                    "version": info.version
                }
            }),
        )),
        "ping" => Some(json_rpc_result(id, json!({}))),
        "tools/list" => Some(json_rpc_result(id, list_tools(tools).await)),
        "tools/call" => Some(json_rpc_result(id, call_tool(request.params, tools).await)),
        _ => Some(json_rpc_error(
            id,
            -32601,
            format!("unknown method {method}"),
        )),
    }
}

async fn list_tools(tools: &[Box<dyn ToolDyn>]) -> Value {
    let mut out = Vec::new();
    for tool in tools {
        let definition = tool.definition(String::new()).await;
        out.push(tool_definition_to_mcp(definition));
    }
    json!({ "tools": out })
}

fn tool_definition_to_mcp(definition: ToolDefinition) -> Value {
    json!({
        "name": definition.name,
        "description": definition.description,
        "inputSchema": definition.parameters,
    })
}

async fn call_tool(params: Value, tools: &[Box<dyn ToolDyn>]) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if name.is_empty() {
        return tool_result("missing tool name", true);
    }

    let Some(tool) = tools.iter().find(|tool| tool.name() == name) else {
        return tool_result(format!("unknown TENEX tool '{name}'"), true);
    };

    match tool.call(arguments.to_string()).await {
        Ok(output) => tool_result(output, false),
        Err(error) => tool_result(error.to_string(), true),
    }
}

fn tool_result(text: impl Into<String>, is_error: bool) -> Value {
    json!({
        "content": [{"type": "text", "text": text.into()}],
        "isError": is_error,
    })
}

fn json_rpc_result(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

fn json_rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message.into()},
    })
}
