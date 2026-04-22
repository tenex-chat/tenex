//! Transport-neutral classification types shared across the Telegram adapter.
//!
//! `RuntimeEventClass` enumerates the `AgentPublisher` methods the worker can
//! invoke. It mirrors `TELEGRAM_RUNTIME_EVENT_CLASSES` on the TypeScript side
//! and is carried on `publish_request` frames so Rust can derive native
//! delivery without re-duplicating classifier logic from Nostr kind/tags.
//!
//! `ConversationVariant` splits the `conversation` class into `primary` and
//! `reasoning` because the TS Telegram publisher routes those variants
//! differently based on per-agent config (`publishConversationToTelegram`
//! vs `publishReasoningToTelegram`). Keeping it as a sub-axis (rather than
//! two classes) preserves the invariant that all `conversation`-class
//! frames are encoded by the same publisher method on the TS side.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Worker-reported runtime event classification attached to `publish_request`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEventClass {
    Complete,
    Conversation,
    Ask,
    Error,
    ToolUse,
    Delegation,
    DelegateFollowup,
    Lesson,
    StreamTextDelta,
}

impl RuntimeEventClass {
    /// Canonical wire-form string value.
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeEventClass::Complete => "complete",
            RuntimeEventClass::Conversation => "conversation",
            RuntimeEventClass::Ask => "ask",
            RuntimeEventClass::Error => "error",
            RuntimeEventClass::ToolUse => "tool_use",
            RuntimeEventClass::Delegation => "delegation",
            RuntimeEventClass::DelegateFollowup => "delegate_followup",
            RuntimeEventClass::Lesson => "lesson",
            RuntimeEventClass::StreamTextDelta => "stream_text_delta",
        }
    }

    /// All accepted wire-form values.
    pub const ALL_WIRE: &'static [&'static str] = &[
        "complete",
        "conversation",
        "ask",
        "error",
        "tool_use",
        "delegation",
        "delegate_followup",
        "lesson",
        "stream_text_delta",
    ];

    /// Parse from the wire value without pulling in the full serde pipeline.
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "complete" => Some(RuntimeEventClass::Complete),
            "conversation" => Some(RuntimeEventClass::Conversation),
            "ask" => Some(RuntimeEventClass::Ask),
            "error" => Some(RuntimeEventClass::Error),
            "tool_use" => Some(RuntimeEventClass::ToolUse),
            "delegation" => Some(RuntimeEventClass::Delegation),
            "delegate_followup" => Some(RuntimeEventClass::DelegateFollowup),
            "lesson" => Some(RuntimeEventClass::Lesson),
            "stream_text_delta" => Some(RuntimeEventClass::StreamTextDelta),
            _ => None,
        }
    }

    /// Whether this class permits a `conversationVariant` tag. Only
    /// `conversation` may (and must) carry one; any other class carrying a
    /// variant is a protocol violation.
    pub fn permits_conversation_variant(self) -> bool {
        matches!(self, RuntimeEventClass::Conversation)
    }
}

impl fmt::Display for RuntimeEventClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Sub-axis for `RuntimeEventClass::Conversation` frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationVariant {
    Primary,
    Reasoning,
}

impl ConversationVariant {
    pub fn as_str(self) -> &'static str {
        match self {
            ConversationVariant::Primary => "primary",
            ConversationVariant::Reasoning => "reasoning",
        }
    }

    pub const ALL_WIRE: &'static [&'static str] = &["primary", "reasoning"];

    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "primary" => Some(ConversationVariant::Primary),
            "reasoning" => Some(ConversationVariant::Reasoning),
            _ => None,
        }
    }
}

impl fmt::Display for ConversationVariant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_event_class_round_trip() {
        for wire in RuntimeEventClass::ALL_WIRE {
            let parsed = RuntimeEventClass::from_wire(wire).expect("every wire value parses");
            assert_eq!(parsed.as_str(), *wire);
        }
    }

    #[test]
    fn conversation_variant_permission_rule() {
        assert!(RuntimeEventClass::Conversation.permits_conversation_variant());
        for other in [
            RuntimeEventClass::Complete,
            RuntimeEventClass::Ask,
            RuntimeEventClass::Error,
            RuntimeEventClass::ToolUse,
            RuntimeEventClass::Delegation,
            RuntimeEventClass::DelegateFollowup,
            RuntimeEventClass::Lesson,
            RuntimeEventClass::StreamTextDelta,
        ] {
            assert!(!other.permits_conversation_variant());
        }
    }

    #[test]
    fn unknown_wire_value_rejected() {
        assert!(RuntimeEventClass::from_wire("publish").is_none());
        assert!(ConversationVariant::from_wire("debug").is_none());
    }
}
