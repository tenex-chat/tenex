use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rig::completion::ToolDefinition;
use rig::tool::{ToolDyn, ToolError};
use rig::wasm_compat::WasmBoxedFuture;
use tenex_protocol::{nostr::NostrChannel, sink::EventSink, Channel, Intent, ToolUseIntent};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdout};
use tokio::net::UnixStream;
use tokio::sync::Mutex as AsyncMutex;

use crate::acp_config::AcpAgentConfig;
use crate::acp_mcp::{AcpMcpContext, MCP_PROTOCOL_VERSION, SERVER_NAME};
use crate::config::ResolvedModel;
use crate::emit::{EmitState, EmitStateArgs};
use crate::skills::{self, SkillLookupCtx};
use crate::tools::agents_write::AgentsWriteTool;
use crate::tools::ask::AskTool;
use crate::tools::conversation_get::ConversationGetTool;
use crate::tools::conversation_list::ConversationListTool;
use crate::tools::conversation_search::ConversationSearchTool;
use crate::tools::create_workflow::CreateWorkflowTool;
use crate::tools::delegate::DelegateTool;
use crate::tools::delegate_crossproject::DelegateCrossProjectTool;
use crate::tools::delegate_followup::DelegateFollowupTool;
use crate::tools::mcp_resources::{
    McpListResourcesTool, McpResourceReadTool, McpSubscribeTool, McpSubscriptionStopTool,
};
use crate::tools::project_list::ProjectListTool;
use crate::tools::rag_add_documents::RagAddDocumentsTool;
use crate::tools::rag_search::RagSearchTool;
use crate::tools::run_workflow::RunWorkflowTool;
use crate::tools::self_delegate::SelfDelegateTool;
use crate::tools::sign_as_user::SignAsUserTool;
use crate::tools::skill_list::SkillListTool;
use crate::tools::skills_set::SkillsSetTool;
use crate::tools::todo::TodoItem;

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
    let stdout = Arc::new(AsyncMutex::new(tokio::io::stdout()));
    let server = build_server(&context, stdout.clone()).await?;
    serve_stdio(server, stdout).await
}

fn open_rag_store(base_dir: &std::path::Path) -> Option<Arc<tenex_rag::RagStore>> {
    let cfg = tenex_rag::EmbedConfig::load_from_base_dir(base_dir)?;
    let db_path = base_dir.join("embeddings.db");
    match tenex_rag::RagStore::open(&db_path, &cfg) {
        Ok(store) => Some(Arc::new(store)),
        Err(e) => {
            eprintln!("[tenex-agent-acp-mcp] RAG store unavailable: {e}");
            None
        }
    }
}

fn read_context(path: &str) -> Result<AcpMcpContext> {
    let bytes = std::fs::read(path).with_context(|| format!("reading ACP MCP context {path}"))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parsing ACP MCP context {path}"))
}

/// Tools that any ACP agent can invoke regardless of active skills.
/// Skill-gated tools (`grant_name -> tool`) are advertised only when an active
/// skill's frontmatter `tools:` list contains the grant name.
struct McpServer {
    always_on: Vec<Box<dyn ToolDyn>>,
    skill_gated: HashMap<String, Box<dyn ToolDyn>>,
    skill_ctx: Arc<SkillLookupCtx>,
    active_skills: Arc<Mutex<Vec<String>>>,
    stdout: Arc<AsyncMutex<Stdout>>,
}

