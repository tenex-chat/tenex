//! `tenex-conversations` — per-project SQLite conversation store.
//!
//! Owns all local conversation state for a TENEX project: materialized messages,
//! tool messages (large bodies inline), per-agent prompt history, per-agent
//! context-management state, and completion records.
//!
//! Storage layout: `<base_dir>/projects/<dTag>/conversation.db`. Single SQLite
//! file per project, opened directly by every consumer. WAL mode + busy-timeout.
//! Multi-reader / single-writer; writers are already serialized at the
//! orchestration layer (RAL).
//!
//! Schema is the contract. Versioned migrations live in [`schema`].

pub mod error;
pub mod ids;
pub mod migration;
pub mod model;
pub mod paths;
pub mod project;
pub mod schema;
pub mod store;

pub use error::{ConversationsError, Result};
pub use ids::normalize_project_id;
pub use model::{
    AgentContextState, Completion, CompletionStatus, FrozenPromptMessage, MessageRecord,
    NewCompletion, NewMessage, NewPromptHistoryEntry, NewToolMessage, PromptHistoryEntry,
    ToolMessage,
};
pub use project::Project;
pub use store::{ConversationListFilter, ConversationStore, MessageQuery};
