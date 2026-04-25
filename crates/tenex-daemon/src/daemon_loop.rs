use std::collections::BTreeMap;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing;

use thiserror::Error;

use crate::backend_config::read_backend_config;
use crate::backend_heartbeat_latch::BackendHeartbeatLatchPlanner;
use crate::daemon_maintenance::{
    DaemonMaintenanceError, DaemonMaintenanceInput, DaemonMaintenanceOutcome,
    TelegramMaintenancePublisher, run_daemon_maintenance_once_from_filesystem,
    run_daemon_maintenance_once_from_filesystem_with_telegram,
};
use crate::daemon_signals::SessionCompletion;
use crate::daemon_worker_runtime::{
    AdmitWorkerDispatchOutcome, DaemonWorkerFilesystemTerminalInput,
    DaemonWorkerLivePublishMaintenance, DaemonWorkerOperationsStatusRuntimeInput,
    DaemonWorkerRuntimeOutcome, DaemonWorkerTelegramEgressRuntimeInput,
    admit_one_worker_dispatch_from_filesystem, run_started_worker_session_from_filesystem,
};
use crate::project_boot_state::{BootedProjectsState, ProjectBootState};
use crate::project_event_index::ProjectEventIndex;
use crate::publish_outbox::{
    PublishOutboxError, PublishOutboxMaintenanceReport, PublishOutboxRelayPublisher,
    PublishOutboxRetryPolicy,
};
use crate::publish_runtime::{PublishRuntimeMaintainInput, maintain_publish_runtime};
use crate::ral_journal::RalPendingDelegation;
use crate::ral_lock::RalLockInfo;
use crate::worker_dispatch::execution::{WorkerDispatchSession, WorkerDispatchSpawner};
use crate::worker_message_flow::WorkerMessagePublishContext;
use crate::worker_process::{AgentWorkerCommand, AgentWorkerProcessConfig};
use crate::worker_runtime_state::SharedWorkerRuntimeState;
use crate::worker_session::frame_pump::WorkerFrameReceiver;
use crate::worker_session::registry::{SessionJoinHandle, WorkerSessionRegistry};

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

#[derive(Debug)]
pub struct DaemonWorkerTickInput<'a> {
    pub runtime_state: SharedWorkerRuntimeState,
    pub correlation_id: String,
    pub lock_owner: RalLockInfo,
    pub command: AgentWorkerCommand,
    pub worker_config: &'a AgentWorkerProcessConfig,
    pub writer_version: String,
    pub resolved_pending_delegations: Vec<RalPendingDelegation>,
    pub publish_result_sequence: Option<Arc<AtomicU64>>,
    /// Registry of detached session threads. The tick pushes a new handle
    /// per admitted dispatch and polls for finished ones at the top of each
    /// tick.
    pub session_registry: WorkerSessionRegistry,
    /// Signal bus sender for session completions. Each spawned blocking task
    /// sends one `SessionCompletion` when it finishes so future driver tasks
    /// can react without polling. `None` in tests that don't need signal wiring.
    pub session_completed_tx: Option<tokio::sync::mpsc::UnboundedSender<SessionCompletion>>,
}

#[derive(Debug)]
pub struct DaemonWorkerLoopInput<'a> {
    pub runtime_state: SharedWorkerRuntimeState,
    pub correlation_id_prefix: String,
    pub lock_owner: RalLockInfo,
    pub command: AgentWorkerCommand,
    pub worker_config: &'a AgentWorkerProcessConfig,
    pub writer_version: String,
    pub resolved_pending_delegations: Vec<RalPendingDelegation>,
    pub publish_result_sequence: Option<Arc<AtomicU64>>,
    /// Shared registry of detached session threads; the driver joins any
    /// remaining entries at shutdown so no session is left running when the
    /// daemon stops.
    pub session_registry: WorkerSessionRegistry,
    /// Signal bus sender for session completions. See `DaemonWorkerTickInput`.
    pub session_completed_tx: Option<tokio::sync::mpsc::UnboundedSender<SessionCompletion>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonTickWithWorkerOutcome {
    pub maintenance: DaemonMaintenanceOutcome,
    /// Outcomes observed this tick. Sessions admitted this tick appear as
    /// `SessionAdmitted`; sessions that finished between the previous tick
    /// and this one appear as `SessionCompleted` / `SessionFailed`; a final
    /// `NotAdmitted` entry is appended if admission stopped early (empty
    /// queue or concurrency limit). Completions from the final tick are
    /// also captured, but any still-running threads at tick end keep running
    /// and are reported in a subsequent tick or at loop shutdown.
    pub worker_runtime: Vec<DaemonWorkerRuntimeOutcome>,
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
    log_daemon_tick_publish_summary("daemon tick", now_ms, &maintenance, None, &publish_outbox);

    Ok(DaemonTickOutcome {
        maintenance,
        publish_outbox,
    })
}

