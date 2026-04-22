use std::error::Error;
use std::path::Path;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
        thread::sleep(Duration::from_millis(sleep_ms));
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
    mut run_once: F,
) -> Result<DaemonMaintenanceLoopOutcome<T>, DaemonMaintenanceLoopError<E>>
where
    C: DaemonMaintenanceLoopClock,
    S: DaemonMaintenanceLoopSleeper,
    F: FnMut(u64) -> Result<T, E>,
    E: Error + Send + Sync + 'static,
{
    let mut steps = Vec::new();

    for iteration_index in 0..max_iterations {
        let now_ms = clock.now_ms();
        let maintenance_outcome =
            run_once(now_ms).map_err(|source| DaemonMaintenanceLoopError::Maintenance {
                completed_iterations: iteration_index,
                iteration_index,
                now_ms,
                source,
            })?;

        let sleep_after_ms = if iteration_index + 1 < max_iterations {
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
    }

    Ok(DaemonMaintenanceLoopOutcome { steps })
}

pub fn run_daemon_tick_once_from_filesystem<P: PublishOutboxRelayPublisher>(
    input: DaemonMaintenanceInput<'_>,
    publisher: &mut P,
    retry_policy: PublishOutboxRetryPolicy,
) -> Result<DaemonTickOutcome, DaemonTickError> {
    let daemon_dir = input.daemon_dir;
    let now_ms = input.now_ms;
    let maintenance = run_daemon_maintenance_once_from_filesystem(input)?;
    let publish_outbox = maintain_publish_runtime(PublishRuntimeMaintainInput {
        daemon_dir,
        publisher,
        now: now_ms,
        retry_policy,
    })?
    .maintenance_report;

    Ok(DaemonTickOutcome {
        maintenance,
        publish_outbox,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DaemonMaintenanceLoopInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub max_iterations: u64,
    pub sleep_ms: u64,
}

pub fn run_daemon_tick_loop_from_filesystem<C, S, P>(
    input: DaemonMaintenanceLoopInput<'_>,
    clock: &mut C,
    sleeper: &mut S,
    publisher: &mut P,
    retry_policy: PublishOutboxRetryPolicy,
) -> Result<
    DaemonMaintenanceLoopOutcome<DaemonTickOutcome>,
    DaemonMaintenanceLoopError<DaemonTickError>,
>
where
    C: DaemonMaintenanceLoopClock,
    S: DaemonMaintenanceLoopSleeper,
    P: PublishOutboxRelayPublisher,
{
    run_daemon_maintenance_loop(
        clock,
        sleeper,
        input.max_iterations,
        input.sleep_ms,
        |now_ms| {
            run_daemon_tick_once_from_filesystem(
                DaemonMaintenanceInput {
                    tenex_base_dir: input.tenex_base_dir,
                    daemon_dir: input.daemon_dir,
                    now_ms,
                },
                publisher,
                retry_policy,
            )
        },
    )
}

pub fn current_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::nostr_event::SignedNostrEvent;
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
    fn filesystem_tick_loop_drains_publish_outbox_after_daemon_maintenance() {
        let fixture = TickFilesystemFixture::new("daemon-loop-publish-success", 0x04);
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![1_710_001_000_000]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut publisher = RecordingPublisher::default();

        let outcome = run_daemon_tick_loop_from_filesystem(
            DaemonMaintenanceLoopInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                daemon_dir: &fixture.daemon_dir,
                max_iterations: 1,
                sleep_ms: 30_000,
            },
            &mut clock,
            &mut sleeper,
            &mut publisher,
            PublishOutboxRetryPolicy::default(),
        )
        .expect("filesystem tick loop must succeed");

        assert_eq!(outcome.steps.len(), 1);
        let tick = &outcome.steps[0].maintenance_outcome;
        assert_eq!(
            tick.maintenance.backend_events.tick.due_task_names,
            vec![
                "backend-status".to_string(),
                format!("project-status:{}:demo-project", fixture.owner_pubkey),
            ]
        );
        assert_eq!(tick.publish_outbox.diagnostics_before.pending_count, 3);
        assert_eq!(tick.publish_outbox.drained.len(), 3);
        assert_eq!(tick.publish_outbox.diagnostics_after.pending_count, 0);
        assert_eq!(tick.publish_outbox.diagnostics_after.published_count, 3);
        assert_eq!(publisher.event_ids.len(), 3);
        assert!(sleeper.sleeps_ms.is_empty());

        let publish_outbox = inspect_publish_outbox(&fixture.daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.pending_count, 0);
        assert_eq!(publish_outbox.published_count, 3);
    }

    #[test]
    fn filesystem_tick_loop_records_retryable_publish_failures() {
        let fixture = TickFilesystemFixture::new("daemon-loop-publish-failure", 0x05);
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![1_710_001_000_000]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut publisher = RetryableFailurePublisher::default();

        let outcome = run_daemon_tick_loop_from_filesystem(
            DaemonMaintenanceLoopInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                daemon_dir: &fixture.daemon_dir,
                max_iterations: 1,
                sleep_ms: 30_000,
            },
            &mut clock,
            &mut sleeper,
            &mut publisher,
            PublishOutboxRetryPolicy::default(),
        )
        .expect("filesystem tick loop must record retryable publish failures");

        let tick = &outcome.steps[0].maintenance_outcome;
        assert_eq!(tick.publish_outbox.diagnostics_before.pending_count, 3);
        assert_eq!(tick.publish_outbox.drained.len(), 3);
        assert!(
            tick.publish_outbox
                .drained
                .iter()
                .all(|drain| drain.status == crate::publish_outbox::PublishOutboxStatus::Failed)
        );
        assert_eq!(tick.publish_outbox.diagnostics_after.pending_count, 0);
        assert_eq!(tick.publish_outbox.diagnostics_after.failed_count, 3);
        assert_eq!(
            tick.publish_outbox.diagnostics_after.retryable_failed_count,
            3
        );
        assert_eq!(tick.publish_outbox.diagnostics_after.retry_due_count, 0);
        assert!(
            tick.publish_outbox
                .diagnostics_after
                .latest_failure
                .as_ref()
                .and_then(|failure| failure.next_attempt_at)
                .is_some()
        );
        assert_eq!(publisher.publish_attempts, 3);
        assert!(sleeper.sleeps_ms.is_empty());

        let publish_outbox = inspect_publish_outbox(&fixture.daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.failed_count, 3);
        assert_eq!(publish_outbox.retryable_failed_count, 3);
    }

    #[derive(Debug)]
    struct TickFilesystemFixture {
        tenex_base_dir: PathBuf,
        daemon_dir: PathBuf,
        owner_pubkey: String,
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
            fs::write(
                project_dir.join("project.json"),
                format!(
                    r#"{{
                        "schemaVersion": 1,
                        "status": "running",
                        "projectOwnerPubkey": "{owner_pubkey}",
                        "projectDTag": "demo-project",
                        "worktrees": ["main"]
                    }}"#
                ),
            )
            .expect("project descriptor must write");

            Self {
                tenex_base_dir,
                daemon_dir,
                owner_pubkey,
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
