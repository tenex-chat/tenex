//! Composable context-management strategies.
//!
//! Strategies operate on a mutable [`ProjectionContext`] holding the
//! in-flight messages, telemetry, and access to `tool_defs`. The default
//! pipeline is fixed: compaction → decay → delegation_markers →
//! proactive_context → reminders.

use std::collections::HashMap;

use crate::CompactionOverride;
use crate::projection::DisplayNameResolver;
use crate::types::{Message, ModelProfile, ProjectionTelemetry, ToolDef};
use async_trait::async_trait;
use std::sync::Arc;
use tenex_conversations::MessageRecord;

mod compaction;
mod decay;
mod delegation_markers;
mod proactive;
mod reminders;

pub use compaction::CompactionToolStrategy;
pub use decay::ToolResultDecayStrategy;
pub use delegation_markers::ExpandDelegationMarkersStrategy;
pub use proactive::ProactiveContextStrategy;
pub use reminders::RemindersStrategy;

/// Mutable working state passed through the strategy pipeline.
pub struct ProjectionContext<'a> {
    /// Messages produced from history; mutated in place by strategies.
    /// Index 0 is the system prompt.
    pub messages: Vec<Message>,
    pub telemetry: ProjectionTelemetry,
    pub model_profile: &'a ModelProfile,
    pub tool_defs: &'a [ToolDef],
    /// Agent todos from `agent_context_state.todos_json`, used by the
    /// reminders strategy to inject the `<agent-todos>` block.
    pub agent_todos: Option<serde_json::Value>,
    /// Pre-computed `<proactive-context>` block (typically RAG output
    /// against the trigger event). Threaded into every step's projection
    /// unchanged so the system prompt stays stable and the prompt cache
    /// remains warm. `None` when no proactive context is configured.
    pub proactive_context: Option<&'a str>,
    /// Pre-loaded child conversation transcripts, keyed by
    /// `delegation_conversation_id`. Populated synchronously by
    /// `project` before the async strategy pipeline runs
    /// (the SQLite store is `!Send` so we can't hold it across an
    /// `.await`). [`ExpandDelegationMarkersStrategy`] consumes this
    /// map to render each marker's `### Transcript:` block. Markers
    /// whose `delegation_conversation_id` is absent here fall back to
    /// an empty `<conversation>` rendering.
    pub delegation_transcripts: HashMap<String, Vec<MessageRecord>>,
    /// The current conversation id. Lets [`ExpandDelegationMarkersStrategy`]
    /// distinguish "direct child of this conversation" markers (full
    /// transcript) from "nested deeper" markers (one-line reference).
    pub conversation_id: &'a str,
    /// Resolves pubkeys to display names for transcript attribution.
    /// Same resolver `project_messages` used for multi-author user
    /// prefixing — passed through so the same names appear inside the
    /// embedded `<conversation>` XML.
    pub name_resolver: Option<&'a dyn DisplayNameResolver>,
}

/// Async callback used by [`CompactionToolStrategy`] to generate a semantic
/// summary of the messages being compacted.
///
/// The trait is intentionally minimal: callers implement it with access to
/// a real LLM client; the context crate itself has no LLM dependency.
/// If no summarizer is available (e.g., no API key configured), the
/// compaction strategy falls back to a deterministic placeholder.
#[async_trait]
pub trait CompactionSummarizer: Send + Sync {
    /// Summarise the given messages into a single high-signal text block.
    ///
    /// The messages are the subset being compacted (between the system
    /// prompt and the preserved tail). The returned string will be used as
    /// the content of the summary marker message inserted in their place.
    async fn summarize(&self, messages: &[Message]) -> anyhow::Result<String>;
}

#[async_trait]
pub trait Strategy: Send + Sync {
    /// Strategy name, recorded in telemetry when the strategy mutates the
    /// context.
    fn name(&self) -> &'static str;
    async fn apply(&self, ctx: &mut ProjectionContext<'_>) -> anyhow::Result<()>;
}

/// The default strategy stack, in the order they run.
///
/// Order is load-bearing: compaction first reduces volume, decay then
/// trims tool-result noise from what survived, reminders finally overlay
/// guidance onto the last visible message so it is never compacted or
/// decayed away.
///
/// `summarizer` is used by the compaction strategy to produce semantic
/// summaries. If `None`, compaction falls back to a deterministic
/// placeholder.
pub fn default_stack(summarizer: Option<Arc<dyn CompactionSummarizer>>) -> Vec<Box<dyn Strategy>> {
    stack_with_compaction_override(summarizer, None)
}

pub fn stack_with_compaction_override(
    summarizer: Option<Arc<dyn CompactionSummarizer>>,
    compaction_override: Option<&CompactionOverride>,
) -> Vec<Box<dyn Strategy>> {
    let compaction = match compaction_override {
        Some(override_) => {
            CompactionToolStrategy::with_threshold_ratio(summarizer, override_.threshold_ratio)
        }
        None => CompactionToolStrategy::new(summarizer),
    };
    vec![
        Box::new(compaction),
        Box::new(ToolResultDecayStrategy),
        // Delegation marker expansion produces user-shaped messages
        // that downstream strategies (proactive, reminders) can then
        // legitimately overlay onto. Must run before those.
        Box::new(ExpandDelegationMarkersStrategy),
        Box::new(ProactiveContextStrategy),
        Box::new(RemindersStrategy),
    ]
}
