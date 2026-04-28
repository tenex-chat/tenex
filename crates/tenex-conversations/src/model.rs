//! Typed row models. Thin wrappers over the SQL schema; structured fields
//! that the schema stores as JSON are exposed as `serde_json::Value` so the
//! library is not coupled to the runner's evolving message-shape types.

use serde::{Deserialize, Serialize};

/// One conversation header row. Field correspondence: `conversations.*`
/// columns plus the JSON sidecars exposed as `serde_json::Value`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationRow {
    pub id: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub last_user_message: Option<String>,
    pub status_label: Option<String>,
    pub status_current_activity: Option<String>,
    pub owner_pubkey: Option<String>,
    pub created_at: Option<i64>,
    pub last_activity: Option<i64>,
    pub metadata: serde_json::Value,
    pub runtime_state: serde_json::Value,
    pub updated_at: i64,
}

/// One materialized message. `record_id` is the canonical identity used by
/// prompt lineage (mirrors the TS `id` field, prefixed `record:...`). The
/// `nostr_event_id` is null for locally-originated rows until they are
/// published.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageRecord {
    pub id: i64,
    pub conversation_id: String,
    pub record_id: String,
    pub nostr_event_id: Option<String>,
    pub sequence: i64,
    pub author_pubkey: String,
    pub sender_pubkey: Option<String>,
    pub ral: Option<i64>,
    pub message_type: String,
    pub role: Option<String>,
    pub content: String,
    pub timestamp: Option<i64>,
    pub targeted_pubkeys: Option<Vec<String>>,
    pub sender_principal: Option<serde_json::Value>,
    pub targeted_principals: Option<serde_json::Value>,
    pub tool_data: Option<serde_json::Value>,
    pub delegation_marker: Option<serde_json::Value>,
    pub human_readable: Option<String>,
    pub transcript_tool_attributes: Option<serde_json::Value>,
    pub created_at: i64,
}

/// Input shape for `append_message`. `sequence` is assigned by the writer.
#[derive(Debug, Clone)]
pub struct NewMessage {
    pub record_id: String,
    pub nostr_event_id: Option<String>,
    pub author_pubkey: String,
    pub sender_pubkey: Option<String>,
    pub ral: Option<i64>,
    pub message_type: String,
    pub role: Option<String>,
    pub content: String,
    pub timestamp: Option<i64>,
    pub targeted_pubkeys: Option<Vec<String>>,
    pub sender_principal: Option<serde_json::Value>,
    pub targeted_principals: Option<serde_json::Value>,
    pub tool_data: Option<serde_json::Value>,
    pub delegation_marker: Option<serde_json::Value>,
    pub human_readable: Option<String>,
    pub transcript_tool_attributes: Option<serde_json::Value>,
}

/// One tool call + its result. Bodies are stored as `BLOB` to make the
/// schema agnostic to encoding choice (today JSON-as-bytes; tomorrow
/// possibly compressed). The library decodes/encodes as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolMessage {
    pub id: i64,
    pub conversation_id: String,
    pub tool_call_id: String,
    pub parent_message_id: Option<i64>,
    pub agent_pubkey: String,
    pub tool_name: String,
    pub call_input: serde_json::Value,
    pub result_output: Option<serde_json::Value>,
    pub is_error: bool,
    pub timestamp: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct NewToolMessage {
    pub tool_call_id: String,
    pub parent_message_id: Option<i64>,
    pub agent_pubkey: String,
    pub tool_name: String,
    pub call_input: serde_json::Value,
    pub result_output: Option<serde_json::Value>,
    pub is_error: bool,
    pub timestamp: Option<i64>,
}

/// One frozen prompt-history row. The replay timeline for an agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptHistoryEntry {
    pub id: i64,
    pub conversation_id: String,
    pub agent_pubkey: String,
    pub prompt_id: String,
    pub sequence: i64,
    pub role: String,
    pub source_kind: String,
    pub source_message_id: Option<String>,
    pub source_record_id: Option<String>,
    pub source_event_id: Option<String>,
    pub overlay_type: Option<String>,
    pub content: serde_json::Value,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct NewPromptHistoryEntry {
    pub agent_pubkey: String,
    pub prompt_id: String,
    pub sequence: i64,
    pub role: String,
    pub source_kind: String,
    pub source_message_id: Option<String>,
    pub source_record_id: Option<String>,
    pub source_event_id: Option<String>,
    pub overlay_type: Option<String>,
    pub content: serde_json::Value,
}

/// Frozen prompt message shape (mirror of the TS `FrozenPromptMessage`),
/// useful when replaying without going through the row model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrozenPromptMessage {
    pub id: String,
    pub role: String,
    pub content: serde_json::Value,
    pub source: FrozenPromptSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrozenPromptSource {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_record_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overlay_type: Option<String>,
}

/// Per-(agent, conversation) bookkeeping row. Holds pointers into
/// prompt-history, plus structured runtime state that the agent runner
/// already serializes (compaction, reminder state, todos, blocked flag,
/// meta-model override, self-applied skills).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentContextState {
    pub conversation_id: String,
    pub agent_pubkey: String,
    pub next_prompt_sequence: i64,
    pub cache_anchored: bool,
    pub seen_message_ids: Vec<String>,
    pub compaction_state: Option<serde_json::Value>,
    pub reminder_state: Option<serde_json::Value>,
    pub reminder_delta_state: Option<serde_json::Value>,
    pub todos: Option<serde_json::Value>,
    pub self_applied_skills: Option<serde_json::Value>,
    pub meta_model_variant: Option<String>,
    pub is_blocked: bool,
    pub todo_nudged: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CompletionStatus {
    Completed,
    Aborted,
}

impl CompletionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CompletionStatus::Completed => "completed",
            CompletionStatus::Aborted => "aborted",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "completed" => Some(CompletionStatus::Completed),
            "aborted" => Some(CompletionStatus::Aborted),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Completion {
    pub id: i64,
    pub conversation_id: String,
    pub root_event_id: Option<String>,
    pub completed_by_pubkey: String,
    pub recipient_pubkey: Option<String>,
    pub status: CompletionStatus,
    pub abort_reason: Option<String>,
    pub nostr_event_id: Option<String>,
    pub completed_at: i64,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct NewCompletion {
    pub root_event_id: Option<String>,
    pub completed_by_pubkey: String,
    pub recipient_pubkey: Option<String>,
    pub status: CompletionStatus,
    pub abort_reason: Option<String>,
    pub nostr_event_id: Option<String>,
    pub completed_at: i64,
    pub metadata: Option<serde_json::Value>,
}
