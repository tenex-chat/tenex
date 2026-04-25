//! Async drivers for intervention arming and review firing.
//!
//! Two tasks replace the former `run_intervention_maintenance` tick-based pass:
//!
//! - **Arm driver** (`run_intervention_arm_driver`): reacts to `RalCompletion`
//!   signals and `project_index_changed` notifications from the signal bus.
//!   On each signal (and once at startup as a catch-up pass), it scans the RAL
//!   journal for newly-completed entries and arms a wakeup for any that are
//!   intervention-eligible. After each arm pass it notifies the fire driver to
//!   recompute its `sleep_until` deadline.
//!
//!   The `project_index_changed` trigger matters for the startup case: the
//!   arm driver's catch-up pass runs before the nostr relay replay is complete,
//!   so the project event index may be empty. When a new project is ingested
//!   (31933 event replayed from relay), the arm pass runs again so any pending
//!   RAL completions waiting for that project descriptor are armed.
//!
//! - **Fire driver** (`run_intervention_fire_driver`): sleeps until the earliest
//!   pending `InterventionReview` wakeup is due, then calls
//!   `fire_due_reviews_now`. On notification from the arm driver it recomputes
//!   the next-due deadline (the arm may have created a sooner wakeup).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::{Notify, mpsc, watch};
use tokio::sync::mpsc::UnboundedSender;
use tokio::time::Instant;

use crate::backend_config::read_backend_config;
use crate::DAEMON_WRITER_VERSION;
use crate::daemon_signals::{PublishEnqueued, RalCompletion};
use crate::intervention::{arm_from_journal, fire_due_reviews_now, next_intervention_wakeup_at};
use crate::project_event_index::ProjectEventIndex;

pub struct InterventionDriverDeps {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
    pub project_event_index: Arc<Mutex<ProjectEventIndex>>,
    pub publish_enqueued_tx: Option<UnboundedSender<PublishEnqueued>>,
}

/// Arm driver: catches up at startup, then re-arms on `RalCompletion` signals
/// and `project_index_changed` notifications.
pub async fn run_intervention_arm_driver(
    deps: InterventionDriverDeps,
    mut ral_completed_rx: mpsc::UnboundedReceiver<RalCompletion>,
    project_index_changed: Arc<Notify>,
    armed_notify: Arc<Notify>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    // Startup catch-up: arm any completions that arrived before this driver
    // started (across daemon restarts). This is the same pass the old tick
    // would have performed on the first maintenance iteration.
    if let Err(error) = run_arm_pass(&deps) {
        tracing::warn!(
            error = %error,
            "intervention arm driver: startup catch-up failed",
        );
    } else {
        armed_notify.notify_one();
        signal_publish_enqueued(&deps);
    }

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => break,
            maybe = ral_completed_rx.recv() => {
                let Some(_completion) = maybe else {
                    // Channel closed — all senders dropped; shut down.
                    break;
                };
                if let Err(error) = run_arm_pass(&deps) {
                    tracing::warn!(
                        error = %error,
                        "intervention arm driver: arm pass failed",
                    );
                } else {
                    // Notify the fire driver: a new wakeup may have been armed
                    // with a sooner deadline than the one we're sleeping toward.
                    armed_notify.notify_one();
                    signal_publish_enqueued(&deps);
                }
            }
            _ = project_index_changed.notified() => {
                // A new project was ingested (31933 replayed from relay). Re-run
                // the arm pass: any RAL completions that were skipped because the
                // project descriptor was missing may now be eligible.
                if let Err(error) = run_arm_pass(&deps) {
                    tracing::warn!(
                        error = %error,
                        "intervention arm driver: arm pass (project-changed) failed",
                    );
                } else {
                    armed_notify.notify_one();
                    signal_publish_enqueued(&deps);
                }
            }
        }
    }
}

fn signal_publish_enqueued(deps: &InterventionDriverDeps) {
    if let Some(ref tx) = deps.publish_enqueued_tx {
        let _ = tx.send(PublishEnqueued);
    }
}

fn run_arm_pass(deps: &InterventionDriverDeps) -> Result<(), String> {
    let now_ms = current_unix_time_ms();
    let descriptors = {
        let projects_base = resolve_projects_base(deps);
        let index = deps
            .project_event_index
            .lock()
            .expect("project event index lock must not be poisoned");
        index.descriptors_report(&projects_base).descriptors
    };
    arm_from_journal(
        &deps.daemon_dir,
        &deps.tenex_base_dir,
        &descriptors,
        now_ms,
        DAEMON_WRITER_VERSION,
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Fire driver: sleeps until the earliest pending `InterventionReview` wakeup,
/// fires due reviews, then recomputes the next deadline.
pub async fn run_intervention_fire_driver(
    deps: InterventionDriverDeps,
    armed_notify: Arc<Notify>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let mut next_at = compute_next_fire_instant(&deps.daemon_dir);

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => break,
            _ = armed_notify.notified() => {
                next_at = compute_next_fire_instant(&deps.daemon_dir);
            }
            _ = sleep_until_optional(next_at) => {
                match run_fire_pass(&deps) {
                    Ok(()) => {
                        if let Some(ref tx) = deps.publish_enqueued_tx {
                            let _ = tx.send(PublishEnqueued);
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            error = %error,
                            "intervention fire driver: fire pass failed",
                        );
                    }
                }
                next_at = compute_next_fire_instant(&deps.daemon_dir);
            }
        }
    }
}

