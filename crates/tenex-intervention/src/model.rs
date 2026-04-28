use serde::{Deserialize, Serialize};

/// Matches the TypeScript `PendingIntervention` interface.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingIntervention {
    pub conversation_id: String,
    /// Millisecond timestamp of the completion event.
    pub completed_at: u64,
    pub agent_pubkey: String,
    pub user_pubkey: String,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifiedEntry {
    pub conversation_id: String,
    /// Millisecond timestamp of when we sent the notification.
    pub notified_at: u64,
}

/// Top-level shape of `intervention_state_<dTag>.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InterventionState {
    #[serde(default)]
    pub pending: Vec<PendingIntervention>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notified: Option<Vec<NotifiedEntry>>,
}