async fn build_server(
    context: &AcpMcpContext,
    stdout: Arc<AsyncMutex<Stdout>>,
) -> Result<McpServer> {
    let agent_config = AcpAgentConfig::load(&context.agent_config_path)?;

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
        completion_project_a_tags: Vec::new(),
    }));

    let project = tenex_project::Project::open(&context.project_id, &context.base_dir)
        .with_context(|| format!("opening project '{}'", context.project_id))?;
    let project_agents = Arc::new(project.agents().context("reading project agents")?);
    let teams = Arc::new(tenex_project::load_teams(
        &context.base_dir,
        Some(&context.project_id),
    ));
    let project_d_tag = tenex_conversations::normalize_project_id(&context.project_id)
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    let conv_db_path =
        tenex_conversations::paths::conversation_db_path(&context.base_dir, &project_d_tag);

    let rag_store = open_rag_store(&context.base_dir);
    let summarization_model = Arc::new(ResolvedModel::resolve(
        &context.base_dir,
        None,
        Arc::new(tenex_llm_config::key_health::KeyHealthTracker::new()),
    )?);

    let skill_ctx = Arc::new(SkillLookupCtx {
        agent_pubkey: context.agent_pubkey.clone(),
        project_path: context.working_dir.clone(),
        base_dir: context.base_dir.clone(),
        agent_config_path: context.agent_config_path.clone(),
    });

    let active_skills = Arc::new(Mutex::new(initial_active_skills(context, &conv_db_path)));
    let todos: Arc<Mutex<Vec<TodoItem>>> = Arc::new(Mutex::new(Vec::new()));

    let mut always_on: Vec<Box<dyn ToolDyn>> = Vec::new();

    if context.expose_delegation_tools {
        always_on.push(expose_tool(
            Box::new(DelegateTool::new(
                state.clone(),
                project_agents.clone(),
                teams.clone(),
                context.project_root.clone(),
            )),
            state.clone(),
            true,
        ));
        always_on.push(expose_tool(
            Box::new(SelfDelegateTool::new(state.clone())),
            state.clone(),
            true,
        ));
        always_on.push(expose_tool(
            Box::new(DelegateCrossProjectTool::new(state.clone())),
            state.clone(),
            true,
        ));
        always_on.push(expose_tool(
            Box::new(DelegateFollowupTool::new(
                state.clone(),
                project_agents.clone(),
                teams.clone(),
                conv_db_path.clone(),
            )),
            state.clone(),
            true,
        ));
    }

    always_on.push(expose_tool(
        Box::new(ProjectListTool::new(context.base_dir.clone())),
        state.clone(),
        false,
    ));
    always_on.push(expose_tool(
        Box::new(AskTool::new(
            state.clone(),
            context.owner_pubkey.clone(),
            context.escalation_pubkey.clone(),
        )),
        state.clone(),
        false,
    ));
    always_on.push(expose_tool(
        Box::new(ConversationGetTool::new(
            state.clone(),
            conv_db_path.clone(),
            context.base_dir.clone(),
            summarization_model.clone(),
        )),
        state.clone(),
        true,
    ));
    always_on.push(expose_tool(
        Box::new(ConversationListTool::new(
            state.clone(),
            conv_db_path.clone(),
            context.base_dir.clone(),
            project_d_tag.clone(),
            project_agents.clone(),
        )),
        state.clone(),
        true,
    ));
    always_on.push(expose_tool(
        Box::new(ConversationSearchTool::new(
            rag_store.clone(),
            project_d_tag.clone(),
        )),
        state.clone(),
        false,
    ));
    always_on.push(expose_tool(
        Box::new(RagSearchTool::new(
            rag_store.clone(),
            project_d_tag.clone(),
            context.agent_pubkey.clone(),
            summarization_model.clone(),
        )),
        state.clone(),
        false,
    ));
    always_on.push(expose_tool(
        Box::new(RagAddDocumentsTool::new(
            rag_store.clone(),
            project_d_tag.clone(),
            context.agent_pubkey.clone(),
        )),
        state.clone(),
        false,
    ));
    always_on.push(expose_tool(
        Box::new(SkillListTool::new(skill_ctx.clone())),
        state.clone(),
        false,
    ));
    always_on.push(expose_tool(
        Box::new(SkillsSetTool::new(skill_ctx.clone(), active_skills.clone())),
        state.clone(),
        false,
    ));

    let mut skill_gated: HashMap<String, Box<dyn ToolDyn>> = HashMap::new();
    skill_gated.insert(
        "agents_write".to_string(),
        expose_tool(
            Box::new(AgentsWriteTool::new(context.base_dir.clone())),
            state.clone(),
            false,
        ),
    );
    skill_gated.insert(
        "create_workflow".to_string(),
        expose_tool(
            Box::new(CreateWorkflowTool::new(context.agent_home.clone())),
            state.clone(),
            false,
        ),
    );
    skill_gated.insert(
        "run_workflow".to_string(),
        expose_tool(
            Box::new(RunWorkflowTool::new(
                context.agent_home.clone(),
                summarization_model.clone(),
                todos.clone(),
                context.agent_pubkey.clone(),
                context.conversation_id.clone(),
            )),
            state.clone(),
            false,
        ),
    );
    skill_gated.insert(
        "sign_as_user".to_string(),
        expose_tool(
            Box::new(SignAsUserTool::new(
                context.owner_pubkey.clone(),
                agent_config.nsec.clone(),
            )),
            state.clone(),
            false,
        ),
    );
    skill_gated.insert(
        "mcp_list_resources".to_string(),
        expose_tool(
            Box::new(McpListResourcesTool::new(context.agent_pubkey.clone())),
            state.clone(),
            false,
        ),
    );
    skill_gated.insert(
        "mcp_resource_read".to_string(),
        expose_tool(
            Box::new(McpResourceReadTool::new(context.agent_pubkey.clone())),
            state.clone(),
            false,
        ),
    );
    skill_gated.insert(
        "mcp_subscribe".to_string(),
        expose_tool(
            Box::new(McpSubscribeTool::new(
                context.agent_pubkey.clone(),
                context.agent_slug.clone(),
                context.conversation_id.clone(),
                project_d_tag.clone(),
            )),
            state.clone(),
            false,
        ),
    );
    skill_gated.insert(
        "mcp_subscription_stop".to_string(),
        expose_tool(
            Box::new(McpSubscriptionStopTool::new(context.agent_pubkey.clone())),
            state,
            false,
        ),
    );

    Ok(McpServer {
        always_on,
        skill_gated,
        skill_ctx,
        active_skills,
        stdout,
    })
}

