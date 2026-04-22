use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::daemon_loop::{
    DaemonMaintenanceLoopClock, DaemonMaintenanceLoopError, DaemonMaintenanceLoopInput,
    DaemonMaintenanceLoopOutcome, DaemonMaintenanceLoopSleeper, DaemonMaintenanceLoopStopSignal,
    DaemonMaintenanceStoppableLoopInput, DaemonTickError, DaemonTickOutcome,
    DaemonTickWithWorkerError, DaemonTickWithWorkerOutcome, DaemonWorkerLoopInput,
    run_daemon_tick_loop_from_filesystem, run_daemon_tick_loop_until_stopped_from_filesystem,
    run_daemon_tick_loop_until_stopped_from_filesystem_with_worker,
};
use crate::daemon_shell::{DaemonShell, DaemonShellError, DaemonShellStopMode};
use crate::process_liveness::ProcessLivenessProbe;
use crate::publish_outbox::PublishOutboxRelayPublisher;
use crate::publish_outbox::PublishOutboxRetryPolicy;
use crate::ral_journal::RalPendingDelegation;
use crate::worker_concurrency::WorkerConcurrencyLimits;
use crate::worker_dispatch_execution::{WorkerDispatchSession, WorkerDispatchSpawner};
use crate::worker_frame_pump::WorkerFrameReceiver;
use crate::worker_process::{AgentWorkerCommand, AgentWorkerProcessConfig};
use crate::worker_runtime_state::WorkerRuntimeState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DaemonForegroundInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub max_iterations: u64,
    pub sleep_ms: u64,
    pub retry_policy: PublishOutboxRetryPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DaemonForegroundStoppableInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub max_iterations: Option<u64>,
    pub sleep_ms: u64,
    pub retry_policy: PublishOutboxRetryPolicy,
}

