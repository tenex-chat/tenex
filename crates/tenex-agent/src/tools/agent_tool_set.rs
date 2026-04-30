use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc, Mutex};

use rig::tool::ToolDyn;
use tenex_rag::{EmbedConfig, RagStore};

use crate::config::ResolvedModel;
use crate::emit::EmitState;
use crate::injections::MessageInjectionTracker;
use crate::runtime_state::RuntimeStateHandle;

use super::agents_write::AgentsWriteTool;
use super::ask::AskTool;
use super::change_model::ChangeModelTool;
use super::conversation_get::ConversationGetTool;
use super::conversation_list::ConversationListTool;
use super::conversation_search::ConversationSearchTool;
use super::delegate::DelegateTool;
use super::delegate_crossproject::DelegateCrossProjectTool;
use super::delegate_followup::DelegateFollowupTool;
use super::find_skills::FindSkillsTool;
use super::fs::{
    FsEditTool, FsGlobTool, FsGrepTool, FsReadTool, FsWriteTool, HomeFsEditTool, HomeFsGlobTool,
    HomeFsGrepTool, HomeFsReadTool, HomeFsWriteTool,
};
use super::kill::KillTool;
use super::learn::LearnTool;
use super::mcp::McpProxyTool;
use super::mcp_resources::{
    McpListResourcesTool, McpResourceReadTool, McpSubscribeTool, McpSubscriptionStopTool,
};
use super::no_response::NoResponseTool;
use super::project_list::ProjectListTool;
use super::rag_add_documents::RagAddDocumentsTool;
use super::rag_search::RagSearchTool;
use super::recording::{RecordingTool, ToolRecorder};
use super::report_publish::ReportPublishTool;
use super::schedule_task::ScheduleTaskTool;
use super::self_delegate::SelfDelegateTool;
use super::send_message::SendMessageTool;
use super::shell::ShellTool;
use super::skill_list::SkillListTool;
use super::skills_set::SkillsSetTool;
use super::todo::{TodoItem, TodoWriteTool};

pub(crate) struct ToolSet {
    pub(crate) emit_state: Arc<EmitState>,
    pub(crate) project_agents: Arc<Vec<tenex_project::Agent>>,
    pub(crate) teams: Arc<Vec<tenex_project::Team>>,
    pub(crate) owner_pubkey: String,
    pub(crate) escalation_pubkey: Option<String>,
    pub(crate) base_dir: PathBuf,
    pub(crate) allows_delegation: bool,
    pub(crate) conv_db_path: PathBuf,
    pub(crate) conversation_id: String,
    pub(crate) agent_pubkey: String,
    pub(crate) agent_home: PathBuf,
    pub(crate) resolved_model: Arc<ResolvedModel>,
    pub(crate) project_d_tag: String,
    pub(crate) agent_slug: String,
    pub(crate) project_id: String,
    pub(crate) execution_id: String,
    pub(crate) suppress_response: Arc<AtomicBool>,
    pub(crate) rag_store: Option<Arc<RagStore>>,
    pub(crate) embed_config: Option<EmbedConfig>,
    pub(crate) working_dir: String,
    pub(crate) shell_env: Vec<(String, String)>,
    pub(crate) granted_tools: HashSet<String>,
    pub(crate) todos: Arc<Mutex<Vec<TodoItem>>>,
    pub(crate) skill_list: SkillListTool,
    pub(crate) skills_set: SkillsSetTool,
    pub(crate) find_skills: FindSkillsTool,
    pub(crate) mcp_proxy_tools: Vec<McpProxyTool>,
    pub(crate) delegate: Option<DelegateTool>,
    pub(crate) rag_add_documents: RagAddDocumentsTool,
    pub(crate) rag_search: RagSearchTool,
    pub(crate) runtime_state: Option<RuntimeStateHandle>,
    pub(crate) message_injections: Arc<Mutex<MessageInjectionTracker>>,
    pub(crate) telegram_config: Option<tenex_telegram::config::TelegramAgentConfig>,
}

impl ToolSet {
    fn push_tool(
        &self,
        tools: &mut Vec<Box<dyn ToolDyn>>,
        recorder: &Arc<ToolRecorder>,
        t: Box<dyn ToolDyn>,
    ) {
        tools.push(RecordingTool::wrap_dyn(
            t,
            recorder.clone(),
            self.runtime_state.clone(),
            Some(self.message_injections.clone()),
        ));
    }

    fn push_fs(
        &self,
        tools: &mut Vec<Box<dyn ToolDyn>>,
        recorder: &Arc<ToolRecorder>,
        granted_name: &str,
        project_tool: Box<dyn ToolDyn>,
        home_tool: Box<dyn ToolDyn>,
    ) {
        let tool = if self.granted_tools.contains(granted_name) {
            project_tool
        } else {
            home_tool
        };
        self.push_tool(tools, recorder, tool);
    }

    pub(crate) fn build_for_turn(&self, recorder: Arc<ToolRecorder>) -> Vec<Box<dyn ToolDyn>> {
        let mut tools: Vec<Box<dyn ToolDyn>> = Vec::new();
        let agent_home_str = self.agent_home.display().to_string();

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(ShellTool::new(
                self.working_dir.clone(),
                self.shell_env.clone(),
                self.project_id.clone(),
                self.conversation_id.clone(),
                self.agent_pubkey.clone(),
                self.execution_id.clone(),
            )),
        );

