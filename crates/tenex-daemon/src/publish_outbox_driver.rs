use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::{mpsc, watch};
use tokio::time;

use crate::daemon_signals::PublishEnqueued;
use crate::publish_outbox::{PublishOutboxRelayPublisher, PublishOutboxRetryPolicy};
use crate::publish_runtime::{
    PublishRuntimeInspectInput, PublishRuntimeMaintainInput, inspect_publish_runtime,
    maintain_publish_runtime,
};

pub struct PublishOutboxDriverDeps<P: PublishOutboxRelayPublisher> {
    pub daemon_dir: PathBuf,
    pub publisher: Arc<Mutex<P>>,
    pub retry_policy: PublishOutboxRetryPolicy,
}

/// Long-lived async task that drains the publish outbox whenever signaled.
///
/// On each `PublishEnqueued` signal (or retry timer fire), acquires the
/// publisher lock and runs `maintain_publish_runtime` to drain the outbox.
/// Records the next retry deadline from the maintenance report and arms a
/// timer so transient failures are retried automatically without waiting for
/// a new signal.
pub async fn run_publish_outbox_driver<P>(
    deps: PublishOutboxDriverDeps<P>,
    mut publish_enqueued_rx: mpsc::UnboundedReceiver<PublishEnqueued>,
    mut shutdown_rx: watch::Receiver<bool>,
) where
    P: PublishOutboxRelayPublisher + Send + 'static,
{
    let mut retry_at: Option<Instant> = compute_next_retry_instant(&deps);

    loop {
        if let Some(deadline) = retry_at {
            tokio::select! {
                biased;
                _ = shutdown_rx.changed() => break,
                maybe = publish_enqueued_rx.recv() => {
                    if maybe.is_none() {
                        break;
                    }
                    drain_outbox(&deps);
                    retry_at = compute_next_retry_instant(&deps);
                }
                _ = time::sleep_until(deadline.into()) => {
                    drain_outbox(&deps);
                    retry_at = compute_next_retry_instant(&deps);
                }
            }
        } else {
            tokio::select! {
                biased;
                _ = shutdown_rx.changed() => break,
                maybe = publish_enqueued_rx.recv() => {
                    if maybe.is_none() {
                        break;
                    }
                    drain_outbox(&deps);
                    retry_at = compute_next_retry_instant(&deps);
                }
            }
        }
    }
}

fn drain_outbox<P: PublishOutboxRelayPublisher>(deps: &PublishOutboxDriverDeps<P>) {
    let mut guard = deps.publisher.lock().expect("publisher mutex poisoned");
    let now_ms = current_unix_time_ms();
    if let Err(source) = maintain_publish_runtime(PublishRuntimeMaintainInput {
        daemon_dir: &deps.daemon_dir,
        publisher: &mut *guard,
        now: now_ms,
        retry_policy: deps.retry_policy,
    }) {
        tracing::warn!(error = %source, "publish outbox driver: drain failed");
    }
}

fn compute_next_retry_instant<P: PublishOutboxRelayPublisher>(
    deps: &PublishOutboxDriverDeps<P>,
) -> Option<Instant> {
    let now_ms = current_unix_time_ms();
    let outcome = inspect_publish_runtime(PublishRuntimeInspectInput {
        daemon_dir: &deps.daemon_dir,
        inspected_at: now_ms,
    })
    .ok()?;
    let diagnostics = outcome.diagnostics;

    let next_attempt_ms = diagnostics.latest_failure?.next_attempt_at?;
    if next_attempt_ms <= now_ms {
        return Some(Instant::now());
    }
    let delay_ms = next_attempt_ms - now_ms;
    Some(Instant::now() + std::time::Duration::from_millis(delay_ms))
}

fn current_unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}
