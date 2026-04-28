//! Token-budget compaction.
//!
//! When the projected token count exceeds a configured fraction of the
//! model's context window, collapse the oldest user/assistant pairs into
//! a single summary marker message. The system prompt at index 0 and a
//! tail of recent turns are always preserved.

use crate::strategies::{ProjectionContext, Strategy};
use crate::tokens::estimate_message_tokens;
use crate::types::Message;

const NAME: &str = "compaction";

pub struct CompactionToolStrategy {
    /// Trigger when projected tokens >= `threshold_ratio * max_context_tokens`.
    threshold_ratio: f64,
    /// Always preserve at least this many tail messages (after the system
    /// prompt) when compacting.
    keep_tail: usize,
}

impl Default for CompactionToolStrategy {
    fn default() -> Self {
        Self {
            threshold_ratio: 0.8,
            keep_tail: 6,
        }
    }
}

impl Strategy for CompactionToolStrategy {
    fn name(&self) -> &'static str {
        NAME
    }

    fn apply(&self, ctx: &mut ProjectionContext<'_>) -> anyhow::Result<()> {
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
        let compact_end = total_msgs - self.keep_tail;
        let compact_start = 1;
        if compact_end <= compact_start {
            return Ok(());
        }

        let collapsed_count = compact_end - compact_start;
        let summary = Message::User {
            content: format!(
                "[compacted summary: {} prior messages elided to fit context window]",
                collapsed_count
            ),
        };

        ctx.messages.splice(compact_start..compact_end, [summary]);
        ctx.telemetry.compacted_count += collapsed_count;
        ctx.telemetry.strategies_applied.push(NAME.to_string());
        Ok(())
    }
}
