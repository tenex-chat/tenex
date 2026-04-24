use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use thiserror::Error;

use crate::backend_heartbeat_latch::BackendHeartbeatLatchPlanner;
use crate::daemon_loop::{
    DaemonMaintenanceLoopClock, DaemonMaintenanceLoopError, DaemonMaintenanceLoopInput,
    DaemonMaintenanceLoopOutcome, DaemonMaintenanceLoopSleeper, DaemonMaintenanceLoopStopSignal,
    DaemonMaintenanceStoppableLoopInput, DaemonTickError, DaemonTickOutcome,
    DaemonTickWithWorkerError, DaemonTickWithWorkerOutcome, DaemonWorkerLoopInput,
    run_daemon_tick_loop_from_filesystem, run_daemon_tick_loop_until_stopped_from_filesystem,
    run_daemon_tick_loop_until_stopped_from_filesystem_with_worker,
};
use crate::daemon_maintenance::TelegramMaintenancePublisher;
use crate::daemon_shell::{DaemonShell, DaemonShellError, DaemonShellStopMode};
use crate::daemon_worker_runtime::DaemonWorkerRuntimeOutcome;
use crate::process_liveness::ProcessLivenessProbe;
use crate::project_boot_state::ProjectBootState;
use crate::project_event_index::ProjectEventIndex;
use crate::publish_outbox::PublishOutboxRelayPublisher;
use crate::publish_outbox::PublishOutboxRetryPolicy;
use crate::ral_journal::RalPendingDelegation;
use crate::worker_dispatch::execution::{WorkerDispatchSession, WorkerDispatchSpawner};
use crate::worker_process::{AgentWorkerCommand, AgentWorkerProcessConfig};
use crate::worker_runtime_state::SharedWorkerRuntimeState;
use crate::worker_session::frame_pump::WorkerFrameReceiver;
use crate::worker_session::registry::WorkerSessionRegistry;

#[derive(Debug, Clone)]
pub struct DaemonForegroundInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub max_iterations: u64,
    pub sleep_ms: u64,
    pub retry_policy: PublishOutboxRetryPolicy,
    pub project_boot_state: Arc<Mutex<ProjectBootState>>,
    pub project_event_index: Arc<Mutex<ProjectEventIndex>>,
    /// Optional latch shared with the whitelist ingress; when present, the
    /// inner maintenance loop gates the kind 24012 heartbeat on it.
    pub heartbeat_latch: Option<Arc<Mutex<BackendHeartbeatLatchPlanner>>>,
}

#[derive(Debug, Clone)]
pub struct DaemonForegroundStoppableInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub max_iterations: Option<u64>,
    pub sleep_ms: u64,
    pub retry_policy: PublishOutboxRetryPolicy,
    pub project_boot_state: Arc<Mutex<ProjectBootState>>,
    pub project_event_index: Arc<Mutex<ProjectEventIndex>>,
    /// See [`DaemonForegroundInput::heartbeat_latch`].
    pub heartbeat_latch: Option<Arc<Mutex<BackendHeartbeatLatchPlanner>>>,
}

