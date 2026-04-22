use std::error::Error;
use std::path::{Path, PathBuf};

use tracing;

use serde_json::Value;
use thiserror::Error;

use crate::dispatch_queue::{
    DispatchQueueError, DispatchQueueRecord, append_dispatch_queue_record, replay_dispatch_queue,
};
use crate::ral_journal::{RalJournalError, RalPendingDelegation};
use crate::ral_lock::RalLockInfo;
use crate::ral_scheduler::RalScheduler;
use crate::worker_completion::WorkerCompletionDispatchInput;
use crate::worker_concurrency::WorkerConcurrencyLimits;
use crate::worker_dispatch_admission::{
    AdmittedWorkerDispatch, WorkerDispatchAdmissionBlockedCandidate,
    WorkerDispatchAdmissionBlockedReason, WorkerDispatchAdmissionError,
    WorkerDispatchAdmissionInput, WorkerDispatchAdmissionPlan, plan_worker_dispatch_admission,
};
use crate::worker_dispatch_admission_start::{
    StartedWorkerDispatchAdmission, WorkerDispatchAdmissionLaunchContext,
    WorkerDispatchAdmissionStartError, WorkerDispatchAdmissionStartOutcome,
    WorkerDispatchExplicitLaunchInput, WorkerDispatchLaunchInputSource,
};
use crate::worker_dispatch_execution::{WorkerDispatchSession, WorkerDispatchSpawner};
use crate::worker_dispatch_input::{
    WorkerDispatchInputError, read_optional as read_optional_worker_dispatch_input,
};
use crate::worker_dispatch_start::{WorkerDispatchStartInput, start_lock_scoped_worker_dispatch};
use crate::worker_dispatch_tick::{
    WorkerDispatchTickError, WorkerDispatchTickInput, apply_worker_dispatch_tick,
};
use crate::worker_frame_pump::WorkerFrameReceiver;
use crate::worker_launch::{WorkerLaunchPlanInput, plan_worker_launch};
use crate::worker_message_flow::{
    WorkerMessagePublishContext, WorkerMessageTerminalContext, WorkerTelegramSendMessageContext,
};
use crate::worker_process::{AgentWorkerCommand, AgentWorkerProcessConfig};
use crate::worker_protocol::AgentWorkerExecutionFlags;
use crate::worker_result::WorkerResultTransitionContext;
use crate::worker_runtime_state::{WorkerRuntimeStartedDispatch, WorkerRuntimeState};
use crate::worker_session_loop::{
    WorkerSessionLoopError, WorkerSessionLoopInput, WorkerSessionLoopOutcome,
    run_worker_session_loop,
};
use crate::worker_telegram_send_flow::WorkerTelegramSendContext;

#[derive(Debug)]
pub struct DaemonWorkerRuntimeInput<'a> {
    pub daemon_dir: &'a Path,
    pub runtime_state: &'a mut WorkerRuntimeState,
    pub limits: WorkerConcurrencyLimits,
    pub lease_sequence: u64,
    pub lease_timestamp: u64,
    pub lease_correlation_id: String,
    pub execute_sequence: u64,
    pub execute_timestamp: u64,
    pub project_base_path: String,
    pub metadata_path: String,
    pub triggering_envelope: Value,
    pub execution_flags: AgentWorkerExecutionFlags,
    pub lock_owner: RalLockInfo,
    pub command: AgentWorkerCommand,
    pub worker_config: &'a AgentWorkerProcessConfig,
    pub started_at: u64,
    pub frame_observed_at: u64,
    pub publish: Option<WorkerMessagePublishContext>,
    pub telegram_send: Option<DaemonWorkerTelegramSendRuntimeInput>,
    pub terminal: DaemonWorkerTerminalRuntimeInput,
    pub max_frames: u64,
}

#[derive(Debug)]
pub struct DaemonWorkerRuntimeFilesystemInput<'a> {
    pub daemon_dir: &'a Path,
    pub runtime_state: &'a mut WorkerRuntimeState,
    pub limits: WorkerConcurrencyLimits,
    pub now_ms: u64,
    pub correlation_id: String,
    pub lock_owner: RalLockInfo,
    pub command: AgentWorkerCommand,
    pub worker_config: &'a AgentWorkerProcessConfig,
    pub writer_version: String,
    pub resolved_pending_delegations: Vec<RalPendingDelegation>,
    pub publish: Option<WorkerMessagePublishContext>,
    pub telegram_send: Option<DaemonWorkerTelegramSendRuntimeInput>,
    pub max_frames: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonWorkerTelegramSendRuntimeInput {
    pub data_dir: PathBuf,
    pub backend_pubkey: String,
    pub writer_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonWorkerTerminalRuntimeInput {
    pub journal_sequence: u64,
    pub journal_timestamp: u64,
    pub writer_version: String,
    pub resolved_pending_delegations: Vec<RalPendingDelegation>,
    pub dispatch_sequence: u64,
    pub dispatch_timestamp: u64,
    pub dispatch_correlation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonWorkerRuntimeOutcome {
    NotAdmitted {
        reason: WorkerDispatchAdmissionBlockedReason,
        blocked_candidates: Vec<WorkerDispatchAdmissionBlockedCandidate>,
    },
    SessionCompleted {
        dispatch_id: String,
        worker_id: String,
        session: WorkerSessionLoopOutcome,
    },
}

#[derive(Debug, Error)]
pub enum DaemonWorkerRuntimeError<S, E>
where
    S: 'static,
    E: Error + Send + Sync + 'static,
{
    #[error("worker dispatch tick failed: {source}")]
    DispatchTick {
        #[source]
        source: Box<WorkerDispatchTickError<S>>,
    },
    #[error("worker dispatch admission planning failed: {source}")]
    DispatchAdmission {
        #[source]
        source: Box<WorkerDispatchAdmissionError>,
    },
    #[error("worker dispatch input read failed for dispatch {dispatch_id}: {source}")]
    DispatchInput {
        dispatch_id: String,
        #[source]
        source: Box<WorkerDispatchInputError>,
    },
    #[error("worker dispatch input is required for dispatch {dispatch_id}")]
    MissingDispatchInput { dispatch_id: String },
    #[error(
        "worker dispatch input dispatch id {actual_dispatch_id} does not match queued dispatch {expected_dispatch_id}"
    )]
    DispatchInputMismatch {
        expected_dispatch_id: String,
        actual_dispatch_id: String,
    },
    #[error(
        "worker dispatch input triggering event {actual_triggering_event_id} does not match queued dispatch {expected_triggering_event_id} for dispatch {dispatch_id}"
    )]
    DispatchInputTriggeringEventMismatch {
        dispatch_id: String,
        expected_triggering_event_id: String,
        actual_triggering_event_id: String,
    },
    #[error("RAL scheduler replay failed: {source}")]
    RalScheduler {
        #[source]
        source: Box<RalJournalError>,
    },
    #[error("dispatch queue replay failed: {source}")]
    DispatchReplay {
        #[source]
        source: Box<DispatchQueueError>,
    },
    #[error("{sequence_space} sequence exhausted after replay sequence {last_sequence}")]
    SequenceExhausted {
        sequence_space: &'static str,
        last_sequence: u64,
    },
    #[error("worker session loop failed: {source}")]
    SessionLoop {
        #[source]
        source: Box<WorkerSessionLoopError<E>>,
    },
}

pub fn run_daemon_worker_runtime_once_from_filesystem<S>(
    spawner: &mut S,
    input: DaemonWorkerRuntimeFilesystemInput<'_>,
) -> Result<
    DaemonWorkerRuntimeOutcome,
    DaemonWorkerRuntimeError<S::Session, <S::Session as WorkerFrameReceiver>::Error>,