fn run_fire_pass(deps: &InterventionDriverDeps) -> Result<(), String> {
    let now_ms = current_unix_time_ms();
    let descriptors = {
        let projects_base = resolve_projects_base(deps);
        let index = deps
            .project_event_index
            .lock()
            .expect("project event index lock must not be poisoned");
        index.descriptors_report(&projects_base).descriptors
    };
    fire_due_reviews_now(
        &deps.daemon_dir,
        &deps.tenex_base_dir,
        &descriptors,
        now_ms,
        DAEMON_WRITER_VERSION,
    )
    .map_err(|e| e.to_string())
}

/// Return the `Instant` at which the soonest pending `InterventionReview`
/// wakeup is due, or `None` if there are no pending wakeups.
fn compute_next_fire_instant(daemon_dir: &std::path::Path) -> Option<Instant> {
    let due_at_ms = next_intervention_wakeup_at(daemon_dir)?;
    let now_ms = current_unix_time_ms();
    if due_at_ms <= now_ms {
        // Already due — return `now` so the select fires immediately.
        Some(Instant::now())
    } else {
        let delay_ms = due_at_ms - now_ms;
        Some(Instant::now() + Duration::from_millis(delay_ms))
    }
}

/// A future that resolves at `deadline` if `Some`, or stays `Pending` forever
/// if `None`. Used to sleep toward the next due wakeup without polling.
async fn sleep_until_optional(deadline: Option<Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

fn resolve_projects_base(deps: &InterventionDriverDeps) -> String {
    read_backend_config(&deps.tenex_base_dir)
        .ok()
        .and_then(|c| c.projects_base)
        .unwrap_or_else(|| "/tmp/tenex-projects".to_string())
}

fn current_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time must be after UNIX_EPOCH")
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::sync::mpsc;

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("{prefix}-{nanos}-{counter}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Verify that the arm driver sends `PublishEnqueued` after a successful arm pass.
    ///
    /// The test drives the arm driver through a single `RalCompletion` signal on a
    /// runtime that has a minimal backend config (intervention disabled). When
    /// `arm_from_journal` returns `Ok`, the driver must call `signal_publish_enqueued`,
    /// which puts a value on the `publish_enqueued_tx` channel. The test asserts that
    /// the channel carries at least one message after the driver task processes the signal.
    #[tokio::test]
    async fn arm_driver_sends_publish_enqueued_after_successful_arm_pass() {
        let tenex_base_dir = unique_temp_dir("intervention-arm-driver-test-base");
        let daemon_dir = unique_temp_dir("intervention-arm-driver-test-daemon");

        // Write a minimal config.json so read_backend_config succeeds.
        // Default intervention config has is_active() == false, so arm_from_journal
        // returns Ok early without needing a RAL journal or signer.
        fs::write(tenex_base_dir.join("config.json"), r#"{}"#).expect("write config.json");

        let (publish_enqueued_tx, mut publish_enqueued_rx) = mpsc::unbounded_channel::<PublishEnqueued>();
        let (ral_tx, ral_rx) = mpsc::unbounded_channel::<RalCompletion>();
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let project_index_changed = Arc::new(Notify::new());
        let armed_notify = Arc::new(Notify::new());

        let deps = InterventionDriverDeps {
            tenex_base_dir: tenex_base_dir.clone(),
            daemon_dir: daemon_dir.clone(),
            project_event_index: Arc::new(Mutex::new(
                crate::project_event_index::ProjectEventIndex::new(),
            )),
            publish_enqueued_tx: Some(publish_enqueued_tx),
        };

        let driver = tokio::spawn(run_intervention_arm_driver(
            deps,
            ral_rx,
            Arc::clone(&project_index_changed),
            Arc::clone(&armed_notify),
            shutdown_rx,
        ));

        // The driver runs a startup catch-up pass immediately; give it time to
        // complete before we check the channel.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Send one RalCompletion to trigger another arm pass.
        ral_tx.send(RalCompletion { sequence: 1 }).expect("send");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Signal shutdown and wait for the driver to exit cleanly.
        shutdown_tx.send(true).expect("shutdown send");
        driver.await.expect("driver task must not panic");

        // The startup pass and the ral-completion pass both called signal_publish_enqueued.
        // At least one PublishEnqueued must have arrived.
        assert!(
            publish_enqueued_rx.try_recv().is_ok(),
            "arm driver must send PublishEnqueued after a successful arm pass"
        );

        fs::remove_dir_all(&tenex_base_dir).ok();
        fs::remove_dir_all(&daemon_dir).ok();
    }
}
