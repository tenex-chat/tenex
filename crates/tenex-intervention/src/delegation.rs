//! DelegationChecker trait and stub implementation.
//!
//! The real implementation will query `tenex-conversations` SQLite when that
//! crate provides delegation state. Until then, the stub treats "no info" as
//! "no active delegations" — the same semantics as the bun runtime being
//! offline at completion time.

pub trait DelegationChecker: Send + Sync {
    /// Returns true if the agent has active outgoing delegations in the given
    /// conversation (meaning the work is not yet complete from the user's POV).
    fn has_active_delegations(&self, agent_pubkey: &str, conversation_id: &str) -> bool;
}

/// Stub: always reports no active delegations.
pub struct StubDelegationChecker;

impl DelegationChecker for StubDelegationChecker {
    fn has_active_delegations(&self, _agent_pubkey: &str, _conversation_id: &str) -> bool {
        false
    }
}
