//! Token-budget compaction.
//!
//! When the projected token count exceeds a configured fraction of the
//! model's context window, collapse the oldest user/assistant pairs into
//! a single summary marker message. The system prompt at index 0 and a
//! tail of recent turns are always preserved.

use crate::strategies::{CompactionSummarizer, ProjectionContext, Strategy};
use crate::tokens::estimate_message_tokens;
use crate::types::Message;
use async_trait::async_trait;
use std::sync::Arc;

const NAME: &str = "compaction";

pub struct CompactionToolStrategy {
    /// Trigger when projected tokens >= `threshold_ratio * max_context_tokens`.
    threshold_ratio: f64,
    /// Always preserve at least this many tail messages (after the system
    /// prompt) when compacting.
    keep_tail: usize,
    /// Optional LLM-backed summarizer. When present, compaction produces a
    /// semantic 8-section summary. When absent, a deterministic placeholder
    /// is used as a fallback.
    summarizer: Option<Arc<dyn CompactionSummarizer>>,
}

impl CompactionToolStrategy {
    pub fn new(summarizer: Option<Arc<dyn CompactionSummarizer>>) -> Self {
        Self {
            threshold_ratio: 0.8,
            keep_tail: 6,
            summarizer,
        }
    }

    pub fn with_threshold_ratio(
        summarizer: Option<Arc<dyn CompactionSummarizer>>,
        threshold_ratio: f64,
    ) -> Self {
        let mut strategy = Self::new(summarizer);
        if threshold_ratio.is_finite() && threshold_ratio > 0.0 {
            strategy.threshold_ratio = threshold_ratio.min(1.0);
        }
        strategy
    }
}

impl Default for CompactionToolStrategy {
    fn default() -> Self {
        Self::new(None)
    }
}

/// Build a deterministic placeholder for when no LLM summarizer is available
/// or the LLM call fails.
fn deterministic_placeholder(messages: &[Message], conversation_id_hint: Option<&str>) -> String {
    let count = messages.len();
    let hint = conversation_id_hint
        .map(|id| format!(" Retrieve full transcript with `conversation_get {}`.", id))
        .unwrap_or_default();
    format!(
        "[Compacted context: {} prior messages condensed to fit context window.{hint}]",
        count
    )
}

#[async_trait]
impl Strategy for CompactionToolStrategy {
    fn name(&self) -> &'static str {
        NAME
    }

    async fn apply(&self, ctx: &mut ProjectionContext<'_>) -> anyhow::Result<()> {
        let max_tokens = ctx.model_profile.max_context_tokens;
        if max_tokens == 0 {
            return Ok(());
        }
        let threshold = (max_tokens as f64 * self.threshold_ratio).ceil() as usize;
        let total: usize = ctx.messages.iter().map(estimate_message_tokens).sum();
        if total <= threshold {
            return Ok(());
        }

        // Index 0 is the system prompt; preserve it and the trailing
        // window. Compact only the middle.
        let total_msgs = ctx.messages.len();
        if total_msgs <= 1 + self.keep_tail {
            return Ok(());
        }
        let mut compact_end = total_msgs - self.keep_tail;
        let compact_start = 1;
        compact_end = extend_over_split_tool_results(&ctx.messages, compact_start, compact_end);
        if compact_end <= compact_start {
            return Ok(());
        }

        let to_compact: Vec<Message> = ctx.messages[compact_start..compact_end].to_vec();
        let collapsed_count = to_compact.len();

        let summary_text = match &self.summarizer {
            Some(s) => match s.summarize(&to_compact).await {
                Ok(text) if !text.trim().is_empty() => text,
                _ => deterministic_placeholder(&to_compact, None),
            },
            None => deterministic_placeholder(&to_compact, None),
        };

        let summary = Message::User {
            content: summary_text,
        };

        ctx.messages.splice(compact_start..compact_end, [summary]);
        ctx.telemetry.compacted_count += collapsed_count;
        ctx.telemetry.strategies_applied.push(NAME.to_string());
        Ok(())
    }
}

fn extend_over_split_tool_results(
    messages: &[Message],
    compact_start: usize,
    mut compact_end: usize,
) -> usize {
    let compacted_tool_call_ids = messages[compact_start..compact_end]
        .iter()
        .flat_map(|msg| match msg {
            Message::Assistant { tool_calls, .. } => tool_calls
                .iter()
                .map(|tool_call| tool_call.id.as_str())
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        })
        .collect::<std::collections::HashSet<_>>();

    while let Some(Message::ToolResult { tool_call_id, .. }) = messages.get(compact_end) {
        if !compacted_tool_call_ids.contains(tool_call_id.as_str()) {
            break;
        }
        compact_end += 1;
    }

    compact_end
}

#[cfg(test)]
mod tests;
