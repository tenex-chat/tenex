//! Per-event stdin frame for persistent ACP subprocesses.
//!
//! The TENEX runtime daemon writes one of these per inbound conversation
//! event to the long-lived `tenex-agent-acp` child. Wraps the Nostr event
//! with W3C trace propagation fields so each prompt gets its own dispatch
//! span instead of inheriting the process-startup trace baked into env
//! vars.

use nostr::Event;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpStdinFrame {
    pub event: Event,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traceparent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracestate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baggage: Option<String>,
    /// The principal who should receive the completion event for this
    /// dispatch. Differs from the envelope's `principal` field for
    /// delegated work: `principal` is the delegating agent, while this is
    /// the original requester to whom the final answer is addressed.
    /// Resolved on the daemon side by `select_dispatch_target` from the
    /// `DispatchJob.completion_recipient_pubkey`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_recipient_pubkey: Option<String>,
}

/// JSON key used by the persistent `tenex-agent-acp` child to signal that
/// a single `session/prompt` task has completed. The daemon's per-child
/// stdout reader watches for `{"<KEY>": "<triggering-event-id-hex>"}` lines
/// and resolves the matching completion listener.
///
/// This signal must always be emitted at the end of every prompt task —
/// including the `Conversation` (pending-external-work) case where there
/// is no `status: completed` Nostr event to pattern-match on.
pub const ACP_PROMPT_DONE_SENTINEL_KEY: &str = "_tenex_prompt_done";
