use std::error::Error;
use std::path::Path;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing;

use thiserror::Error;

use crate::backend_config::read_backend_config;
use crate::daemon_maintenance::{
    DaemonMaintenanceError, DaemonMaintenanceInput, DaemonMaintenanceOutcome,
    TelegramMaintenancePublisher, run_daemon_maintenance_once_from_filesystem,
    run_daemon_maintenance_once_from_filesystem_with_telegram,
};
use crate::daemon_worker_runtime::{
    DaemonWorkerRuntimeFilesystemInput, DaemonWorkerRuntimeOutcome,
    DaemonWorkerTelegramSendRuntimeInput, run_daemon_worker_runtime_once_from_filesystem,
};
use crate::publish_outbox::{
    PublishOutboxError, PublishOutboxMaintenanceReport, PublishOutboxRelayPublisher,
    PublishOutboxRetryPolicy,
};
use crate::publish_runtime::{PublishRuntimeMaintainInput, maintain_publish_runtime};
use crate::ral_journal::RalPendingDelegation;
use crate::ral_lock::RalLockInfo;
use crate::worker_concurrency::WorkerConcurrencyLimits;
use crate::worker_dispatch_execution::{WorkerDispatchSession, WorkerDispatchSpawner};
use crate::worker_frame_pump::WorkerFrameReceiver;
use crate::worker_message_flow::WorkerMessagePublishContext;
use crate::worker_process::{AgentWorkerCommand, AgentWorkerProcessConfig};
use crate::worker_runtime_state::WorkerRuntimeState;

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
        thread::sleep(Duration::from_millis(sleep_ms));
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

#[derive(Debug)]
pub struct DaemonWorkerTickInput<'a> {
    pub runtime_state: &'a mut WorkerRuntimeState,
    pub limits: WorkerConcurrencyLimits,
    pub correlation_id: String,
    pub lock_owner: RalLockInfo,
    pub command: AgentWorkerCommand,
    pub worker_config: &'a AgentWorkerProcessConfig,
    pub writer_version: String,
    pub resolved_pending_delegations: Vec<RalPendingDelegation>,
    pub publish: Option<WorkerMessagePublishContext>,
    pub max_frames: u64,
}

