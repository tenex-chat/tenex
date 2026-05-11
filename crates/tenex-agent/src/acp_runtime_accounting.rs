//! Runtime-time accounting for the ACP session/prompt loop.
//!
//! In the ACP path the agent doesn't drive its own LLM streaming; it sits
//! across an ACP child process and receives stream updates. Each outbound
//! event carries the unreported wall-clock delta in `llm-runtime`, and
//! the final completion carries the full session total in
//! `llm-runtime-total`.
//!
//! This is wall-clock-based (not LLM-stream-based) because the ACP
//! protocol gives no signal for "LLM stream started/ended"; the relevant
//! accounting unit is the time spent in the prompt request.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// One-shot tracker scoped to a single ACP `session/prompt` request.
pub struct AcpRuntimeAccounting {
    stream_start: Instant,
    last_reported_ms: AtomicU64,
}

impl AcpRuntimeAccounting {
    pub fn started_now() -> Self {
        Self {
            stream_start: Instant::now(),
            last_reported_ms: AtomicU64::new(0),
        }
    }

    /// Compute the unreported elapsed-time delta since the session start,
    /// advance the watermark, and return `Some(delta_ms)` when nonzero.
    /// Returns `None` for a zero delta so callers can leave the
    /// `llm-runtime` field unset (mirrors the tag-filter contract: zero
    /// stays unset).
    pub fn take_delta(&self) -> Option<u64> {
        let elapsed_ms = self.stream_start.elapsed().as_millis() as u64;
        self.consume_at(elapsed_ms)
    }

    /// Atomically sample the final unreported delta and the session
    /// total from a single `Instant::now()` reading. Use at session
    /// completion so the summed per-event `llm-runtime` values cannot
    /// exceed `llm-runtime-total` due to a scheduling-induced gap
    /// between two separate samples.
    pub fn take_final(&self) -> (Option<u64>, u64) {
        let elapsed_ms = self.stream_start.elapsed().as_millis() as u64;
        let delta = self.consume_at(elapsed_ms);
        (delta, elapsed_ms)
    }

    fn consume_at(&self, elapsed_ms: u64) -> Option<u64> {
        let previous = self.last_reported_ms.swap(elapsed_ms, Ordering::AcqRel);
        let delta = elapsed_ms.saturating_sub(previous);
        if delta > 0 { Some(delta) } else { None }
    }
}