#[derive(Debug)]
pub struct DaemonForegroundWorkerInput<'a> {
    pub runtime_state: SharedWorkerRuntimeState,
    pub correlation_id_prefix: String,
    pub command: AgentWorkerCommand,
    pub worker_config: &'a AgentWorkerProcessConfig,
    pub writer_version: String,
    pub resolved_pending_delegations: Vec<RalPendingDelegation>,
    pub publish_result_sequence: Option<Arc<AtomicU64>>,
    pub max_frames: u64,
    /// Shared across ticks and the loop driver so detached session threads
    /// spawned by one tick can be observed (and joined at shutdown) by the
    /// driver.
    pub session_registry: WorkerSessionRegistry,
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
    /// Session outcomes collected at loop shutdown by joining any session
    /// threads still running when the stop signal fired.
    pub shutdown_completions: Vec<DaemonWorkerRuntimeOutcome>,
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
    publisher: &Arc<Mutex<P>>,
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
            project_boot_state: input.project_boot_state.clone(),
            project_event_index: input.project_event_index.clone(),
            heartbeat_latch: input.heartbeat_latch.clone(),
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
    publisher: &Arc<Mutex<P>>,
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
            project_boot_state: input.project_boot_state.clone(),
            project_event_index: input.project_event_index.clone(),
            heartbeat_latch: input.heartbeat_latch.clone(),
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
    publisher: &Arc<Mutex<P>>,
    telegram_publisher: &mut dyn TelegramMaintenancePublisher,
) -> Result<DaemonForegroundWithWorkerReport, DaemonForegroundWithWorkerError>
where
    Probe: ProcessLivenessProbe + Clone,
    C: DaemonMaintenanceLoopClock,
    Sleep: DaemonMaintenanceLoopSleeper,
    Stop: DaemonMaintenanceLoopStopSignal,
    P: PublishOutboxRelayPublisher + Send + 'static,
    Spawner: WorkerDispatchSpawner,
    Spawner::Session: WorkerFrameReceiver
        + WorkerDispatchSession<Error = <Spawner::Session as WorkerFrameReceiver>::Error>
        + Send
        + 'static,
    <Spawner::Session as WorkerFrameReceiver>::Error: Send,
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
            project_boot_state: input.project_boot_state.clone(),
            project_event_index: input.project_event_index.clone(),
            heartbeat_latch: input.heartbeat_latch.clone(),
        },
        DaemonWorkerLoopInput {
            runtime_state: worker.runtime_state,
            correlation_id_prefix: worker.correlation_id_prefix,
            lock_owner,
            command: worker.command,
            worker_config: worker.worker_config,
            writer_version: worker.writer_version,
            resolved_pending_delegations: worker.resolved_pending_delegations,
            publish_result_sequence: worker.publish_result_sequence,
            max_frames: worker.max_frames,
            session_registry: worker.session_registry,
        },
        clock,
        sleeper,
        stop_signal,
        spawner,
        publisher,
        input.retry_policy,
        telegram_publisher,
    );

    match tick_result {
        Ok(loop_outcome) => {
            let report = DaemonForegroundWithWorkerReport {
                tenex_base_dir: input.tenex_base_dir.to_path_buf(),
                daemon_dir: shell.daemon_dir().to_path_buf(),
                started_at_ms,
                tick_loop: loop_outcome.tick_loop,
                shutdown_completions: loop_outcome.shutdown_completions,
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
    use crate::daemon_maintenance::NoTelegramPublisher;
    use crate::daemon_worker_runtime::DaemonWorkerRuntimeOutcome;
    use crate::dispatch_queue::{
        DispatchQueueRecordParams, DispatchQueueStatus, append_dispatch_queue_record,
        build_dispatch_queue_record, replay_dispatch_queue,
    };
    use crate::filesystem_state::{read_lock_info_file, read_status_file};
    use crate::nostr_event::SignedNostrEvent;
    use crate::process_liveness::ProcessLivenessProbe;
    use crate::publish_outbox::{
        PublishRelayError, PublishRelayReport, PublishRelayResult, inspect_publish_outbox,
    };
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
        RalReplayStatus, append_ral_journal_record, replay_ral_journal,
    };
    use crate::ral_lock::RalLockOwnerProcessStatus;
    use crate::worker_dispatch::admission::WorkerDispatchAdmissionBlockedReason;
    use crate::worker_dispatch::execution::BootedWorkerDispatch;
    use crate::worker_dispatch::input::{
        WorkerDispatchExecuteFields, WorkerDispatchInput, WorkerDispatchInputFromExecuteFields,
        WorkerDispatchInputSourceType, WorkerDispatchInputWriterMetadata,
        write_create_or_compare_equal,
    };
    use crate::worker_process::AgentWorkerReady;
    use crate::worker_protocol::{
        AGENT_WORKER_MAX_FRAME_BYTES, AGENT_WORKER_PROTOCOL_ENCODING,
        AGENT_WORKER_PROTOCOL_VERSION, AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
        AGENT_WORKER_STREAM_BATCH_MS, AgentWorkerExecutionFlags, WorkerProtocolConfig,
        encode_agent_worker_protocol_frame,
    };
    use crate::worker_runtime_state::new_shared_worker_runtime_state;
    use crate::worker_session::session_loop::{
        WorkerSessionLoopFinalReason, WorkerSessionLoopOutcome,
    };
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::error::Error as StdError;
    use std::fmt;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
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

    #[derive(Debug, Clone)]
    struct RecordingWorkerSpawner {
        incoming_frames: VecDeque<Vec<u8>>,
        sent_messages: Arc<Mutex<Vec<Value>>>,
        spawn_calls: usize,
    }

    impl WorkerDispatchSpawner for RecordingWorkerSpawner {
        type Session = RecordingWorkerSession;
        type Error = RecordingWorkerError;

        fn spawn_worker(
            &mut self,
            command: &AgentWorkerCommand,
            config: &AgentWorkerProcessConfig,
        ) -> Result<BootedWorkerDispatch<Self::Session>, Self::Error> {
            self.spawn_calls += 1;
            assert!(!command.program.as_os_str().is_empty());
            assert!(config.boot_timeout.as_millis() > 0);
            Ok(BootedWorkerDispatch {
                ready: ready_message("worker-alpha"),
                session: RecordingWorkerSession {
                    incoming_frames: self.incoming_frames.clone(),
                    sent_messages: Arc::clone(&self.sent_messages),
                },
            })
        }
    }

    #[derive(Debug, Clone)]
    struct RecordingWorkerSession {
        incoming_frames: VecDeque<Vec<u8>>,
        sent_messages: Arc<Mutex<Vec<Value>>>,
    }

    impl WorkerFrameReceiver for RecordingWorkerSession {
        type Error = RecordingWorkerError;

        fn receive_worker_frame(&mut self) -> Result<Vec<u8>, Self::Error> {
            self.incoming_frames
                .pop_front()
                .ok_or(RecordingWorkerError("missing worker frame"))
        }
    }

    impl WorkerDispatchSession for RecordingWorkerSession {
        type Error = RecordingWorkerError;

        fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error> {
            self.sent_messages
                .lock()
                .expect("sent message lock must not be poisoned")
                .push(message.clone());
            Ok(())
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct RecordingWorkerError(&'static str);

    impl fmt::Display for RecordingWorkerError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    impl StdError for RecordingWorkerError {}

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
        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let project_event_index = Arc::new(Mutex::new(ProjectEventIndex::new()));

        let report = run_daemon_foreground_from_filesystem(
            &shell,
            DaemonForegroundInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                max_iterations: 2,
                sleep_ms: 25,
                retry_policy: PublishOutboxRetryPolicy::default(),
                project_boot_state: empty_project_boot_state(),
                project_event_index: Arc::clone(&project_event_index),
                heartbeat_latch: None,
            },
            &mut clock,
            &mut sleeper,
            &publisher,
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
        assert!(!publisher.lock().unwrap().published_event_ids.is_empty());
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
        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let project_event_index = Arc::new(Mutex::new(ProjectEventIndex::new()));

        let report = run_daemon_foreground_until_stopped_from_filesystem(
            &shell,
            DaemonForegroundStoppableInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                max_iterations: None,
                sleep_ms: 25,
                retry_policy: PublishOutboxRetryPolicy::default(),
                project_boot_state: empty_project_boot_state(),
                project_event_index: Arc::clone(&project_event_index),
                heartbeat_latch: None,
            },
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            &publisher,
        )
        .expect("foreground runner must stop cleanly");

        assert_eq!(report.tick_loop.steps.len(), 1);
        assert_eq!(
            clock.observed_now_ms_values,
            vec![1_710_001_000_000, 1_710_001_000_100]
        );
        assert!(sleeper.sleeps_ms.is_empty());
        assert_eq!(stop_signal.checks, 2);
        assert!(!publisher.lock().unwrap().published_event_ids.is_empty());
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
        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let mut telegram_publisher = NoTelegramPublisher;
        let mut spawner = EmptyQueueSpawner::default();
        let runtime_state = new_shared_worker_runtime_state();
        let worker_config = AgentWorkerProcessConfig::default();
        let project_event_index = Arc::new(Mutex::new(ProjectEventIndex::new()));

        let report = run_daemon_foreground_until_stopped_from_filesystem_with_worker(
            &shell,
            DaemonForegroundStoppableInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                max_iterations: None,
                sleep_ms: 25,
                retry_policy: PublishOutboxRetryPolicy::default(),
                project_boot_state: empty_project_boot_state(),
                project_event_index: Arc::clone(&project_event_index),
                heartbeat_latch: None,
            },
            DaemonForegroundWorkerInput {
                runtime_state: runtime_state.clone(),
                correlation_id_prefix: "foreground-worker-test".to_string(),
                command: AgentWorkerCommand::new("bun"),
                worker_config: &worker_config,
                writer_version: "foreground-worker-test@0".to_string(),
                resolved_pending_delegations: Vec::new(),
                publish_result_sequence: Some(Arc::new(AtomicU64::new(700))),
                max_frames: 1,
                session_registry: WorkerSessionRegistry::new(),
            },
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            &mut spawner,
            &publisher,
            &mut telegram_publisher,
        )
        .expect("foreground worker runner must succeed");

        assert_eq!(report.tick_loop.steps.len(), 1);
        let worker_runtime = &report.tick_loop.steps[0].maintenance_outcome.worker_runtime;
        assert_eq!(worker_runtime.len(), 1);
        match &worker_runtime[0] {
            DaemonWorkerRuntimeOutcome::NotAdmitted { reason, .. } => {
                assert_eq!(
                    reason,
                    &WorkerDispatchAdmissionBlockedReason::NoQueuedDispatches
                );
            }
            other => panic!("unexpected worker runtime outcome: {other:?}"),
        }
        assert_eq!(spawner.spawn_calls, 0);
        assert!(!publisher.lock().unwrap().published_event_ids.is_empty());
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
    fn foreground_runner_with_worker_executes_queued_dispatch_from_sidecar() {
        let fixture = foreground_fixture("foreground_runner_with_worker_executes_dispatch");
        seed_claimed_ral(&fixture.daemon_dir);
        seed_queued_dispatch(&fixture.daemon_dir);
        seed_dispatch_input(&fixture.daemon_dir);
        let shell = test_shell(&fixture.daemon_dir);
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![1_710_000_700_000, 1_710_000_700_030]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let mut stop_signal = StopAfterChecks {
            checks: 0,
            stop_on_or_after: 2,
        };
        let sent_messages = Arc::new(Mutex::new(Vec::new()));
        let mut spawner = RecordingWorkerSpawner {
            incoming_frames: VecDeque::from([
                frame_for(&heartbeat_message()),
                frame_for(&complete_message(vec!["published-event-id".to_string()])),
            ]),
            sent_messages: Arc::clone(&sent_messages),
            spawn_calls: 0,
        };
        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let mut telegram_publisher = NoTelegramPublisher;
        let runtime_state = new_shared_worker_runtime_state();
        let worker_config = AgentWorkerProcessConfig::default();
        let project_event_index = Arc::new(Mutex::new(ProjectEventIndex::new()));

        let report = run_daemon_foreground_until_stopped_from_filesystem_with_worker(
            &shell,
            DaemonForegroundStoppableInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                max_iterations: None,
                sleep_ms: 25,
                retry_policy: PublishOutboxRetryPolicy::default(),
                project_boot_state: empty_project_boot_state(),
                project_event_index: Arc::clone(&project_event_index),
                heartbeat_latch: None,
            },
            DaemonForegroundWorkerInput {
                runtime_state: runtime_state.clone(),
                correlation_id_prefix: "foreground-worker-dispatch-test".to_string(),
                command: AgentWorkerCommand::new("bun"),
                worker_config: &worker_config,
                writer_version: "foreground-worker-test@0".to_string(),
                resolved_pending_delegations: Vec::new(),
                publish_result_sequence: Some(Arc::new(AtomicU64::new(700))),
                max_frames: 4,
                session_registry: WorkerSessionRegistry::new(),
            },
            &mut clock,
            &mut sleeper,
            &mut stop_signal,
            &mut spawner,
            &publisher,
            &mut telegram_publisher,
        )
        .expect("foreground worker runner must complete queued dispatch");

        assert_eq!(spawner.spawn_calls, 1);
        assert_eq!(report.tick_loop.steps.len(), 1);
        // First tick admits the queued dispatch; since the session thread is
        // detached, the tick returns before it finishes. Admission is all
        // the per-tick outcome carries.
        let tick_outcomes = &report.tick_loop.steps[0].maintenance_outcome.worker_runtime;
        assert!(
            tick_outcomes.iter().any(|o| matches!(
                o,
                DaemonWorkerRuntimeOutcome::SessionAdmitted { dispatch_id, worker_id }
                if dispatch_id == "dispatch-alpha" && worker_id == "worker-alpha"
            )),
            "expected SessionAdmitted for dispatch-alpha, got {tick_outcomes:?}"
        );
        // The session thread is joined at loop shutdown and its terminal
        // outcome lands in shutdown_completions.
        assert_eq!(
            report.shutdown_completions,
            vec![DaemonWorkerRuntimeOutcome::SessionCompleted {
                dispatch_id: "dispatch-alpha".to_string(),
                worker_id: "worker-alpha".to_string(),
                session: WorkerSessionLoopOutcome {
                    frame_count: 2,
                    final_reason: WorkerSessionLoopFinalReason::TerminalResultHandled,
                },
            }]
        );
        let sent_messages = sent_messages
            .lock()
            .expect("sent message lock must not be poisoned");
        let execute = sent_messages
            .iter()
            .find(|message| message["type"] == "execute")
            .expect("execute message must be sent");
        assert_eq!(execute["projectBasePath"], "/sidecar/repo");
        assert_eq!(execute["triggeringEnvelope"]["content"], "from sidecar");
        assert!(runtime_state.lock().expect("runtime state lock").is_empty());

        let queue = replay_dispatch_queue(&fixture.daemon_dir).expect("dispatch queue must replay");
        assert!(queue.queued.is_empty());
        assert!(queue.leased.is_empty());
        assert_eq!(queue.terminal.len(), 1);
        assert_eq!(queue.terminal[0].status, DispatchQueueStatus::Completed);

        let ral = replay_ral_journal(&fixture.daemon_dir).expect("RAL journal must replay");
        assert_eq!(
            ral.states
                .get(&identity())
                .expect("RAL state must exist")
                .status,
            RalReplayStatus::Completed
        );
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
        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let project_event_index = Arc::new(Mutex::new(ProjectEventIndex::new()));

        let error = run_daemon_foreground_from_filesystem(
            &shell,
            DaemonForegroundInput {
                tenex_base_dir: &daemon_dir,
                max_iterations: 1,
                sleep_ms: 25,
                retry_policy: PublishOutboxRetryPolicy::default(),
                project_boot_state: empty_project_boot_state(),
                project_event_index: Arc::clone(&project_event_index),
                heartbeat_latch: None,
            },
            &mut clock,
            &mut sleeper,
            &publisher,
        )
        .expect_err("missing backend config must fail the tick loop");

        match error {
            DaemonForegroundError::Tick { source } => {
                let message = source.to_string();
                assert!(
                    message.contains("config.json"),
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
        assert!(publisher.lock().unwrap().published_event_ids.is_empty());

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

    fn seed_claimed_ral(daemon_dir: &Path) {
        seed_allocated_ral(daemon_dir);
        append_ral_journal_record(
            daemon_dir,
            &RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "foreground-worker-test@0",
                2,
                1_710_000_700_002,
                "claim-alpha",
                RalJournalEvent::Claimed {
                    identity: identity(),
                    worker_id: "worker-alpha".to_string(),
                    claim_token: "claim-alpha".to_string(),
                },
            ),
        )
        .expect("claimed RAL record must append");
    }

    fn seed_allocated_ral(daemon_dir: &Path) {
        append_ral_journal_record(
            daemon_dir,
            &RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "foreground-worker-test@0",
                1,
                1_710_000_700_001,
                "allocate-alpha",
                RalJournalEvent::Allocated {
                    identity: identity(),
                    triggering_event_id: Some("event-alpha".to_string()),
                },
            ),
        )
        .expect("allocated RAL record must append");
    }

    fn seed_queued_dispatch(daemon_dir: &Path) {
        let ral_identity = identity();
        append_dispatch_queue_record(
            daemon_dir,
            &build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 1,
                timestamp: 1_710_000_700_001,
                correlation_id: "queue-dispatch-alpha".to_string(),
                dispatch_id: "dispatch-alpha".to_string(),
                ral: crate::dispatch_queue::DispatchRalIdentity {
                    project_id: ral_identity.project_id,
                    agent_pubkey: ral_identity.agent_pubkey,
                    conversation_id: ral_identity.conversation_id,
                    ral_number: ral_identity.ral_number,
                },
                triggering_event_id: "event-alpha".to_string(),
                claim_token: "claim-alpha".to_string(),
                status: DispatchQueueStatus::Queued,
            }),
        )
        .expect("queued dispatch must append");
    }

    fn seed_dispatch_input(daemon_dir: &Path) {
        write_create_or_compare_equal(daemon_dir, &dispatch_input())
            .expect("dispatch input sidecar must write");
    }

    fn dispatch_input() -> WorkerDispatchInput {
        WorkerDispatchInput::from_execute_fields(WorkerDispatchInputFromExecuteFields {
            dispatch_id: "dispatch-alpha".to_string(),
            source_type: WorkerDispatchInputSourceType::Nostr,
            writer: WorkerDispatchInputWriterMetadata {
                writer: "daemon_foreground_test".to_string(),
                writer_version: "foreground-worker-test@0".to_string(),
                timestamp: 1_710_000_700_030,
            },
            execute_fields: WorkerDispatchExecuteFields {
                worker_id: Some("worker-alpha".to_string()),
                triggering_event_id: "event-alpha".to_string(),
                project_base_path: "/sidecar/repo".to_string(),
                metadata_path: "/sidecar/repo/.tenex/project.json".to_string(),
                triggering_envelope: {
                    let mut envelope = triggering_envelope("event-alpha");
                    envelope["content"] = json!("from sidecar");
                    envelope
                },
                execution_flags: AgentWorkerExecutionFlags {
                    is_delegation_completion: false,
                    has_pending_delegations: false,
                    pending_delegation_ids: Vec::new(),
                    debug: false,
                },
            },
            source_metadata: Some(json!({ "eventId": "event-alpha" })),
        })
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

    fn empty_project_boot_state() -> Arc<Mutex<ProjectBootState>> {
        Arc::new(Mutex::new(ProjectBootState::new()))
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

    fn heartbeat_message() -> Value {
        let identity = identity();
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "heartbeat",
            "correlationId": "runtime-alpha",
            "sequence": 20,
            "timestamp": 1_710_000_700_100_u64,
            "projectId": identity.project_id,
            "agentPubkey": identity.agent_pubkey,
            "conversationId": identity.conversation_id,
            "ralNumber": identity.ral_number,
            "state": "streaming",
            "activeToolCount": 0,
            "accumulatedRuntimeMs": 700_u64,
        })
    }

    fn complete_message(final_event_ids: Vec<String>) -> Value {
        let identity = identity();
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "complete",
            "correlationId": "runtime-alpha",
            "sequence": 21,
            "timestamp": 1_710_000_700_200_u64,
            "projectId": identity.project_id,
            "agentPubkey": identity.agent_pubkey,
            "conversationId": identity.conversation_id,
            "ralNumber": identity.ral_number,
            "finalRalState": "completed",
            "publishedUserVisibleEvent": true,
            "pendingDelegationsRemain": false,
            "accumulatedRuntimeMs": 900_u64,
            "finalEventIds": final_event_ids,
            "keepWorkerWarm": false,
        })
    }

    fn triggering_envelope(event_id: &str) -> Value {
        json!({
            "transport": "nostr",
            "principal": {
                "id": "nostr:owner-alpha",
                "transport": "nostr",
                "linkedPubkey": "owner-alpha",
                "kind": "human"
            },
            "channel": {
                "id": "nostr:conversation-alpha",
                "transport": "nostr",
                "kind": "conversation"
            },
            "message": {
                "id": event_id,
                "transport": "nostr",
                "nativeId": event_id
            },
            "recipients": [],
            "content": "hello",
            "occurredAt": 1_710_000_700,
            "capabilities": [],
            "metadata": {}
        })
    }

    fn frame_for(message: &Value) -> Vec<u8> {
        encode_agent_worker_protocol_frame(message).expect("message must encode")
    }

    fn ready_message(worker_id: &str) -> AgentWorkerReady {
        AgentWorkerReady {
            worker_id: worker_id.to_string(),
            pid: 123,
            protocol: worker_protocol_config(),
            message: json!({
                "version": AGENT_WORKER_PROTOCOL_VERSION,
                "type": "ready",
                "correlationId": worker_id,
                "sequence": 1,
                "timestamp": 1_710_000_700_000_u64,
                "workerId": worker_id,
                "pid": 123_u64,
                "protocol": {
                    "version": AGENT_WORKER_PROTOCOL_VERSION,
                    "encoding": AGENT_WORKER_PROTOCOL_ENCODING
                },
            }),
        }
    }

    fn worker_protocol_config() -> WorkerProtocolConfig {
        WorkerProtocolConfig {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            encoding: AGENT_WORKER_PROTOCOL_ENCODING.to_string(),
            max_frame_bytes: AGENT_WORKER_MAX_FRAME_BYTES,
            stream_batch_ms: AGENT_WORKER_STREAM_BATCH_MS,
            stream_batch_max_bytes: AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
            heartbeat_interval_ms: Some(30_000),
            missed_heartbeat_threshold: Some(3),
            worker_boot_timeout_ms: Some(30_000),
            graceful_abort_timeout_ms: Some(5_000),
            force_kill_timeout_ms: Some(5_000),
            idle_ttl_ms: Some(60_000),
        }
    }

    fn identity() -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: "project-alpha".to_string(),
            agent_pubkey: "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"
                .to_string(),
            conversation_id: "conversation-alpha".to_string(),
            ral_number: 3,
        }
    }
}
