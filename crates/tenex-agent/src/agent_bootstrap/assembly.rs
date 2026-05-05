//! Assembly stages that combine bootstrap inputs into the agent's
//! per-turn objects: the system prompt, the [`EmitState`], and the
//! supervisor + completion hook + delegate tool bundle.

use std::sync::{Arc, Mutex};

use tenex_protocol::{
    Channel, ConversationRef, InboundEnvelope, PrincipalKind, PrincipalRef, ProjectRef,
};
use tenex_supervision::{heuristics::default_supervisor, supervisor::Supervisor};

use crate::config::AgentConfig;
use crate::emit::{EmitState, EmitStateArgs};
use crate::hook::EmitHook;
use crate::runtime_state::RuntimeStateHandle;
use crate::tools::{DelegateTool, TodoItem};

/// Inputs for [`compose_system_prompt`].
///
/// Holds borrowed slices for everything `tenex_system_prompt` needs so the
/// orchestrator passes shared bootstrap state through one bundle.
pub(super) struct SystemPromptInputs<'a> {
    pub agent_config: &'a AgentConfig,
    pub pubkey_hex: &'a str,
    pub conversation_id: &'a str,
    pub working_dir: &'a str,
    pub project_base_path: &'a str,
    pub project_meta: &'a tenex_project::ProjectMetadata,
    pub project_agents: &'a [tenex_project::Agent],
    pub teams_fragment: &'a str,
    pub home: &'a tenex_system_prompt::HomeDirectoryInfo<'a>,
    pub root_agents_md: Option<&'a str>,
    pub preloaded_skills_block: Option<&'a str>,
    pub workflows_fragment: Option<&'a str>,
    pub telegram_channel_bindings: &'a [tenex_system_prompt::TelegramChannelBinding],
    pub telegram_chat_context: Option<tenex_system_prompt::TelegramChatContextForPrompt>,
    pub scheduled_tasks: &'a [tenex_system_prompt::ScheduledTaskForPrompt],
    pub current_branch: Option<&'a str>,
    pub worktrees: &'a [tenex_project::WorktreeInfo],
    pub category_str: Option<&'a str>,
    pub category: Option<tenex_supervision::types::AgentCategory>,
    pub global_system_prompt: Option<&'a str>,
}

/// Render the system prompt by forwarding all overlays to
/// [`tenex_system_prompt::build_system_prompt`].
pub(super) fn compose_system_prompt(inputs: SystemPromptInputs<'_>) -> String {
    tenex_system_prompt::build_system_prompt(tenex_system_prompt::BuildSystemPromptInput {
        identity_name: inputs.agent_config.identity_name(),
        pubkey_hex: inputs.pubkey_hex,
        category_str: inputs.category_str,
        category: inputs.category,
        global_system_prompt: inputs.global_system_prompt,
        instructions: inputs.agent_config.instructions.as_deref(),
        working_dir: inputs.working_dir,
        project_base_path: Some(inputs.project_base_path),
        project_meta: Some(inputs.project_meta),
        project_id: Some(&inputs.project_meta.d_tag),
        conversation_id: Some(inputs.conversation_id),
        root_agents_md: inputs.root_agents_md,
        agents: inputs.project_agents,
        teams_fragment: inputs.teams_fragment,
        home: inputs.home,
        preloaded_skills_block: inputs.preloaded_skills_block,
        workflows_fragment: inputs.workflows_fragment,
        telegram_channel_bindings: inputs.telegram_channel_bindings,
        telegram_chat_context: inputs.telegram_chat_context,
        scheduled_tasks: inputs.scheduled_tasks,
        current_branch: inputs.current_branch,
        worktrees: inputs.worktrees,
    })
}

/// Inputs for [`assemble_emit_state`].
pub(super) struct EmitStateInputs<'a> {
    pub channel: Arc<dyn Channel>,
    pub project_ref: ProjectRef,
    pub envelope: &'a InboundEnvelope,
    pub conversation_id: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub current_branch: Option<&'a str>,
}

/// Compose the agent's [`EmitState`] from project + envelope context.
/// Resolves the optional `TENEX_COMPLETION_RECIPIENT_PUBKEY` override and
/// formats the model string used in emitted events.
pub(super) fn assemble_emit_state(inputs: EmitStateInputs<'_>) -> Arc<EmitState> {
    let current_project_addr = inputs.project_ref.coordinate();
    let completion_project_a_tags: Vec<String> = inputs
        .envelope
        .metadata
        .project_a_tags
        .iter()
        .filter(|addr| *addr != &current_project_addr)
        .cloned()
        .collect();
    let conversation_root = nostr::EventId::from_hex(inputs.conversation_id)
        .ok()
        .map(|root_event_id| ConversationRef::Nostr { root_event_id });
    let completion_recipient = std::env::var("TENEX_COMPLETION_RECIPIENT_PUBKEY")
        .ok()
        .and_then(|pubkey| nostr::PublicKey::from_hex(&pubkey).ok())
        .map(|pubkey| PrincipalRef::Nostr {
            pubkey,
            kind: PrincipalKind::Human,
            display_name: None,
        });
    Arc::new(EmitState::new(EmitStateArgs {
        channel: inputs.channel,
        project: inputs.project_ref,
        triggering_principal: inputs.envelope.principal.clone(),
        triggering_message: Some(inputs.envelope.message.clone()),
        conversation_root,
        completion_recipient,
        model: format!("{}:{}", inputs.provider, inputs.model),
        team: inputs.envelope.metadata.team.clone(),
        current_branch: inputs.current_branch.map(str::to_string),
        completion_project_a_tags,
    }))
}

/// Outputs of [`init_supervisor_and_hook`].
pub(super) struct SupervisorComponents {
    pub supervisor_ref: Arc<Mutex<Supervisor>>,
    pub hook: EmitHook,
    pub allows_delegation: bool,
    pub delegate_tool: Option<DelegateTool>,
}

/// Initialize the per-turn supervisor, completion hook, and (when the
/// agent's category permits) the delegation tool. The category from the
/// agent config drives both delegation gating and supervisor policy.
pub(super) fn init_supervisor_and_hook(
    agent_config: &AgentConfig,
    emit_state: Arc<EmitState>,
    todos: Arc<Mutex<Vec<TodoItem>>>,
    runtime_state: Option<RuntimeStateHandle>,
    project_agents: Arc<Vec<tenex_project::Agent>>,
    teams: Arc<Vec<tenex_project::Team>>,
) -> SupervisorComponents {
    let sup_category: Option<tenex_supervision::types::AgentCategory> = agent_config
        .category
        .as_deref()
        .and_then(|s| s.parse().ok());
    let supervisor = Arc::new(Mutex::new(default_supervisor()));
    let supervisor_ref = supervisor.clone();
    let hook = EmitHook::new(
        emit_state.clone(),
        supervisor,
        todos,
        sup_category,
        runtime_state,
    );
    let allows_delegation = sup_category.map(|c| c.allows_delegation()).unwrap_or(true);
    let delegate_tool = if allows_delegation {
        Some(DelegateTool::new(emit_state, project_agents, teams))
    } else {
        None
    };
    SupervisorComponents {
        supervisor_ref,
        hook,
        allows_delegation,
        delegate_tool,
    }
}
