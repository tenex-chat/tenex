//! Shared emission state: the channel, the conversation thread, the
//! token-counter accumulator. Both the prompt hook and the delegate tool
//! consume this through `Arc<EmitState>`.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tenex_protocol::{
    Channel, ConversationRef, EncodingContext, MessageRef, PrincipalRef, ProjectRef,
};

/// RAL turn counter across all turns of a single agent invocation.
pub struct AgentMeta {
    pub ral: u32,
}

impl AgentMeta {
    pub fn new() -> Self {
        Self { ral: 0 }
    }
}

/// Cloneable handle holding the immutable thread context plus the shared
/// counter. Cheap to share across hook + tools.
#[derive(Clone)]
pub struct EmitState {
    pub channel: Arc<dyn Channel>,
    pub project: ProjectRef,
    pub triggering_principal: PrincipalRef,
    pub triggering_message: Option<MessageRef>,
    pub conversation_root: Option<ConversationRef>,
    pub completion_recipient: Option<PrincipalRef>,
    pub model: String,
    /// Team scope from the inbound event's `["team", ...]` tag.
    pub team: Option<String>,
    pub meta: Arc<Mutex<AgentMeta>>,
    pending_external_work: Arc<AtomicBool>,
}

impl EmitState {
    pub fn new(
        channel: Arc<dyn Channel>,
        project: ProjectRef,
        triggering_principal: PrincipalRef,
        triggering_message: Option<MessageRef>,
        conversation_root: Option<ConversationRef>,
        completion_recipient: Option<PrincipalRef>,
        model: String,
        team: Option<String>,
    ) -> Self {
        Self {
            channel,
            project,
            triggering_principal,
            triggering_message,
            conversation_root,
            completion_recipient,
            model,
            team,
            meta: Arc::new(Mutex::new(AgentMeta::new())),
            pending_external_work: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn mark_pending_external_work(&self) {
        self.pending_external_work.store(true, Ordering::Release);
    }

    #[allow(dead_code)]
    pub fn has_pending_external_work(&self) -> bool {
        self.pending_external_work.load(Ordering::Acquire)
    }

    pub fn build_ctx(&self, ral: u32) -> EncodingContext {
        self.build_ctx_with_team(ral, self.team.clone())
    }

    /// Build an encoding context, overriding the team tag. Used by the
    /// delegate tool when delegating by team name — the outbound event must
    /// carry the resolved team name, not the inbound one.
    pub fn build_ctx_with_team(&self, ral: u32, team: Option<String>) -> EncodingContext {
        EncodingContext {
            project: self.project.clone(),
            conversation_root: self.conversation_root.clone(),
            triggering_message: self.triggering_message.clone(),
            completion_recipient: self.completion_recipient.clone(),
            triggering_principal: self.triggering_principal.clone(),
            ral,
            model: Some(self.model.clone()),
            cost_usd: None,
            execution_time_ms: None,
            llm_runtime_ms: None,
            llm_runtime_total_ms: None,
            branch: None,
            team,
        }
    }
}