pub fn run_daemon_tick_once_from_filesystem_with_worker<P, S>(
    input: DaemonMaintenanceInput<'_>,
    worker: DaemonWorkerTickInput<'_>,
    spawner: &mut S,
    publisher: &Arc<Mutex<P>>,
    retry_policy: PublishOutboxRetryPolicy,
    telegram_publisher: &mut dyn TelegramMaintenancePublisher,
) -> Result<DaemonTickWithWorkerOutcome, DaemonTickWithWorkerError>
where
    P: PublishOutboxRelayPublisher + Send + 'static,
    S: WorkerDispatchSpawner,
    S::Session: WorkerFrameReceiver
        + WorkerDispatchSession<Error = <S::Session as WorkerFrameReceiver>::Error>
        + Send
        + 'static,
    <S::Session as WorkerFrameReceiver>::Error: Send,
{
    let daemon_dir = input.daemon_dir;
    let tenex_base_dir = input.tenex_base_dir;
    let now_ms = input.now_ms;
    let maintenance =
        run_daemon_maintenance_once_from_filesystem_with_telegram(input, &mut *telegram_publisher)?;
    let telegram_egress =
        worker_telegram_egress_runtime_input(tenex_base_dir, &worker.writer_version);
    let operations_status_project_owner_pubkeys = maintenance
        .booted_project_descriptor_report
        .descriptors
        .iter()
        .map(|descriptor| {
            (
                descriptor.project_d_tag.clone(),
                descriptor.project_owner_pubkey.clone(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    // Drain any session threads that finished between the previous tick and
    // this one. Their terminal outcomes land in this tick's worker_runtime.
    let mut worker_runtime: Vec<DaemonWorkerRuntimeOutcome> =
        worker.session_registry.drain_finished();

    // Admit-loop: keep admitting queued dispatches and spawning a detached
    // OS thread per admitted session until admission returns NotAdmitted.
    // Threads run independently across tick boundaries; the next tick picks
    // up their completions via drain_finished().
    let mut admitted_this_tick = 0usize;
    let final_not_admitted: DaemonWorkerRuntimeOutcome = loop {
        let correlation_id = format!("{}:admission-{}", worker.correlation_id, admitted_this_tick);
        let admission = admit_one_worker_dispatch_from_filesystem(
            spawner,
            daemon_dir,
            &worker.runtime_state,
            now_ms,
            &correlation_id,
            worker.lock_owner.clone(),
            worker.command.clone(),
            worker.worker_config,
        )
        .map_err(|source| DaemonTickWithWorkerError::WorkerRuntime {
            message: source.to_string(),
        })?;
        match admission {
            AdmitWorkerDispatchOutcome::Admitted(started) => {
                let dispatch_id = started.runtime_started.dispatch_id.clone();
                let worker_id = started.runtime_started.worker_id.clone();
                let daemon_dir_owned: PathBuf = daemon_dir.to_path_buf();
                let runtime_state_clone = worker.runtime_state.clone();
                let publisher_for_thread = Arc::clone(publisher);
                let publish_ctx = worker.publish_result_sequence.as_ref().map(|source| {
                    WorkerMessagePublishContext {
                        accepted_at: now_ms,
                        result_sequence_source: source.clone(),
                        result_timestamp: now_ms,
                        telegram_egress: None,
                    }
                });
                let telegram_egress_clone = telegram_egress.clone();
                let operations_status_tenex_base_dir: PathBuf = tenex_base_dir.to_path_buf();
                let operations_status_pubkeys = operations_status_project_owner_pubkeys.clone();
                let writer_version = worker.writer_version.clone();
                let resolved_pending_delegations = worker.resolved_pending_delegations.clone();
                let dispatch_correlation_id =
                    format!("{}:complete-{}", worker.correlation_id, admitted_this_tick);
                let dispatch_id_for_thread = dispatch_id.clone();
                let worker_id_for_thread = worker_id.clone();
                let session_completed_tx_for_spawn = worker.session_completed_tx.clone();
                let handle = tokio::task::spawn_blocking(move || {
                    let publisher_for_live = Arc::clone(&publisher_for_thread);
                    let mut live_publish_maintenance = move |daemon_dir: &Path, now: u64| {
                        let mut guard =
                            publisher_for_live.lock().expect("publisher mutex poisoned");
                        maintain_publish_runtime(PublishRuntimeMaintainInput {
                            daemon_dir,
                            publisher: &mut *guard,
                            now,
                            retry_policy,
                        })
                        .map(|_| ())
                        .map_err(|source| source.to_string())
                    };
                    let operations_status = DaemonWorkerOperationsStatusRuntimeInput {
                        tenex_base_dir: operations_status_tenex_base_dir.as_path(),
                        project_owner_pubkeys: &operations_status_pubkeys,
                    };
                    let result = run_started_worker_session_from_filesystem(
                        daemon_dir_owned.as_path(),
                        &runtime_state_clone,
                        now_ms,
                        publish_ctx,
                        telegram_egress_clone,
                        Some(operations_status),
                        Some(DaemonWorkerLivePublishMaintenance {
                            maintain: &mut live_publish_maintenance,
                        }),
                        DaemonWorkerFilesystemTerminalInput {
                            timestamp: now_ms,
                            writer_version,
                            resolved_pending_delegations,
                            dispatch_correlation_id,
                        },
                        started,
                    );
                    let outcome = match result {
                        Ok(outcome) => outcome,
                        Err(source) => {
                            tracing::error!(
                                error = %source,
                                dispatch_id = %dispatch_id_for_thread,
                                worker_id = %worker_id_for_thread,
                                "detached session task returned error"
                            );
                            DaemonWorkerRuntimeOutcome::SessionFailed {
                                dispatch_id: dispatch_id_for_thread,
                                worker_id: worker_id_for_thread,
                                error: source.to_string(),
                            }
                        }
                    };
                    if let Some(tx) = &session_completed_tx_for_spawn {
                        let _ = tx.send(SessionCompletion);
                    }
                    crate::foreground_wake::request_wake();
                    outcome
                });
                worker.session_registry.push(SessionJoinHandle {
                    dispatch_id: dispatch_id.clone(),
                    worker_id: worker_id.clone(),
                    handle,
                });
                worker_runtime.push(DaemonWorkerRuntimeOutcome::SessionAdmitted {
                    dispatch_id,
                    worker_id,
                });
                admitted_this_tick += 1;
            }
            AdmitWorkerDispatchOutcome::NotAdmitted {
                reason,
                blocked_candidates,
            } => {
                break DaemonWorkerRuntimeOutcome::NotAdmitted {
                    reason,
                    blocked_candidates,
                };
            }
        }
    };
    worker_runtime.push(final_not_admitted);
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
    log_daemon_tick_publish_summary(
        "daemon worker tick",
        now_ms,
        &maintenance,
        Some(worker_runtime.as_slice()),
        &publish_outbox,
    );

    Ok(DaemonTickWithWorkerOutcome {
        maintenance,
        worker_runtime,
        publish_outbox,
    })
}

fn log_daemon_tick_publish_summary(
    message: &'static str,
    now_ms: u64,
    maintenance: &DaemonMaintenanceOutcome,
    worker_runtime: Option<&[DaemonWorkerRuntimeOutcome]>,
    publish_outbox: &PublishOutboxMaintenanceReport,
) {
    let backend_enqueued_event_count = backend_enqueued_event_count(maintenance);
    let backend_due_task_count = maintenance.backend_events.tick.due_task_names.len();
    let project_descriptor_count = maintenance.project_descriptor_report.descriptors.len();
    let booted_project_descriptor_count = maintenance
        .booted_project_descriptor_report
        .descriptors
        .len();
    let project_status_count = maintenance.backend_events.tick.project_statuses.len();
    let worker_outcome: Option<Vec<&'static str>> =
        worker_runtime.map(|outcomes| outcomes.iter().map(worker_runtime_outcome_label).collect());
    let publish_pending_before = publish_outbox.diagnostics_before.pending_count;
    let publish_failed_before = publish_outbox.diagnostics_before.failed_count;
    let publish_requeued_count = publish_outbox.requeued.len();
    let publish_drained_count = publish_outbox.drained.len();
    let publish_pending_after = publish_outbox.diagnostics_after.pending_count;
    let publish_published_after = publish_outbox.diagnostics_after.published_count;
    let publish_failed_after = publish_outbox.diagnostics_after.failed_count;
    let publish_retry_due_after = publish_outbox.diagnostics_after.retry_due_count;
    let any_session_completed = worker_runtime
        .map(|outcomes| {
            outcomes.iter().any(|o| {
                matches!(
                    o,
                    DaemonWorkerRuntimeOutcome::SessionCompleted { .. }
                        | DaemonWorkerRuntimeOutcome::SessionAdmitted { .. }
                        | DaemonWorkerRuntimeOutcome::SessionFailed { .. }
                )
            })
        })
        .unwrap_or(false);
    let has_activity = backend_due_task_count > 0
        || backend_enqueued_event_count > 0
        || publish_pending_before > 0
        || publish_failed_before > 0
        || publish_requeued_count > 0
        || publish_drained_count > 0
        || any_session_completed;

    crate::stdout_status::report_publish_backlog(
        publish_pending_before,
        publish_drained_count,
        publish_pending_after,
    );

    if has_activity {
        tracing::info!(
            tick_kind = message,
            now_ms,
            backend_due_task_count,
            backend_enqueued_event_count,
            project_descriptor_count,
            booted_project_descriptor_count,
            project_status_count,
            worker_outcome = ?worker_outcome,
            publish_pending_before,
            publish_failed_before,
            publish_requeued_count,
            publish_drained_count,
            publish_pending_after,
            publish_published_after,
            publish_failed_after,
            publish_retry_due_after,
            "daemon tick publish summary"
        );
    } else {
        tracing::debug!(
            tick_kind = message,
            now_ms,
            backend_due_task_count,
            backend_enqueued_event_count,
            project_descriptor_count,
            booted_project_descriptor_count,
            project_status_count,
            worker_outcome = ?worker_outcome,
            publish_pending_after,
            publish_published_after,
            publish_failed_after,
            publish_retry_due_after,
            "daemon tick publish summary"
        );
    }
}

fn backend_enqueued_event_count(maintenance: &DaemonMaintenanceOutcome) -> usize {
    maintenance
        .backend_events
        .tick
        .project_statuses
        .iter()
        .map(|status| status.enqueued_event_count)
        .sum::<usize>()
}

fn worker_runtime_outcome_label(outcome: &DaemonWorkerRuntimeOutcome) -> &'static str {
    match outcome {
        DaemonWorkerRuntimeOutcome::NotAdmitted { .. } => "not_admitted",
        DaemonWorkerRuntimeOutcome::SessionAdmitted { .. } => "session_admitted",
        DaemonWorkerRuntimeOutcome::SessionCompleted { .. } => "session_completed",
        DaemonWorkerRuntimeOutcome::SessionFailed { .. } => "session_failed",
    }
}

fn worker_telegram_egress_runtime_input(
    tenex_base_dir: &Path,
    writer_version: &str,
) -> Option<DaemonWorkerTelegramEgressRuntimeInput> {
    let backend_pubkey = match read_backend_config(tenex_base_dir)
        .and_then(|config| config.backend_signer())
        .map(|signer| signer.pubkey_hex().to_string())
    {
        Ok(pubkey) => pubkey,
        Err(error) => {
            tracing::warn!(
                error = %error,
                "worker telegram egress context unavailable; proactive telegram egress will fail closed"
            );
            return None;
        }
    };

    Some(DaemonWorkerTelegramEgressRuntimeInput {
        data_dir: tenex_base_dir.join("data"),
        backend_pubkey,
        writer_version: writer_version.to_string(),
    })
}

#[derive(Debug, Clone)]
pub struct DaemonMaintenanceLoopInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub max_iterations: u64,
    pub sleep_ms: u64,
    pub project_boot_state: Arc<Mutex<ProjectBootState>>,
    pub project_event_index: Arc<Mutex<ProjectEventIndex>>,
    /// Optional latch shared with the whitelist ingress; when present, a
    /// `Stopped` state gates the kind 24012 heartbeat publish.
    pub heartbeat_latch: Option<Arc<Mutex<BackendHeartbeatLatchPlanner>>>,
}

#[derive(Debug, Clone)]
pub struct DaemonMaintenanceStoppableLoopInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub max_iterations: Option<u64>,
    pub sleep_ms: u64,
    pub project_boot_state: Arc<Mutex<ProjectBootState>>,
    pub project_event_index: Arc<Mutex<ProjectEventIndex>>,
    /// See [`DaemonMaintenanceLoopInput::heartbeat_latch`].
    pub heartbeat_latch: Option<Arc<Mutex<BackendHeartbeatLatchPlanner>>>,
}

pub fn run_daemon_tick_loop_from_filesystem<C, S, P>(
    input: DaemonMaintenanceLoopInput<'_>,
    clock: &mut C,
    sleeper: &mut S,
    publisher: &Arc<Mutex<P>>,
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
    let heartbeat_latch = input.heartbeat_latch.clone();
    let project_boot_state = input.project_boot_state.clone();
    let project_event_index = input.project_event_index.clone();
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
                    project_boot_state: project_boot_state_snapshot(&project_boot_state),
                    project_event_index: Arc::clone(&project_event_index),
                    heartbeat_latch: heartbeat_latch.clone(),
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
    publisher: &Arc<Mutex<P>>,
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
    let heartbeat_latch = input.heartbeat_latch.clone();
    let project_boot_state = input.project_boot_state.clone();
    let project_event_index = input.project_event_index.clone();
    if input.max_iterations.is_some() {
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
                        project_boot_state: project_boot_state_snapshot(&project_boot_state),
                        project_event_index: Arc::clone(&project_event_index),
                        heartbeat_latch: heartbeat_latch.clone(),
                    },
                    publisher,
                    retry_policy,
                )
            },
        )
    } else {
        run_resilient_daemon_maintenance_loop_until_stopped(
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
                        project_boot_state: project_boot_state_snapshot(&project_boot_state),
                        project_event_index: Arc::clone(&project_event_index),
                        heartbeat_latch: heartbeat_latch.clone(),
                    },
                    publisher,
                    retry_policy,
                )
            },
        )
    }
}

