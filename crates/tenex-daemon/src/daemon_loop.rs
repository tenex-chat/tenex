use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing;

use thiserror::Error;

use crate::daemon_maintenance::{
    DaemonMaintenanceError, DaemonMaintenanceInput, DaemonMaintenanceOutcome,
    run_daemon_maintenance_once_from_filesystem,
};
use crate::publish_outbox::{
    PublishOutboxError, PublishOutboxMaintenanceReport, PublishOutboxRelayPublisher,
    PublishOutboxRetryPolicy,
};
use crate::publish_runtime::{PublishRuntimeMaintainInput, maintain_publish_runtime};

pub trait DaemonMaintenanceLoopClock {
    fn now_ms(&mut self) -> u64;
}

pub trait DaemonMaintenanceLoopSleeper {
    fn sleep_ms(&mut self, sleep_ms: u64);
}

pub trait DaemonMaintenanceLoopStopSignal {
    fn should_stop(&mut self) -> bool;
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SystemDaemonMaintenanceLoopClock;

impl DaemonMaintenanceLoopClock for SystemDaemonMaintenanceLoopClock {
    fn now_ms(&mut self) -> u64 {
        current_unix_time_ms()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ThreadDaemonMaintenanceLoopSleeper;

impl DaemonMaintenanceLoopSleeper for ThreadDaemonMaintenanceLoopSleeper {
    fn sleep_ms(&mut self, sleep_ms: u64) {
        crate::foreground_wake::sleep_with_wake(Duration::from_millis(sleep_ms), || false);
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NeverStopDaemonMaintenanceLoop;

impl DaemonMaintenanceLoopStopSignal for NeverStopDaemonMaintenanceLoop {
    fn should_stop(&mut self) -> bool {
        false
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonMaintenanceLoopStepOutcome<T> {
    pub iteration_index: u64,
    pub now_ms: u64,
    pub maintenance_outcome: T,
    pub sleep_after_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonMaintenanceLoopOutcome<T> {
    pub steps: Vec<DaemonMaintenanceLoopStepOutcome<T>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonTickOutcome {
    pub maintenance: DaemonMaintenanceOutcome,
    pub publish_outbox: PublishOutboxMaintenanceReport,
}

#[derive(Debug, Error)]
pub enum DaemonMaintenanceLoopError<E>
where
    E: Error + Send + Sync + 'static,
{
    #[error(
        "daemon maintenance iteration {iteration_index} failed after {completed_iterations} successful iterations at {now_ms}ms: {source}"
    )]
    Maintenance {
        completed_iterations: u64,
        iteration_index: u64,
        now_ms: u64,
        #[source]
        source: E,
    },
}

#[derive(Debug, Error)]
pub enum DaemonTickError {
    #[error("daemon maintenance failed: {0}")]
    Maintenance(#[from] DaemonMaintenanceError),
    #[error("publish-outbox maintenance failed: {0}")]
    PublishOutbox(#[from] PublishOutboxError),
}

pub fn run_daemon_maintenance_loop<C, S, F, T, E>(
    clock: &mut C,
    sleeper: &mut S,
    max_iterations: u64,
    sleep_ms: u64,
    run_once: F,
) -> Result<DaemonMaintenanceLoopOutcome<T>, DaemonMaintenanceLoopError<E>>
where
    C: DaemonMaintenanceLoopClock,
    S: DaemonMaintenanceLoopSleeper,
    F: FnMut(u64) -> Result<T, E>,
    E: Error + Send + Sync + 'static,
{
    let mut stop_signal = NeverStopDaemonMaintenanceLoop;
    run_daemon_maintenance_loop_until_stopped(
        clock,
        sleeper,
        &mut stop_signal,
        Some(max_iterations),
        sleep_ms,
        run_once,
    )
}

pub fn run_daemon_maintenance_loop_until_stopped<C, S, Stop, F, T, E>(
    clock: &mut C,
    sleeper: &mut S,
    stop_signal: &mut Stop,
    max_iterations: Option<u64>,
    sleep_ms: u64,
    mut run_once: F,
) -> Result<DaemonMaintenanceLoopOutcome<T>, DaemonMaintenanceLoopError<E>>
where
    C: DaemonMaintenanceLoopClock,
    S: DaemonMaintenanceLoopSleeper,
    Stop: DaemonMaintenanceLoopStopSignal,
    F: FnMut(u64) -> Result<T, E>,
    E: Error + Send + Sync + 'static,
{
    let mut steps = Vec::new();
    let mut iteration_index = 0;

    while max_iterations.is_none_or(|limit| iteration_index < limit) && !stop_signal.should_stop() {
        let now_ms = clock.now_ms();
        let _tick_span =
            tracing::debug_span!("daemon.tick", iteration = iteration_index, now_ms = now_ms)
                .entered();
        let maintenance_outcome =
            run_once(now_ms).map_err(|source| DaemonMaintenanceLoopError::Maintenance {
                completed_iterations: iteration_index,
                iteration_index,
                now_ms,
                source,
            })?;

        drop(_tick_span);
        tracing::debug!(iteration = iteration_index, "daemon tick complete");

        let next_iteration_index = iteration_index.saturating_add(1);
        let stop_requested = stop_signal.should_stop();
        let should_sleep =
            max_iterations.is_none_or(|limit| next_iteration_index < limit) && !stop_requested;
        let sleep_after_ms = if should_sleep {
            sleeper.sleep_ms(sleep_ms);
            Some(sleep_ms)
        } else {
            None
        };

        steps.push(DaemonMaintenanceLoopStepOutcome {
            iteration_index,
            now_ms,
            maintenance_outcome,
            sleep_after_ms,
        });

        iteration_index = next_iteration_index;
        if stop_requested {
            break;
        }
    }

    Ok(DaemonMaintenanceLoopOutcome { steps })
}

pub fn run_resilient_daemon_maintenance_loop_until_stopped<C, S, Stop, F, T, E>(
    clock: &mut C,
    sleeper: &mut S,
    stop_signal: &mut Stop,
    max_iterations: Option<u64>,
    sleep_ms: u64,
    mut run_once: F,
) -> Result<DaemonMaintenanceLoopOutcome<T>, DaemonMaintenanceLoopError<E>>
where
    C: DaemonMaintenanceLoopClock,
    S: DaemonMaintenanceLoopSleeper,
    Stop: DaemonMaintenanceLoopStopSignal,
    F: FnMut(u64) -> Result<T, E>,
    E: Error + Send + Sync + 'static,
{
    let mut steps = Vec::new();
    let mut iteration_index = 0;

    while max_iterations.is_none_or(|limit| iteration_index < limit) && !stop_signal.should_stop() {
        let now_ms = clock.now_ms();
        let _tick_span =
            tracing::debug_span!("daemon.tick", iteration = iteration_index, now_ms = now_ms)
                .entered();
        let maintenance_outcome = match run_once(now_ms) {
            Ok(maintenance_outcome) => maintenance_outcome,
            Err(source) => {
                drop(_tick_span);
                let error_chain = format_error_chain(&source);
                tracing::warn!(
                    iteration = iteration_index,
                    now_ms,
                    completed_iterations = steps.len(),
                    error = %error_chain,
                    "daemon tick failed; continuing"
                );
                crate::stdout_status::print_daemon_tick_failure(iteration_index, &source);

                let next_iteration_index = iteration_index.saturating_add(1);
                let stop_requested = stop_signal.should_stop();
                let should_sleep = max_iterations.is_none_or(|limit| next_iteration_index < limit)
                    && !stop_requested;
                if should_sleep {
                    sleeper.sleep_ms(sleep_ms);
                }

                iteration_index = next_iteration_index;
                if stop_requested {
                    break;
                }
                continue;
            }
        };

        drop(_tick_span);
        tracing::debug!(iteration = iteration_index, "daemon tick complete");

        let next_iteration_index = iteration_index.saturating_add(1);
        let stop_requested = stop_signal.should_stop();
        let should_sleep =
            max_iterations.is_none_or(|limit| next_iteration_index < limit) && !stop_requested;
        let sleep_after_ms = if should_sleep {
            sleeper.sleep_ms(sleep_ms);
            Some(sleep_ms)
        } else {
            None
        };

        steps.push(DaemonMaintenanceLoopStepOutcome {
            iteration_index,
            now_ms,
            maintenance_outcome,
            sleep_after_ms,
        });

        iteration_index = next_iteration_index;
        if stop_requested {
            break;
        }
    }

    Ok(DaemonMaintenanceLoopOutcome { steps })
}

pub fn run_daemon_tick_once_from_filesystem<P: PublishOutboxRelayPublisher>(
    input: DaemonMaintenanceInput<'_>,
    publisher: &Arc<Mutex<P>>,
    retry_policy: PublishOutboxRetryPolicy,
) -> Result<DaemonTickOutcome, DaemonTickError> {
    let daemon_dir = input.daemon_dir;
    let now_ms = input.now_ms;
    let maintenance = run_daemon_maintenance_once_from_filesystem(input)?;
    let publish_outbox = {
        let mut guard = publisher
            .lock()
            .expect("publisher mutex poisoned; another thread panicked while publishing");
        maintain_publish_runtime(PublishRuntimeMaintainInput {
            daemon_dir,
            publisher: &mut *guard,
            now: now_ms,
            retry_policy,
        })?
        .maintenance_report
    };
    Ok(DaemonTickOutcome {
        maintenance,
        publish_outbox,
    })
}


pub fn current_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn format_error_chain(error: &dyn Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(" ← ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::nostr_event::SignedNostrEvent;
    use crate::project_boot_state::{BootedProjectsState, ProjectBootState};
    use crate::project_event_index::ProjectEventIndex;
    use crate::publish_outbox::{
        PublishRelayError, PublishRelayReport, PublishRelayResult, inspect_publish_outbox,
    };
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::collections::VecDeque;
    use std::error::Error as StdError;
    use std::fmt;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn project_boot_state_snapshot(
        project_boot_state: &Arc<Mutex<ProjectBootState>>,
    ) -> BootedProjectsState {
        project_boot_state
            .lock()
            .expect("project boot state mutex must not be poisoned")
            .snapshot()
    }

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    #[derive(Debug, Default)]
    struct RecordingClock {
        now_ms_values: VecDeque<u64>,
        observed_now_ms_values: Vec<u64>,
    }

    impl DaemonMaintenanceLoopClock for RecordingClock {
        fn now_ms(&mut self) -> u64 {
            let now_ms = self
                .now_ms_values
                .pop_front()
                .expect("clock must have a value");
            self.observed_now_ms_values.push(now_ms);
            now_ms
        }
    }

    #[derive(Debug, Default)]
    struct RecordingSleeper {
        sleeps_ms: Vec<u64>,
    }

    impl DaemonMaintenanceLoopSleeper for RecordingSleeper {
        fn sleep_ms(&mut self, sleep_ms: u64) {
            self.sleeps_ms.push(sleep_ms);
        }
    }

    #[derive(Debug)]
    struct StopAfterChecks {
        checks: usize,
        stop_on_or_after: usize,
    }

    impl DaemonMaintenanceLoopStopSignal for StopAfterChecks {
        fn should_stop(&mut self) -> bool {
            self.checks += 1;
            self.checks >= self.stop_on_or_after
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct FakeLoopError(&'static str);

    impl fmt::Display for FakeLoopError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    impl StdError for FakeLoopError {}

    #[test]
    fn system_clock_reports_nonzero_unix_time() {
        let mut clock = SystemDaemonMaintenanceLoopClock;
        assert!(clock.now_ms() > 0);
    }

    #[test]
    fn bounded_loop_with_zero_iterations_does_nothing() {
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![10, 20]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut run_once_calls = Vec::new();

        let outcome = run_daemon_maintenance_loop(&mut clock, &mut sleeper, 0, 25, |now_ms| {
            run_once_calls.push(now_ms);
            Ok::<u64, FakeLoopError>(now_ms + 1)
        })
        .expect("zero-iteration loop must succeed");

        assert!(outcome.steps.is_empty());
        assert!(run_once_calls.is_empty());
        assert!(clock.observed_now_ms_values.is_empty());
        assert!(sleeper.sleeps_ms.is_empty());
    }

    #[test]
    fn bounded_loop_records_steps_and_sleep_requests() {
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![11, 22, 33]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut run_once_calls = Vec::new();

        let outcome = run_daemon_maintenance_loop(&mut clock, &mut sleeper, 3, 15, |now_ms| {
            run_once_calls.push(now_ms);
            Ok::<String, FakeLoopError>(format!("maintenance@{now_ms}"))
        })
        .expect("bounded loop must succeed");

        assert_eq!(run_once_calls, vec![11, 22, 33]);
        assert_eq!(clock.observed_now_ms_values, vec![11, 22, 33]);
        assert_eq!(sleeper.sleeps_ms, vec![15, 15]);
        assert_eq!(outcome.steps.len(), 3);
        assert_eq!(
            outcome.steps[0],
            DaemonMaintenanceLoopStepOutcome {
                iteration_index: 0,
                now_ms: 11,
                maintenance_outcome: "maintenance@11".to_string(),
                sleep_after_ms: Some(15),
            }
        );
        assert_eq!(
            outcome.steps[1],
            DaemonMaintenanceLoopStepOutcome {
                iteration_index: 1,
                now_ms: 22,
                maintenance_outcome: "maintenance@22".to_string(),
                sleep_after_ms: Some(15),
            }
        );
        assert_eq!(
            outcome.steps[2],
            DaemonMaintenanceLoopStepOutcome {
                iteration_index: 2,
                now_ms: 33,
                maintenance_outcome: "maintenance@33".to_string(),
                sleep_after_ms: None,
            }
        );
    }

    #[test]
    fn bounded_loop_stops_on_failure_without_sleeping_after_the_failure() {
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![101, 202]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut run_once_calls = Vec::new();

        let err = run_daemon_maintenance_loop(&mut clock, &mut sleeper, 3, 30, |now_ms| {
            run_once_calls.push(now_ms);
            if now_ms == 101 {
                Ok::<String, FakeLoopError>("first-pass".to_string())
            } else {
                Err(FakeLoopError("boom"))
            }
        })
        .expect_err("second iteration must fail");

        assert_eq!(run_once_calls, vec![101, 202]);
        assert_eq!(clock.observed_now_ms_values, vec![101, 202]);
        assert_eq!(sleeper.sleeps_ms, vec![30]);
        assert!(matches!(
            err,
            DaemonMaintenanceLoopError::Maintenance {
                completed_iterations: 1,
                iteration_index: 1,
                now_ms: 202,
                source: FakeLoopError("boom"),
            }
        ));
    }

    #[test]
    fn resilient_stoppable_loop_continues_after_failure() {
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![101, 202]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut stop_signal = StopAfterChecks {
            checks: 0,
            stop_on_or_after: 4,
        };
        let mut run_once_calls = Vec::new();

        let outcome = run_resilient_daemon_maintenance_loop_until_stopped(
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            None,
            30,
            |now_ms| {
                run_once_calls.push(now_ms);
                if now_ms == 101 {
                    Err(FakeLoopError("boom"))
                } else {
                    Ok::<String, FakeLoopError>("recovered".to_string())
                }
            },
        )
        .expect("resilient loop must continue through recoverable failures");

        assert_eq!(run_once_calls, vec![101, 202]);
        assert_eq!(clock.observed_now_ms_values, vec![101, 202]);
        assert_eq!(sleeper.sleeps_ms, vec![30]);
        assert_eq!(outcome.steps.len(), 1);
        assert_eq!(outcome.steps[0].iteration_index, 1);
        assert_eq!(outcome.steps[0].maintenance_outcome, "recovered");
        assert_eq!(outcome.steps[0].sleep_after_ms, None);
    }

    #[test]
    fn stoppable_loop_exits_without_sleeping_after_stop_signal() {
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![11, 22, 33]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut stop_signal = StopAfterChecks {
            checks: 0,
            stop_on_or_after: 4,
        };
        let mut run_once_calls = Vec::new();

        let outcome = run_daemon_maintenance_loop_until_stopped(
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            None,
            15,
            |now_ms| {
                run_once_calls.push(now_ms);
                Ok::<String, FakeLoopError>(format!("maintenance@{now_ms}"))
            },
        )
        .expect("stoppable loop must succeed");

        assert_eq!(run_once_calls, vec![11, 22]);
        assert_eq!(clock.observed_now_ms_values, vec![11, 22]);
        assert_eq!(sleeper.sleeps_ms, vec![15]);
        assert_eq!(outcome.steps.len(), 2);
        assert_eq!(outcome.steps[0].sleep_after_ms, Some(15));
        assert_eq!(outcome.steps[1].sleep_after_ms, None);
        assert_eq!(stop_signal.checks, 4);
    }

    #[test]
    fn stoppable_loop_can_exit_before_first_iteration() {
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![11]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut stop_signal = StopAfterChecks {
            checks: 0,
            stop_on_or_after: 1,
        };
        let mut run_once_calls = Vec::new();

        let outcome = run_daemon_maintenance_loop_until_stopped(
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            None,
            15,
            |now_ms| {
                run_once_calls.push(now_ms);
                Ok::<String, FakeLoopError>(format!("maintenance@{now_ms}"))
            },
        )
        .expect("stoppable loop must succeed");

        assert!(outcome.steps.is_empty());
        assert!(run_once_calls.is_empty());
        assert!(clock.observed_now_ms_values.is_empty());
        assert!(sleeper.sleeps_ms.is_empty());
        assert_eq!(stop_signal.checks, 1);
    }

    #[test]
    fn filesystem_tick_drains_publish_outbox_after_daemon_maintenance() {
        let fixture = TickFilesystemFixture::new("daemon-loop-publish-success", 0x04);
        // Pre-seed the publish outbox with one project-status record. The tick's
        // job is to drain it; the project_status_driver now owns the periodic
        // publish, but any enqueued records must still drain on tick.
        crate::project_status_runtime::publish_project_status_from_filesystem(
            crate::project_status_runtime::ProjectStatusRuntimeInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                daemon_dir: &fixture.daemon_dir,
                created_at: 1_710_001_000,
                accepted_at: 1_710_001_000_000,
                request_timestamp: 1_710_001_000_000,
                project_owner_pubkey: &fixture.owner_pubkey,
                project_d_tag: "demo-project",
                project_manager_pubkey: None,
                project_base_path: None,
                agents: None,
                worktrees: None,
            },
        )
        .expect("pre-seed project-status publish must succeed");

        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));

        let outcome = run_daemon_tick_once_from_filesystem(
            crate::daemon_maintenance::DaemonMaintenanceInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                daemon_dir: &fixture.daemon_dir,
                now_ms: 1_710_001_000_000,
                project_boot_state: project_boot_state_snapshot(&fixture.project_boot_state),
                project_event_index: Arc::clone(&fixture.project_event_index),
                heartbeat_latch: None,
                dispatch_enqueued_tx: None,
            },
            &publisher,
            PublishOutboxRetryPolicy::default(),
        )
        .expect("filesystem tick must succeed");

        assert_eq!(outcome.publish_outbox.diagnostics_before.pending_count, 1);
        assert_eq!(outcome.publish_outbox.drained.len(), 1);
        assert_eq!(outcome.publish_outbox.diagnostics_after.pending_count, 0);
        assert_eq!(outcome.publish_outbox.diagnostics_after.published_count, 1);
        assert_eq!(publisher.lock().unwrap().event_ids.len(), 1);

        let publish_outbox = inspect_publish_outbox(&fixture.daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.pending_count, 0);
        assert_eq!(publish_outbox.published_count, 1);
    }

    #[test]
    fn filesystem_tick_records_retryable_publish_failures() {
        let fixture = TickFilesystemFixture::new("daemon-loop-publish-failure", 0x05);
        // Pre-seed the publish outbox with one project-status record so the tick
        // has something to drain (and fail on).
        crate::project_status_runtime::publish_project_status_from_filesystem(
            crate::project_status_runtime::ProjectStatusRuntimeInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                daemon_dir: &fixture.daemon_dir,
                created_at: 1_710_001_000,
                accepted_at: 1_710_001_000_000,
                request_timestamp: 1_710_001_000_000,
                project_owner_pubkey: &fixture.owner_pubkey,
                project_d_tag: "demo-project",
                project_manager_pubkey: None,
                project_base_path: None,
                agents: None,
                worktrees: None,
            },
        )
        .expect("pre-seed project-status publish must succeed");

        let publisher = Arc::new(Mutex::new(RetryableFailurePublisher::default()));

        let outcome = run_daemon_tick_once_from_filesystem(
            crate::daemon_maintenance::DaemonMaintenanceInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                daemon_dir: &fixture.daemon_dir,
                now_ms: 1_710_001_000_000,
                project_boot_state: project_boot_state_snapshot(&fixture.project_boot_state),
                project_event_index: Arc::clone(&fixture.project_event_index),
                heartbeat_latch: None,
                dispatch_enqueued_tx: None,
            },
            &publisher,
            PublishOutboxRetryPolicy::default(),
        )
        .expect("filesystem tick must record retryable publish failures");

        assert_eq!(outcome.publish_outbox.diagnostics_before.pending_count, 1);
        assert_eq!(outcome.publish_outbox.drained.len(), 1);
        assert!(
            outcome.publish_outbox
                .drained
                .iter()
                .all(|drain| drain.status == crate::publish_outbox::PublishOutboxStatus::Failed)
        );
        assert_eq!(outcome.publish_outbox.diagnostics_after.pending_count, 0);
        assert_eq!(outcome.publish_outbox.diagnostics_after.failed_count, 1);
        assert_eq!(
            outcome.publish_outbox.diagnostics_after.retryable_failed_count,
            1
        );
        assert_eq!(outcome.publish_outbox.diagnostics_after.retry_due_count, 0);
        assert!(
            outcome.publish_outbox
                .diagnostics_after
                .latest_failure
                .as_ref()
                .and_then(|failure| failure.next_attempt_at)
                .is_some()
        );
        assert_eq!(publisher.lock().unwrap().publish_attempts, 1);

        let publish_outbox = inspect_publish_outbox(&fixture.daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.failed_count, 1);
        assert_eq!(publish_outbox.retryable_failed_count, 1);
    }

    #[derive(Debug)]
    struct TickFilesystemFixture {
        tenex_base_dir: PathBuf,
        daemon_dir: PathBuf,
        owner_pubkey: String,
        project_boot_state: Arc<Mutex<ProjectBootState>>,
        project_event_index: Arc<Mutex<ProjectEventIndex>>,
    }

    impl TickFilesystemFixture {
        fn new(prefix: &str, owner_key_fill: u8) -> Self {
            let tenex_base_dir = unique_temp_dir(prefix);
            let daemon_dir = tenex_base_dir.join("daemon");
            let agents_dir = tenex_base_dir.join("agents");
            let project_dir = tenex_base_dir.join("projects").join("demo-project");
            fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
            fs::create_dir_all(&agents_dir).expect("agents dir must create");
            fs::create_dir_all(&project_dir).expect("project dir must create");

            let owner_pubkey = pubkey_hex(owner_key_fill);
            fs::write(
                backend_config_path(&tenex_base_dir),
                format!(
                    r#"{{
                        "whitelistedPubkeys": ["{owner_pubkey}"],
                        "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                        "relays": ["wss://relay.one"]
                    }}"#
                ),
            )
            .expect("config must write");
            let project_event_index = Arc::new(Mutex::new(ProjectEventIndex::new()));
            project_event_index
                .lock()
                .expect("project event index lock")
                .upsert(SignedNostrEvent {
                    id: format!("project-event-{prefix}"),
                    pubkey: owner_pubkey.clone(),
                    created_at: 1_710_000_998,
                    kind: 31933,
                    tags: vec![vec!["d".to_string(), "demo-project".to_string()]],
                    content: String::new(),
                    sig: "0".repeat(128),
                });
            let project_boot_state = Arc::new(Mutex::new(ProjectBootState::new()));
            project_boot_state
                .lock()
                .expect("project boot state lock must not poison")
                .record_boot_event(
                    &SignedNostrEvent {
                        id: format!("boot-event-{prefix}"),
                        pubkey: owner_pubkey.clone(),
                        created_at: 1_710_000_999,
                        kind: 24000,
                        tags: vec![vec![
                            "a".to_string(),
                            format!("31933:{owner_pubkey}:demo-project"),
                        ]],
                        content: String::new(),
                        sig: "0".repeat(128),
                    },
                    1_710_000_999_000,
                )
                .expect("project boot state must record");

            Self {
                tenex_base_dir,
                daemon_dir,
                owner_pubkey,
                project_boot_state,
                project_event_index,
            }
        }
    }

    impl Drop for TickFilesystemFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.tenex_base_dir);
        }
    }

    #[derive(Debug, Default)]
    struct RecordingPublisher {
        event_ids: Vec<String>,
    }

    impl PublishOutboxRelayPublisher for RecordingPublisher {
        fn publish_signed_event(
            &mut self,
            event: &SignedNostrEvent,
        ) -> Result<PublishRelayReport, PublishRelayError> {
            self.event_ids.push(event.id.clone());
            Ok(PublishRelayReport {
                relay_results: vec![PublishRelayResult {
                    relay_url: "wss://relay.one".to_string(),
                    accepted: true,
                    message: None,
                }],
            })
        }
    }

    #[derive(Debug, Default)]
    struct RetryableFailurePublisher {
        publish_attempts: usize,
    }

    impl PublishOutboxRelayPublisher for RetryableFailurePublisher {
        fn publish_signed_event(
            &mut self,
            _event: &SignedNostrEvent,
        ) -> Result<PublishRelayReport, PublishRelayError> {
            self.publish_attempts += 1;
            Err(PublishRelayError {
                message: "relay timeout".to_string(),
                retryable: true,
            })
        }
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }
}
