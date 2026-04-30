//! Composable context-management strategies.
//!
//! Strategies operate on a mutable [`ProjectionContext`] holding the
//! in-flight messages, telemetry, and access to `tool_defs`. The default
//! pipeline is fixed: compaction → decay → reminders.

use crate::types::{Message, ModelProfile, ProjectionTelemetry, ToolDef};
use async_trait::async_trait;
use std::sync::Arc;

mod compaction;
mod decay;
mod reminders;

pub use compaction::CompactionToolStrategy;
pub use decay::ToolResultDecayStrategy;
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
    vec![
        Box::new(CompactionToolStrategy::new(summarizer)),
        Box::new(ToolResultDecayStrategy),
        Box::new(RemindersStrategy),
    ]
}