>
where
    S: WorkerDispatchSpawner,
    S::Session: WorkerFrameReceiver
        + WorkerDispatchSession<Error = <S::Session as WorkerFrameReceiver>::Error>
        + 'static,
{
    let DaemonWorkerRuntimeFilesystemInput {
        daemon_dir,
        runtime_state,
        limits,
        now_ms,
        correlation_id,
        lock_owner,
        command,
        worker_config,
        writer_version,
        resolved_pending_delegations,
        publish,
        telegram_send,
        max_frames,
    } = input;

    let dispatch_state = replay_dispatch_queue(daemon_dir).map_err(|source| {
        DaemonWorkerRuntimeError::DispatchReplay {
            source: Box::new(source),
        }
    })?;

    if dispatch_state.queued.is_empty() {
        tracing::debug!("worker runtime: no queued dispatches");
        return Ok(DaemonWorkerRuntimeOutcome::NotAdmitted {
            reason: WorkerDispatchAdmissionBlockedReason::NoQueuedDispatches,
            blocked_candidates: Vec::new(),
        });
    }

    let lease_sequence = next_sequence(dispatch_state.last_sequence, "dispatch queue")?;
    let active_workers = runtime_state.to_active_worker_concurrency_snapshots();
    let active_dispatches = runtime_state.to_active_dispatch_concurrency_snapshots();
    let admission = plan_worker_dispatch_admission(WorkerDispatchAdmissionInput {
        dispatch_state: &dispatch_state,
        active_workers: &active_workers,
        active_dispatches: &active_dispatches,
        limits,
        sequence: lease_sequence,
        timestamp: now_ms,
        correlation_id: format!("{correlation_id}:lease"),
    })
    .map_err(|source| DaemonWorkerRuntimeError::DispatchAdmission {
        source: Box::new(source),
    })?;

    let admitted = match admission {
        WorkerDispatchAdmissionPlan::Admitted(admitted) => *admitted,
        WorkerDispatchAdmissionPlan::NotAdmitted {
            reason,
            blocked_candidates,
        } => {
            tracing::debug!(reason = ?reason, "worker dispatch not admitted");
            return Ok(DaemonWorkerRuntimeOutcome::NotAdmitted {
                reason,
                blocked_candidates,
            });
        }
    };
    tracing::info!(
        dispatch_id = %admitted.selected_dispatch.dispatch_id,
        agent_pubkey = %admitted.selected_dispatch.ral.agent_pubkey,
        "worker dispatch admitted, spawning"
    );
    let launch_input = read_worker_dispatch_launch_input(daemon_dir, &admitted.selected_dispatch)?;

    let started = start_admitted_worker_dispatch(
        spawner,
        StartAdmittedWorkerDispatchInput {
            daemon_dir,
            runtime_state,
            admitted,
            execute_sequence: 1,
            execute_timestamp: now_ms,
            launch_input,
            lock_owner,
            command,
            worker_config,
            started_at: now_ms,
        },
    )
    .map_err(|source| DaemonWorkerRuntimeError::DispatchTick {
        source: Box::new(WorkerDispatchTickError::AdmissionStart {
            source: Box::new(source),
        }),
    })?;

    run_started_worker_session_from_filesystem(
        daemon_dir,
        runtime_state,
        now_ms,
        publish,
        telegram_send,
        DaemonWorkerFilesystemTerminalInput {
            timestamp: now_ms,
            writer_version,
            resolved_pending_delegations,
            dispatch_correlation_id: format!("{correlation_id}:complete"),
        },
        max_frames,
        started,
    )
}

pub fn run_daemon_worker_runtime_once<S>(
    spawner: &mut S,
    input: DaemonWorkerRuntimeInput<'_>,
) -> Result<
    DaemonWorkerRuntimeOutcome,
    DaemonWorkerRuntimeError<S::Session, <S::Session as WorkerFrameReceiver>::Error>,
>
where
    S: WorkerDispatchSpawner,
    S::Session: WorkerFrameReceiver
        + WorkerDispatchSession<Error = <S::Session as WorkerFrameReceiver>::Error>
        + 'static,
{
    let DaemonWorkerRuntimeInput {
        daemon_dir,
        runtime_state,
        limits,
        lease_sequence,
        lease_timestamp,
        lease_correlation_id,
        execute_sequence,
        execute_timestamp,
        project_base_path,
        metadata_path,
        triggering_envelope,
        execution_flags,
        lock_owner,
        command,
        worker_config,
        started_at,
        frame_observed_at,
        publish,
        telegram_send,
        terminal,
        max_frames,
    } = input;

    let started = apply_worker_dispatch_tick(
        spawner,
        WorkerDispatchTickInput {
            daemon_dir,
            runtime_state,
            limits,
            lease_sequence,
            lease_timestamp,
            lease_correlation_id,
            execute_sequence,
            execute_timestamp,
            launch_input: WorkerDispatchLaunchInputSource::FilesystemSidecarWithExplicitFallback(
                WorkerDispatchExplicitLaunchInput {
                    worker_id: None,
                    project_base_path,
                    metadata_path,
                    triggering_envelope,
                    execution_flags,
                },
            ),
            lock_owner,
            command,
            worker_config,
            started_at,
        },
    )
    .map_err(|source| DaemonWorkerRuntimeError::DispatchTick {
        source: Box::new(source),
    })?;

    match started {
        WorkerDispatchAdmissionStartOutcome::NotAdmitted {
            reason,
            blocked_candidates,
        } => Ok(DaemonWorkerRuntimeOutcome::NotAdmitted {
            reason,
            blocked_candidates,
        }),
        WorkerDispatchAdmissionStartOutcome::Started(started) => run_started_worker_session(
            daemon_dir,
            runtime_state,
            frame_observed_at,
            publish,
            telegram_send,
            terminal,
            max_frames,
            *started,
        ),
    }
}

#[derive(Debug)]
struct StartAdmittedWorkerDispatchInput<'a> {
    daemon_dir: &'a Path,
    runtime_state: &'a mut WorkerRuntimeState,
    admitted: AdmittedWorkerDispatch,
    execute_sequence: u64,
    execute_timestamp: u64,
    launch_input: WorkerDispatchExplicitLaunchInput,
    lock_owner: RalLockInfo,
    command: AgentWorkerCommand,
    worker_config: &'a AgentWorkerProcessConfig,
    started_at: u64,
}

fn start_admitted_worker_dispatch<S>(
    spawner: &mut S,
    input: StartAdmittedWorkerDispatchInput<'_>,
) -> Result<StartedWorkerDispatchAdmission<S::Session>, WorkerDispatchAdmissionStartError<S::Session>>
where
    S: WorkerDispatchSpawner,
{
    let StartAdmittedWorkerDispatchInput {
        daemon_dir,
        runtime_state,
        admitted,
        execute_sequence,
        execute_timestamp,
        launch_input,
        lock_owner,
        command,
        worker_config,
        started_at,
    } = input;

    let launch_plan = plan_worker_launch(WorkerLaunchPlanInput {
        dispatch: &admitted.leased_record,
        identity: &ral_identity_from_dispatch(&admitted.leased_record),
        sequence: execute_sequence,
        timestamp: execute_timestamp,
        project_base_path: launch_input.project_base_path.clone(),
        metadata_path: launch_input.metadata_path.clone(),
        triggering_envelope: launch_input.triggering_envelope.clone(),
        execution_flags: launch_input.execution_flags.clone(),
    })
    .map_err(|source| WorkerDispatchAdmissionStartError::LaunchPlan {
        admission: Box::new(admitted.clone()),
        source: Box::new(source),
    })?;

    let context = WorkerDispatchAdmissionLaunchContext {
        admission: admitted,
        launch_plan,
    };

    append_dispatch_queue_record(daemon_dir, &context.admission.leased_record).map_err(
        |source| WorkerDispatchAdmissionStartError::LeaseAppend {
            context: Box::new(context.clone()),
            source: Box::new(source),
        },
    )?;

    let started = start_lock_scoped_worker_dispatch(
        spawner,
        WorkerDispatchStartInput {
            daemon_dir,
            launch_plan: &context.launch_plan,
            lock_owner: &lock_owner,
            command: if let Some(worker_id) = launch_input.worker_id.as_deref() {
                command.env("TENEX_AGENT_WORKER_ID", worker_id)
            } else {
                command
            },
            worker_config,
        },
    )
    .map_err(|source| WorkerDispatchAdmissionStartError::DispatchStart {
        context: Box::new(context.clone()),
        source: Box::new(source),
    })?;

    let runtime_started = WorkerRuntimeStartedDispatch::from_ready(
        &started.dispatch.ready,
        context.admission.leased_record.dispatch_id.clone(),
        ral_identity_from_dispatch(&context.admission.leased_record),
        context.admission.leased_record.claim_token.clone(),
        started_at,
    );

    match runtime_state.register_started_dispatch(runtime_started.clone()) {
        Ok(()) => Ok(StartedWorkerDispatchAdmission {
            context,
            runtime_started,
            started,
        }),
        Err(source) => Err(WorkerDispatchAdmissionStartError::RuntimeRegister {
            context: Box::new(StartedWorkerDispatchAdmission {
                context,
                runtime_started,
                started,
            }),
            source: Box::new(source),
        }),
    }
}

