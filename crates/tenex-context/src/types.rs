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
        /// Provider reasoning blocks that must be replayed before later tool
        /// calls for providers with strict ordering requirements.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        reasoning: Vec<ReasoningBlock>,
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
        /// Provider-native call identifier, distinct from TENEX's internal
        /// `tool_call_id`. Some APIs require this on the result message.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_call_id: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        is_error: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningBlock {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_call_id: Option<String>,
    pub name: String,
    pub arguments: serde_json::Value,
}

fn is_false(b: &bool) -> bool {
    !b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_deserializes_without_provider_fields() {
        let assistant: Message = serde_json::from_value(serde_json::json!({
            "role": "assistant",
            "content": "done",
            "tool_calls": [{
                "id": "call-1",
                "name": "shell",
                "arguments": { "command": "true" }
            }]
        }))
        .expect("old assistant message shape");

        let Message::Assistant {
            reasoning,
            tool_calls,
            ..
        } = assistant
        else {
            panic!("expected assistant");
        };
        assert!(reasoning.is_empty());
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].provider_call_id, None);

        let tool_result: Message = serde_json::from_value(serde_json::json!({
            "role": "toolresult",
            "tool_call_id": "call-1",
            "tool_name": "shell",
            "content": "ok",
            "is_error": false
        }))
        .expect("old tool result message shape");

        let Message::ToolResult {
            provider_call_id, ..
        } = tool_result
        else {
            panic!("expected tool result");
        };
        assert_eq!(provider_call_id, None);
    }
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

/// Options for projecting persisted conversation history plus any in-flight
/// messages accumulated inside the current turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectionOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub in_turn_tail: Vec<Message>,
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
    /// Cache breakpoint hints observed during this turn. Non-empty only when
    /// the provider reported a cache hit (`hit_tokens > 0`), recording the
    /// position in `messages_visible` where the cache anchor was live.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub breakpoint_hints: Vec<BreakpointHint>,
}

/// Cache outcome from a single provider call.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CacheObservation {
    pub hit_tokens: u64,
    pub miss_tokens: u64,
    pub written_tokens: u64,
}
