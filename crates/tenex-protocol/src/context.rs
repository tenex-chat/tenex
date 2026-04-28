//! Resolved primitives needed to encode an intent into a wire message.
//!
//! Higher-layer services (ConversationStore, delegation chain resolver, RAL
//! registry) populate this struct. The encoder consumes it as plain data — it
//! never reaches into globals.

use crate::refs::{ConversationRef, PrincipalRef, ProjectRef};

#[derive(Debug, Clone)]
pub struct EncodingContext {
    /// Project the message belongs to. Always tagged via `["a", "31933:…"]`.
    pub project: ProjectRef,
    /// Root of the conversation thread. `None` for delegation/ask/intervention
    /// (those events start fresh threads).
    pub conversation_root: Option<ConversationRef>,
    /// Pre-resolved completion p-tag recipient. The delegation chain may
    /// override the trigger when completions need to route up the stack.
    pub completion_recipient: Option<PrincipalRef>,
    /// Fallback recipient when `completion_recipient` is unset (direct conversations).
    pub triggering_principal: PrincipalRef,
    pub ral: u32,
    pub model: Option<String>,
    pub cost_usd: Option<f64>,
    pub execution_time_ms: Option<u64>,
    pub llm_runtime_ms: Option<u64>,
    /// Completion-only: total accumulated runtime for this RAL.
    pub llm_runtime_total_ms: Option<u64>,
    pub branch: Option<String>,
    pub team: Option<String>,
}
