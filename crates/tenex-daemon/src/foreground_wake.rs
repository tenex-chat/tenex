//! Cross-thread wake signal for the foreground maintenance loop.
//!
//! Some ingress events (notably project-boot and project-index updates) need
//! the next maintenance tick to run *now*, not after the foreground loop's
//! next `sleep_ms` interval. The ingress path flips the wake flag; the
//! foreground sleeper checks it inside its poll loop and returns early if
//! set, letting maintenance run immediately.
//!
//! This is a process-local singleton for two reasons:
//!   1. Keeps the signal out of every struct's constructor.
//!   2. Matches the existing `DAEMON_STOP_REQUESTED` / `DAEMON_RELOAD_REQUESTED`
//!      pattern in `bin/daemon.rs`.
//!
//! The current implementation supports both sync sleepers and async loop
//! drivers: a process-local atomic flag keeps the sync path working, and a
//! Tokio `Notify` mirrors the same signal for async consumers.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use tokio::sync::Notify;

static FOREGROUND_WAKE_REQUESTED: AtomicBool = AtomicBool::new(false);
static FOREGROUND_WAKE_NOTIFY: OnceLock<Notify> = OnceLock::new();
const FOREGROUND_WAKE_POLL_INTERVAL: Duration = Duration::from_millis(100);

fn wake_notify() -> &'static Notify {
    FOREGROUND_WAKE_NOTIFY.get_or_init(Notify::new)
}

/// Ask the foreground loop to stop sleeping and run maintenance on its next
/// poll. Idempotent — repeated calls between ticks coalesce into one wake.
pub fn request_wake() {
    FOREGROUND_WAKE_REQUESTED.store(true, Ordering::SeqCst);
    wake_notify().notify_waiters();
}

/// Consume the wake flag: returns `true` exactly once per request_wake call
/// and clears the flag.
pub fn take_wake() -> bool {
    FOREGROUND_WAKE_REQUESTED.swap(false, Ordering::SeqCst)
}

/// Sleeps for up to `sleep_for`, but returns early when either a foreground
/// wake is requested or `should_stop()` reports shutdown.
pub fn sleep_with_wake<F>(sleep_for: Duration, mut should_stop: F)
where
    F: FnMut() -> bool,
{
    let mut remaining = sleep_for;
    while remaining > Duration::ZERO && !should_stop() {
        if take_wake() {
            return;
        }
        let step = remaining.min(FOREGROUND_WAKE_POLL_INTERVAL);
        thread::sleep(step);
        remaining = remaining.saturating_sub(step);
    }
}

/// Async counterpart to [`sleep_with_wake`]'s wake-consumption behavior.
/// Returns once a foreground wake has been requested, consuming that wake
/// exactly once across async and sync waiters.
pub async fn wait_for_wake() {
    loop {
        if take_wake() {
            return;
        }
        let notified = wake_notify().notified();
        if take_wake() {
            return;
        }
        notified.await;
    }
}

/// Test-only: reset the flag without consuming. Needed when two tests live
/// in the same process and the previous test left the flag set.
#[cfg(test)]
pub fn reset_for_test() {
    FOREGROUND_WAKE_REQUESTED.store(false, Ordering::SeqCst);
}

#[cfg(test)]
static FOREGROUND_WAKE_TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub fn lock_for_test() -> std::sync::MutexGuard<'static, ()> {
    FOREGROUND_WAKE_TEST_MUTEX
        .lock()
        .expect("foreground wake test mutex must not be poisoned")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn sleep_with_wake_returns_early_after_request() {
        let _guard = lock_for_test();
        reset_for_test();

        let wake_thread = thread::spawn(|| {
            thread::sleep(Duration::from_millis(25));
            request_wake();
        });

        let started_at = Instant::now();
        sleep_with_wake(Duration::from_secs(1), || false);
        wake_thread.join().expect("wake thread must join");

        assert!(
            started_at.elapsed() < Duration::from_millis(500),
            "sleep should exit promptly after foreground wake"
        );

        reset_for_test();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_for_wake_returns_after_request() {
        let _guard = lock_for_test();
        reset_for_test();

        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(25)).await;
            request_wake();
        });

        let started_at = Instant::now();
        wait_for_wake().await;

        assert!(
            started_at.elapsed() < Duration::from_millis(500),
            "async wait should exit promptly after foreground wake"
        );

        reset_for_test();
    }
}