#[derive(Debug)]
pub struct DaemonForegroundWorkerInput<'a> {
    pub runtime_state: &'a mut WorkerRuntimeState,
    pub limits: WorkerConcurrencyLimits,
    pub correlation_id_prefix: String,
    pub command: AgentWorkerCommand,
    pub worker_config: &'a AgentWorkerProcessConfig,
    pub writer_version: String,
    pub resolved_pending_delegations: Vec<RalPendingDelegation>,
    pub first_publish_result_sequence: Option<u64>,
    pub max_frames: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonForegroundReport {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
    pub started_at_ms: u64,
    pub tick_loop: DaemonMaintenanceLoopOutcome<DaemonTickOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonForegroundWithWorkerReport {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
    pub started_at_ms: u64,
    pub tick_loop: DaemonMaintenanceLoopOutcome<DaemonTickWithWorkerOutcome>,
}

#[derive(Debug, Error)]
pub enum DaemonForegroundError {
    #[error("daemon foreground start failed: {source}")]
    Start {
        #[source]
        source: DaemonShellError,
    },
    #[error("daemon foreground tick loop failed: {source}")]
    Tick {
        #[source]
        source: Box<DaemonMaintenanceLoopError<DaemonTickError>>,
    },
    #[error("daemon foreground tick loop failed: {source}; shutdown also failed: {stop_error}")]
    TickAndStop {
        #[source]
        source: Box<DaemonMaintenanceLoopError<DaemonTickError>>,
        stop_error: DaemonShellError,
    },
    #[error("daemon foreground shutdown failed after successful tick loop: {source}")]
    Shutdown {
        report: Box<DaemonForegroundReport>,
        #[source]
        source: DaemonShellError,
    },
}

#[derive(Debug, Error)]
pub enum DaemonForegroundWithWorkerError {
    #[error("daemon foreground start failed: {source}")]
    Start {
        #[source]
        source: DaemonShellError,
    },
    #[error("daemon foreground tick loop failed: {source}")]
    Tick {
        #[source]
        source: Box<DaemonMaintenanceLoopError<DaemonTickWithWorkerError>>,
    },
    #[error("daemon foreground tick loop failed: {source}; shutdown also failed: {stop_error}")]
    TickAndStop {
        #[source]
        source: Box<DaemonMaintenanceLoopError<DaemonTickWithWorkerError>>,
        stop_error: DaemonShellError,
    },
    #[error("daemon foreground shutdown failed after successful tick loop: {source}")]
    Shutdown {
        report: Box<DaemonForegroundWithWorkerReport>,
        #[source]
        source: DaemonShellError,
    },
}

pub fn run_daemon_foreground_from_filesystem<C, S, P, Probe>(
    shell: &DaemonShell<Probe>,
    input: DaemonForegroundInput<'_>,
    clock: &mut C,
    sleeper: &mut S,
    publisher: &mut P,
) -> Result<DaemonForegroundReport, DaemonForegroundError>
where
    Probe: ProcessLivenessProbe + Clone,
    C: DaemonMaintenanceLoopClock,
    S: DaemonMaintenanceLoopSleeper,
    P: PublishOutboxRelayPublisher,
{
    let started_at_ms = clock.now_ms();
    let session = shell
        .start_foreground(started_at_ms)
        .map_err(|source| DaemonForegroundError::Start { source })?;

    let tick_result = run_daemon_tick_loop_from_filesystem(
        DaemonMaintenanceLoopInput {
            tenex_base_dir: input.tenex_base_dir,
            daemon_dir: shell.daemon_dir(),
            max_iterations: input.max_iterations,
            sleep_ms: input.sleep_ms,
        },
        clock,
        sleeper,
        publisher,
        input.retry_policy,
    );

    match tick_result {
        Ok(tick_loop) => {
            let report = DaemonForegroundReport {
                tenex_base_dir: input.tenex_base_dir.to_path_buf(),
                daemon_dir: shell.daemon_dir().to_path_buf(),
                started_at_ms,
                tick_loop,
            };
            match session.stop(DaemonShellStopMode::Shutdown) {
                Ok(()) => Ok(report),
                Err(source) => Err(DaemonForegroundError::Shutdown {
                    report: Box::new(report),
                    source,
                }),
            }
        }
        Err(source) => match session.stop(DaemonShellStopMode::Shutdown) {
            Ok(()) => Err(DaemonForegroundError::Tick {
                source: Box::new(source),
            }),
            Err(stop_error) => Err(DaemonForegroundError::TickAndStop {
                source: Box::new(source),
                stop_error,
            }),
        },
    }
}

pub fn run_daemon_foreground_until_stopped_from_filesystem<C, S, Stop, P, Probe>(
    shell: &DaemonShell<Probe>,
    input: DaemonForegroundStoppableInput<'_>,
    clock: &mut C,
    sleeper: &mut S,
    stop_signal: &mut Stop,
    publisher: &mut P,
) -> Result<DaemonForegroundReport, DaemonForegroundError>
where
    Probe: ProcessLivenessProbe + Clone,
    C: DaemonMaintenanceLoopClock,
    S: DaemonMaintenanceLoopSleeper,
    Stop: DaemonMaintenanceLoopStopSignal,
    P: PublishOutboxRelayPublisher,
{
    let started_at_ms = clock.now_ms();
    let session = shell
        .start_foreground(started_at_ms)
        .map_err(|source| DaemonForegroundError::Start { source })?;

    let tick_result = run_daemon_tick_loop_until_stopped_from_filesystem(
        DaemonMaintenanceStoppableLoopInput {
            tenex_base_dir: input.tenex_base_dir,
            daemon_dir: shell.daemon_dir(),
            max_iterations: input.max_iterations,
            sleep_ms: input.sleep_ms,
        },
        clock,
        sleeper,
        stop_signal,
        publisher,
        input.retry_policy,
    );

    match tick_result {
        Ok(tick_loop) => {
            let report = DaemonForegroundReport {
                tenex_base_dir: input.tenex_base_dir.to_path_buf(),
                daemon_dir: shell.daemon_dir().to_path_buf(),
                started_at_ms,
                tick_loop,
            };
            match session.stop(DaemonShellStopMode::Shutdown) {
                Ok(()) => Ok(report),
                Err(source) => Err(DaemonForegroundError::Shutdown {
                    report: Box::new(report),
                    source,
                }),
            }
        }
        Err(source) => match session.stop(DaemonShellStopMode::Shutdown) {
            Ok(()) => Err(DaemonForegroundError::Tick {
                source: Box::new(source),
            }),
            Err(stop_error) => Err(DaemonForegroundError::TickAndStop {
                source: Box::new(source),
                stop_error,
            }),
        },
    }
}

pub fn run_daemon_foreground_until_stopped_from_filesystem_with_worker<
    C,
    Sleep,
    Stop,
    P,
    Probe,
    Spawner,
>(
    shell: &DaemonShell<Probe>,
    input: DaemonForegroundStoppableInput<'_>,
    worker: DaemonForegroundWorkerInput<'_>,
    clock: &mut C,
    sleeper: &mut Sleep,
    stop_signal: &mut Stop,
    spawner: &mut Spawner,
    publisher: &mut P,
) -> Result<DaemonForegroundWithWorkerReport, DaemonForegroundWithWorkerError>
where
    Probe: ProcessLivenessProbe + Clone,
    C: DaemonMaintenanceLoopClock,
    Sleep: DaemonMaintenanceLoopSleeper,
    Stop: DaemonMaintenanceLoopStopSignal,
    P: PublishOutboxRelayPublisher,
    Spawner: WorkerDispatchSpawner,
    Spawner::Session: WorkerFrameReceiver
        + WorkerDispatchSession<Error = <Spawner::Session as WorkerFrameReceiver>::Error>
        + 'static,
{
    let started_at_ms = clock.now_ms();
    let session = shell
        .start_foreground(started_at_ms)
        .map_err(|source| DaemonForegroundWithWorkerError::Start { source })?;
    let lock_owner = session.lock_info().clone();

    let tick_result = run_daemon_tick_loop_until_stopped_from_filesystem_with_worker(
        DaemonMaintenanceStoppableLoopInput {
            tenex_base_dir: input.tenex_base_dir,
            daemon_dir: shell.daemon_dir(),
            max_iterations: input.max_iterations,
            sleep_ms: input.sleep_ms,
        },
        DaemonWorkerLoopInput {
            runtime_state: worker.runtime_state,
            limits: worker.limits,
            correlation_id_prefix: worker.correlation_id_prefix,
            lock_owner,
            command: worker.command,
            worker_config: worker.worker_config,
            writer_version: worker.writer_version,
            resolved_pending_delegations: worker.resolved_pending_delegations,
            first_publish_result_sequence: worker.first_publish_result_sequence,
            max_frames: worker.max_frames,
        },
        clock,
        sleeper,
        stop_signal,
        spawner,
        publisher,
        input.retry_policy,
    );

    match tick_result {
        Ok(tick_loop) => {
            let report = DaemonForegroundWithWorkerReport {
                tenex_base_dir: input.tenex_base_dir.to_path_buf(),
                daemon_dir: shell.daemon_dir().to_path_buf(),
                started_at_ms,
                tick_loop,
            };
            match session.stop(DaemonShellStopMode::Shutdown) {
                Ok(()) => Ok(report),
                Err(source) => Err(DaemonForegroundWithWorkerError::Shutdown {
                    report: Box::new(report),
                    source,
                }),
            }
        }
        Err(source) => match session.stop(DaemonShellStopMode::Shutdown) {
            Ok(()) => Err(DaemonForegroundWithWorkerError::Tick {
                source: Box::new(source),
            }),
            Err(stop_error) => Err(DaemonForegroundWithWorkerError::TickAndStop {
                source: Box::new(source),
                stop_error,
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::daemon_worker_runtime::DaemonWorkerRuntimeOutcome;
    use crate::filesystem_state::{read_lock_info_file, read_status_file};
    use crate::nostr_event::SignedNostrEvent;
    use crate::process_liveness::ProcessLivenessProbe;
    use crate::publish_outbox::{
        PublishRelayError, PublishRelayReport, PublishRelayResult, inspect_publish_outbox,
    };
    use crate::ral_lock::RalLockOwnerProcessStatus;
    use crate::worker_dispatch_admission::WorkerDispatchAdmissionBlockedReason;
    use crate::worker_dispatch_execution::BootedWorkerDispatch;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use serde_json::json;
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

    #[derive(Debug, Default)]
    struct RecordingPublisher {
        published_event_ids: Vec<String>,
    }

    impl PublishOutboxRelayPublisher for RecordingPublisher {
        fn publish_signed_event(
            &mut self,
            event: &SignedNostrEvent,
        ) -> Result<PublishRelayReport, PublishRelayError> {
            self.published_event_ids.push(event.id.clone());
            Ok(PublishRelayReport {
                relay_results: vec![PublishRelayResult {
                    relay_url: "wss://relay.one".to_string(),
                    accepted: true,
                    message: None,
                }],
            })
        }
    }

    #[derive(Debug, Clone)]
    struct FixedProbe {
        status: RalLockOwnerProcessStatus,
    }

    impl ProcessLivenessProbe for FixedProbe {
        fn process_status(&self, _pid: u32) -> RalLockOwnerProcessStatus {
            self.status
        }
    }

    #[derive(Debug, Default)]
    struct EmptyQueueSpawner {
        spawn_calls: usize,
    }

    impl WorkerDispatchSpawner for EmptyQueueSpawner {
        type Session = EmptyQueueSession;
        type Error = EmptyQueueWorkerError;

        fn spawn_worker(
            &mut self,
            command: &AgentWorkerCommand,
            config: &AgentWorkerProcessConfig,
        ) -> Result<BootedWorkerDispatch<Self::Session>, Self::Error> {
            self.spawn_calls += 1;
            panic!("worker should not spawn for empty queue: {command:?} {config:?}");
        }
    }

    #[derive(Debug)]
    struct EmptyQueueSession;

    impl WorkerDispatchSession for EmptyQueueSession {
        type Error = EmptyQueueWorkerError;

        fn send_worker_message(&mut self, message: &serde_json::Value) -> Result<(), Self::Error> {
            panic!("empty queue session should not receive messages: {message:?}");
        }
    }

    impl WorkerFrameReceiver for EmptyQueueSession {
        type Error = EmptyQueueWorkerError;

        fn receive_worker_frame(&mut self) -> Result<Vec<u8>, Self::Error> {
            panic!("empty queue session should not receive frames");
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct EmptyQueueWorkerError(&'static str);

    impl fmt::Display for EmptyQueueWorkerError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    impl StdError for EmptyQueueWorkerError {}

    #[test]
    fn foreground_runner_runs_the_tick_loop_and_shuts_down() {
        let fixture = foreground_fixture("foreground_runner_runs_the_tick_loop_and_shuts_down");
        let shell = test_shell(&fixture.daemon_dir);
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![
                1_710_001_000_000,
                1_710_001_000_100,
                1_710_001_000_200,
            ]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut publisher = RecordingPublisher::default();

        let report = run_daemon_foreground_from_filesystem(
            &shell,
            DaemonForegroundInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                max_iterations: 2,
                sleep_ms: 25,
                retry_policy: PublishOutboxRetryPolicy::default(),
            },
            &mut clock,
            &mut sleeper,
            &mut publisher,
        )
        .expect("foreground runner must succeed");

        assert_eq!(report.tenex_base_dir, fixture.tenex_base_dir);
        assert_eq!(report.daemon_dir, fixture.daemon_dir);
        assert_eq!(report.started_at_ms, 1_710_001_000_000);
        assert_eq!(
            clock.observed_now_ms_values,
            vec![1_710_001_000_000, 1_710_001_000_100, 1_710_001_000_200]
        );
        assert_eq!(sleeper.sleeps_ms, vec![25]);
        assert_eq!(report.tick_loop.steps.len(), 2);
        assert_eq!(report.tick_loop.steps[0].iteration_index, 0);
        assert_eq!(report.tick_loop.steps[1].iteration_index, 1);
        assert_eq!(report.tick_loop.steps[0].sleep_after_ms, Some(25));
        assert_eq!(report.tick_loop.steps[1].sleep_after_ms, None);
        assert!(!publisher.published_event_ids.is_empty());
        assert_eq!(
            read_lock_info_file(&fixture.daemon_dir).expect("lock read must succeed"),
            None
        );
        assert_eq!(
            read_status_file(&fixture.daemon_dir).expect("status read must succeed"),
            None
        );
        let publish_outbox = inspect_publish_outbox(&fixture.daemon_dir, 1_710_001_000_200)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.pending_count, 0);
        assert!(publish_outbox.published_count > 0);
    }

    #[test]
    fn foreground_runner_until_stopped_honors_stop_signal_and_shuts_down() {
        let fixture =
            foreground_fixture("foreground_runner_until_stopped_honors_stop_signal_and_shuts_down");
        let shell = test_shell(&fixture.daemon_dir);
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![1_710_001_000_000, 1_710_001_000_100]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut stop_signal = StopAfterChecks {
            checks: 0,
            stop_on_or_after: 2,
        };
        let mut publisher = RecordingPublisher::default();

        let report = run_daemon_foreground_until_stopped_from_filesystem(
            &shell,
            DaemonForegroundStoppableInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                max_iterations: None,
                sleep_ms: 25,
                retry_policy: PublishOutboxRetryPolicy::default(),
            },
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            &mut publisher,
        )
        .expect("foreground runner must stop cleanly");

        assert_eq!(report.tick_loop.steps.len(), 1);
        assert_eq!(
            clock.observed_now_ms_values,
            vec![1_710_001_000_000, 1_710_001_000_100]
        );
        assert!(sleeper.sleeps_ms.is_empty());
        assert_eq!(stop_signal.checks, 2);
        assert!(!publisher.published_event_ids.is_empty());
        assert_eq!(
            read_lock_info_file(&fixture.daemon_dir).expect("lock read must succeed"),
            None
        );
        assert_eq!(
            read_status_file(&fixture.daemon_dir).expect("status read must succeed"),
            None
        );
    }

    #[test]
    fn foreground_runner_with_worker_runs_runtime_and_shuts_down() {
        let fixture = foreground_fixture("foreground_runner_with_worker_runs_runtime");
        let shell = test_shell(&fixture.daemon_dir);
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![1_710_001_000_000, 1_710_001_000_100]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut stop_signal = StopAfterChecks {
            checks: 0,
            stop_on_or_after: 2,
        };
        let mut publisher = RecordingPublisher::default();
        let mut spawner = EmptyQueueSpawner::default();
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = AgentWorkerProcessConfig::default();

        let report = run_daemon_foreground_until_stopped_from_filesystem_with_worker(
            &shell,
            DaemonForegroundStoppableInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                max_iterations: None,
                sleep_ms: 25,
                retry_policy: PublishOutboxRetryPolicy::default(),
            },
            DaemonForegroundWorkerInput {
                runtime_state: &mut runtime_state,
                limits: WorkerConcurrencyLimits::default(),
                correlation_id_prefix: "foreground-worker-test".to_string(),
                command: AgentWorkerCommand::new("bun"),
                worker_config: &worker_config,
                writer_version: "foreground-worker-test@0".to_string(),
                resolved_pending_delegations: Vec::new(),
                first_publish_result_sequence: Some(700),
                max_frames: 1,
            },
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            &mut spawner,
            &mut publisher,
        )
        .expect("foreground worker runner must succeed");

        assert_eq!(report.tick_loop.steps.len(), 1);
        match &report.tick_loop.steps[0].maintenance_outcome.worker_runtime {
            DaemonWorkerRuntimeOutcome::NotAdmitted { reason, .. } => {
                assert_eq!(
                    reason,
                    &WorkerDispatchAdmissionBlockedReason::NoQueuedDispatches
                );
            }
            other => panic!("unexpected worker runtime outcome: {other:?}"),
        }
        assert_eq!(spawner.spawn_calls, 0);
        assert!(!publisher.published_event_ids.is_empty());
        assert_eq!(
            read_lock_info_file(&fixture.daemon_dir).expect("lock read must succeed"),
            None
        );
        assert_eq!(
            read_status_file(&fixture.daemon_dir).expect("status read must succeed"),
            None
        );
    }

    #[test]
    fn foreground_runner_releases_lock_and_status_when_the_tick_loop_fails() {
        let daemon_dir = unique_temp_daemon_dir();
        let shell = test_shell(&daemon_dir);
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![1_710_001_100_000, 1_710_001_100_100]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut publisher = RecordingPublisher::default();

        let error = run_daemon_foreground_from_filesystem(
            &shell,
            DaemonForegroundInput {
                tenex_base_dir: &daemon_dir,
                max_iterations: 1,
                sleep_ms: 25,
                retry_policy: PublishOutboxRetryPolicy::default(),
            },
            &mut clock,
            &mut sleeper,
            &mut publisher,
        )
        .expect_err("missing backend config must fail the tick loop");

        match error {
            DaemonForegroundError::Tick { source } => {
                assert!(
                    source
                        .to_string()
                        .contains("backend-events maintenance failed"),
                    "unexpected tick failure: {source}"
                );
            }
            other => panic!("unexpected error: {other:?}"),
        }
        assert_eq!(
            read_lock_info_file(&daemon_dir).expect("lock read must succeed"),
            None
        );
        assert_eq!(
            read_status_file(&daemon_dir).expect("status read must succeed"),
            None
        );
        assert!(sleeper.sleeps_ms.is_empty());
        assert!(publisher.published_event_ids.is_empty());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[derive(Debug)]
    struct ForegroundFixture {
        tenex_base_dir: PathBuf,
        daemon_dir: PathBuf,
    }

    impl Drop for ForegroundFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.tenex_base_dir);
        }
    }

    fn foreground_fixture(prefix: &str) -> ForegroundFixture {
        let tenex_base_dir = unique_temp_dir(prefix);
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        let projects_dir = tenex_base_dir.join("projects");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&projects_dir).expect("projects dir must create");
        let config = json!({
            "whitelistedPubkeys": [owner_pubkey(0x02)],
            "tenexPrivateKey": TEST_SECRET_KEY_HEX,
            "relays": ["wss://relay.one"],
        });
        fs::write(
            backend_config_path(&tenex_base_dir),
            serde_json::to_string_pretty(&config).expect("config json must serialize"),
        )
        .expect("config must write");

        ForegroundFixture {
            tenex_base_dir,
            daemon_dir,
        }
    }

    fn test_shell(daemon_dir: &Path) -> DaemonShell<FixedProbe> {
        DaemonShell::with_identity(
            daemon_dir.to_path_buf(),
            FixedProbe {
                status: RalLockOwnerProcessStatus::Running,
            },
            4242,
            "tenex-host",
        )
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        unique_temp_dir("daemon-foreground")
    }

    fn owner_pubkey(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }
}
