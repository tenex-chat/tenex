//! Process-local wake signal for the async publish-outbox drainer.
//!
//! Publish requests are still accepted synchronously into the filesystem
//! outbox. This singleton lets those sync acceptance paths wake the Tokio
//! outbox-drain task immediately without threading a notifier through every
//! call site.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

static PUBLISH_OUTBOX_DRAIN_REQUESTED: AtomicBool = AtomicBool::new(false);
static PUBLISH_OUTBOX_DRAIN_NOTIFY: OnceLock<Notify> = OnceLock::new();

fn drain_notify() -> &'static Notify {
    PUBLISH_OUTBOX_DRAIN_NOTIFY.get_or_init(Notify::new)
}

/// Request a publish-outbox drain. Repeated calls coalesce until a waiter
/// consumes the signal.
pub fn request_drain() {
    PUBLISH_OUTBOX_DRAIN_REQUESTED.store(true, Ordering::SeqCst);
    drain_notify().notify_waiters();
}

/// Consume the current drain request, returning `true` exactly once per
/// requested drain across all waiters.
pub fn take_drain() -> bool {
    PUBLISH_OUTBOX_DRAIN_REQUESTED.swap(false, Ordering::SeqCst)
}

/// Wait until a publish-outbox drain has been requested, consuming that
/// request exactly once.
pub async fn wait_for_drain() {
    loop {
        if take_drain() {
            return;
        }
        let notified = drain_notify().notified();
        if take_drain() {
            return;
        }
        notified.await;
    }
}

#[cfg(test)]
pub fn reset_for_test() {
    PUBLISH_OUTBOX_DRAIN_REQUESTED.store(false, Ordering::SeqCst);
}

#[cfg(test)]
static PUBLISH_OUTBOX_WAKE_TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub fn lock_for_test() -> std::sync::MutexGuard<'static, ()> {
    PUBLISH_OUTBOX_WAKE_TEST_MUTEX
        .lock()
        .expect("publish outbox wake test mutex must not be poisoned")
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn wait_for_drain_returns_after_request() {
        let _guard = lock_for_test();
        reset_for_test();

        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(25)).await;
            request_drain();
        });

        tokio::time::timeout(Duration::from_millis(500), wait_for_drain())
            .await
            .expect("publish outbox wake should resolve promptly");

        reset_for_test();
    }
}
