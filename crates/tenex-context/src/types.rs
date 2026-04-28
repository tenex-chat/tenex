//! Public types for `tenex-context`.
//!
//! These describe the projection of conversation history into the
//! `messages[]` half of an LLM request, plus the per-turn write-back
//! payload used to update frozen prompt-history.
//!
//! Types are intentionally minimal: this crate represents role + content
//! + tool linkage, not provider-specific message shapes. The agent runner
//!
//! is responsible for translating [`Message`] into the concrete shape its
//! LLM client expects.

use serde::{Deserialize, Serialize};

/// Provider/model capability profile. Drives strategy decisions and cache
/// breakpoint emission. Today these capability flags are scattered and
/// implicit; making them explicit here kills a class of provider-specific
/// projection bugs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProfile {
    pub provider: String,
    pub model_id: String,
    /// Provider supports prompt caching for the message stream.
    pub prompt_cache: bool,
    /// Provider supports ephemeral reminder overlays (vs. inline durable).
    pub ephemeral_reminders: bool,
    /// Provider accepts image content in messages.
    pub image_support: bool,
    /// Maximum context window in tokens. Used by compaction.
    pub max_context_tokens: usize,
}

/// Tool definition relevant to projection.
///
/// `preserve_results` is the no-decay flag: when set, the decay strategy
/// excludes results of that tool from eviction. Declared by the tool
/// author; resolved by lookup against `tool_defs` passed into [`crate::project`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub preserve_results: bool,
}

/// One message in the projection. Provider-agnostic; the agent runner
/// converts this into the shape its LLM client expects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Message {
    System {
        content: String,
    },
    User {
        content: String,
    },
    Assistant {
        content: String,
        /// Tool calls emitted by the assistant on this turn, if any.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ToolCall>,
    },
    /// Tool result tied back to a prior assistant tool call.
    ToolResult {
        /// Identifier of the originating call (matches [`ToolCall::id`]).
        tool_call_id: String,
        /// Name of the originating tool. Carried at projection-build time
        /// so decay can resolve `preserve_results` without re-querying
        /// storage during projection.
        tool_name: String,
        content: String,
        #[serde(default, skip_serializing_if = "is_false")]
        is_error: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

fn is_false(b: &bool) -> bool {
    !b
}

/// Cache breakpoint hint at a position in the projected `messages` array.
///
/// The agent runner attaches provider-specific cache controls at these
/// positions. This crate names *where* and *what kind*; the runner does
/// the protocol mechanics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BreakpointHint {
    /// Index into `Projection::messages`.
    pub position: usize,
    pub kind: BreakpointKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BreakpointKind {
    /// Anchor at the system-prompt boundary. Always emitted.
    SystemAnchor,
    /// Anchor inside the message stream. Gated on
    /// [`ModelProfile::prompt_cache`].
    MessageStream,
}

/// Telemetry from a single projection. Names which strategies fired and
/// how much was evicted, for observability and tests.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectionTelemetry {
    pub strategies_applied: Vec<String>,
    pub evicted_count: usize,
    pub compacted_count: usize,
    pub reminders_overlayed: usize,
}

/// Result of [`crate::project`]: messages to send + cache hints + telemetry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Projection {
    pub messages: Vec<Message>,
    pub cache_breakpoints: Vec<BreakpointHint>,
    pub telemetry: ProjectionTelemetry,
}

/// Per-turn write-back payload. The agent runner reports what was actually
/// sent and what the provider observed; [`crate::record_turn`] persists it
/// into `tenex-conversations`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnRecord {
    pub messages_visible: Vec<Message>,
    pub reminders_applied: Vec<String>,
    pub compaction_decisions: Vec<String>,
    pub cache_observed: CacheObservation,
}

/// Cache outcome from a single provider call.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CacheObservation {
    pub hit_tokens: u64,
    pub miss_tokens: u64,
    pub written_tokens: u64,
}
