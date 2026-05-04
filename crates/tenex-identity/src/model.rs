use serde::{Deserialize, Serialize};

/// Resolved Nostr kind:0 identity for a pubkey.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityView {
    pub pubkey: String,
    pub display_name: Option<String>,
    pub name: Option<String>,
    pub nip05: Option<String>,
    pub picture: Option<String>,
    pub banner: Option<String>,
    pub about: Option<String>,
    pub lud16: Option<String>,
    /// TENEX-agent extension: short stable handle published in the kind:0
    /// content JSON under the `slug` key. Used by remote-backend agent
    /// listings so peers can be addressed by name rather than pubkey.
    pub slug: Option<String>,
    /// TENEX-agent extension: the agent's `use-criteria` event tag value
    /// (`["use-criteria", "<text>"]`). Tells callers when to delegate to
    /// this agent.
    pub use_criteria: Option<String>,
    /// TENEX-agent extension: the human-readable backend name from the
    /// `["backend", "<name>"]` event tag. Identifies which backend instance
    /// manages this agent so peers can label it in their agent lists.
    pub backend_name: Option<String>,
    pub event_id: Option<String>,
    /// Unix seconds from the kind:0 event's created_at field.
    pub created_at: Option<i64>,
    /// Unix seconds at which this row was fetched and cached.
    pub fetched_at: i64,
}

impl IdentityView {
    /// Best display name: display_name → name → shortened pubkey (first 8 hex chars).
    pub fn best_name(&self) -> &str {
        if let Some(dn) = &self.display_name {
            if !dn.trim().is_empty() {
                return dn.as_str();
            }
        }
        if let Some(n) = &self.name {
            if !n.trim().is_empty() {
                return n.as_str();
            }
        }
        // Shortened pubkey fallback — return a prefix of the stored pubkey.
        let end = self.pubkey.len().min(8);
        &self.pubkey[..end]
    }
}
