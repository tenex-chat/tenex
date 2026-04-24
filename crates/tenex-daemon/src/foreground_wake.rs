//! Cross-thread wake signal for the foreground maintenance loop.
//!
//! Some ingress events (notably project-boot) need the next maintenance tick
//! to run *now*, not after the foreground loop's next `sleep_ms` interval.
//! The ingress path flips the wake flag; the foreground sleeper checks it
//! inside its poll loop and returns early if set, letting maintenance run
//! immediately.
//!
//! This is a process-local singleton for two reasons:
//!   1. Keeps the signal out of every struct's constructor.
//!   2. Matches the existing `DAEMON_STOP_REQUESTED` / `DAEMON_RELOAD_REQUESTED`
//!      pattern in `bin/daemon.rs`.
//!
//! After the async-runtime migration (see docs/plans/…-async-runtime-migration.md
//! Phase 4) this becomes a `tokio::sync::watch` or `Notify`; the callers
//! don't change shape.

use std::sync::atomic::{AtomicBool, Ordering};

static FOREGROUND_WAKE_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Ask the foreground loop to stop sleeping and run maintenance on its next
/// poll. Idempotent — repeated calls between ticks coalesce into one wake.
pub fn request_wake() {
    FOREGROUND_WAKE_REQUESTED.store(true, Ordering::SeqCst);
}

/// Consume the wake flag: returns `true` exactly once per request_wake call
/// and clears the flag.
pub fn take_wake() -> bool {
    FOREGROUND_WAKE_REQUESTED.swap(false, Ordering::SeqCst)
}

/// Test-only: reset the flag without consuming. Needed when two tests live
/// in the same process and the previous test left the flag set.
#[cfg(test)]
pub fn reset_for_test() {
    FOREGROUND_WAKE_REQUESTED.store(false, Ordering::SeqCst);
}
