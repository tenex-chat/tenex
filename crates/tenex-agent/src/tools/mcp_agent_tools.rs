//! Tool set for the standalone `tenex mcp agent` MCP server.
//!
//! Builds the "Category A" tools — filesystem, todo, RAG, conversation,
//! delegation, learn/ask/report/html_publish — without the `RecordingTool`
//! wrapping (the external runtime owns the conversation record), and without
//! socket-dependent tools (`shell`, `sign_as_user`, `mcp_resources`, `kill`),
//! Telegram, or workflow-write tools.
//!
//! This module is consumed only through the `tenex-agent` lib target by the
//! `tenex mcp agent` CLI; the bin turn-loop builds tools through
//! `ToolSet::build_for_turn` instead. The allow below silences the
//! resulting dead-code warning when the bin compiles this file as part of
//! the shared `tools/` tree.
#![allow(dead_code)]

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use nostr::Keys;
use rig::tool::ToolDyn;
use tenex_rag::RagStore;
use tenex_supervision::types::AgentCategory;

use crate::config::ResolvedModel;
use crate::emit::EmitState;
use crate::skills::SkillLookupCtx;

use super::agents_md::AgentsMdReminderState;
use super::ask::AskTool;
use super::conversation_get::ConversationGetTool;
use super::conversation_list::ConversationListTool;
use super::conversation_search::ConversationSearchTool;
use super::delegate::DelegateTool;
use super::delegate_crossproject::DelegateCrossProjectTool;
use super::delegate_followup::DelegateFollowupTool;
use super::fs::{
    FsEditTool, FsGlobTool, FsGrepTool, FsReadTool, FsWriteTool, HomeFsEditTool, HomeFsGlobTool,
    HomeFsGrepTool, HomeFsReadTool, HomeFsWriteTool,
};
use super::html_publish::HtmlPublishTool;
use super::learn::LearnTool;
use super::project_list::ProjectListTool;
use super::rag_add_documents::RagAddDocumentsTool;
use super::rag_search::RagSearchTool;
use super::report_publish::ReportPublishTool;
use super::schedule_task::ScheduleTaskTool;
use super::self_delegate::SelfDelegateTool;
use super::skill_list::SkillListTool;
use super::skills_set::SkillsSetTool;
use super::todo::{TodoItem, TodoWriteTool};

/// Inputs for [`build_mcp_agent_tools`]. Carries the per-invocation state
/// the `tenex mcp agent` standalone MCP server needs. Excludes runtime-control
/// fields (`shell_env`, `mcp_proxy_tools`, `telegram_config`,
/// `message_injections`) since standalone mode does not include their
/// associated tools.
pub struct McpAgentContext {
    pub emit_state: Arc<EmitState>,
    pub project_agents: Arc<Vec<tenex_project::Agent>>,
    pub teams: Arc<Vec<tenex_project::Team>>,
    pub owner_pubkey: String,
    pub escalation_pubkey: Option<String>,
    pub base_dir: PathBuf,
    pub allows_delegation: bool,
    pub agent_category: Option<AgentCategory>,
    pub conv_db_path: PathBuf,
    pub agent_pubkey: String,
    pub agent_home: PathBuf,
    pub resolved_model: Arc<ResolvedModel>,
    pub summarization_model: Arc<ResolvedModel>,
    pub project_d_tag: String,
    pub agent_slug: String,
    pub project_id: String,
    pub rag_store: Option<Arc<RagStore>>,
    pub working_dir: String,
    pub granted_tools: HashSet<String>,
    pub todos: Arc<Mutex<Vec<TodoItem>>>,
    pub blossom_url: String,
    pub agent_keys: Keys,
    pub project_root: PathBuf,
    pub skill_ctx: Arc<SkillLookupCtx>,
    pub self_applied_skills: Arc<Mutex<Vec<String>>>,
}

