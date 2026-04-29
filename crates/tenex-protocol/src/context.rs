//! Resolved primitives needed to encode an intent into a wire message.
//!
//! Higher-layer services (ConversationStore, delegation chain resolver, RAL
//! registry) populate this struct. The encoder consumes it as plain data — it
//! never reaches into globals.

use crate::refs::{ConversationRef, MessageRef, PrincipalRef, ProjectRef};

#[derive(Debug, Clone)]
pub struct EncodingContext {
    /// Project the message belongs to. Always tagged via `["a", "31933:…"]`.
    pub project: ProjectRef,
    /// Root of the current parent conversation. Fresh delegations still start
    /// a new thread without an `e` root, but carry this id in a `delegation`
    /// tag so runtimes can route child completions back to the parent context.
    pub conversation_root: Option<ConversationRef>,
    /// The event our reply should thread directly to. Emitted as an
    /// `["e", id, "", "reply"]` tag whenever `conversation_root` is present.
    /// May equal the root (when replying to the first message in a thread);
    /// the encoder emits the reply tag regardless.
    pub triggering_message: Option<MessageRef>,
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