/// Return type of the worker tick loop. Carries the per-tick outcomes plus
/// the `shutdown_completions` drained by joining every remaining session
/// thread at loop exit, so the caller can observe sessions that started
/// inside the loop but finished after the last tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonWorkerLoopOutcome {
    pub tick_loop: DaemonMaintenanceLoopOutcome<DaemonTickWithWorkerOutcome>,
    pub shutdown_completions: Vec<DaemonWorkerRuntimeOutcome>,
}

pub fn run_daemon_tick_loop_until_stopped_from_filesystem_with_worker<C, Sleep, Stop, P, S>(
    input: DaemonMaintenanceStoppableLoopInput<'_>,
    worker: DaemonWorkerLoopInput<'_>,
    clock: &mut C,
    sleeper: &mut Sleep,
    stop_signal: &mut Stop,
    spawner: &mut S,
    publisher: &Arc<Mutex<P>>,
    retry_policy: PublishOutboxRetryPolicy,
    telegram_publisher: &mut dyn TelegramMaintenancePublisher,
) -> Result<DaemonWorkerLoopOutcome, DaemonMaintenanceLoopError<DaemonTickWithWorkerError>>
where
    C: DaemonMaintenanceLoopClock,
    Sleep: DaemonMaintenanceLoopSleeper,
    Stop: DaemonMaintenanceLoopStopSignal,
    P: PublishOutboxRelayPublisher + Send + 'static,
    S: WorkerDispatchSpawner,
    S::Session: WorkerFrameReceiver
        + WorkerDispatchSession<Error = <S::Session as WorkerFrameReceiver>::Error>
        + Send
        + 'static,
    <S::Session as WorkerFrameReceiver>::Error: Send,
{
    let DaemonWorkerLoopInput {
        runtime_state,
        correlation_id_prefix,
        lock_owner,
        command,
        worker_config,
        writer_version,
        resolved_pending_delegations,
        publish_result_sequence,
        session_registry,
        session_completed_tx,
    } = worker;
    let heartbeat_latch = input.heartbeat_latch.clone();
    let project_boot_state = input.project_boot_state.clone();
    let project_event_index = input.project_event_index.clone();

    let run_tick = |now_ms: u64| {
        run_daemon_tick_once_from_filesystem_with_worker(
            DaemonMaintenanceInput {
                tenex_base_dir: input.tenex_base_dir,
                daemon_dir: input.daemon_dir,
                now_ms,
                project_boot_state: project_boot_state_snapshot(&project_boot_state),
                project_event_index: Arc::clone(&project_event_index),
                heartbeat_latch: heartbeat_latch.clone(),
            },
            DaemonWorkerTickInput {
                runtime_state: runtime_state.clone(),
                correlation_id: format!("{correlation_id_prefix}:{now_ms}"),
                lock_owner: lock_owner.clone(),
                command: command.clone(),
                worker_config,
                writer_version: writer_version.clone(),
                resolved_pending_delegations: resolved_pending_delegations.clone(),
                publish_result_sequence: publish_result_sequence.clone(),
                session_registry: session_registry.clone(),
                session_completed_tx: session_completed_tx.clone(),
            },
            spawner,
            publisher,
            retry_policy,
            &mut *telegram_publisher,
        )
    };

    let tick_loop = if input.max_iterations.is_some() {
        run_daemon_maintenance_loop_until_stopped(
            clock,
            sleeper,
            stop_signal,
            input.max_iterations,
            input.sleep_ms,
            run_tick,
        )?
    } else {
        run_resilient_daemon_maintenance_loop_until_stopped(
            clock,
            sleeper,
            stop_signal,
            input.max_iterations,
            input.sleep_ms,
            run_tick,
        )?
    };

    // Join any session threads that were still running when the tick loop
    // stopped. This keeps the daemon from returning while worker processes
    // are still mid-session.
    let shutdown_completions = session_registry.join_all();

    Ok(DaemonWorkerLoopOutcome {
        tick_loop,
        shutdown_completions,
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

fn project_boot_state_snapshot(
    project_boot_state: &Arc<Mutex<ProjectBootState>>,
) -> BootedProjectsState {
    project_boot_state
        .lock()
        .expect("project boot state mutex must not be poisoned")
        .snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::daemon_maintenance::NoTelegramPublisher;
    use crate::dispatch_queue::{
        DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        append_dispatch_queue_record, build_dispatch_queue_record, replay_dispatch_queue,
    };
    use crate::nostr_event::SignedNostrEvent;
    use crate::publish_outbox::{
        PublishRelayError, PublishRelayReport, PublishRelayResult, inspect_publish_outbox,
    };
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
        RalReplayStatus, append_ral_journal_record, replay_ral_journal,
    };
    use crate::ral_lock::build_ral_lock_info;
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
    use std::sync::Barrier;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio;

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
    fn filesystem_tick_loop_drains_publish_outbox_after_daemon_maintenance() {
        let fixture = TickFilesystemFixture::new("daemon-loop-publish-success", 0x04);
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![1_710_001_000_000]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));

        let outcome = run_daemon_tick_loop_from_filesystem(
            DaemonMaintenanceLoopInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                daemon_dir: &fixture.daemon_dir,
                max_iterations: 1,
                sleep_ms: 30_000,
                project_boot_state: Arc::clone(&fixture.project_boot_state),
                project_event_index: Arc::clone(&fixture.project_event_index),
                heartbeat_latch: None,
            },
            &mut clock,
            &mut sleeper,
            &publisher,
            PublishOutboxRetryPolicy::default(),
        )
        .expect("filesystem tick loop must succeed");

        assert_eq!(outcome.steps.len(), 1);
        let tick = &outcome.steps[0].maintenance_outcome;
        assert_eq!(
            tick.maintenance.backend_events.tick.due_task_names,
            vec![format!(
                "project-status:{}:demo-project",
                fixture.owner_pubkey
            )]
        );
        assert_eq!(tick.publish_outbox.diagnostics_before.pending_count, 1);
        assert_eq!(tick.publish_outbox.drained.len(), 1);
        assert_eq!(tick.publish_outbox.diagnostics_after.pending_count, 0);
        assert_eq!(tick.publish_outbox.diagnostics_after.published_count, 1);
        assert_eq!(publisher.lock().unwrap().event_ids.len(), 1);
        assert!(sleeper.sleeps_ms.is_empty());

        let publish_outbox = inspect_publish_outbox(&fixture.daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.pending_count, 0);
        assert_eq!(publish_outbox.published_count, 1);
    }

    #[test]
    fn filesystem_tick_loop_records_retryable_publish_failures() {
        let fixture = TickFilesystemFixture::new("daemon-loop-publish-failure", 0x05);
        let mut clock = RecordingClock {
            now_ms_values: VecDeque::from(vec![1_710_001_000_000]),
            observed_now_ms_values: Vec::new(),
        };
        let mut sleeper = RecordingSleeper::default();
        let publisher = Arc::new(Mutex::new(RetryableFailurePublisher::default()));

        let outcome = run_daemon_tick_loop_from_filesystem(
            DaemonMaintenanceLoopInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                daemon_dir: &fixture.daemon_dir,
                max_iterations: 1,
                sleep_ms: 30_000,
                project_boot_state: Arc::clone(&fixture.project_boot_state),
                project_event_index: Arc::clone(&fixture.project_event_index),
                heartbeat_latch: None,
            },
            &mut clock,
            &mut sleeper,
            &publisher,
            PublishOutboxRetryPolicy::default(),
        )
        .expect("filesystem tick loop must record retryable publish failures");

        let tick = &outcome.steps[0].maintenance_outcome;
        assert_eq!(tick.publish_outbox.diagnostics_before.pending_count, 1);
        assert_eq!(tick.publish_outbox.drained.len(), 1);
        assert!(
            tick.publish_outbox
                .drained
                .iter()
                .all(|drain| drain.status == crate::publish_outbox::PublishOutboxStatus::Failed)
        );
        assert_eq!(tick.publish_outbox.diagnostics_after.pending_count, 0);
        assert_eq!(tick.publish_outbox.diagnostics_after.failed_count, 1);
        assert_eq!(
            tick.publish_outbox.diagnostics_after.retryable_failed_count,
            1
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
        assert_eq!(publisher.lock().unwrap().publish_attempts, 1);
        assert!(sleeper.sleeps_ms.is_empty());

        let publish_outbox = inspect_publish_outbox(&fixture.daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.failed_count, 1);
        assert_eq!(publish_outbox.retryable_failed_count, 1);
    }

    #[test]
    fn filesystem_tick_with_worker_runs_worker_runtime_before_publish_drain() {
        let fixture = TickFilesystemFixture::new("daemon-loop-worker-empty-queue", 0x06);
        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let mut telegram_publisher = NoTelegramPublisher;
        let mut spawner = EmptyQueueSpawner::default();
        let runtime_state = new_shared_worker_runtime_state();
        let worker_config = AgentWorkerProcessConfig::default();

        let outcome = run_daemon_tick_once_from_filesystem_with_worker(
            DaemonMaintenanceInput {
                tenex_base_dir: &fixture.tenex_base_dir,
                daemon_dir: &fixture.daemon_dir,
                now_ms: 1_710_001_000_000,
                project_boot_state: project_boot_state_snapshot(&fixture.project_boot_state),
                project_event_index: Arc::clone(&fixture.project_event_index),
                heartbeat_latch: None,
            },
            DaemonWorkerTickInput {
                runtime_state: runtime_state.clone(),
                correlation_id: "daemon-loop-worker-empty-queue".to_string(),
                lock_owner: build_ral_lock_info(100, "host-a", 1_710_001_000_000),
                command: AgentWorkerCommand::new("bun"),
                worker_config: &worker_config,
                writer_version: "daemon-loop-test@0".to_string(),
                resolved_pending_delegations: Vec::new(),
                publish_result_sequence: None,
                session_registry: WorkerSessionRegistry::new(),
                session_completed_tx: None,
            },
            &mut spawner,
            &publisher,
            PublishOutboxRetryPolicy::default(),
            &mut telegram_publisher,
        )
        .expect("filesystem tick with worker must succeed");

        assert_eq!(
            outcome.maintenance.backend_events.tick.due_task_names,
            vec![format!(
                "project-status:{}:demo-project",
                fixture.owner_pubkey
            )]
        );
        assert_eq!(outcome.worker_runtime.len(), 1);
        assert!(matches!(
            outcome.worker_runtime[0],
            DaemonWorkerRuntimeOutcome::NotAdmitted {
                reason: WorkerDispatchAdmissionBlockedReason::NoQueuedDispatches,
                blocked_candidates: _,
            }
        ));
        assert_eq!(spawner.spawn_calls, 0);
        assert_eq!(outcome.publish_outbox.diagnostics_before.pending_count, 1);
        assert_eq!(outcome.publish_outbox.drained.len(), 1);
        assert_eq!(outcome.publish_outbox.diagnostics_after.pending_count, 0);
        assert_eq!(publisher.lock().unwrap().event_ids.len(), 1);
    }

    #[test]
    fn filesystem_tick_with_worker_drains_publish_outbox_after_worker_runtime_error() {
        let fixture = TickFilesystemFixture::new("daemon-loop-worker-error-drain", 0x07);
        let scenario = DispatchScenario {
            project_id: "project-alpha",
            agent_pubkey: TEST_AGENT_PUBKEY.to_string(),
            conversation_id: "conversation-alpha",
            ral_number: 7,
            dispatch_id: "dispatch-alpha",
            dispatch_sequence: 1,
            dispatch_timestamp: 1_710_000_700_001,
            correlation_id: "queue-dispatch-alpha",
            triggering_event_id: "event-alpha",
            claim_token: "claim-alpha",
            worker_id: "worker-alpha",
            ral_alloc_sequence: 1,
            ral_alloc_timestamp: 1_710_000_700_001,
            ral_alloc_correlation_id: "ral-alloc-alpha",
            ral_claim_sequence: 2,
            ral_claim_timestamp: 1_710_000_700_002,
            ral_claim_correlation_id: "ral-claim-alpha",
        };
        seed_queued_dispatch_for(&fixture.daemon_dir, &scenario);
        seed_dispatch_input_for(&fixture.daemon_dir, &scenario);
        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let runtime_state = new_shared_worker_runtime_state();
        let session_registry = WorkerSessionRegistry::new();

        let tenex_base_dir = fixture.tenex_base_dir.clone();
        let daemon_dir = fixture.daemon_dir.clone();
        let project_boot_state = project_boot_state_snapshot(&fixture.project_boot_state);
        let project_event_index = Arc::clone(&fixture.project_event_index);
        let publisher_clone = Arc::clone(&publisher);
        let session_registry_clone = session_registry.clone();
        let runtime_state_clone = runtime_state.clone();

        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime must build");
        let (outcome, spawner, session_outcomes) = rt
            .block_on(async {
                tokio::task::spawn_blocking(move || {
                    let worker_config = AgentWorkerProcessConfig::default();
                    let mut spawner = ProtocolErrorSpawner::default();
                    let mut telegram_publisher = NoTelegramPublisher;
                    let outcome = run_daemon_tick_once_from_filesystem_with_worker(
                        DaemonMaintenanceInput {
                            tenex_base_dir: &tenex_base_dir,
                            daemon_dir: &daemon_dir,
                            now_ms: 1_710_001_000_000,
                            project_boot_state,
                            project_event_index,
                            heartbeat_latch: None,
                        },
                        DaemonWorkerTickInput {
                            runtime_state: runtime_state_clone,
                            correlation_id: "daemon-loop-worker-error-drain".to_string(),
                            lock_owner: build_ral_lock_info(100, "host-a", 1_710_001_000_000),
                            command: AgentWorkerCommand::new("bun"),
                            worker_config: &worker_config,
                            writer_version: "daemon-loop-test@0".to_string(),
                            resolved_pending_delegations: Vec::new(),
                            publish_result_sequence: None,
                            session_registry: session_registry_clone.clone(),
                            session_completed_tx: None,
                        },
                        &mut spawner,
                        &publisher_clone,
                        PublishOutboxRetryPolicy::default(),
                        &mut telegram_publisher,
                    )
                    .expect(
                        "tick must succeed; admission is synchronous and session errors detach",
                    );
                    // Join sessions inside the blocking context where Handle::current() is valid.
                    let session_outcomes = session_registry_clone.join_all();
                    (outcome, spawner, session_outcomes)
                })
                .await
                .expect("spawn_blocking must not panic")
            });

        // Tick admitted the session (and reports NoQueuedDispatches next).
        assert!(
            outcome
                .worker_runtime
                .iter()
                .any(|o| matches!(o, DaemonWorkerRuntimeOutcome::SessionAdmitted { .. }))
        );
        // The spawned session task errors out asynchronously; join it and
        // assert the failure is reported.
        assert_eq!(session_outcomes.len(), 1);
        assert!(matches!(
            session_outcomes[0],
            DaemonWorkerRuntimeOutcome::SessionFailed { .. }
        ));
        assert_eq!(spawner.spawn_calls, 1);
        // Publish outbox drain still runs before the tick returns.
        assert_eq!(publisher.lock().unwrap().event_ids.len(), 1);
        let publish_outbox = inspect_publish_outbox(&fixture.daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.pending_count, 0);
        assert_eq!(publish_outbox.published_count, 1);
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

    /// One independent `(RAL identity, dispatch, worker)` tuple used to seed
    /// the filesystem fixtures for a concurrent-session test.
    #[derive(Debug, Clone)]
    struct DispatchScenario {
        project_id: &'static str,
        agent_pubkey: String,
        conversation_id: &'static str,
        ral_number: u64,
        dispatch_id: &'static str,
        dispatch_sequence: u64,
        dispatch_timestamp: u64,
        correlation_id: &'static str,
        triggering_event_id: &'static str,
        claim_token: &'static str,
        worker_id: &'static str,
        ral_alloc_sequence: u64,
        ral_alloc_timestamp: u64,
        ral_alloc_correlation_id: &'static str,
        ral_claim_sequence: u64,
        ral_claim_timestamp: u64,
        ral_claim_correlation_id: &'static str,
    }

    impl DispatchScenario {
        fn ral_identity(&self) -> RalJournalIdentity {
            RalJournalIdentity {
                project_id: self.project_id.to_string(),
                agent_pubkey: self.agent_pubkey.clone(),
                conversation_id: self.conversation_id.to_string(),
                ral_number: self.ral_number,
            }
        }
    }

    fn seed_queued_dispatch_for(daemon_dir: &Path, scenario: &DispatchScenario) {
        append_dispatch_queue_record(
            daemon_dir,
            &build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: scenario.dispatch_sequence,
                timestamp: scenario.dispatch_timestamp,
                correlation_id: scenario.correlation_id.to_string(),
                dispatch_id: scenario.dispatch_id.to_string(),
                ral: DispatchRalIdentity {
                    project_id: scenario.project_id.to_string(),
                    agent_pubkey: scenario.agent_pubkey.clone(),
                    conversation_id: scenario.conversation_id.to_string(),
                    ral_number: scenario.ral_number,
                },
                triggering_event_id: scenario.triggering_event_id.to_string(),
                claim_token: scenario.claim_token.to_string(),
                status: DispatchQueueStatus::Queued,
            }),
        )
        .expect("queued dispatch must append");
    }

    fn seed_dispatch_input_for(daemon_dir: &Path, scenario: &DispatchScenario) {
        write_create_or_compare_equal(
            daemon_dir,
            &WorkerDispatchInput::from_execute_fields(WorkerDispatchInputFromExecuteFields {
                dispatch_id: scenario.dispatch_id.to_string(),
                source_type: WorkerDispatchInputSourceType::Nostr,
                writer: WorkerDispatchInputWriterMetadata {
                    writer: "daemon_loop_test".to_string(),
                    writer_version: "daemon-loop-test@0".to_string(),
                    timestamp: scenario.dispatch_timestamp + 29,
                },
                execute_fields: WorkerDispatchExecuteFields {
                    worker_id: Some(scenario.worker_id.to_string()),
                    triggering_event_id: scenario.triggering_event_id.to_string(),
                    project_base_path: "/sidecar/repo".to_string(),
                    metadata_path: "/sidecar/repo/.tenex/project.json".to_string(),
                    triggering_envelope: triggering_envelope_for(scenario),
                    execution_flags: AgentWorkerExecutionFlags {
                        is_delegation_completion: false,
                        has_pending_delegations: false,
                        pending_delegation_ids: Vec::new(),
                        debug: false,
                    },
                },
                source_metadata: Some(json!({ "eventId": scenario.triggering_event_id })),
            }),
        )
        .expect("dispatch input sidecar must write");
    }

    fn seed_claimed_ral_for(daemon_dir: &Path, scenario: &DispatchScenario) {
        append_ral_journal_record(
            daemon_dir,
            &RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "daemon-loop-test@0",
                scenario.ral_alloc_sequence,
                scenario.ral_alloc_timestamp,
                scenario.ral_alloc_correlation_id,
                RalJournalEvent::Allocated {
                    identity: scenario.ral_identity(),
                    triggering_event_id: Some(scenario.triggering_event_id.to_string()),
                },
            ),
        )
        .expect("allocated RAL record must append");
        append_ral_journal_record(
            daemon_dir,
            &RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "daemon-loop-test@0",
                scenario.ral_claim_sequence,
                scenario.ral_claim_timestamp,
                scenario.ral_claim_correlation_id,
                RalJournalEvent::Claimed {
                    identity: scenario.ral_identity(),
                    worker_id: scenario.worker_id.to_string(),
                    claim_token: scenario.claim_token.to_string(),
                },
            ),
        )
        .expect("claimed RAL record must append");
    }

    fn triggering_envelope_for(scenario: &DispatchScenario) -> Value {
        let native_id = scenario.triggering_event_id;
        json!({
            "transport": "nostr",
            "principal": {
                "id": format!("nostr:owner-{}", scenario.project_id),
                "transport": "nostr",
                "kind": "human"
            },
            "channel": {
                "id": format!("conversation:{}", scenario.conversation_id),
                "transport": "nostr",
                "kind": "conversation"
            },
            "message": {
                "id": native_id,
                "transport": "nostr",
                "nativeId": native_id
            },
            "recipients": [
                {
                    "id": format!("nostr:agent-{}", scenario.agent_pubkey),
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

    fn heartbeat_message_for(scenario: &DispatchScenario) -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "heartbeat",
            "correlationId": format!("{}-heartbeat", scenario.worker_id),
            "sequence": 20,
            "timestamp": 1_710_001_000_100_u64,
            "projectId": scenario.project_id,
            "agentPubkey": scenario.agent_pubkey,
            "conversationId": scenario.conversation_id,
            "ralNumber": scenario.ral_number,
            "state": "streaming",
            "activeToolCount": 0,
            "accumulatedRuntimeMs": 700_u64,
        })
    }

    fn complete_message_for(scenario: &DispatchScenario) -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "complete",
            "correlationId": format!("{}-complete", scenario.worker_id),
            "sequence": 21,
            "timestamp": 1_710_001_000_200_u64,
            "projectId": scenario.project_id,
            "agentPubkey": scenario.agent_pubkey,
            "conversationId": scenario.conversation_id,
            "ralNumber": scenario.ral_number,
            "finalRalState": "completed",
            "publishedUserVisibleEvent": true,
            "pendingDelegationsRemain": false,
            "accumulatedRuntimeMs": 900_u64,
            "finalEventIds": [format!("event-published-{}", scenario.dispatch_id)],
            "keepWorkerWarm": false,
        })
    }

    fn frame_for(message: &Value) -> Vec<u8> {
        encode_agent_worker_protocol_frame(message).expect("worker frame must encode")
    }

    /// Spawner that returns two distinct `BarrierGatedSession` instances wired
    /// to the same `Arc<Barrier>`. The first call each session makes to
    /// `receive_worker_frame` waits at the barrier, so both session threads
    /// must be running concurrently before either one can progress past its
    /// first frame — proving the tick really did launch them in parallel.
    struct BarrierGatedSpawner {
        sessions: VecDeque<BarrierGatedSession>,
        spawn_calls: usize,
    }

    impl BarrierGatedSpawner {
        fn new(sessions: Vec<BarrierGatedSession>) -> Self {
            Self {
                sessions: VecDeque::from(sessions),
                spawn_calls: 0,
            }
        }
    }

    impl WorkerDispatchSpawner for BarrierGatedSpawner {
        type Session = BarrierGatedSession;
        type Error = BarrierGatedWorkerError;

        fn spawn_worker(
            &mut self,
            _command: &AgentWorkerCommand,
            _config: &AgentWorkerProcessConfig,
        ) -> Result<BootedWorkerDispatch<Self::Session>, Self::Error> {
            self.spawn_calls += 1;
            let session = self.sessions.pop_front().ok_or(BarrierGatedWorkerError(
                "spawn_worker called more times than prepared sessions",
            ))?;
            let ready = ready_message(session.worker_id);
            Ok(BootedWorkerDispatch { ready, session })
        }
    }

    struct BarrierGatedSession {
        worker_id: &'static str,
        barrier: Arc<Barrier>,
        barrier_fired: bool,
        frames: VecDeque<Vec<u8>>,
    }

    impl BarrierGatedSession {
        fn new(worker_id: &'static str, barrier: Arc<Barrier>, frames: Vec<Vec<u8>>) -> Self {
            Self {
                worker_id,
                barrier,
                barrier_fired: false,
                frames: VecDeque::from(frames),
            }
        }
    }

    impl WorkerDispatchSession for BarrierGatedSession {
        type Error = BarrierGatedWorkerError;

        fn send_worker_message(&mut self, _message: &Value) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    impl WorkerFrameReceiver for BarrierGatedSession {
        type Error = BarrierGatedWorkerError;

        fn receive_worker_frame(&mut self) -> Result<Vec<u8>, Self::Error> {
            if !self.barrier_fired {
                self.barrier_fired = true;
                self.barrier.wait();
            }
            self.frames
                .pop_front()
                .ok_or(BarrierGatedWorkerError("no more frames queued"))
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct BarrierGatedWorkerError(&'static str);

    impl fmt::Display for BarrierGatedWorkerError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    impl StdError for BarrierGatedWorkerError {}

    #[test]
    fn filesystem_tick_admits_two_concurrent_worker_sessions_to_completion() {
        let fixture = TickFilesystemFixture::new("daemon-loop-worker-concurrent", 0x08);

        let alpha = DispatchScenario {
            project_id: "project-alpha",
            agent_pubkey: TEST_AGENT_PUBKEY.to_string(),
            conversation_id: "conversation-alpha",
            ral_number: 7,
            dispatch_id: "dispatch-alpha",
            dispatch_sequence: 1,
            dispatch_timestamp: 1_710_000_800_001,
            correlation_id: "queue-dispatch-alpha",
            triggering_event_id: "event-alpha",
            claim_token: "claim-alpha",
            worker_id: "worker-alpha",
            ral_alloc_sequence: 1,
            ral_alloc_timestamp: 1_710_000_700_001,
            ral_alloc_correlation_id: "ral-alloc-alpha",
            ral_claim_sequence: 2,
            ral_claim_timestamp: 1_710_000_700_002,
            ral_claim_correlation_id: "ral-claim-alpha",
        };
        let beta = DispatchScenario {
            project_id: "project-beta",
            agent_pubkey: pubkey_hex(0x09),
            conversation_id: "conversation-beta",
            ral_number: 13,
            dispatch_id: "dispatch-beta",
            dispatch_sequence: 2,
            dispatch_timestamp: 1_710_000_800_002,
            correlation_id: "queue-dispatch-beta",
            triggering_event_id: "event-beta",
            claim_token: "claim-beta",
            worker_id: "worker-beta",
            ral_alloc_sequence: 3,
            ral_alloc_timestamp: 1_710_000_700_003,
            ral_alloc_correlation_id: "ral-alloc-beta",
            ral_claim_sequence: 4,
            ral_claim_timestamp: 1_710_000_700_004,
            ral_claim_correlation_id: "ral-claim-beta",
        };

        // Seed RAL first (allocated + claimed for each identity), then the
        // queued dispatches, then the dispatch-input sidecars — matching the
        // order the production ingress path writes these records.
        seed_claimed_ral_for(&fixture.daemon_dir, &alpha);
        seed_claimed_ral_for(&fixture.daemon_dir, &beta);
        seed_queued_dispatch_for(&fixture.daemon_dir, &alpha);
        seed_queued_dispatch_for(&fixture.daemon_dir, &beta);
        seed_dispatch_input_for(&fixture.daemon_dir, &alpha);
        seed_dispatch_input_for(&fixture.daemon_dir, &beta);

        // Shared barrier: both spawned session tasks park on their first
        // receive_worker_frame call and only unblock once both have reached
        // it. If admission were serialized (admit-run-complete-admit), task
        // two would never get spawned before task one exited and the
        // barrier would deadlock the test.
        let barrier = Arc::new(Barrier::new(2));
        let alpha_frames = vec![
            frame_for(&heartbeat_message_for(&alpha)),
            frame_for(&complete_message_for(&alpha)),
        ];
        let beta_frames = vec![
            frame_for(&heartbeat_message_for(&beta)),
            frame_for(&complete_message_for(&beta)),
        ];
        let spawner = BarrierGatedSpawner::new(vec![
            BarrierGatedSession::new(alpha.worker_id, Arc::clone(&barrier), alpha_frames),
            BarrierGatedSession::new(beta.worker_id, Arc::clone(&barrier), beta_frames),
        ]);

        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let runtime_state = new_shared_worker_runtime_state();
        let session_registry = WorkerSessionRegistry::new();

        let tenex_base_dir = fixture.tenex_base_dir.clone();
        let daemon_dir = fixture.daemon_dir.clone();
        let project_boot_state = project_boot_state_snapshot(&fixture.project_boot_state);
        let project_event_index = Arc::clone(&fixture.project_event_index);
        let publisher_clone = Arc::clone(&publisher);
        let session_registry_clone = session_registry.clone();
        let runtime_state_clone = runtime_state.clone();

        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime must build");
        let (outcome, spawner, session_outcomes) = rt
            .block_on(async {
                tokio::task::spawn_blocking(move || {
                    let worker_config = AgentWorkerProcessConfig::default();
                    let mut spawner = spawner;
                    let mut telegram_publisher = NoTelegramPublisher;
                    let outcome = run_daemon_tick_once_from_filesystem_with_worker(
                        DaemonMaintenanceInput {
                            tenex_base_dir: &tenex_base_dir,
                            daemon_dir: &daemon_dir,
                            now_ms: 1_710_001_000_000,
                            project_boot_state,
                            project_event_index,
                            heartbeat_latch: None,
                        },
                        DaemonWorkerTickInput {
                            runtime_state: runtime_state_clone,
                            correlation_id: "daemon-loop-worker-concurrent".to_string(),
                            lock_owner: build_ral_lock_info(100, "host-a", 1_710_001_000_000),
                            command: AgentWorkerCommand::new("bun"),
                            worker_config: &worker_config,
                            writer_version: "daemon-loop-test@0".to_string(),
                            resolved_pending_delegations: Vec::new(),
                            publish_result_sequence: None,
                            session_registry: session_registry_clone.clone(),
                            session_completed_tx: None,
                        },
                        &mut spawner,
                        &publisher_clone,
                        PublishOutboxRetryPolicy::default(),
                        &mut telegram_publisher,
                    )
                    .expect("concurrent-session tick must succeed");
                    // Join sessions inside the blocking context where Handle::current() is valid.
                    let session_outcomes = session_registry_clone.join_all();
                    (outcome, spawner, session_outcomes)
                })
                .await
                .expect("spawn_blocking must not panic")
            });

        // The tick must admit both dispatches synchronously. Exactly two
        // SessionAdmitted entries (one per dispatch) with distinct
        // dispatch_id/worker_id pairs, followed by a terminal
        // NotAdmitted{NoQueuedDispatches}.
        let admitted: Vec<(&String, &String)> = outcome
            .worker_runtime
            .iter()
            .filter_map(|runtime_outcome| match runtime_outcome {
                DaemonWorkerRuntimeOutcome::SessionAdmitted {
                    dispatch_id,
                    worker_id,
                } => Some((dispatch_id, worker_id)),
                _ => None,
            })
            .collect();
        assert_eq!(admitted.len(), 2, "tick must admit both dispatches");
        let dispatch_ids: std::collections::BTreeSet<&str> = admitted
            .iter()
            .map(|(dispatch_id, _)| dispatch_id.as_str())
            .collect();
        let worker_ids: std::collections::BTreeSet<&str> = admitted
            .iter()
            .map(|(_, worker_id)| worker_id.as_str())
            .collect();
        assert_eq!(
            dispatch_ids,
            ["dispatch-alpha", "dispatch-beta"].into_iter().collect()
        );
        assert_eq!(
            worker_ids,
            ["worker-alpha", "worker-beta"].into_iter().collect()
        );
        assert!(matches!(
            outcome.worker_runtime.last(),
            Some(DaemonWorkerRuntimeOutcome::NotAdmitted {
                reason: WorkerDispatchAdmissionBlockedReason::NoQueuedDispatches,
                ..
            })
        ));
        assert_eq!(spawner.spawn_calls, 2);

        // Join both detached session tasks and assert each finished with a
        // clean TerminalResultHandled completion keyed to its own
        // dispatch_id/worker_id.
        assert_eq!(session_outcomes.len(), 2);
        let mut completed: Vec<(String, String)> = session_outcomes
            .iter()
            .map(|runtime_outcome| match runtime_outcome {
                DaemonWorkerRuntimeOutcome::SessionCompleted {
                    dispatch_id,
                    worker_id,
                    session,
                } => {
                    assert_eq!(
                        *session,
                        WorkerSessionLoopOutcome {
                            frame_count: 2,
                            final_reason: WorkerSessionLoopFinalReason::TerminalResultHandled,
                        }
                    );
                    (dispatch_id.clone(), worker_id.clone())
                }
                other => panic!("expected SessionCompleted, got {other:?}"),
            })
            .collect();
        completed.sort();
        assert_eq!(
            completed,
            vec![
                ("dispatch-alpha".to_string(), "worker-alpha".to_string()),
                ("dispatch-beta".to_string(), "worker-beta".to_string()),
            ]
        );

        // Terminal filesystem state: both dispatches landed in the queue as
        // Completed with distinct sequence numbers.
        let queue = replay_dispatch_queue(&fixture.daemon_dir).expect("dispatch queue must replay");
        assert!(queue.queued.is_empty());
        assert!(queue.leased.is_empty());
        let terminal_by_dispatch: std::collections::BTreeMap<String, u64> = queue
            .terminal
            .iter()
            .map(|record| {
                assert_eq!(record.status, DispatchQueueStatus::Completed);
                (record.dispatch_id.clone(), record.sequence)
            })
            .collect();
        assert_eq!(terminal_by_dispatch.len(), 2);
        let terminal_sequences: std::collections::BTreeSet<u64> =
            terminal_by_dispatch.values().copied().collect();
        assert_eq!(
            terminal_sequences.len(),
            2,
            "terminal dispatch sequences must be distinct"
        );

        // RAL journal: each identity replays to Completed with a distinct
        // journal sequence for its Completed record.
        let ral = replay_ral_journal(&fixture.daemon_dir).expect("RAL journal must replay");
        let alpha_state = ral
            .states
            .get(&alpha.ral_identity())
            .expect("alpha RAL state must exist");
        let beta_state = ral
            .states
            .get(&beta.ral_identity())
            .expect("beta RAL state must exist");
        assert_eq!(alpha_state.status, RalReplayStatus::Completed);
        assert_eq!(beta_state.status, RalReplayStatus::Completed);
        // The last_sequence on each replay entry reflects its terminal
        // Completed record; they must be distinct.
        assert_ne!(
            alpha_state.last_sequence, beta_state.last_sequence,
            "alpha and beta completion sequences must be distinct"
        );

        // Both detached tasks released their runtime-state entries cleanly.
        assert_eq!(runtime_state.lock().unwrap().len(), 0);
    }

    /// Regression gate for the `Option<TokioRuntimeHandle>` design that broke
    /// scenario 101 Phase 5. That bug caused sessions spawned through
    /// construction paths that called `WorkerSessionRegistry::new()` (not
    /// `new_on_runtime`) to fall back to `std::thread::spawn`, leaving
    /// `drain_finished` returning `SessionFailed` before `remove_terminal_worker`
    /// ran, leaving the admission in-flight counter permanently wrong.
    ///
    /// The new design eliminates all construction-site decisions: every
    /// `WorkerSessionRegistry::new()` call site produces the same struct, and
    /// sessions always run as `tokio::task::spawn_blocking`. This test verifies:
    ///
    /// 1. A session spawned through the production tick path returns
    ///    `SessionCompleted` (not `SessionFailed`) when the worker sends a
    ///    complete frame and `drain_finished` surfaces that outcome.
    /// 2. `SharedWorkerRuntimeState` is empty after `drain_finished` returns,
    ///    proving `remove_terminal_worker` ran inside the task before the
    ///    handle's `is_finished()` returned true.
    #[test]
    fn drain_finished_returns_session_completed_and_runtime_state_is_clear() {
        let scenario = DispatchScenario {
            project_id: "project-alpha",
            agent_pubkey: TEST_AGENT_PUBKEY.to_string(),
            conversation_id: "conversation-alpha",
            ral_number: 7,
            dispatch_id: "dispatch-drain-gate",
            dispatch_sequence: 1,
            dispatch_timestamp: 1_710_000_700_001,
            correlation_id: "queue-dispatch-drain-gate",
            triggering_event_id: "event-drain-gate",
            claim_token: "claim-drain-gate",
            worker_id: "worker-drain-gate",
            ral_alloc_sequence: 1,
            ral_alloc_timestamp: 1_710_000_700_001,
            ral_alloc_correlation_id: "ral-alloc-drain-gate",
            ral_claim_sequence: 2,
            ral_claim_timestamp: 1_710_000_700_002,
            ral_claim_correlation_id: "ral-claim-drain-gate",
        };

        let fixture = TickFilesystemFixture::new("daemon-loop-drain-gate", 0x0A);
        seed_claimed_ral_for(&fixture.daemon_dir, &scenario);
        seed_queued_dispatch_for(&fixture.daemon_dir, &scenario);
        seed_dispatch_input_for(&fixture.daemon_dir, &scenario);

        // Single-count barrier fires immediately — no coordination needed.
        let barrier = Arc::new(Barrier::new(1));
        let frames = vec![
            frame_for(&heartbeat_message_for(&scenario)),
            frame_for(&complete_message_for(&scenario)),
        ];
        let spawner = BarrierGatedSpawner::new(vec![BarrierGatedSession::new(
            scenario.worker_id,
            Arc::clone(&barrier),
            frames,
        )]);

        let publisher = Arc::new(Mutex::new(RecordingPublisher::default()));
        let runtime_state = new_shared_worker_runtime_state();
        let session_registry = WorkerSessionRegistry::new();

        let tenex_base_dir = fixture.tenex_base_dir.clone();
        let daemon_dir = fixture.daemon_dir.clone();
        let project_boot_state = project_boot_state_snapshot(&fixture.project_boot_state);
        let project_event_index = Arc::clone(&fixture.project_event_index);
        let publisher_clone = Arc::clone(&publisher);
        let session_registry_clone = session_registry.clone();
        let runtime_state_clone = runtime_state.clone();

        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime must build");

        let (drain_outcomes, runtime_len) = rt.block_on(async {
            tokio::task::spawn_blocking(move || {
                let worker_config = AgentWorkerProcessConfig::default();
                let mut spawner = spawner;
                let mut telegram_publisher = NoTelegramPublisher;
                let tick_outcome = run_daemon_tick_once_from_filesystem_with_worker(
                    DaemonMaintenanceInput {
                        tenex_base_dir: &tenex_base_dir,
                        daemon_dir: &daemon_dir,
                        now_ms: 1_710_001_000_000,
                        project_boot_state,
                        project_event_index,
                        heartbeat_latch: None,
                    },
                    DaemonWorkerTickInput {
                        runtime_state: runtime_state_clone.clone(),
                        correlation_id: "daemon-loop-drain-gate".to_string(),
                        lock_owner: build_ral_lock_info(100, "host-a", 1_710_001_000_000),
                        command: AgentWorkerCommand::new("bun"),
                        worker_config: &worker_config,
                        writer_version: "daemon-loop-test@0".to_string(),
                        resolved_pending_delegations: Vec::new(),
                        publish_result_sequence: None,
                        session_registry: session_registry_clone.clone(),
                        session_completed_tx: None,
                    },
                    &mut spawner,
                    &publisher_clone,
                    PublishOutboxRetryPolicy::default(),
                    &mut telegram_publisher,
                )
                .expect("tick must succeed");

                // The tick must admit the session.
                assert!(
                    tick_outcome
                        .worker_runtime
                        .iter()
                        .any(|o| matches!(o, DaemonWorkerRuntimeOutcome::SessionAdmitted { .. })),
                    "tick must emit SessionAdmitted"
                );

                // Block until the session task finishes, then call drain_finished
                // to verify the outcome. join_all is the correct sync-context join
                // from within spawn_blocking (Handle::current().block_on works here).
                let drain_outcomes = session_registry_clone.join_all();
                let runtime_len = runtime_state_clone
                    .lock()
                    .expect("runtime state lock")
                    .len();
                (drain_outcomes, runtime_len)
            })
            .await
            .expect("spawn_blocking must not panic")
        });

        // Exactly one session outcome, and it must be SessionCompleted — not
        // SessionFailed. The prior Option<RuntimeHandle> bug would have produced
        // SessionFailed here because the None-handle path never actually joined
        // the task.
        assert_eq!(drain_outcomes.len(), 1, "exactly one session must be joined");
        assert!(
            matches!(
                drain_outcomes[0],
                DaemonWorkerRuntimeOutcome::SessionCompleted { .. }
            ),
            "session must complete successfully, got {:?}",
            drain_outcomes[0]
        );

        // The session's closure called remove_terminal_worker before returning,
        // so by the time is_finished() becomes true (and block_on returns),
        // the runtime state entry is already gone.
        assert_eq!(
            runtime_len, 0,
            "SharedWorkerRuntimeState must be empty after session completes: \
             remove_terminal_worker must run inside the task closure before it returns"
        );
    }
}