fn read_worker_dispatch_launch_input<S, E>(
    daemon_dir: &Path,
    dispatch: &DispatchQueueRecord,
) -> Result<WorkerDispatchExplicitLaunchInput, DaemonWorkerRuntimeError<S, E>>
where
    S: 'static,
    E: Error + Send + Sync + 'static,
{
    let input = read_optional_worker_dispatch_input(daemon_dir, &dispatch.dispatch_id)
        .map_err(|source| DaemonWorkerRuntimeError::DispatchInput {
            dispatch_id: dispatch.dispatch_id.clone(),
            source: Box::new(source),
        })?
        .ok_or_else(|| DaemonWorkerRuntimeError::MissingDispatchInput {
            dispatch_id: dispatch.dispatch_id.clone(),
        })?;

    if input.dispatch_id != dispatch.dispatch_id {
        return Err(DaemonWorkerRuntimeError::DispatchInputMismatch {
            expected_dispatch_id: dispatch.dispatch_id.clone(),
            actual_dispatch_id: input.dispatch_id,
        });
    }

    let fields = input.resolved_execute_fields().map_err(|source| {
        DaemonWorkerRuntimeError::DispatchInput {
            dispatch_id: dispatch.dispatch_id.clone(),
            source: Box::new(WorkerDispatchInputError::Validation(source)),
        }
    })?;

    if fields.triggering_event_id != dispatch.triggering_event_id {
        return Err(
            DaemonWorkerRuntimeError::DispatchInputTriggeringEventMismatch {
                dispatch_id: dispatch.dispatch_id.clone(),
                expected_triggering_event_id: dispatch.triggering_event_id.clone(),
                actual_triggering_event_id: fields.triggering_event_id,
            },
        );
    }

    Ok(WorkerDispatchExplicitLaunchInput {
        worker_id: fields.worker_id,
        project_base_path: fields.project_base_path,
        metadata_path: fields.metadata_path,
        triggering_envelope: fields.triggering_envelope,
        execution_flags: fields.execution_flags,
    })
}

