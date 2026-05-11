//! LLM runtime accumulator used to populate the `llm-runtime` and
//! `llm-runtime-total` tags on outbound events. Mirrors the TypeScript
//! `ExecutionTimingTracker`.
//!
//! Lifecycle:
//!
//! - [`AgentMeta::start_stream`] records the stream start as both the
//!   live-stream baseline and the unreported-checkpoint.
//! - [`AgentMeta::consume_unreported`] folds any live-stream time
//!   accumulated since the last checkpoint into the running total,
//!   advances both the checkpoint and the last-reported watermark, and
//!   returns the delta.
//! - [`AgentMeta::end_stream`] folds the final tail of stream time into
//!   the total and clears the stream baseline. Idempotent — calling it
//!   when no stream is active is a no-op so callers can safely end the
//!   stream at handoff (e.g. tool-call) and again at the rig
//!   `on_stream_completion_response_finish` hook without double-counting.
//!
//! All timestamps use [`Instant`] (monotonic) so a wall-clock adjustment
//! mid-turn cannot retract accumulated runtime.

use std::time::Instant;

/// RAL turn counter across all turns of a single agent invocation, plus
/// the LLM runtime accumulator.
pub struct AgentMeta {
    pub ral: u32,
    llm_stream_start: Option<Instant>,
    last_checkpoint: Option<Instant>,
    accumulated_ms: u64,
    last_reported_ms: u64,
}

impl AgentMeta {
    pub fn new() -> Self {
        Self {
            ral: 0,
            llm_stream_start: None,
            last_checkpoint: None,
            accumulated_ms: 0,
            last_reported_ms: 0,
        }
    }

    pub fn start_stream(&mut self, now: Instant) {
        self.llm_stream_start = Some(now);
        self.last_checkpoint = Some(now);
    }

    /// Fold the final tail of stream time into the accumulator and clear
    /// the stream baseline. No-op if no stream is currently active, so
    /// callers may invoke this at multiple points (tool-call handoff,
    /// rig finish hook) without double-counting.
    pub fn end_stream(&mut self, now: Instant) {
        if self.llm_stream_start.is_some() {
            let checkpoint = self
                .last_checkpoint
                .unwrap_or_else(|| self.llm_stream_start.expect("stream start is Some"));
            self.accumulated_ms = self
                .accumulated_ms
                .saturating_add(elapsed_ms(now, checkpoint));
            self.llm_stream_start = None;
            self.last_checkpoint = None;
        }
    }

    /// Roll the live mid-stream slice into `accumulated_ms` (so callers
    /// emitting mid-stream events see up-to-date runtime), advance the
    /// reported watermark, and return the delta. Returns `None` when the
    /// delta is zero so callers can leave the `llm-runtime` field unset
    /// rather than emit `0`.
    pub fn consume_unreported(&mut self, now: Instant) -> Option<u64> {
        if self.llm_stream_start.is_some() {
            let checkpoint = self
                .last_checkpoint
                .unwrap_or_else(|| self.llm_stream_start.expect("stream start is Some"));
            self.accumulated_ms = self
                .accumulated_ms
                .saturating_add(elapsed_ms(now, checkpoint));
            self.last_checkpoint = Some(now);
        }
        let unreported = self.accumulated_ms.saturating_sub(self.last_reported_ms);
        self.last_reported_ms = self.accumulated_ms;
        if unreported > 0 {
            Some(unreported)
        } else {
            None
        }
    }

    pub fn accumulated_with_live(&self, now: Instant) -> u64 {
        let mut total = self.accumulated_ms;
        if self.llm_stream_start.is_some() {
            let checkpoint = self
                .last_checkpoint
                .unwrap_or_else(|| self.llm_stream_start.expect("stream start is Some"));
            total = total.saturating_add(elapsed_ms(now, checkpoint));
        }
        total
    }
}

fn elapsed_ms(now: Instant, earlier: Instant) -> u64 {
    now.saturating_duration_since(earlier).as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn fresh_meta() -> AgentMeta {
        AgentMeta::new()
    }

    #[test]
    fn no_stream_returns_none() {
        let mut m = fresh_meta();
        assert_eq!(m.consume_unreported(Instant::now()), None);
        assert_eq!(m.accumulated_with_live(Instant::now()), 0);
    }

    #[test]
    fn mid_stream_consume_returns_live_slice_and_advances_checkpoint() {
        let mut m = fresh_meta();
        let t0 = Instant::now();
        m.start_stream(t0);
        let t1 = t0 + Duration::from_millis(25);
        let first = m.consume_unreported(t1).unwrap();
        assert_eq!(first, 25);
        // Second consume immediately at the same instant sees zero new
        // slice and returns None — the checkpoint was advanced.
        assert_eq!(m.consume_unreported(t1), None);
        let t2 = t1 + Duration::from_millis(10);
        let second = m.consume_unreported(t2).unwrap();
        assert_eq!(second, 10);
        assert_eq!(m.accumulated_with_live(t2), 35);
    }

    #[test]
    fn end_stream_does_not_double_count() {
        // Mirrors RALRegistry.test.ts:1473 "should not double-count runtime
        // after endLLMStream".
        let mut m = fresh_meta();
        let t0 = Instant::now();
        m.start_stream(t0);
        let t1 = t0 + Duration::from_millis(50);
        let consumed_during = m.consume_unreported(t1).unwrap();
        let t2 = t1 + Duration::from_millis(20);
        m.end_stream(t2);
        let consumed_after = m.consume_unreported(t2 + Duration::from_millis(5));
        assert_eq!(consumed_during, 50);
        assert_eq!(consumed_after, Some(20));
        assert_eq!(m.accumulated_with_live(t2 + Duration::from_millis(5)), 70);
    }

    #[test]
    fn end_stream_is_idempotent() {
        // Calling end_stream twice (e.g. once at on_tool_call, once at
        // on_stream_completion_response_finish) must not double-count.
        let mut m = fresh_meta();
        let t0 = Instant::now();
        m.start_stream(t0);
        let t1 = t0 + Duration::from_millis(40);
        m.end_stream(t1);
        // Second end at a later instant: ignored.
        m.end_stream(t1 + Duration::from_millis(100));
        assert_eq!(m.accumulated_with_live(t1 + Duration::from_millis(200)), 40);
    }

    #[test]
    fn multi_stream_accumulates() {
        // Mirrors RALRegistry.test.ts:1505 "should accumulate runtime across
        // multiple streams".
        let mut m = fresh_meta();
        let t0 = Instant::now();
        m.start_stream(t0);
        let t1 = t0 + Duration::from_millis(30);
        m.end_stream(t1);
        let after_first = m.consume_unreported(t1).unwrap();
        assert_eq!(after_first, 30);

        // Second stream begins later.
        let t2 = t1 + Duration::from_millis(100);
        m.start_stream(t2);
        let t3 = t2 + Duration::from_millis(40);
        m.end_stream(t3);
        let after_second = m.consume_unreported(t3).unwrap();
        assert_eq!(after_second, 40);

        assert_eq!(m.accumulated_with_live(t3), 70);
    }
}