pub fn build_mcp_agent_tools(ctx: &McpAgentContext) -> Vec<Box<dyn ToolDyn>> {
    let mut tools: Vec<Box<dyn ToolDyn>> = Vec::new();
    let agent_home_str = ctx.agent_home.display().to_string();
    let workspace_restricted = ctx
        .agent_category
        .map(AgentCategory::is_workspace_access_restricted)
        .unwrap_or(false);
    let agents_md = Arc::new(AgentsMdReminderState::new(ctx.project_root.clone()));

    let project_fs_allowed = !workspace_restricted;

    if project_fs_allowed && ctx.granted_tools.contains("fs_read") {
        tools.push(Box::new(FsReadTool::new(
            ctx.working_dir.clone(),
            agents_md.clone(),
        )));
    } else {
        tools.push(Box::new(HomeFsReadTool::new(agent_home_str.clone())));
    }

    if project_fs_allowed && ctx.granted_tools.contains("fs_write") {
        tools.push(Box::new(FsWriteTool::new(ctx.working_dir.clone())));
        tools.push(Box::new(FsEditTool::new(ctx.working_dir.clone())));
    } else {
        tools.push(Box::new(HomeFsWriteTool::new(agent_home_str.clone())));
        tools.push(Box::new(HomeFsEditTool::new(agent_home_str.clone())));
    }

    if project_fs_allowed && ctx.granted_tools.contains("fs_glob") {
        tools.push(Box::new(FsGlobTool::new(
            ctx.working_dir.clone(),
            agents_md.clone(),
        )));
    } else {
        tools.push(Box::new(HomeFsGlobTool::new(agent_home_str.clone())));
    }

    if project_fs_allowed && ctx.granted_tools.contains("fs_grep") {
        tools.push(Box::new(FsGrepTool::new(ctx.working_dir.clone())));
    } else {
        tools.push(Box::new(HomeFsGrepTool::new(agent_home_str.clone())));
    }

    tools.push(Box::new(TodoWriteTool::new(ctx.todos.clone())));
    tools.push(Box::new(SkillListTool::new(ctx.skill_ctx.clone())));
    tools.push(Box::new(SkillsSetTool::new(
        ctx.skill_ctx.clone(),
        ctx.self_applied_skills.clone(),
    )));

    tools.push(Box::new(RagAddDocumentsTool::new(
        ctx.rag_store.clone(),
        ctx.project_id.clone(),
        ctx.agent_pubkey.clone(),
    )));
    tools.push(Box::new(RagSearchTool::new(
        ctx.rag_store.clone(),
        ctx.project_id.clone(),
        ctx.agent_pubkey.clone(),
        ctx.resolved_model.clone(),
    )));

    tools.push(Box::new(LearnTool::new(
        ctx.emit_state.clone(),
        ctx.agent_home.clone(),
        ctx.resolved_model.clone(),
    )));

    tools.push(Box::new(AskTool::new(
        ctx.emit_state.clone(),
        ctx.owner_pubkey.clone(),
        ctx.escalation_pubkey.clone(),
    )));

    tools.push(Box::new(ProjectListTool::new(ctx.base_dir.clone())));

    tools.push(Box::new(ConversationGetTool::new(
        ctx.emit_state.clone(),
        ctx.conv_db_path.clone(),
        ctx.base_dir.clone(),
        ctx.summarization_model.clone(),
    )));
    tools.push(Box::new(ConversationListTool::new(
        ctx.emit_state.clone(),
        ctx.conv_db_path.clone(),
        ctx.base_dir.clone(),
        ctx.project_d_tag.clone(),
        ctx.project_agents.clone(),
    )));
    tools.push(Box::new(ConversationSearchTool::new(
        ctx.rag_store.clone(),
        ctx.project_d_tag.clone(),
    )));

    tools.push(Box::new(ScheduleTaskTool::new(
        ctx.project_d_tag.clone(),
        ctx.agent_pubkey.clone(),
        ctx.agent_slug.clone(),
        ctx.project_id.clone(),
    )));

    if ctx.allows_delegation {
        tools.push(Box::new(DelegateTool::new(
            ctx.emit_state.clone(),
            ctx.project_agents.clone(),
            ctx.teams.clone(),
            ctx.project_root.clone(),
        )));
        tools.push(Box::new(SelfDelegateTool::new(ctx.emit_state.clone())));
        tools.push(Box::new(DelegateCrossProjectTool::new(
            ctx.emit_state.clone(),
        )));
        tools.push(Box::new(DelegateFollowupTool::new(
            ctx.emit_state.clone(),
            ctx.project_agents.clone(),
            ctx.teams.clone(),
            ctx.conv_db_path.clone(),
        )));
    }

    tools.push(Box::new(ReportPublishTool::new(
        ctx.emit_state.clone(),
        ctx.working_dir.clone(),
    )));

    tools.push(Box::new(HtmlPublishTool::new(
        ctx.emit_state.clone(),
        ctx.blossom_url.clone(),
        ctx.agent_keys.clone(),
    )));

    tools
}