#[derive(Debug)]
pub struct DaemonWorkerLoopInput<'a> {
    pub runtime_state: &'a mut WorkerRuntimeState,
    pub limits: WorkerConcurrencyLimits,
    pub correlation_id_prefix: String,
    pub lock_owner: RalLockInfo,
    pub command: AgentWorkerCommand,
    pub worker_config: &'a AgentWorkerProcessConfig,
    pub writer_version: String,
    pub resolved_pending_delegations: Vec<RalPendingDelegation>,
    pub first_publish_result_sequence: Option<u64>,
    pub max_frames: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonTickWithWorkerOutcome {
    pub maintenance: DaemonMaintenanceOutcome,
    pub worker_runtime: DaemonWorkerRuntimeOutcome,
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

#[derive(Debug, Error)]
pub enum DaemonTickWithWorkerError {
    #[error("daemon maintenance failed: {0}")]
    Maintenance(#[from] DaemonMaintenanceError),
    #[error("daemon worker runtime failed: {message}")]
    WorkerRuntime { message: String },
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

pub fn run_daemon_tick_once_from_filesystem_with_worker<P, S>(
    input: DaemonMaintenanceInput<'_>,
    worker: DaemonWorkerTickInput<'_>,
    spawner: &mut S,
    publisher: &mut P,
    retry_policy: PublishOutboxRetryPolicy,
    telegram_publisher: &mut dyn TelegramMaintenancePublisher,
) -> Result<DaemonTickWithWorkerOutcome, DaemonTickWithWorkerError>
where
    P: PublishOutboxRelayPublisher,
    S: WorkerDispatchSpawner,
    S::Session: WorkerFrameReceiver
        + WorkerDispatchSession<Error = <S::Session as WorkerFrameReceiver>::Error>
        + 'static,
{
    let daemon_dir = input.daemon_dir;
    let tenex_base_dir = input.tenex_base_dir;
    let now_ms = input.now_ms;
    let maintenance =
        run_daemon_maintenance_once_from_filesystem_with_telegram(input, &mut *telegram_publisher)?;
    let telegram_send = worker_telegram_send_runtime_input(tenex_base_dir, &worker.writer_version);
    let worker_runtime = run_daemon_worker_runtime_once_from_filesystem(
        spawner,
        DaemonWorkerRuntimeFilesystemInput {
            daemon_dir,
            runtime_state: worker.runtime_state,
            limits: worker.limits,
            now_ms,
            correlation_id: worker.correlation_id,
            lock_owner: worker.lock_owner,
            command: worker.command,
            worker_config: worker.worker_config,
            writer_version: worker.writer_version,
            resolved_pending_delegations: worker.resolved_pending_delegations,
            publish: worker.publish,
            telegram_send,
            max_frames: worker.max_frames,
        },
    );
    let publish_outbox = maintain_publish_runtime(PublishRuntimeMaintainInput {
        daemon_dir,
        publisher,
        now: now_ms,
        retry_policy,
    })?
    .maintenance_report;
    let worker_runtime =
        worker_runtime.map_err(|source| DaemonTickWithWorkerError::WorkerRuntime {
            message: source.to_string(),
        })?;

    Ok(DaemonTickWithWorkerOutcome {
        maintenance,
        worker_runtime,
        publish_outbox,
    })
}

fn worker_telegram_send_runtime_input(
    tenex_base_dir: &Path,
    writer_version: &str,
) -> Option<DaemonWorkerTelegramSendRuntimeInput> {
    let backend_pubkey = match read_backend_config(tenex_base_dir)
        .and_then(|config| config.backend_signer())
        .map(|signer| signer.pubkey_hex().to_string())
    {
        Ok(pubkey) => pubkey,
        Err(error) => {
            tracing::warn!(
                error = %error,
                "worker telegram send context unavailable; proactive telegram sends will fail closed"
            );
            return None;
        }
    };

    Some(DaemonWorkerTelegramSendRuntimeInput {
        data_dir: tenex_base_dir.join("data"),
        backend_pubkey,
        writer_version: writer_version.to_string(),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DaemonMaintenanceLoopInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub max_iterations: u64,
    pub sleep_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DaemonMaintenanceStoppableLoopInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub max_iterations: Option<u64>,
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

pub fn run_daemon_tick_loop_until_stopped_from_filesystem<C, S, Stop, P>(
    input: DaemonMaintenanceStoppableLoopInput<'_>,
    clock: &mut C,
    sleeper: &mut S,
    stop_signal: &mut Stop,
    publisher: &mut P,
    retry_policy: PublishOutboxRetryPolicy,
) -> Result<
    DaemonMaintenanceLoopOutcome<DaemonTickOutcome>,
    DaemonMaintenanceLoopError<DaemonTickError>,
>
where
    C: DaemonMaintenanceLoopClock,
    S: DaemonMaintenanceLoopSleeper,
    Stop: DaemonMaintenanceLoopStopSignal,
    P: PublishOutboxRelayPublisher,
{
    run_daemon_maintenance_loop_until_stopped(
        clock,
        sleeper,
        stop_signal,
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

pub fn run_daemon_tick_loop_until_stopped_from_filesystem_with_worker<C, Sleep, Stop, P, S>(
    input: DaemonMaintenanceStoppableLoopInput<'_>,
    worker: DaemonWorkerLoopInput<'_>,
    clock: &mut C,
    sleeper: &mut Sleep,
    stop_signal: &mut Stop,
    spawner: &mut S,
    publisher: &mut P,
    retry_policy: PublishOutboxRetryPolicy,
    telegram_publisher: &mut dyn TelegramMaintenancePublisher,
) -> Result<
    DaemonMaintenanceLoopOutcome<DaemonTickWithWorkerOutcome>,
    DaemonMaintenanceLoopError<DaemonTickWithWorkerError>,
>
where
    C: DaemonMaintenanceLoopClock,
    Sleep: DaemonMaintenanceLoopSleeper,
    Stop: DaemonMaintenanceLoopStopSignal,
    P: PublishOutboxRelayPublisher,
    S: WorkerDispatchSpawner,
    S::Session: WorkerFrameReceiver
        + WorkerDispatchSession<Error = <S::Session as WorkerFrameReceiver>::Error>
        + 'static,
{
    let DaemonWorkerLoopInput {
        runtime_state,
        limits,
        correlation_id_prefix,
        lock_owner,
        command,
        worker_config,
        writer_version,
        resolved_pending_delegations,
        first_publish_result_sequence,
        max_frames,
    } = worker;
    let mut next_publish_result_sequence = first_publish_result_sequence;

    run_daemon_maintenance_loop_until_stopped(
        clock,
        sleeper,
        stop_signal,
        input.max_iterations,
        input.sleep_ms,
        |now_ms| {
            let publish =
                next_publish_result_sequence.map(|result_sequence| WorkerMessagePublishContext {
                    accepted_at: now_ms,
                    result_sequence,
                    result_timestamp: now_ms,
                });
            if let Some(result_sequence) = next_publish_result_sequence.as_mut() {
                *result_sequence = result_sequence.saturating_add(1);
            }

            run_daemon_tick_once_from_filesystem_with_worker(
                DaemonMaintenanceInput {
                    tenex_base_dir: input.tenex_base_dir,
                    daemon_dir: input.daemon_dir,
                    now_ms,
                },
                DaemonWorkerTickInput {
                    runtime_state: &mut *runtime_state,
                    limits,
                    correlation_id: format!("{correlation_id_prefix}:{now_ms}"),
                    lock_owner: lock_owner.clone(),
                    command: command.clone(),
                    worker_config,
                    writer_version: writer_version.clone(),
                    resolved_pending_delegations: resolved_pending_delegations.clone(),
                    publish,
                    max_frames,
                },
                spawner,
                publisher,
                retry_policy,
                &mut *telegram_publisher,
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
    use crate::daemon_maintenance::NoTelegramPublisher;
    use crate::dispatch_queue::{
        DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        append_dispatch_queue_record, build_dispatch_queue_record,
    };
    use crate::nostr_event::SignedNostrEvent;
    use crate::publish_outbox::{
        PublishRelayError, PublishRelayReport, PublishRelayResult, inspect_publish_outbox,
    };
    use crate::ral_lock::build_ral_lock_info;
    use crate::worker_dispatch_admission::WorkerDispatchAdmissionBlockedReason;
    use crate::worker_dispatch_execution::BootedWorkerDispatch;
    use crate::worker_dispatch_input::{
        WorkerDispatchExecuteFields, WorkerDispatchInput, WorkerDispatchInputFromExecuteFields,
        WorkerDispatchInputSourceType, WorkerDispatchInputWriterMetadata,
        write_create_or_compare_equal,
    };
    use crate::worker_process::AgentWorkerReady;
    use crate::worker_protocol::{
        AGENT_WORKER_MAX_FRAME_BYTES, AGENT_WORKER_PROTOCOL_ENCODING,
        AGENT_WORKER_PROTOCOL_VERSION, AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
        AGENT_WORKER_STREAM_BATCH_MS, AgentWorkerExecutionFlags, WorkerProtocolConfig,
    };
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::error::Error as StdError;
    use std::fmt;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const TEST_AGENT_PUBKEY: &str =
        "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";

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

    #[test]
    fn filesystem_tick_with_worker_runs_worker_runtime_before_publish_drain() {
        let fixture = TickFilesystemFixture::new("daemon-loop-worker-empty-queue", 0x06);
        let mut publisher = RecordingPublisher::default();
        let mut telegram_publisher = NoTelegramPublisher;
        let mut spawner = EmptyQueueSpawner::default();
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = AgentWorkerProcessConfig::default();

        let outcome = run_daemon_tick_once_from_filesystem_with_worker(
            DaemonMaintenanceInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                daemon_dir: &fixture.daemon_dir,
                now_ms: 1_710_001_000_000,
            },
            DaemonWorkerTickInput {
                runtime_state: &mut runtime_state,
                limits: WorkerConcurrencyLimits::default(),
                correlation_id: "daemon-loop-worker-empty-queue".to_string(),
                lock_owner: build_ral_lock_info(100, "host-a", 1_710_001_000_000),
                command: AgentWorkerCommand::new("bun"),
                worker_config: &worker_config,
                writer_version: "daemon-loop-test@0".to_string(),
                resolved_pending_delegations: Vec::new(),
                publish: None,
                max_frames: 1,
            },
            &mut spawner,
            &mut publisher,
            PublishOutboxRetryPolicy::default(),
            &mut telegram_publisher,
        )
        .expect("filesystem tick with worker must succeed");

        assert_eq!(
            outcome.maintenance.backend_events.tick.due_task_names,
            vec![
                "backend-status".to_string(),
                format!("project-status:{}:demo-project", fixture.owner_pubkey),
            ]
        );
        assert!(matches!(
            outcome.worker_runtime,
            DaemonWorkerRuntimeOutcome::NotAdmitted {
                reason: WorkerDispatchAdmissionBlockedReason::NoQueuedDispatches,
                blocked_candidates: _,
            }
        ));
        assert_eq!(spawner.spawn_calls, 0);
        assert_eq!(outcome.publish_outbox.diagnostics_before.pending_count, 3);
        assert_eq!(outcome.publish_outbox.drained.len(), 3);
        assert_eq!(outcome.publish_outbox.diagnostics_after.pending_count, 0);
        assert_eq!(publisher.event_ids.len(), 3);
    }

    #[test]
    fn filesystem_tick_with_worker_drains_publish_outbox_after_worker_runtime_error() {
        let fixture = TickFilesystemFixture::new("daemon-loop-worker-error-drain", 0x07);
        seed_queued_dispatch(&fixture.daemon_dir);
        seed_dispatch_input(&fixture.daemon_dir);
        let mut publisher = RecordingPublisher::default();
        let mut telegram_publisher = NoTelegramPublisher;
        let mut spawner = ProtocolErrorSpawner::default();
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = AgentWorkerProcessConfig::default();

        let error = run_daemon_tick_once_from_filesystem_with_worker(
            DaemonMaintenanceInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                daemon_dir: &fixture.daemon_dir,
                now_ms: 1_710_001_000_000,
            },
            DaemonWorkerTickInput {
                runtime_state: &mut runtime_state,
                limits: WorkerConcurrencyLimits::default(),
                correlation_id: "daemon-loop-worker-error-drain".to_string(),
                lock_owner: build_ral_lock_info(100, "host-a", 1_710_001_000_000),
                command: AgentWorkerCommand::new("bun"),
                worker_config: &worker_config,
                writer_version: "daemon-loop-test@0".to_string(),
                resolved_pending_delegations: Vec::new(),
                publish: None,
                max_frames: 1,
            },
            &mut spawner,
            &mut publisher,
            PublishOutboxRetryPolicy::default(),
            &mut telegram_publisher,
        )
        .expect_err("worker protocol error must fail the tick");

        assert!(matches!(
            error,
            DaemonTickWithWorkerError::WorkerRuntime { .. }
        ));
        assert_eq!(spawner.spawn_calls, 1);
        assert_eq!(publisher.event_ids.len(), 3);
        let publish_outbox = inspect_publish_outbox(&fixture.daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.pending_count, 0);
        assert_eq!(publish_outbox.published_count, 3);
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

    #[derive(Debug, Default)]
    struct ProtocolErrorSpawner {
        spawn_calls: usize,
    }

    impl WorkerDispatchSpawner for ProtocolErrorSpawner {
        type Session = ProtocolErrorSession;
        type Error = ProtocolErrorWorkerError;

        fn spawn_worker(
            &mut self,
            _command: &AgentWorkerCommand,
            _config: &AgentWorkerProcessConfig,
        ) -> Result<BootedWorkerDispatch<Self::Session>, Self::Error> {
            self.spawn_calls += 1;
            Ok(BootedWorkerDispatch {
                ready: ready_message("worker-alpha"),
                session: ProtocolErrorSession {
                    frames: VecDeque::from([malformed_worker_frame()]),
                },
            })
        }
    }

    #[derive(Debug)]
    struct ProtocolErrorSession {
        frames: VecDeque<Vec<u8>>,
    }

    impl WorkerDispatchSession for ProtocolErrorSession {
        type Error = ProtocolErrorWorkerError;

        fn send_worker_message(&mut self, _message: &Value) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    impl WorkerFrameReceiver for ProtocolErrorSession {
        type Error = ProtocolErrorWorkerError;

        fn receive_worker_frame(&mut self) -> Result<Vec<u8>, Self::Error> {
            self.frames
                .pop_front()
                .ok_or(ProtocolErrorWorkerError("missing worker frame"))
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct ProtocolErrorWorkerError(&'static str);

    impl fmt::Display for ProtocolErrorWorkerError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    impl StdError for ProtocolErrorWorkerError {}

    fn malformed_worker_frame() -> Vec<u8> {
        vec![0, 0, 0, 1, b'{']
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
            heartbeat_interval_ms: None,
            missed_heartbeat_threshold: None,
            worker_boot_timeout_ms: None,
            graceful_abort_timeout_ms: None,
            force_kill_timeout_ms: None,
            idle_ttl_ms: None,
        }
    }

    fn seed_queued_dispatch(daemon_dir: &Path) {
        append_dispatch_queue_record(
            daemon_dir,
            &build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 1,
                timestamp: 1_710_000_700_001,
                correlation_id: "queue-dispatch-alpha".to_string(),
                dispatch_id: "dispatch-alpha".to_string(),
                ral: DispatchRalIdentity {
                    project_id: "project-alpha".to_string(),
                    agent_pubkey: TEST_AGENT_PUBKEY.to_string(),
                    conversation_id: "conversation-alpha".to_string(),
                    ral_number: 7,
                },
                triggering_event_id: "event-alpha".to_string(),
                claim_token: "claim-alpha".to_string(),
                status: DispatchQueueStatus::Queued,
            }),
        )
        .expect("queued dispatch must append");
    }

    fn seed_dispatch_input(daemon_dir: &Path) {
        write_create_or_compare_equal(
            daemon_dir,
            &WorkerDispatchInput::from_execute_fields(WorkerDispatchInputFromExecuteFields {
                dispatch_id: "dispatch-alpha".to_string(),
                source_type: WorkerDispatchInputSourceType::Nostr,
                writer: WorkerDispatchInputWriterMetadata {
                    writer: "daemon_loop_test".to_string(),
                    writer_version: "daemon-loop-test@0".to_string(),
                    timestamp: 1_710_000_700_030,
                },
                execute_fields: WorkerDispatchExecuteFields {
                    worker_id: Some("worker-alpha".to_string()),
                    triggering_event_id: "event-alpha".to_string(),
                    project_base_path: "/sidecar/repo".to_string(),
                    metadata_path: "/sidecar/repo/.tenex/project.json".to_string(),
                    triggering_envelope: triggering_envelope("event-alpha"),
                    execution_flags: AgentWorkerExecutionFlags {
                        is_delegation_completion: false,
                        has_pending_delegations: false,
                        debug: false,
                    },
                },
                source_metadata: Some(json!({ "eventId": "event-alpha" })),
            }),
        )
        .expect("dispatch input sidecar must write");
    }

    fn triggering_envelope(event_id: &str) -> Value {
        json!({
            "transport": "nostr",
            "principal": {
                "id": "nostr:owner-a",
                "transport": "nostr",
                "kind": "human"
            },
            "channel": {
                "id": "conversation:conversation-alpha",
                "transport": "nostr",
                "kind": "conversation"
            },
            "message": {
                "id": event_id,
                "transport": "nostr",
                "nativeId": event_id
            },
            "recipients": [
                {
                    "id": "nostr:agent-a",
                    "transport": "nostr",
                    "kind": "agent"
                }
            ],
            "content": "hello",
            "occurredAt": 1_710_001_000_000u64,
            "capabilities": ["reply"],
            "metadata": {}
        })
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
