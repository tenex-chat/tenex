use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rig::completion::ToolDefinition;
use rig::tool::{ToolDyn, ToolError};
use rig::wasm_compat::WasmBoxedFuture;
use serde::Deserialize;
use serde_json::{json, Value};
use tenex_protocol::{nostr::NostrChannel, sink::EventSink, Channel, Intent, ToolUseIntent};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::acp_config::AcpAgentConfig;
use crate::acp_mcp::{agent_allows_delegation, AcpMcpContext, MCP_PROTOCOL_VERSION, SERVER_NAME};
use crate::emit::{EmitState, EmitStateArgs};
use crate::tools::delegate::DelegateTool;
use crate::tools::delegate_crossproject::DelegateCrossProjectTool;
use crate::tools::delegate_followup::DelegateFollowupTool;
use crate::tools::self_delegate::SelfDelegateTool;

#[derive(Clone)]
struct SocketEventSink {
    socket_path: PathBuf,
}

#[async_trait::async_trait]
impl EventSink for SocketEventSink {
    async fn deliver(&self, event: nostr::Event) -> Result<()> {
        use nostr::JsonUtil;
        let mut stream = UnixStream::connect(&self.socket_path)
            .await
            .with_context(|| {
                format!(
                    "connecting ACP MCP event socket {}",
                    self.socket_path.display()
                )
            })?;
        stream.write_all(event.as_json().as_bytes()).await?;
        stream.write_all(b"\n").await?;
        stream.flush().await?;
        Ok(())
    }
}

pub(super) async fn run_stdio_server(context_path: &str) -> Result<()> {
    let context = read_context(context_path)?;
    let tools = build_tools(&context)?;
    serve_stdio(tools).await
}

fn read_context(path: &str) -> Result<AcpMcpContext> {
    let bytes = std::fs::read(path).with_context(|| format!("reading ACP MCP context {path}"))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parsing ACP MCP context {path}"))
}

fn build_tools(context: &AcpMcpContext) -> Result<Vec<Box<dyn ToolDyn>>> {
    let agent_config = AcpAgentConfig::load(&context.agent_config_path)?;
    if !agent_allows_delegation(&agent_config) {
        return Ok(Vec::new());
    }

    let channel: Arc<dyn Channel> = Arc::new(
        NostrChannel::from_nsec(
            &agent_config.nsec,
            SocketEventSink {
                socket_path: context.event_socket_path.clone(),
            },
        )
        .context("initializing ACP MCP Nostr channel")?,
    );
    let state = Arc::new(EmitState::new(EmitStateArgs {
        channel,
        project: context.project.clone(),
        triggering_principal: context.triggering_principal.clone(),
        triggering_message: context.triggering_message.clone(),
        conversation_root: context.conversation_root.clone(),
        completion_recipient: context.completion_recipient.clone(),
        model: context.model.clone(),
        team: context.team.clone(),
        current_branch: None,
    }));

    let project = tenex_project::Project::open(&context.project_id, &context.base_dir)
        .with_context(|| format!("opening project '{}'", context.project_id))?;
    let project_agents = Arc::new(project.agents().context("reading project agents")?);
    let teams = Arc::new(tenex_project::load_teams(
        &context.base_dir,
        Some(&context.project_id),
    ));
    let conv_db_path = {
        let d_tag = tenex_conversations::normalize_project_id(&context.project_id)
            .map_err(|err| anyhow::anyhow!("{err}"))?;
        tenex_conversations::paths::conversation_db_path(&context.base_dir, &d_tag)
    };

    Ok(vec![
        expose_tool(
            Box::new(DelegateTool::new(
                state.clone(),
                project_agents.clone(),
                teams.clone(),
            )),
            state.clone(),
            true,
        ),
        expose_tool(
            Box::new(SelfDelegateTool::new(state.clone())),
            state.clone(),
            false,
        ),
        expose_tool(
            Box::new(DelegateCrossProjectTool::new(state.clone())),
            state.clone(),
            false,
        ),
        expose_tool(
            Box::new(DelegateFollowupTool::new(
                state.clone(),
                project_agents,
                teams,
                conv_db_path,
            )),
            state,
            true,
        ),
    ])
}

fn expose_tool(
    inner: Box<dyn ToolDyn>,
    state: Arc<EmitState>,
    emits_own_tool_use: bool,
) -> Box<dyn ToolDyn> {
    Box::new(AcpMcpTool {
        inner,
        state,
        emits_own_tool_use,
    })
}

struct AcpMcpTool {
    inner: Box<dyn ToolDyn>,
    state: Arc<EmitState>,
    emits_own_tool_use: bool,
}

impl ToolDyn for AcpMcpTool {
    fn name(&self) -> String {
        self.inner.name()
    }

    fn definition<'a>(&'a self, prompt: String) -> WasmBoxedFuture<'a, ToolDefinition> {
        self.inner.definition(prompt)
    }

    fn call<'a>(&'a self, args: String) -> WasmBoxedFuture<'a, Result<String, ToolError>> {
        Box::pin(async move {
            let name = self.inner.name();
            let result = self.inner.call(args.clone()).await;
            if result.is_ok() && !self.emits_own_tool_use {
                emit_tool_use(self.state.clone(), name, args).await;
            }
            result
        })
    }
}

async fn emit_tool_use(state: Arc<EmitState>, tool_name: String, args_json: String) {
    let ral = state.meta.lock().ral;
    let ctx = state.build_ctx(ral);
    let intent = ToolUseIntent {
        tool_name,
        content: String::new(),
        args_json: Some(args_json),
        referenced_messages: Vec::new(),
        usage: None,
    };
    if let Err(error) = state.channel.send(Intent::ToolUse(intent), &ctx).await {
        eprintln!("[tenex-agent-acp-mcp] warn: failed to emit tool-use event: {error}");
    }
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

async fn serve_stdio(tools: Vec<Box<dyn ToolDyn>>) -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<JsonRpcRequest>(&line) {
            Ok(request) => handle_request(request, &tools).await,
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

async fn handle_request(request: JsonRpcRequest, tools: &[Box<dyn ToolDyn>]) -> Option<Value> {
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
                    "name": SERVER_NAME,
                    "version": env!("CARGO_PKG_VERSION")
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
