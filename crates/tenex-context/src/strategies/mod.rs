//! Composable context-management strategies.
//!
//! Strategies operate on a mutable [`ProjectionContext`] holding the
//! in-flight messages, telemetry, and access to `tool_defs`. The default
//! pipeline is fixed: compaction → decay → reminders.

use crate::types::{Message, ModelProfile, ProjectionTelemetry, ToolDef};

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

pub trait Strategy {
    /// Strategy name, recorded in telemetry when the strategy mutates the
    /// context.
    fn name(&self) -> &'static str;
    fn apply(&self, ctx: &mut ProjectionContext<'_>) -> anyhow::Result<()>;
}

/// The default strategy stack, in the order they run.
///
/// Order is load-bearing: compaction first reduces volume, decay then
/// trims tool-result noise from what survived, reminders finally overlay
/// guidance onto the last visible message so it is never compacted or
/// decayed away.
pub fn default_stack() -> Vec<Box<dyn Strategy>> {
    vec![
        Box::new(CompactionToolStrategy::default()),
        Box::new(ToolResultDecayStrategy::default()),
        Box::new(RemindersStrategy::default()),
    ]
}