/// Compute the initial active-skill set: agent default skills + envelope
/// skills + previously self-applied skills from the conversation store +
/// category auto-enables. Mirrors `agent_bootstrap::stages::build_skill_context`.
fn initial_active_skills(context: &AcpMcpContext, conv_db_path: &PathBuf) -> Vec<String> {
    let mut ids: Vec<String> = context.default_skills.clone();
    for id in &context.envelope_skills {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    if let Ok(store) = tenex_conversations::ConversationStore::open(conv_db_path) {
        if let Ok(Some(state)) =
            store.get_agent_context_state(&context.conversation_id, &context.agent_pubkey)
        {
            if let Some(persisted) = state
                .self_applied_skills
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
            {
                for id in persisted {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
            }
        }
    }
    let auto_workflow = matches!(
        context.agent_category.as_deref(),
        Some("orchestrator") | Some("principal")
    );
    if auto_workflow && !ids.iter().any(|id| id == "workflows") {
        ids.push("workflows".to_string());
    }
    ids
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
    let ral = state.meta.lock().unwrap().ral;
    let mut ctx = state.build_ctx(ral);
    ctx.llm_runtime_ms = state.take_runtime_delta();
    let intent = ToolUseIntent {
        tool_name,
        content: String::new(),
        args_json: Some(args_json),
        referenced_messages: Vec::new(),
        usage: None,
        extra_tags: Vec::new(),
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

async fn serve_stdio(server: McpServer, stdout: Arc<AsyncMutex<Stdout>>) -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let server = Arc::new(server);

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<JsonRpcRequest>(&line) {
            Ok(request) => handle_request(request, &server).await,
            Err(error) => Some(json_rpc_error(
                Value::Null,
                -32700,
                format!("parse error: {error}"),
            )),
        };
        if let Some(response) = response {
            write_line(&stdout, &response).await?;
        }
    }
    Ok(())
}

async fn write_line(stdout: &Arc<AsyncMutex<Stdout>>, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    let mut out = stdout.lock().await;
    out.write_all(&bytes).await?;
    out.flush().await?;
    Ok(())
}

async fn handle_request(request: JsonRpcRequest, server: &Arc<McpServer>) -> Option<Value> {
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
                "capabilities": {"tools": {"listChanged": true}},
                "serverInfo": {
                    "name": SERVER_NAME,
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )),
        "ping" => Some(json_rpc_result(id, json!({}))),
        "tools/list" => Some(json_rpc_result(id, server.list_tools().await)),
        "tools/call" => Some(json_rpc_result(id, server.call_tool(request.params).await)),
        _ => Some(json_rpc_error(
            id,
            -32601,
            format!("unknown method {method}"),
        )),
    }
}

impl McpServer {
    /// Tools granted by the currently active skills (union of every active
    /// skill's frontmatter `tools:` list).
    fn granted_tool_names(&self) -> HashSet<String> {
        let active = self.active_skills.lock().unwrap().clone();
        if active.is_empty() {
            return HashSet::new();
        }
        let resolved = skills::fetch_skills(&active, &self.skill_ctx);
        resolved
            .iter()
            .filter_map(|s| s.frontmatter.as_ref())
            .flat_map(|fm| fm.tools.iter().cloned())
            .collect()
    }

    async fn list_tools(&self) -> Value {
        let granted = self.granted_tool_names();
        let mut out = Vec::new();
        for tool in &self.always_on {
            let def = tool.definition(String::new()).await;
            out.push(tool_definition_to_mcp(def));
        }
        for (grant, tool) in &self.skill_gated {
            if granted.contains(grant) {
                let def = tool.definition(String::new()).await;
                out.push(tool_definition_to_mcp(def));
            }
        }
        json!({ "tools": out })
    }

    async fn call_tool(self: &Arc<Self>, params: Value) -> Value {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if name.is_empty() {
            return tool_result("missing tool name", true);
        }

        let tool: Option<&Box<dyn ToolDyn>> = self
            .always_on
            .iter()
            .find(|t| t.name() == name)
            .or_else(|| self.skill_gated.values().find(|t| t.name() == name));

        let Some(tool) = tool else {
            return tool_result(format!("unknown TENEX tool '{name}'"), true);
        };

        let active_before = if name == "skills_set" {
            Some(self.active_skills.lock().unwrap().clone())
        } else {
            None
        };

        let result = tool.call(arguments.to_string()).await;

        if let Some(before) = active_before {
            let after = self.active_skills.lock().unwrap().clone();
            if result.is_ok() && before != after {
                if let Err(err) = self.notify_tools_list_changed().await {
                    eprintln!("[tenex-agent-acp-mcp] warn: tools/list_changed failed: {err}");
                }
            }
        }

        match result {
            Ok(output) => tool_result(output, false),
            Err(error) => tool_result(error.to_string(), true),
        }
    }

    async fn notify_tools_list_changed(&self) -> Result<()> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "notifications/tools/list_changed"
        });
        write_line(&self.stdout, &payload).await
    }
}

fn tool_definition_to_mcp(definition: ToolDefinition) -> Value {
    json!({
        "name": definition.name,
        "description": definition.description,
        "inputSchema": definition.parameters,
    })
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
