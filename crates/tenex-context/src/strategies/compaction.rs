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

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(max_tokens: usize) -> ModelProfile {
        ModelProfile {
            provider: "test".into(),
            model_id: "test-model".into(),
            prompt_cache: false,
            ephemeral_reminders: false,
            image_support: false,
            max_context_tokens: max_tokens,
        }
    }

    /// Build a context with a system prompt followed by `n` user messages
    /// each with `content` of the given string (repeated to hit token budgets).
    use crate::types::{ModelProfile, ProjectionTelemetry};

    fn ctx_with_messages<'a>(
        system: &str,
        user_msgs: &[&str],
        p: &'a ModelProfile,
    ) -> ProjectionContext<'a> {
        let mut messages = vec![Message::System { content: system.to_string() }];
        for u in user_msgs {
            messages.push(Message::User { content: u.to_string() });
        }
        ProjectionContext {
            messages,
            telemetry: ProjectionTelemetry::default(),
            model_profile: p,
            tool_defs: &[],
            agent_todos: None,
        }
    }

    #[test]
    fn no_compaction_below_threshold() {
        let p = profile(1000); // threshold = 800
        // System(4 chars) + 3 user(4 chars each) = 5 tokens total — far below 800
        let mut ctx = ctx_with_messages("sys.", &["msg1", "msg2", "msg3"], &p);
        CompactionToolStrategy::default().apply(&mut ctx).unwrap();
        assert_eq!(ctx.telemetry.compacted_count, 0);
        assert_eq!(ctx.messages.len(), 4); // unchanged
    }

    #[test]
    fn no_compaction_when_zero_max_tokens() {
        let p = profile(0);
        let mut ctx = ctx_with_messages("sys", &["a", "b", "c"], &p);
        CompactionToolStrategy::default().apply(&mut ctx).unwrap();
        assert_eq!(ctx.telemetry.compacted_count, 0);
    }

    #[test]
    fn compaction_collapses_middle_and_preserves_head_and_tail() {
        // Each message is 40 chars = 10 tokens (ceil(40/4)).
        // max_context_tokens = 100, threshold = 80.
        // System(10) + 9 user(10 each) = 100 tokens > 80 → triggers.
        // total_msgs = 10, keep_tail = 6
        // compact_end = 10 - 6 = 4, compact_start = 1
        // Messages[1..4] (3 messages) → 1 summary
        // Final message count: 1(sys) + 1(summary) + 6(tail) = 8
        let p = profile(100);
        let user_msgs: Vec<&str> = (0..9).map(|_| "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").collect();
        let sys_content = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 40 chars
        let mut ctx = ctx_with_messages(sys_content, &user_msgs, &p);

        CompactionToolStrategy::default().apply(&mut ctx).unwrap();

        assert!(
            ctx.telemetry.compacted_count >= 1,
            "should compact at least 1 message, got {}",
            ctx.telemetry.compacted_count
        );
        // System prompt is always at index 0 and unchanged
        assert!(
            matches!(&ctx.messages[0], Message::System { content } if content == sys_content),
            "system prompt must be preserved at index 0"
        );
        // A summary marker was inserted
        let has_summary = ctx.messages.iter().any(|m| {
            matches!(m, Message::User { content } if content.starts_with("[compacted summary:"))
        });
        assert!(has_summary, "summary marker must be present");
        // Strategy recorded in telemetry
        assert!(ctx.telemetry.strategies_applied.contains(&"compaction".to_string()));
    }

    #[test]
    fn compaction_respects_keep_tail() {
        // Ensure the last `keep_tail` messages are never compacted.
        // Build enough messages to trigger compaction.
        let p = profile(100);
        // 40-char system + 14 user(40-char each) = 10 + 14*10 = 150 > 80
        let msgs: Vec<&str> = (0..14).map(|_| "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").collect();
        let tag = "SENTINEL_TAIL_MESSAGE_AAAAAAAAAAAAAAAAAAA"; // will be placed at the tail
        let mut ctx = ctx_with_messages("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", &msgs, &p);
        // Replace the last message with a sentinel so we can check it survived
        let last = ctx.messages.len() - 1;
        ctx.messages[last] = Message::User { content: tag.to_string() };

        CompactionToolStrategy::default().apply(&mut ctx).unwrap();

        let tail_survived = ctx.messages.iter().any(|m| {
            matches!(m, Message::User { content } if content == tag)
        });
        assert!(tail_survived, "last message in tail must survive compaction");
    }

    #[test]
    fn no_compaction_when_too_few_messages() {
        // keep_tail = 6, so total_msgs must be > 7 to have anything to compact.
        let p = profile(10); // very small budget
        // Only 4 messages total — can't compact (1 + keep_tail = 7 > 4)
        let mut ctx = ctx_with_messages("s", &["a", "b", "c"], &p);
        CompactionToolStrategy::default().apply(&mut ctx).unwrap();
        // Even if over threshold, can't compact fewer messages than required
        assert_eq!(ctx.telemetry.compacted_count, 0);
    }
}