        self.push_fs(
            &mut tools,
            &recorder,
            "fs_read",
            Box::new(FsReadTool::new(self.working_dir.clone())),
            Box::new(HomeFsReadTool::new(agent_home_str.clone())),
        );

        if self.granted_tools.contains("fs_write") {
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(FsWriteTool::new(self.working_dir.clone())),
            );
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(FsEditTool::new(self.working_dir.clone())),
            );
        } else {
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(HomeFsWriteTool::new(agent_home_str.clone())),
            );
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(HomeFsEditTool::new(agent_home_str.clone())),
            );
        }

        self.push_fs(
            &mut tools,
            &recorder,
            "fs_glob",
            Box::new(FsGlobTool::new(self.working_dir.clone())),
            Box::new(HomeFsGlobTool::new(agent_home_str.clone())),
        );

        self.push_fs(
            &mut tools,
            &recorder,
            "fs_grep",
            Box::new(FsGrepTool::new(self.working_dir.clone())),
            Box::new(HomeFsGrepTool::new(agent_home_str.clone())),
        );

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(TodoWriteTool::new(self.todos.clone())),
        );
        self.push_tool(&mut tools, &recorder, Box::new(self.skill_list.clone()));
        self.push_tool(&mut tools, &recorder, Box::new(self.skills_set.clone()));
        self.push_tool(&mut tools, &recorder, Box::new(self.find_skills.clone()));

        if self.granted_tools.contains("mcp_list_resources") {
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(McpListResourcesTool::new(self.agent_pubkey.clone())),
            );
        }
        if self.granted_tools.contains("mcp_resource_read") {
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(McpResourceReadTool::new(self.agent_pubkey.clone())),
            );
        }
        if self.granted_tools.contains("mcp_subscribe") {
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(McpSubscribeTool::new(
                    self.agent_pubkey.clone(),
                    self.agent_slug.clone(),
                    self.conversation_id.clone(),
                    self.project_d_tag.clone(),
                )),
            );
        }
        if self.granted_tools.contains("mcp_subscription_stop") {
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(McpSubscriptionStopTool::new(self.agent_pubkey.clone())),
            );
        }

        for tool in &self.mcp_proxy_tools {
            self.push_tool(&mut tools, &recorder, Box::new(tool.clone()));
        }

        if let Some(d) = &self.delegate {
            self.push_tool(&mut tools, &recorder, Box::new(d.clone()));
        }

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(self.rag_add_documents.clone()),
        );
        self.push_tool(&mut tools, &recorder, Box::new(self.rag_search.clone()));

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(LearnTool::new(
                self.emit_state.clone(),
                self.agent_home.clone(),
                self.resolved_model.clone(),
            )),
        );

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(AskTool::new(
                self.emit_state.clone(),
                self.owner_pubkey.clone(),
                self.escalation_pubkey.clone(),
            )),
        );

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(ProjectListTool::new(self.base_dir.clone())),
        );

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(ConversationGetTool::new(
                self.conv_db_path.clone(),
                self.resolved_model.clone(),
            )),
        );
        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(ConversationListTool::new(
                self.conv_db_path.clone(),
                self.base_dir.clone(),
                self.project_d_tag.clone(),
            )),
        );

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(ConversationSearchTool::new(
                self.rag_store.clone(),
                self.embed_config.clone(),
                self.base_dir.clone(),
                self.project_id.clone(),
            )),
        );

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(ChangeModelTool::new(
                self.conv_db_path.clone(),
                self.conversation_id.clone(),
                self.agent_pubkey.clone(),
            )),
        );

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(KillTool::new(
                self.project_d_tag.clone(),
                self.conversation_id.clone(),
                self.agent_pubkey.clone(),
            )),
        );

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(ScheduleTaskTool::new(
                self.project_d_tag.clone(),
                self.agent_pubkey.clone(),
                self.agent_slug.clone(),
                self.project_id.clone(),
            )),
        );

        if self.allows_delegation {
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(SelfDelegateTool::new(self.emit_state.clone())),
            );
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(DelegateCrossProjectTool::new(self.emit_state.clone())),
            );
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(DelegateFollowupTool::new(
                    self.emit_state.clone(),
                    self.project_agents.clone(),
                    self.teams.clone(),
                    self.conv_db_path.clone(),
                )),
            );
        }

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(NoResponseTool::new(self.suppress_response.clone())),
        );

        self.push_tool(
            &mut tools,
            &recorder,
            Box::new(ReportPublishTool::new(
                self.emit_state.clone(),
                self.working_dir.clone(),
            )),
        );

        if let Some(ref tc) = self.telegram_config {
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(SendMessageTool::new(
                    tc.bot_token.clone(),
                    tc.api_base_url.clone(),
                    self.base_dir.clone(),
                    self.agent_pubkey.clone(),
                    self.project_id.clone(),
                )),
            );
        }

        if self.granted_tools.contains("agents_write") {
            self.push_tool(
                &mut tools,
                &recorder,
                Box::new(AgentsWriteTool::new(self.base_dir.clone())),
            );
        }

        tools
    }
}
