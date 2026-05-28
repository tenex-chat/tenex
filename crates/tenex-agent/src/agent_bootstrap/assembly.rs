//! Assembly stages that combine bootstrap inputs into the agent's
//! per-turn objects: the system prompt, the [`EmitState`], and the
//! supervisor + completion hook + delegate tool bundle.

use std::sync::{Arc, Mutex};

use tenex_protocol::{
    Channel, ConversationRef, InboundEnvelope, PrincipalKind, PrincipalRef, ProjectRef,
};
use tenex_supervision::{heuristics::default_supervisor, supervisor::Supervisor, types::AgentCategory};

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
    pub teams: &'a [tenex_project::Team],
    pub agent_slug: &'a str,
    pub active_team: Option<&'a str>,
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
        teams: inputs.teams,
        agent_slug: inputs.agent_slug,
        active_team: inputs.active_team,
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
    pub agent_category: Option<AgentCategory>,
}

/// Initialize the per-turn supervisor, completion hook, and (when the
/// agent's category permits) the delegation tool. The category is
/// pre-resolved by the bootstrap (with backfill) so all downstream
/// consumers — supervisor policy, delegation gating, and ToolSet
/// category gating — share a single source of truth.
pub(super) fn init_supervisor_and_hook(
    agent_category: Option<AgentCategory>,
    emit_state: Arc<EmitState>,
    todos: Arc<Mutex<Vec<TodoItem>>>,
    runtime_state: Option<RuntimeStateHandle>,
    project_agents: Arc<Vec<tenex_project::Agent>>,
    teams: Arc<Vec<tenex_project::Team>>,
    project_root: std::path::PathBuf,
    conv_db_path: std::path::PathBuf,
) -> SupervisorComponents {
    let supervisor = Arc::new(Mutex::new(default_supervisor()));
    let supervisor_ref = supervisor.clone();
    let hook = EmitHook::new(
        emit_state.clone(),
        supervisor,
        todos,
        agent_category,
        runtime_state,
    );
    let allows_delegation = agent_category
        .map(|c| c.allows_delegation())
        .unwrap_or(true);
    let delegate_tool = if allows_delegation {
        Some(DelegateTool::new(
            emit_state,
            project_agents,
            teams,
            project_root,
            conv_db_path,
        ))
    } else {
        None
    };
    SupervisorComponents {
        supervisor_ref,
        hook,
        allows_delegation,
        delegate_tool,
        agent_category,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use async_trait::async_trait;
    use tenex_protocol::{
        Channel, ChannelError, EncodingContext, Intent, MessageRef, PrincipalRef, ProjectRef,
    };

    struct FakeChannel(PrincipalRef);

    #[async_trait]
    impl Channel for FakeChannel {
        fn name(&self) -> &'static str {
            "fake"
        }

        fn identity(&self) -> &PrincipalRef {
            &self.0
        }

        async fn send(
            &self,
            _intent: Intent,
            _ctx: &EncodingContext,
        ) -> Result<Vec<MessageRef>, ChannelError> {
            Err(ChannelError::Unsupported("test"))
        }
    }

    fn make_emit_state() -> Arc<EmitState> {
        let keys = nostr::Keys::generate();
        let identity = PrincipalRef::nostr_agent(keys.public_key());
        let channel: Arc<dyn Channel> = Arc::new(FakeChannel(identity.clone()));
        let project = ProjectRef {
            author: keys.public_key(),
            d_tag: "test".into(),
        };
        Arc::new(EmitState::new(EmitStateArgs {
            channel,
            project,
            triggering_principal: identity,
            triggering_message: None,
            conversation_root: None,
            completion_recipient: None,
            model: "test:test".into(),
            team: None,
            current_branch: None,
            completion_project_a_tags: vec![],
        }))
    }

    fn run(category: Option<AgentCategory>) -> SupervisorComponents {
        init_supervisor_and_hook(
            category,
            make_emit_state(),
            Arc::new(Mutex::new(Vec::new())),
            None,
            Arc::new(Vec::new()),
            Arc::new(Vec::new()),
            std::path::PathBuf::from("/tmp"),
            std::path::PathBuf::from("/tmp/conv.db"),
        )
    }

    /// Reproduces the bug where the static `agent_config.category` was re-parsed
    /// inside `init_supervisor_and_hook` instead of using the value resolved
    /// (and possibly backfilled) by the bootstrap. With backfill, the static
    /// config has `None` but the resolved value is `Some(Orchestrator)`; the
    /// resolved value must reach `ToolSet.agent_category` so the workspace
    /// restriction applies.
    #[tokio::test]
    async fn backfilled_orchestrator_propagates_to_supervisor_components() {
        let components = run(Some(AgentCategory::Orchestrator));
        assert_eq!(
            components.agent_category,
            Some(AgentCategory::Orchestrator)
        );
        assert!(components.allows_delegation);
        assert!(components.delegate_tool.is_some());
    }

    #[tokio::test]
    async fn backfilled_principal_propagates_to_supervisor_components() {
        let components = run(Some(AgentCategory::Principal));
        assert_eq!(components.agent_category, Some(AgentCategory::Principal));
        assert!(components.allows_delegation);
        assert!(components.delegate_tool.is_some());
    }

    #[tokio::test]
    async fn worker_can_delegate() {
        let components = run(Some(AgentCategory::Worker));
        assert_eq!(components.agent_category, Some(AgentCategory::Worker));
        assert!(components.allows_delegation);
        assert!(components.delegate_tool.is_some());
    }

    #[tokio::test]
    async fn domain_expert_cannot_delegate() {
        let components = run(Some(AgentCategory::DomainExpert));
        assert_eq!(
            components.agent_category,
            Some(AgentCategory::DomainExpert)
        );
        assert!(!components.allows_delegation);
        assert!(components.delegate_tool.is_none());
    }

    #[tokio::test]
    async fn unresolved_category_defaults_to_unrestricted() {
        let components = run(None);
        assert_eq!(components.agent_category, None);
        assert!(components.allows_delegation);
        assert!(components.delegate_tool.is_some());
    }
}
