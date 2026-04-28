//! Shared emission state: the channel, the conversation thread, the
//! token-counter accumulator. Both the prompt hook and the delegate tool
//! consume this through `Arc<EmitState>`.

use std::sync::{Arc, Mutex};
use tenex_protocol::{
    Channel, ConversationRef, EncodingContext, PrincipalRef, ProjectRef,
};

/// Token-and-RAL accumulator across all turns of a single agent invocation.
pub struct AgentMeta {
    pub ral: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cached_input_tokens: u64,
}

impl AgentMeta {
    pub fn new() -> Self {
        Self { ral: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_input_tokens: 0 }
    }
}

/// Cloneable handle holding the immutable thread context plus the shared
/// counter. Cheap to share across hook + tools.
#[derive(Clone)]
pub struct EmitState {
    pub channel: Arc<dyn Channel>,
    pub project: ProjectRef,
    pub triggering_principal: PrincipalRef,
    pub conversation_root: Option<ConversationRef>,
    pub model: String,
    pub meta: Arc<Mutex<AgentMeta>>,
}

impl EmitState {
    pub fn build_ctx(&self, ral: u32) -> EncodingContext {
        EncodingContext {
            project: self.project.clone(),
            conversation_root: self.conversation_root.clone(),
            completion_recipient: None,
            triggering_principal: self.triggering_principal.clone(),
            ral,
            model: Some(self.model.clone()),
            cost_usd: None,
            execution_time_ms: None,
            llm_runtime_ms: None,
            llm_runtime_total_ms: None,
            branch: None,
            team: None,
        }
    }
}