fn ral_identity_from_dispatch(
    dispatch: &DispatchQueueRecord,
) -> crate::ral_journal::RalJournalIdentity {
    crate::ral_journal::RalJournalIdentity {
        project_id: dispatch.ral.project_id.clone(),
        agent_pubkey: dispatch.ral.agent_pubkey.clone(),
        conversation_id: dispatch.ral.conversation_id.clone(),
        ral_number: dispatch.ral.ral_number,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DaemonWorkerFilesystemTerminalInput {
    timestamp: u64,
    writer_version: String,
    resolved_pending_delegations: Vec<RalPendingDelegation>,
    dispatch_correlation_id: String,
}

fn run_started_worker_session<S>(
    daemon_dir: &Path,
    runtime_state: &mut WorkerRuntimeState,
    frame_observed_at: u64,
    publish: Option<WorkerMessagePublishContext>,
    telegram_send: Option<DaemonWorkerTelegramSendRuntimeInput>,
    terminal: DaemonWorkerTerminalRuntimeInput,
    max_frames: u64,
    started: StartedWorkerDispatchAdmission<S>,
) -> Result<
    DaemonWorkerRuntimeOutcome,
    DaemonWorkerRuntimeError<S, <S as WorkerFrameReceiver>::Error>,
>
where
    S: WorkerFrameReceiver
        + WorkerDispatchSession<Error = <S as WorkerFrameReceiver>::Error>
        + 'static,
{
    let scheduler = RalScheduler::from_daemon_dir(daemon_dir).map_err(|source| {
        DaemonWorkerRuntimeError::RalScheduler {
            source: Box::new(source),
        }
    })?;
    let dispatch_state = replay_dispatch_queue(daemon_dir).map_err(|source| {
        DaemonWorkerRuntimeError::DispatchReplay {
            source: Box::new(source),
        }
    })?;

    run_started_worker_session_with_state(
        daemon_dir,
        runtime_state,
        frame_observed_at,
        publish,
        telegram_send,
        terminal,
        max_frames,
        started,
        &scheduler,
        &dispatch_state,
    )
}

fn run_started_worker_session_from_filesystem<S>(
    daemon_dir: &Path,
    runtime_state: &mut WorkerRuntimeState,
    frame_observed_at: u64,
    publish: Option<WorkerMessagePublishContext>,
    telegram_send: Option<DaemonWorkerTelegramSendRuntimeInput>,
    terminal: DaemonWorkerFilesystemTerminalInput,
    max_frames: u64,
    started: StartedWorkerDispatchAdmission<S>,
) -> Result<
    DaemonWorkerRuntimeOutcome,
    DaemonWorkerRuntimeError<S, <S as WorkerFrameReceiver>::Error>,
>
where
    S: WorkerFrameReceiver
        + WorkerDispatchSession<Error = <S as WorkerFrameReceiver>::Error>
        + 'static,
{
    let scheduler = RalScheduler::from_daemon_dir(daemon_dir).map_err(|source| {
        DaemonWorkerRuntimeError::RalScheduler {
            source: Box::new(source),
        }
    })?;
    let dispatch_state = replay_dispatch_queue(daemon_dir).map_err(|source| {
        DaemonWorkerRuntimeError::DispatchReplay {
            source: Box::new(source),
        }
    })?;

    let terminal = DaemonWorkerTerminalRuntimeInput {
        journal_sequence: next_sequence(scheduler.state().last_sequence, "RAL journal")?,
        journal_timestamp: terminal.timestamp,
        writer_version: terminal.writer_version,
        resolved_pending_delegations: terminal.resolved_pending_delegations,
        dispatch_sequence: next_sequence(dispatch_state.last_sequence, "dispatch queue")?,
        dispatch_timestamp: terminal.timestamp,
        dispatch_correlation_id: terminal.dispatch_correlation_id,
    };

    run_started_worker_session_with_state(
        daemon_dir,
        runtime_state,
        frame_observed_at,
        publish,
        telegram_send,
        terminal,
        max_frames,
        started,
        &scheduler,
        &dispatch_state,
    )
}

fn run_started_worker_session_with_state<S>(
    daemon_dir: &Path,
    runtime_state: &mut WorkerRuntimeState,
    frame_observed_at: u64,
    publish: Option<WorkerMessagePublishContext>,
    telegram_send: Option<DaemonWorkerTelegramSendRuntimeInput>,
    terminal: DaemonWorkerTerminalRuntimeInput,
    max_frames: u64,
    started: StartedWorkerDispatchAdmission<S>,
    scheduler: &RalScheduler,
    dispatch_state: &crate::dispatch_queue::DispatchQueueState,
) -> Result<
    DaemonWorkerRuntimeOutcome,
    DaemonWorkerRuntimeError<S, <S as WorkerFrameReceiver>::Error>,
>
where
    S: WorkerFrameReceiver
        + WorkerDispatchSession<Error = <S as WorkerFrameReceiver>::Error>
        + 'static,
{
    let worker_id = started.runtime_started.worker_id.clone();
    let dispatch_id = started.context.admission.leased_record.dispatch_id.clone();
    let claim_token = started.context.admission.leased_record.claim_token.clone();
    let mut session = started.started.dispatch.session;

    let _session_span = tracing::info_span!(
        "worker.session",
        dispatch_id = %dispatch_id,
        worker_id = %worker_id,
    )
    .entered();
    tracing::info!(dispatch_id = %dispatch_id, worker_id = %worker_id, "worker session started");

    let telegram_send = telegram_send
        .as_ref()
        .map(|telegram| WorkerTelegramSendMessageContext {
            accepted_at: frame_observed_at,
            result_sequence: terminal.dispatch_sequence.saturating_add(1),
            result_timestamp: frame_observed_at,
            context: WorkerTelegramSendContext {
                data_dir: telegram.data_dir.as_path(),
                backend_pubkey: telegram.backend_pubkey.as_str(),
                writer_version: telegram.writer_version.as_str(),
            },
        });

    let session = run_worker_session_loop(
        &mut session,
        WorkerSessionLoopInput {
            daemon_dir,
            runtime_state,
            worker_id: &worker_id,
            observed_at: frame_observed_at,
            publish,
            terminal: Some(WorkerMessageTerminalContext {
                scheduler,
                dispatch_state,
                result_context: WorkerResultTransitionContext {
                    worker_id: worker_id.clone(),
                    claim_token,
                    journal_sequence: terminal.journal_sequence,
                    journal_timestamp: terminal.journal_timestamp,
                    writer_version: terminal.writer_version,
                    resolved_pending_delegations: terminal.resolved_pending_delegations,
                },
                dispatch: Some(WorkerCompletionDispatchInput {
                    dispatch_id: dispatch_id.clone(),
                    sequence: terminal.dispatch_sequence,
                    timestamp: terminal.dispatch_timestamp,
                    correlation_id: terminal.dispatch_correlation_id,
                }),
                locks: started.started.locks,
            }),
            telegram_send,
            max_frames,
        },
    )
    .map_err(|source| DaemonWorkerRuntimeError::SessionLoop {
        source: Box::new(source),
    })?;

    tracing::info!(dispatch_id = %dispatch_id, worker_id = %worker_id, "worker session completed");
    Ok(DaemonWorkerRuntimeOutcome::SessionCompleted {
        dispatch_id,
        worker_id,
        session,
    })
}

fn next_sequence<S, E>(
    last_sequence: u64,
    sequence_space: &'static str,
) -> Result<u64, DaemonWorkerRuntimeError<S, E>>
where
    S: 'static,
    E: Error + Send + Sync + 'static,
{
    last_sequence
        .checked_add(1)
        .ok_or(DaemonWorkerRuntimeError::SequenceExhausted {
            sequence_space,
            last_sequence,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        append_dispatch_queue_record, build_dispatch_queue_record,
    };
    use crate::nostr_event::Nip01EventFixture;
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalError, RalJournalEvent, RalJournalIdentity,
        RalJournalRecord, RalReplayStatus, append_ral_journal_record, replay_ral_journal,
    };
    use crate::ral_lock::{build_ral_lock_info, read_ral_lock_info};
    use crate::worker_dispatch_admission::WorkerDispatchAdmissionBlockedReason;
    use crate::worker_dispatch_admission_start::WorkerDispatchAdmissionStartError;
    use crate::worker_dispatch_execution::{
        AgentWorkerProcessDispatchSpawner, BootedWorkerDispatch, WorkerDispatchExecutionError,
    };
    use crate::worker_dispatch_input::{
        WorkerDispatchExecuteFields, WorkerDispatchInput, WorkerDispatchInputFromExecuteFields,
        WorkerDispatchInputSourceType, WorkerDispatchInputWriterMetadata,
        write_create_or_compare_equal,
    };
    use crate::worker_dispatch_start::WorkerDispatchStartError;
    use crate::worker_launch_lock::release_worker_launch_locks;
    use crate::worker_message_flow::WorkerMessageFlowError;
    use crate::worker_process::{
        AgentWorkerProcess, AgentWorkerReady, WorkerProcessError, bun_agent_worker_command,
    };
    use crate::worker_protocol::WorkerProtocolError;
    use crate::worker_protocol::{
        AGENT_WORKER_MAX_FRAME_BYTES, AGENT_WORKER_PROTOCOL_ENCODING,
        AGENT_WORKER_PROTOCOL_VERSION, AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
        AGENT_WORKER_STREAM_BATCH_MS, WorkerProtocolConfig, encode_agent_worker_protocol_frame,
    };
    use crate::worker_publish::WorkerPublishError;
    use crate::worker_publish_flow::WorkerPublishFlowError;
    use crate::worker_result::WorkerResultError;
    use crate::worker_session_loop::WorkerSessionLoopError;
    use crate::worker_session_loop::WorkerSessionLoopFinalReason;
    use crate::worker_terminal_flow::{WorkerTerminalFlowError, WorkerTerminalFlowPlanningError};
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::fmt;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug, Clone)]
    struct RecordingSpawner {
        incoming_frames: VecDeque<Vec<u8>>,
        sent_messages: Arc<Mutex<Vec<Value>>>,
    }

    impl WorkerDispatchSpawner for RecordingSpawner {
        type Session = RecordingSession;
        type Error = FakeWorkerError;

        fn spawn_worker(
            &mut self,
            _command: &AgentWorkerCommand,
            _config: &AgentWorkerProcessConfig,
        ) -> Result<BootedWorkerDispatch<Self::Session>, Self::Error> {
            Ok(BootedWorkerDispatch {
                ready: ready_message("worker-alpha"),
                session: RecordingSession {
                    incoming_frames: self.incoming_frames.clone(),
                    sent_messages: Arc::clone(&self.sent_messages),
                },
            })
        }
    }

    #[derive(Debug)]
    struct ClaimingAgentWorkerProcessDispatchSpawner {
        daemon_dir: PathBuf,
        inner: AgentWorkerProcessDispatchSpawner,
    }

    impl WorkerDispatchSpawner for ClaimingAgentWorkerProcessDispatchSpawner {
        type Session = AgentWorkerProcess;
        type Error = ClaimingSpawnerError;

        fn spawn_worker(
            &mut self,
            command: &AgentWorkerCommand,
            config: &AgentWorkerProcessConfig,
        ) -> Result<BootedWorkerDispatch<Self::Session>, Self::Error> {
            let booted = self
                .inner
                .spawn_worker(command, config)
                .map_err(ClaimingSpawnerError::Spawn)?;

            append_ral_journal_record(
                &self.daemon_dir,
                &RalJournalRecord::new(
                    RAL_JOURNAL_WRITER_RUST_DAEMON,
                    "test-version",
                    2,
                    1_710_000_700_002,
                    "claim-alpha",
                    RalJournalEvent::Claimed {
                        identity: identity(),
                        worker_id: booted.ready.worker_id.clone(),
                        claim_token: "claim-alpha".to_string(),
                    },
                ),
            )
            .map_err(ClaimingSpawnerError::Claim)?;

            Ok(booted)
        }
    }

    #[derive(Debug)]
    enum ClaimingSpawnerError {
        Spawn(WorkerProcessError),
        Claim(RalJournalError),
    }

    impl fmt::Display for ClaimingSpawnerError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                Self::Spawn(source) => write!(formatter, "worker spawn failed: {source}"),
                Self::Claim(source) => write!(formatter, "RAL claim append failed: {source}"),
            }
        }
    }

    impl Error for ClaimingSpawnerError {}

    #[derive(Debug, Clone)]
    struct RecordingSession {
        incoming_frames: VecDeque<Vec<u8>>,
        sent_messages: Arc<Mutex<Vec<Value>>>,
    }

    impl WorkerFrameReceiver for RecordingSession {
        type Error = FakeWorkerError;

        fn receive_worker_frame(&mut self) -> Result<Vec<u8>, Self::Error> {
            self.incoming_frames
                .pop_front()
                .ok_or(FakeWorkerError("missing worker frame"))
        }
    }

    impl WorkerDispatchSession for RecordingSession {
        type Error = FakeWorkerError;

        fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error> {
            self.sent_messages
                .lock()
                .expect("sent message lock must not be poisoned")
                .push(message.clone());
            Ok(())
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct FakeWorkerError(&'static str);

    impl fmt::Display for FakeWorkerError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    impl Error for FakeWorkerError {}

    #[test]
    fn runs_queued_dispatch_through_worker_session_and_terminal_filesystem_state() {
        let daemon_dir = unique_temp_daemon_dir();
        seed_claimed_ral(&daemon_dir);
        seed_queued_dispatch(&daemon_dir);
        let sent_messages = Arc::new(Mutex::new(Vec::new()));
        let mut spawner = RecordingSpawner {
            incoming_frames: VecDeque::from([
                frame_for(&heartbeat_message()),
                frame_for(&complete_message(vec!["published-event-id".to_string()])),
            ]),
            sent_messages: Arc::clone(&sent_messages),
        };
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = worker_config();

        let outcome = run_daemon_worker_runtime_once(
            &mut spawner,
            runtime_input(&daemon_dir, &mut runtime_state, &worker_config, None, 4),
        )
        .expect("runtime dispatch must complete");

        assert_eq!(
            outcome,
            DaemonWorkerRuntimeOutcome::SessionCompleted {
                dispatch_id: "dispatch-alpha".to_string(),
                worker_id: "worker-alpha".to_string(),
                session: WorkerSessionLoopOutcome {
                    frame_count: 2,
                    final_reason: WorkerSessionLoopFinalReason::TerminalResultHandled,
                },
            }
        );
        assert!(
            sent_messages
                .lock()
                .expect("sent message lock must not be poisoned")
                .iter()
                .any(|message| message["type"] == "execute")
        );
        assert!(runtime_state.is_empty());

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(queue.queued.len(), 0);
        assert_eq!(queue.leased.len(), 0);
        assert_eq!(queue.terminal.len(), 1);
        assert_eq!(queue.terminal[0].status, DispatchQueueStatus::Completed);

        let ral = replay_ral_journal(&daemon_dir).expect("RAL journal must replay");
        assert_eq!(
            ral.states
                .get(&identity())
                .expect("RAL state must exist")
                .status,
            RalReplayStatus::Completed
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn rejects_malformed_worker_frame_after_dispatch_start() {
        let daemon_dir = unique_temp_daemon_dir();
        seed_claimed_ral(&daemon_dir);
        seed_queued_dispatch(&daemon_dir);
        let sent_messages = Arc::new(Mutex::new(Vec::new()));
        let mut spawner = RecordingSpawner {
            incoming_frames: VecDeque::from([malformed_frame()]),
            sent_messages: Arc::clone(&sent_messages),
        };
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = worker_config();

        let error = run_daemon_worker_runtime_once(
            &mut spawner,
            runtime_input(&daemon_dir, &mut runtime_state, &worker_config, None, 4),
        )
        .expect_err("malformed frame must fail");

        match error {
            DaemonWorkerRuntimeError::SessionLoop { source } => match *source {
                WorkerSessionLoopError::Decode { source } => {
                    assert!(matches!(source, WorkerProtocolError::JsonDecodeFailed(_)));
                }
                other => panic!("expected decode failure, got {other:?}"),
            },
            other => panic!("expected session loop error, got {other:?}"),
        }
        assert!(
            sent_messages
                .lock()
                .expect("sent message lock must not be poisoned")
                .iter()
                .any(|message| message["type"] == "execute")
        );
        assert!(runtime_state.get_worker("worker-alpha").is_some());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn rejects_worker_session_when_frame_limit_is_exceeded() {
        let daemon_dir = unique_temp_daemon_dir();
        seed_claimed_ral(&daemon_dir);
        seed_queued_dispatch(&daemon_dir);
        let sent_messages = Arc::new(Mutex::new(Vec::new()));
        let mut spawner = RecordingSpawner {
            incoming_frames: VecDeque::from([
                frame_for(&heartbeat_message()),
                frame_for(&complete_message(vec!["published-event-id".to_string()])),
            ]),
            sent_messages: Arc::clone(&sent_messages),
        };
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = worker_config();

        let error = run_daemon_worker_runtime_once(
            &mut spawner,
            runtime_input(&daemon_dir, &mut runtime_state, &worker_config, None, 1),
        )
        .expect_err("max frame limit must fail");

        match error {
            DaemonWorkerRuntimeError::SessionLoop { source } => match *source {
                WorkerSessionLoopError::MaxFrameLimitExceeded {
                    frame_count,
                    max_frames,
                } => {
                    assert_eq!(frame_count, 1);
                    assert_eq!(max_frames, 1);
                }
                other => panic!("expected max frame limit error, got {other:?}"),
            },
            other => panic!("expected session loop error, got {other:?}"),
        }
        assert!(
            sent_messages
                .lock()
                .expect("sent message lock must not be poisoned")
                .iter()
                .any(|message| message["type"] == "execute")
        );
        assert!(runtime_state.get_worker("worker-alpha").is_some());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn rejects_publish_acceptance_failure_after_dispatch_start() {
        let daemon_dir = unique_temp_daemon_dir();
        seed_claimed_ral(&daemon_dir);
        seed_queued_dispatch(&daemon_dir);
        let fixture = signed_event_fixture();
        let sent_messages = Arc::new(Mutex::new(Vec::new()));
        let mut spawner = RecordingSpawner {
            incoming_frames: VecDeque::from([frame_for(&publish_request_message(&fixture))]),
            sent_messages: Arc::clone(&sent_messages),
        };
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = worker_config();

        let error = run_daemon_worker_runtime_once(
            &mut spawner,
            runtime_input(
                &daemon_dir,
                &mut runtime_state,
                &worker_config,
                Some(WorkerMessagePublishContext {
                    accepted_at: 1_710_000_800_100,
                    result_sequence: 20,
                    result_timestamp: 1_710_000_800_200,
                }),
                4,
            ),
        )
        .expect_err("publish acceptance failure must fail");

        match error {
            DaemonWorkerRuntimeError::SessionLoop { source } => match *source {
                WorkerSessionLoopError::MessageFlow { source } => match source {
                    WorkerMessageFlowError::Publish { source } => match *source {
                        WorkerPublishFlowError::Publish { source } => {
                            assert!(matches!(
                                *source,
                                WorkerPublishError::PublishResultSequenceNotAfterRequest { .. }
                            ));
                        }
                        other => panic!("expected publish acceptance failure, got {other:?}"),
                    },
                    other => panic!("expected publish message flow failure, got {other:?}"),
                },
                other => panic!("expected message flow failure, got {other:?}"),
            },
            other => panic!("expected session loop error, got {other:?}"),
        }
        let messages = sent_messages
            .lock()
            .expect("sent message lock must not be poisoned");
        assert!(messages.iter().any(|message| message["type"] == "execute"));
        assert!(
            !messages
                .iter()
                .any(|message| message["type"] == "publish_result")
        );
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending outbox must read")
                .is_none()
        );
        assert!(runtime_state.get_worker("worker-alpha").is_some());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn returns_locks_from_terminal_planning_failure() {
        let daemon_dir = unique_temp_daemon_dir();
        seed_claimed_ral(&daemon_dir);
        seed_queued_dispatch(&daemon_dir);
        let sent_messages = Arc::new(Mutex::new(Vec::new()));
        let mut spawner = RecordingSpawner {
            incoming_frames: VecDeque::from([frame_for(&waiting_for_delegation_message())]),
            sent_messages: Arc::clone(&sent_messages),
        };
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = worker_config();

        let error = run_daemon_worker_runtime_once(
            &mut spawner,
            runtime_input(&daemon_dir, &mut runtime_state, &worker_config, None, 4),
        )
        .expect_err("terminal planning failure must fail");

        let locks = match error {
            DaemonWorkerRuntimeError::SessionLoop { source } => match *source {
                WorkerSessionLoopError::MessageFlow { source } => match source {
                    WorkerMessageFlowError::Terminal { source } => match *source {
                        WorkerTerminalFlowError::Planning { source, locks } => {
                            match *source {
                                WorkerTerminalFlowPlanningError::Result { source } => {
                                    assert!(matches!(
                                        source,
                                        WorkerResultError::UnresolvedPendingDelegation { .. }
                                    ));
                                }
                                other => {
                                    panic!(
                                        "expected terminal planning result failure, got {other:?}"
                                    )
                                }
                            }
                            *locks
                        }
                        other => panic!("expected terminal planning error, got {other:?}"),
                    },
                    other => panic!("expected terminal message flow failure, got {other:?}"),
                },
                other => panic!("expected message flow failure, got {other:?}"),
            },
            other => panic!("expected session loop error, got {other:?}"),
        };
        let owner = build_ral_lock_info(100, "host-alpha", 1_710_000_700_000);
        assert_eq!(
            read_ral_lock_info(&locks.allocation.path).expect("allocation lock must be readable"),
            Some(owner.clone())
        );
        assert_eq!(
            read_ral_lock_info(&locks.state.path).expect("state lock must be readable"),
            Some(owner)
        );
        assert!(
            sent_messages
                .lock()
                .expect("sent message lock must not be poisoned")
                .iter()
                .any(|message| message["type"] == "execute")
        );
        assert!(runtime_state.get_worker("worker-alpha").is_some());

        release_worker_launch_locks(locks).expect("locks must release");
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn returns_receive_failure_before_terminal_after_dispatch_start() {
        let daemon_dir = unique_temp_daemon_dir();
        seed_claimed_ral(&daemon_dir);
        seed_queued_dispatch(&daemon_dir);
        let sent_messages = Arc::new(Mutex::new(Vec::new()));
        let mut spawner = RecordingSpawner {
            incoming_frames: VecDeque::from([frame_for(&heartbeat_message())]),
            sent_messages: Arc::clone(&sent_messages),
        };
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = worker_config();

        let error = run_daemon_worker_runtime_once(
            &mut spawner,
            runtime_input(&daemon_dir, &mut runtime_state, &worker_config, None, 4),
        )
        .expect_err("missing terminal frame must fail");

        match error {
            DaemonWorkerRuntimeError::SessionLoop { source } => match *source {
                WorkerSessionLoopError::Receive { source } => {
                    assert_eq!(source, FakeWorkerError("missing worker frame"));
                }
                other => panic!("expected receive failure, got {other:?}"),
            },
            other => panic!("expected session loop error, got {other:?}"),
        }
        assert!(
            sent_messages
                .lock()
                .expect("sent message lock must not be poisoned")
                .iter()
                .any(|message| message["type"] == "execute")
        );
        assert!(runtime_state.get_worker("worker-alpha").is_some());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn accepts_worker_publish_request_before_terminal_completion() {
        let daemon_dir = unique_temp_daemon_dir();
        seed_claimed_ral(&daemon_dir);
        seed_queued_dispatch(&daemon_dir);
        let fixture = signed_event_fixture();
        let sent_messages = Arc::new(Mutex::new(Vec::new()));
        let mut spawner = RecordingSpawner {
            incoming_frames: VecDeque::from([
                frame_for(&publish_request_message(&fixture)),
                frame_for(&complete_message(vec![fixture.signed.id.clone()])),
            ]),
            sent_messages: Arc::clone(&sent_messages),
        };
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = worker_config();

        let outcome = run_daemon_worker_runtime_once(
            &mut spawner,
            runtime_input(
                &daemon_dir,
                &mut runtime_state,
                &worker_config,
                Some(WorkerMessagePublishContext {
                    accepted_at: 1_710_000_800_100,
                    result_sequence: 900,
                    result_timestamp: 1_710_000_800_200,
                }),
                4,
            ),
        )
        .expect("runtime dispatch with publish request must complete");

        assert!(matches!(
            outcome,
            DaemonWorkerRuntimeOutcome::SessionCompleted { .. }
        ));
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending outbox must read")
                .is_some()
        );
        assert!(
            sent_messages
                .lock()
                .expect("sent message lock must not be poisoned")
                .iter()
                .any(|message| message["type"] == "publish_result"
                    && message["status"] == "accepted")
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn filesystem_entrypoint_runs_queued_dispatch_through_worker_and_completes_state() {
        let daemon_dir = unique_temp_daemon_dir();
        seed_claimed_ral(&daemon_dir);
        seed_queued_dispatch(&daemon_dir);
        seed_dispatch_input(&daemon_dir);
        let sent_messages = Arc::new(Mutex::new(Vec::new()));
        let mut spawner = RecordingSpawner {
            incoming_frames: VecDeque::from([
                frame_for(&heartbeat_message()),
                frame_for(&complete_message(vec!["published-event-id".to_string()])),
            ]),
            sent_messages: Arc::clone(&sent_messages),
        };
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = worker_config();

        let outcome = run_daemon_worker_runtime_once_from_filesystem(
            &mut spawner,
            filesystem_runtime_input(&daemon_dir, &mut runtime_state, &worker_config, None, 4),
        )
        .expect("filesystem runtime dispatch must complete");

        assert_eq!(
            outcome,
            DaemonWorkerRuntimeOutcome::SessionCompleted {
                dispatch_id: "dispatch-alpha".to_string(),
                worker_id: "worker-alpha".to_string(),
                session: WorkerSessionLoopOutcome {
                    frame_count: 2,
                    final_reason: WorkerSessionLoopFinalReason::TerminalResultHandled,
                },
            }
        );
        let sent_messages = sent_messages
            .lock()
            .expect("sent message lock must not be poisoned");
        let execute = sent_messages
            .iter()
            .find(|message| message["type"] == "execute")
            .expect("execute message must be sent");
        assert_eq!(execute["sequence"], 1);
        assert_eq!(execute["projectBasePath"], "/sidecar/repo");
        assert_eq!(execute["triggeringEnvelope"]["content"], "from sidecar");
        assert!(runtime_state.is_empty());

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(queue.last_sequence, 3);
        assert!(queue.queued.is_empty());
        assert!(queue.leased.is_empty());
        assert_eq!(queue.terminal.len(), 1);
        assert_eq!(queue.terminal[0].status, DispatchQueueStatus::Completed);

        let ral = replay_ral_journal(&daemon_dir).expect("RAL journal must replay");
        assert_eq!(ral.last_sequence, 3);
        assert_eq!(
            ral.states
                .get(&identity())
                .expect("RAL state must exist")
                .status,
            RalReplayStatus::Completed
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn filesystem_entrypoint_empty_queue_is_noop_without_ral_state() {
        let daemon_dir = unique_temp_daemon_dir();
        let sent_messages = Arc::new(Mutex::new(Vec::new()));
        let mut spawner = RecordingSpawner {
            incoming_frames: VecDeque::new(),
            sent_messages: Arc::clone(&sent_messages),
        };
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = worker_config();

        let outcome = run_daemon_worker_runtime_once_from_filesystem(
            &mut spawner,
            filesystem_runtime_input(&daemon_dir, &mut runtime_state, &worker_config, None, 4),
        )
        .expect("empty filesystem queue is not an error");

        assert!(matches!(
            outcome,
            DaemonWorkerRuntimeOutcome::NotAdmitted {
                reason: WorkerDispatchAdmissionBlockedReason::NoQueuedDispatches,
                blocked_candidates,
            } if blocked_candidates.is_empty()
        ));
        assert!(sent_messages.lock().expect("sent message lock").is_empty());
        assert!(runtime_state.is_empty());
        assert!(
            replay_dispatch_queue(&daemon_dir)
                .expect("missing dispatch queue must replay")
                .queued
                .is_empty()
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn returns_not_admitted_without_spawning_when_dispatch_queue_is_empty() {
        let daemon_dir = unique_temp_daemon_dir();
        seed_claimed_ral(&daemon_dir);
        let sent_messages = Arc::new(Mutex::new(Vec::new()));
        let mut spawner = RecordingSpawner {
            incoming_frames: VecDeque::new(),
            sent_messages: Arc::clone(&sent_messages),
        };
        let mut runtime_state = WorkerRuntimeState::default();
        let worker_config = worker_config();

        let outcome = run_daemon_worker_runtime_once(
            &mut spawner,
            runtime_input(&daemon_dir, &mut runtime_state, &worker_config, None, 4),
        )
        .expect("empty queue is not an error");

        assert!(matches!(
            outcome,
            DaemonWorkerRuntimeOutcome::NotAdmitted {
                reason: WorkerDispatchAdmissionBlockedReason::NoQueuedDispatches,
                blocked_candidates,
            } if blocked_candidates.is_empty()
        ));
        assert!(sent_messages.lock().expect("sent message lock").is_empty());
        assert!(runtime_state.is_empty());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    #[ignore = "requires Bun and repo TypeScript dependencies"]
    fn bun_agent_worker_real_bun_runtime_spine_round_trips_filesystem_state() {
        let daemon_dir = unique_temp_daemon_dir();
        seed_allocated_ral(&daemon_dir);
        seed_queued_dispatch(&daemon_dir);

        let bun = std::env::var("BUN_BIN").unwrap_or_else(|_| "bun".to_string());
        let command = bun_agent_worker_command(&repo_root(), bun)
            .env("TENEX_AGENT_WORKER_ENGINE", "mock")
            .env("LOG_LEVEL", "silent");
        let worker_config = AgentWorkerProcessConfig {
            boot_timeout: Duration::from_secs(5),
        };
        let mut spawner = ClaimingAgentWorkerProcessDispatchSpawner {
            daemon_dir: daemon_dir.clone(),
            inner: AgentWorkerProcessDispatchSpawner,
        };
        let mut runtime_state = WorkerRuntimeState::default();

        let outcome = run_daemon_worker_runtime_once(
            &mut spawner,
            runtime_input_with_command(
                &daemon_dir,
                &mut runtime_state,
                &worker_config,
                command,
                None,
                8,
            ),
        )
        .unwrap_or_else(|error| {
            panic_with_runtime_error("real Bun runtime spine must complete", error)
        });

        match outcome {
            DaemonWorkerRuntimeOutcome::SessionCompleted {
                dispatch_id,
                worker_id,
                session,
            } => {
                assert_eq!(dispatch_id, "dispatch-alpha");
                assert!(!worker_id.is_empty());
                assert_eq!(
                    session.final_reason,
                    WorkerSessionLoopFinalReason::TerminalResultHandled
                );
                assert_eq!(session.frame_count, 3);
            }
            other => panic!("expected session completion, got {other:?}"),
        }
        assert!(runtime_state.is_empty());

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(queue.queued.len(), 0);
        assert_eq!(queue.leased.len(), 0);
        assert_eq!(queue.terminal.len(), 1);
        assert_eq!(queue.terminal[0].status, DispatchQueueStatus::Completed);

        let ral = replay_ral_journal(&daemon_dir).expect("RAL journal must replay");
        assert_eq!(
            ral.states
                .get(&identity())
                .expect("RAL state must exist")
                .status,
            RalReplayStatus::Completed
        );
        assert_no_ral_locks_remaining(&daemon_dir);

        cleanup_temp_dir(daemon_dir);
    }

    fn runtime_input<'a>(
        daemon_dir: &'a Path,
        runtime_state: &'a mut WorkerRuntimeState,
        worker_config: &'a AgentWorkerProcessConfig,
        publish: Option<WorkerMessagePublishContext>,
        max_frames: u64,
    ) -> DaemonWorkerRuntimeInput<'a> {
        DaemonWorkerRuntimeInput {
            daemon_dir,
            runtime_state,
            limits: WorkerConcurrencyLimits {
                global: None,
                per_project: None,
                per_agent: None,
            },
            lease_sequence: 2,
            lease_timestamp: 1_710_000_700_010,
            lease_correlation_id: "lease-dispatch-alpha".to_string(),
            execute_sequence: 10,
            execute_timestamp: 1_710_000_700_020,
            project_base_path: "/repo".to_string(),
            metadata_path: "/repo/.tenex/project.json".to_string(),
            triggering_envelope: triggering_envelope("event-alpha"),
            execution_flags: AgentWorkerExecutionFlags {
                is_delegation_completion: false,
                has_pending_delegations: false,
                debug: false,
            },
            lock_owner: build_ral_lock_info(100, "host-alpha", 1_710_000_700_000),
            command: worker_command(),
            worker_config,
            started_at: 1_710_000_700_030,
            frame_observed_at: 1_710_000_700_040,
            publish,
            telegram_send: None,
            terminal: DaemonWorkerTerminalRuntimeInput {
                journal_sequence: 3,
                journal_timestamp: 1_710_000_700_050,
                writer_version: "test-version".to_string(),
                resolved_pending_delegations: Vec::new(),
                dispatch_sequence: 3,
                dispatch_timestamp: 1_710_000_700_060,
                dispatch_correlation_id: "complete-dispatch-alpha".to_string(),
            },
            max_frames,
        }
    }

    fn runtime_input_with_command<'a>(
        daemon_dir: &'a Path,
        runtime_state: &'a mut WorkerRuntimeState,
        worker_config: &'a AgentWorkerProcessConfig,
        command: AgentWorkerCommand,
        publish: Option<WorkerMessagePublishContext>,
        max_frames: u64,
    ) -> DaemonWorkerRuntimeInput<'a> {
        let mut input = runtime_input(
            daemon_dir,
            runtime_state,
            worker_config,
            publish,
            max_frames,
        );
        input.command = command;
        input
    }

    fn filesystem_runtime_input<'a>(
        daemon_dir: &'a Path,
        runtime_state: &'a mut WorkerRuntimeState,
        worker_config: &'a AgentWorkerProcessConfig,
        publish: Option<WorkerMessagePublishContext>,
        max_frames: u64,
    ) -> DaemonWorkerRuntimeFilesystemInput<'a> {
        DaemonWorkerRuntimeFilesystemInput {
            daemon_dir,
            runtime_state,
            limits: WorkerConcurrencyLimits {
                global: None,
                per_project: None,
                per_agent: None,
            },
            now_ms: 1_710_000_700_030,
            correlation_id: "filesystem-runtime-alpha".to_string(),
            lock_owner: build_ral_lock_info(100, "host-alpha", 1_710_000_700_000),
            command: worker_command(),
            worker_config,
            writer_version: "test-version".to_string(),
            resolved_pending_delegations: Vec::new(),
            publish,
            telegram_send: None,
            max_frames,
        }
    }

    fn assert_no_ral_locks_remaining(daemon_dir: &Path) {
        let locks_dir = crate::ral_lock::ral_locks_dir(daemon_dir);
        if !locks_dir.exists() {
            return;
        }

        let remaining = fs::read_dir(&locks_dir)
            .expect("RAL lock dir must read")
            .collect::<Result<Vec<_>, _>>()
            .expect("RAL lock entries must read");
        assert!(
            remaining.is_empty(),
            "expected no RAL locks after terminal completion, found {remaining:?}"
        );
    }

    fn panic_with_runtime_error(
        context: &str,
        error: DaemonWorkerRuntimeError<AgentWorkerProcess, WorkerProcessError>,
    ) -> ! {
        panic!("{context}: {}", format_runtime_error(error));
    }

    fn format_runtime_error(
        error: DaemonWorkerRuntimeError<AgentWorkerProcess, WorkerProcessError>,
    ) -> String {
        match error {
            DaemonWorkerRuntimeError::DispatchTick { source } => {
                format!("dispatch tick: {}", format_dispatch_tick_error(*source))
            }
            DaemonWorkerRuntimeError::DispatchAdmission { source } => {
                format!("dispatch admission: {source}")
            }
            DaemonWorkerRuntimeError::DispatchInput {
                dispatch_id,
                source,
            } => {
                format!("dispatch input {dispatch_id}: {source}")
            }
            DaemonWorkerRuntimeError::MissingDispatchInput { dispatch_id } => {
                format!("dispatch input {dispatch_id}: missing")
            }
            DaemonWorkerRuntimeError::DispatchInputMismatch {
                expected_dispatch_id,
                actual_dispatch_id,
            } => {
                format!(
                    "dispatch input mismatch: expected {expected_dispatch_id}, got {actual_dispatch_id}"
                )
            }
            DaemonWorkerRuntimeError::DispatchInputTriggeringEventMismatch {
                dispatch_id,
                expected_triggering_event_id,
                actual_triggering_event_id,
            } => {
                format!(
                    "dispatch input {dispatch_id} triggering event mismatch: expected {expected_triggering_event_id}, got {actual_triggering_event_id}"
                )
            }
            DaemonWorkerRuntimeError::RalScheduler { source } => {
                format!("RAL scheduler replay: {source}")
            }
            DaemonWorkerRuntimeError::DispatchReplay { source } => {
                format!("dispatch queue replay: {source}")
            }
            DaemonWorkerRuntimeError::SequenceExhausted {
                sequence_space,
                last_sequence,
            } => {
                format!("{sequence_space} sequence exhausted after replay sequence {last_sequence}")
            }
            DaemonWorkerRuntimeError::SessionLoop { source } => {
                format!("session loop: {source}")
            }
        }
    }

    fn format_dispatch_tick_error(error: WorkerDispatchTickError<AgentWorkerProcess>) -> String {
        match error {
            WorkerDispatchTickError::DispatchQueueReplay { source } => {
                format!("dispatch queue replay: {source}")
            }
            WorkerDispatchTickError::AdmissionStart { source } => {
                format!("admission/start: {}", format_admission_start_error(*source))
            }
        }
    }

    fn format_admission_start_error(
        error: WorkerDispatchAdmissionStartError<AgentWorkerProcess>,
    ) -> String {
        match error {
            WorkerDispatchAdmissionStartError::Admission { source } => {
                format!("admission planning: {source}")
            }
            WorkerDispatchAdmissionStartError::LaunchInput { source, .. } => {
                format!("launch input: {source}")
            }
            WorkerDispatchAdmissionStartError::LaunchPlan { source, .. } => {
                format!("launch planning: {source}")
            }
            WorkerDispatchAdmissionStartError::LeaseAppend { source, .. } => {
                format!("lease append: {source}")
            }
            WorkerDispatchAdmissionStartError::DispatchStart { source, .. } => {
                format!("dispatch start: {}", format_dispatch_start_error(*source))
            }
            WorkerDispatchAdmissionStartError::RuntimeRegister { source, .. } => {
                format!("runtime registration: {source}")
            }
        }
    }

    fn format_dispatch_start_error(error: WorkerDispatchStartError) -> String {
        match error {
            WorkerDispatchStartError::Lock(source) => {
                format!("launch lock acquisition: {source}")
            }
            WorkerDispatchStartError::Dispatch(source) => {
                format!(
                    "dispatch execution: {}",
                    format_dispatch_execution_error(*source)
                )
            }
            WorkerDispatchStartError::LockRollbackFailed {
                start_error,
                release_error,
            } => format!(
                "dispatch execution failed and lock rollback failed: start={}; release={release_error}",
                format_dispatch_execution_error(*start_error)
            ),
        }
    }

    fn format_dispatch_execution_error(error: WorkerDispatchExecutionError) -> String {
        match error {
            WorkerDispatchExecutionError::InvalidExecuteMessage(source) => {
                format!("invalid execute message: {source}")
            }
            WorkerDispatchExecutionError::UnexpectedMessageType { actual } => {
                format!("unexpected message type: {actual}")
            }
            WorkerDispatchExecutionError::Spawn(source) => format!("worker spawn: {source}"),
            WorkerDispatchExecutionError::SendExecute(source) => {
                format!("execute send: {source}")
            }
        }
    }

    fn seed_claimed_ral(daemon_dir: &Path) {
        seed_allocated_ral(daemon_dir);
        append_ral_journal_record(
            daemon_dir,
            &RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "test-version",
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
        fs::create_dir_all(daemon_dir).expect("daemon dir must create");
        append_ral_journal_record(
            daemon_dir,
            &RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "test-version",
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
                ral: DispatchRalIdentity {
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
                writer: "daemon_worker_runtime_test".to_string(),
                writer_version: "test-version".to_string(),
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
                    debug: false,
                },
            },
            source_metadata: Some(json!({ "eventId": "event-alpha" })),
        })
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

    fn publish_request_message(fixture: &Nip01EventFixture) -> Value {
        let identity = identity();
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_request",
            "correlationId": "runtime-alpha-publish",
            "sequence": 20,
            "timestamp": 1_710_000_700_100_u64,
            "projectId": identity.project_id,
            "agentPubkey": identity.agent_pubkey,
            "conversationId": identity.conversation_id,
            "ralNumber": identity.ral_number,
            "requestId": "publish-fixture-01",
            "waitForRelayOk": true,
            "timeoutMs": 30_000_u64,
            "runtimeEventClass": "complete",
            "event": fixture.signed,
        })
    }

    fn waiting_for_delegation_message() -> Value {
        let identity = identity();
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "waiting_for_delegation",
            "correlationId": "runtime-alpha-terminal",
            "sequence": 22,
            "timestamp": 1_710_000_700_300_u64,
            "projectId": identity.project_id,
            "agentPubkey": identity.agent_pubkey,
            "conversationId": identity.conversation_id,
            "ralNumber": identity.ral_number,
            "pendingDelegations": ["delegation-conversation-1"],
            "finalRalState": "waiting_for_delegation",
            "publishedUserVisibleEvent": false,
            "pendingDelegationsRemain": true,
            "accumulatedRuntimeMs": 1_200_u64,
            "finalEventIds": [],
            "keepWorkerWarm": true,
        })
    }

    fn malformed_frame() -> Vec<u8> {
        vec![0, 0, 0, 1, b'{']
    }

    fn frame_for(message: &Value) -> Vec<u8> {
        encode_agent_worker_protocol_frame(message).expect("message must encode")
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
                "protocol": worker_protocol_config_json(),
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

    fn worker_protocol_config_json() -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "encoding": AGENT_WORKER_PROTOCOL_ENCODING,
            "maxFrameBytes": AGENT_WORKER_MAX_FRAME_BYTES,
            "streamBatchMs": AGENT_WORKER_STREAM_BATCH_MS,
            "streamBatchMaxBytes": AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
            "heartbeatIntervalMs": 30_000_u64,
            "missedHeartbeatThreshold": 3_u64,
            "workerBootTimeoutMs": 30_000_u64,
            "gracefulAbortTimeoutMs": 5_000_u64,
            "forceKillTimeoutMs": 5_000_u64,
            "idleTtlMs": 60_000_u64,
        })
    }

    fn triggering_envelope(native_id: &str) -> Value {
        let identity = identity();
        json!({
            "transport": "nostr",
            "principal": {
                "id": "nostr:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "transport": "nostr",
                "linkedPubkey": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "kind": "human"
            },
            "channel": {
                "id": "conversation:conversation-alpha",
                "transport": "nostr",
                "kind": "conversation"
            },
            "message": {
                "id": native_id,
                "transport": "nostr",
                "nativeId": native_id
            },
            "recipients": [{
                "id": format!("nostr:{}", identity.agent_pubkey),
                "transport": "nostr",
                "linkedPubkey": identity.agent_pubkey,
                "kind": "agent"
            }],
            "content": "hello",
            "occurredAt": 1_710_000_700_000_u64,
            "capabilities": ["reply", "delegate"],
            "metadata": {},
            "conversationId": identity.conversation_id,
            "agentPubkey": identity.agent_pubkey,
            "projectId": identity.project_id,
            "source": "nostr"
        })
    }

    fn worker_command() -> AgentWorkerCommand {
        AgentWorkerCommand::new("bun")
            .arg("run")
            .arg("src/agents/execution/worker/agent-worker.ts")
            .current_dir("/repo")
            .env("TENEX_AGENT_WORKER_ENGINE", "agent")
    }

    fn worker_config() -> AgentWorkerProcessConfig {
        AgentWorkerProcessConfig {
            boot_timeout: Duration::from_millis(250),
        }
    }

    fn signed_event_fixture() -> Nip01EventFixture {
        serde_json::from_str(include_str!(
            "../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json"
        ))
        .expect("fixture must parse")
    }

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("crate must live under repo_root/crates/tenex-daemon")
            .to_path_buf()
    }

    fn unique_temp_daemon_dir() -> std::path::PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "tenex-daemon-worker-runtime-{}-{}-{}",
            std::process::id(),
            unique_suffix(),
            counter
        ))
    }

    fn unique_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos()
    }

    fn cleanup_temp_dir(path: std::path::PathBuf) {
        let _ = fs::remove_dir_all(path);
    }
}
