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

/// Lifecycle state of a delegation, as observed by the *parent* (delegator)
/// agent. Mirrors the TypeScript `DelegationMarker.status` field. The
/// parent's conversation gains one marker row per state transition
/// (initially `Pending`, then `Completed` or `Aborted`), so the
/// projection layer can lazily render the full delegation lifecycle as a
/// `# DELEGATION COMPLETED` (or `# DELEGATION IN PROGRESS` / `# DELEGATION
/// ABORTED`) block carrying the child conversation transcript.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DelegationStatus {
    Pending,
    Completed,
    Aborted,
}

impl DelegationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DelegationStatus::Pending => "pending",
            DelegationStatus::Completed => "completed",
            DelegationStatus::Aborted => "aborted",
        }
    }
}

/// Marker row inserted into the *parent* (delegator) agent's
/// conversation to track an outgoing delegation. Persisted as a row in
/// the `messages` table with `message_type = "delegation-marker"`,
/// `content = ""`, and the marker payload in the `delegation_marker`
/// JSON column. Projection's `ExpandDelegationMarkersStrategy` reads
/// these rows and lazily expands them into the `# DELEGATION ...`
/// rendering carrying the child conversation transcript.
///
/// Mirrors the TypeScript `DelegationMarker` shape that drove the same
/// behaviour pre-Rust port (`src/conversations/types.ts:21-36` in the
/// final TS commit).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DelegationMarker {
    /// The child conversation's id (which IS the delegation Nostr event
    /// id, in our Nostr-rooted conversation model). Identifies the
    /// delegation across the parent and child stores.
    pub delegation_conversation_id: String,
    /// Pubkey of the agent the parent delegated to.
    pub recipient_pubkey: String,
    /// The parent conversation's id. Set so the projection can tell
    /// "direct child of this conversation" vs "nested deeper down" —
    /// only direct children get full-transcript expansion to avoid
    /// exponential context bloat on multi-level delegations.
    pub parent_conversation_id: String,
    /// When the delegation was created. Unix seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initiated_at: Option<i64>,
    /// When the delegation finished (`Completed` or `Aborted`). Unix
    /// seconds. Always `None` for `Pending`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    pub status: DelegationStatus,
    /// Aborted-only narrative. `None` for `Pending` and `Completed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abort_reason: Option<String>,
}

/// One image (or other binary) attachment hanging off a `messages` row.
/// Carried as a separate row in `message_attachments` so the BLOB
/// payload doesn't bloat list queries on the `messages` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentRecord {
    pub id: i64,
    pub message_id: i64,
    pub ordinal: i64,
    pub media_type: String,
    pub data: Vec<u8>,
    pub source_url: Option<String>,
    pub created_at: i64,
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

/// One snapshot of a file an agent wrote via `fs_write`, captured at write
/// time so a later run of the same agent in the same conversation can detect
/// external modifications. Keyed by `(conversation_id, agent_pubkey,
/// file_path)` (upsert; last write wins). `file_path` is stored exactly as the
/// agent passed it to `fs_write` (relative to the working directory), so the
/// reader re-resolves it against the same working directory it would for a
/// write. `content_bytes` is the verbatim written bytes when ≤ 50 KB, else
/// `None`; `content_hash` is always the SHA-256 hex of the full content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSnapshot {
    pub id: i64,
    pub conversation_id: String,
    pub agent_pubkey: String,
    pub execution_id: String,
    pub file_path: String,
    pub content_hash: String,
    pub content_bytes: Option<Vec<u8>>,
    pub size_bytes: i64,
    pub recorded_at: i64,
}

/// Input shape for [`crate::store::ConversationStore::record_file_snapshot`].
#[derive(Debug, Clone)]
pub struct NewFileSnapshot {
    pub agent_pubkey: String,
    pub execution_id: String,
    pub file_path: String,
    pub content_hash: String,
    pub content_bytes: Option<Vec<u8>>,
    pub size_bytes: i64,
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
