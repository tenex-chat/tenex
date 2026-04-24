use std::error::Error;
use std::fmt;
use std::path::Path;

use serde_json::Value;

use crate::dispatch_queue::{
    DispatchQueueError, DispatchQueueLifecycleInput, DispatchQueueRecord, DispatchQueueState,
    acquire_dispatch_queue_lock, append_dispatch_queue_record, plan_dispatch_queue_lease,
    replay_dispatch_queue,
};
use crate::ral_journal::RalJournalIdentity;
use crate::ral_lock::RalLockInfo;
use crate::worker_concurrency::WorkerConcurrencyLimits;
use crate::worker_dispatch::admission::{
    AdmittedWorkerDispatch, WorkerDispatchAdmissionBlockedCandidate,
    WorkerDispatchAdmissionBlockedReason, WorkerDispatchAdmissionError,
    WorkerDispatchAdmissionInput, WorkerDispatchAdmissionPlan, plan_worker_dispatch_admission,
};
use crate::worker_dispatch::execution::WorkerDispatchSpawner;
use crate::worker_dispatch::input::{
    WorkerDispatchInput, WorkerDispatchInputError, WorkerDispatchInputValidationError,
    read_optional as read_optional_worker_dispatch_input,
};
use crate::worker_dispatch::start::{
    LockScopedStartedWorkerDispatch, WorkerDispatchStartError, WorkerDispatchStartInput,
    start_lock_scoped_worker_dispatch,
};
use crate::worker_launch::{
    WorkerLaunchError, WorkerLaunchPlan, WorkerLaunchPlanInput, plan_worker_launch,
};
use crate::worker_process::{AgentWorkerCommand, AgentWorkerProcessConfig};
use crate::worker_protocol::AgentWorkerExecutionFlags;
use crate::worker_runtime_state::{
    WorkerRuntimeStartedDispatch, WorkerRuntimeState, WorkerRuntimeStateError,
};

#[derive(Debug)]
pub struct WorkerDispatchAdmissionStartInput<'a> {
    pub daemon_dir: &'a Path,
    pub dispatch_state: &'a DispatchQueueState,
    pub runtime_state: &'a mut WorkerRuntimeState,
    pub limits: WorkerConcurrencyLimits,
    pub lease_sequence: u64,
    pub lease_timestamp: u64,
    pub lease_correlation_id: String,
    pub execute_sequence: u64,
    pub execute_timestamp: u64,
    pub launch_input: WorkerDispatchLaunchInputSource,
    pub lock_owner: RalLockInfo,
    pub command: AgentWorkerCommand,
    pub worker_config: &'a AgentWorkerProcessConfig,
    pub started_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerDispatchExplicitLaunchInput {
    pub worker_id: Option<String>,
    pub project_base_path: String,
    pub metadata_path: String,
    pub triggering_envelope: Value,
    pub execution_flags: AgentWorkerExecutionFlags,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerDispatchLaunchInputSource {
    FilesystemSidecarRequired,
    FilesystemSidecarWithExplicitFallback(WorkerDispatchExplicitLaunchInput),
}

#[derive(Debug)]
pub enum WorkerDispatchAdmissionStartOutcome<S> {
    NotAdmitted {
        reason: WorkerDispatchAdmissionBlockedReason,
        blocked_candidates: Vec<WorkerDispatchAdmissionBlockedCandidate>,
    },
    Started(Box<StartedWorkerDispatchAdmission<S>>),
}

#[derive(Debug)]
pub struct StartedWorkerDispatchAdmission<S> {
    pub context: WorkerDispatchAdmissionLaunchContext,
    pub runtime_started: WorkerRuntimeStartedDispatch,
    pub started: LockScopedStartedWorkerDispatch<S>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerDispatchAdmissionLaunchContext {
    pub admission: AdmittedWorkerDispatch,
    pub launch_plan: WorkerLaunchPlan,
}

#[derive(Debug, thiserror::Error)]
pub enum WorkerDispatchLaunchInputError {
    #[error("filesystem dispatch input is required for dispatch {dispatch_id}")]
    MissingFilesystemDispatchInput { dispatch_id: String },
    #[error(
        "filesystem dispatch input dispatch id {actual_dispatch_id} does not match queued dispatch {expected_dispatch_id}"
    )]
    DispatchIdMismatch {
        expected_dispatch_id: String,
        actual_dispatch_id: String,
    },
    #[error(
        "filesystem dispatch input triggering event {actual_triggering_event_id} does not match queued dispatch {expected_triggering_event_id} for dispatch {dispatch_id}"
    )]
    TriggeringEventMismatch {
        dispatch_id: String,
        expected_triggering_event_id: String,
        actual_triggering_event_id: String,
    },
    #[error("filesystem dispatch input read failed for dispatch {dispatch_id}: {source}")]
    Read {
        dispatch_id: String,
        #[source]
        source: WorkerDispatchInputError,
    },
    #[error("filesystem dispatch input is invalid for dispatch {dispatch_id}: {source}")]
    Invalid {
        dispatch_id: String,
        #[source]
        source: WorkerDispatchInputValidationError,
    },
}

pub enum WorkerDispatchAdmissionStartError<S> {
    Admission {
        source: Box<WorkerDispatchAdmissionError>,
    },
    LaunchInput {
        admission: Box<AdmittedWorkerDispatch>,
        source: Box<WorkerDispatchLaunchInputError>,
    },
    LaunchPlan {
        admission: Box<AdmittedWorkerDispatch>,
        source: Box<WorkerLaunchError>,
    },
    DelegationSnapshot {
        admission: Box<AdmittedWorkerDispatch>,
        source: Box<crate::ral_journal::RalJournalError>,
    },
    LeaseAppend {
        context: Box<WorkerDispatchAdmissionLaunchContext>,
        source: Box<DispatchQueueError>,
    },
    DispatchStart {
        context: Box<WorkerDispatchAdmissionLaunchContext>,
        source: Box<WorkerDispatchStartError>,
    },
    RuntimeRegister {
        context: Box<StartedWorkerDispatchAdmission<S>>,
        source: Box<WorkerRuntimeStateError>,
    },
}

pub type WorkerDispatchAdmissionStartResult<S> =
    Result<WorkerDispatchAdmissionStartOutcome<S>, WorkerDispatchAdmissionStartError<S>>;

pub fn apply_worker_dispatch_admission_start<S>(
    spawner: &mut S,
    input: WorkerDispatchAdmissionStartInput<'_>,
) -> WorkerDispatchAdmissionStartResult<S::Session>
where
    S: WorkerDispatchSpawner,
{
    let WorkerDispatchAdmissionStartInput {
        daemon_dir,
        dispatch_state,
        runtime_state,
        limits,
        lease_sequence,
        lease_timestamp,
        lease_correlation_id,
        execute_sequence,
        execute_timestamp,
        launch_input,
        lock_owner,
        command,
        worker_config,
        started_at,
    } = input;

    let active_workers = runtime_state.to_active_worker_concurrency_snapshots();
    let active_dispatches = runtime_state.to_active_dispatch_concurrency_snapshots();
    let admission = plan_worker_dispatch_admission(WorkerDispatchAdmissionInput {
        dispatch_state,
        active_workers: &active_workers,
        active_dispatches: &active_dispatches,
        limits,
        sequence: lease_sequence,
        timestamp: lease_timestamp,
        correlation_id: lease_correlation_id.clone(),
    })
    .map_err(|source| WorkerDispatchAdmissionStartError::Admission {
        source: Box::new(source),
    })?;

    let admitted = match admission {
        WorkerDispatchAdmissionPlan::Admitted(admitted) => *admitted,
        WorkerDispatchAdmissionPlan::NotAdmitted {
            reason,
            blocked_candidates,
        } => {
            return Ok(WorkerDispatchAdmissionStartOutcome::NotAdmitted {
                reason,
                blocked_candidates,
            });
        }
    };

    let resolved_launch_input =
        resolve_launch_input(daemon_dir, &admitted.leased_record, launch_input).map_err(
            |source| WorkerDispatchAdmissionStartError::LaunchInput {
                admission: Box::new(admitted.clone()),
                source: Box::new(source),
            },
        )?;

    let delegation_snapshot = load_delegation_snapshot(daemon_dir, &admitted.leased_record)
        .map_err(
            |source| WorkerDispatchAdmissionStartError::DelegationSnapshot {
                admission: Box::new(admitted.clone()),
                source: Box::new(source),
            },
        )?;

    let launch_plan = plan_launch_for_admitted_dispatch(
        &admitted,
        execute_sequence,
        execute_timestamp,
        resolved_launch_input.clone(),
        delegation_snapshot,
    )
    .map_err(|source| WorkerDispatchAdmissionStartError::LaunchPlan {
        admission: Box::new(admitted.clone()),
        source: Box::new(source),
    })?;

    let mut context = WorkerDispatchAdmissionLaunchContext {
        admission: admitted,
        launch_plan,
    };

    let _dispatch_lock = acquire_dispatch_queue_lock(daemon_dir).map_err(|source| {
        WorkerDispatchAdmissionStartError::LeaseAppend {
            context: Box::new(context.clone()),
            source: Box::new(source),
        }
    })?;
    let current_dispatch_state = replay_dispatch_queue(daemon_dir).map_err(|source| {
        WorkerDispatchAdmissionStartError::LeaseAppend {
            context: Box::new(context.clone()),
            source: Box::new(source),
        }
    })?;
    context.admission.leased_record = plan_dispatch_queue_lease(
        &current_dispatch_state,
        DispatchQueueLifecycleInput {
            dispatch_id: context.admission.selected_dispatch.dispatch_id.clone(),
            sequence: current_dispatch_state.last_sequence + 1,
            timestamp: lease_timestamp,
            correlation_id: lease_correlation_id,
        },
    )
    .map_err(|source| WorkerDispatchAdmissionStartError::LeaseAppend {
        context: Box::new(context.clone()),
        source: Box::new(source),
    })?;
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
            command: if let Some(worker_id) = resolved_launch_input.worker_id.as_deref() {
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

    let identity = ral_identity_from_dispatch(&context.admission.leased_record);
    let runtime_started = WorkerRuntimeStartedDispatch::from_ready(
        &started.dispatch.ready,
        context.admission.leased_record.dispatch_id.clone(),
        identity,
        context.admission.leased_record.claim_token.clone(),
        started_at,
    );

    match runtime_state.register_started_dispatch(runtime_started.clone()) {
        Ok(()) => Ok(WorkerDispatchAdmissionStartOutcome::Started(Box::new(
            StartedWorkerDispatchAdmission {
                context,
                runtime_started,
                started,
            },
        ))),
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

fn load_delegation_snapshot(
    daemon_dir: &Path,
    dispatch: &DispatchQueueRecord,
) -> Result<crate::ral_journal::RalDelegationSnapshot, crate::ral_journal::RalJournalError> {
    let scheduler = crate::ral_scheduler::RalScheduler::from_daemon_dir(daemon_dir)?;
    Ok(scheduler.delegation_snapshot_for(
        &dispatch.ral.project_id,
        &dispatch.ral.agent_pubkey,
        &dispatch.ral.conversation_id,
    ))
}

fn plan_launch_for_admitted_dispatch(
    admitted: &AdmittedWorkerDispatch,
    sequence: u64,
    timestamp: u64,
    launch_input: WorkerDispatchExplicitLaunchInput,
    delegation_snapshot: crate::ral_journal::RalDelegationSnapshot,
) -> Result<WorkerLaunchPlan, WorkerLaunchError> {
    let WorkerDispatchExplicitLaunchInput {
        worker_id: _,
        project_base_path,
        metadata_path,
        triggering_envelope,
        execution_flags,
    } = launch_input;
    let identity = ral_identity_from_dispatch(&admitted.leased_record);
    plan_worker_launch(WorkerLaunchPlanInput {
        dispatch: &admitted.leased_record,
        identity: &identity,
        sequence,
        timestamp,
        project_base_path,
        metadata_path,
        triggering_envelope,
        execution_flags,
        delegation_snapshot,
    })
}

fn resolve_launch_input(
    daemon_dir: &Path,
    dispatch: &DispatchQueueRecord,
    source: WorkerDispatchLaunchInputSource,
) -> Result<WorkerDispatchExplicitLaunchInput, WorkerDispatchLaunchInputError> {
    match read_optional_worker_dispatch_input(daemon_dir, &dispatch.dispatch_id).map_err(
        |source| WorkerDispatchLaunchInputError::Read {
            dispatch_id: dispatch.dispatch_id.clone(),
            source,
        },
    )? {
        Some(input) => launch_input_from_filesystem_sidecar(dispatch, input),
        None => match source {
            WorkerDispatchLaunchInputSource::FilesystemSidecarRequired => Err(
                WorkerDispatchLaunchInputError::MissingFilesystemDispatchInput {
                    dispatch_id: dispatch.dispatch_id.clone(),
                },
            ),
            WorkerDispatchLaunchInputSource::FilesystemSidecarWithExplicitFallback(fallback) => {
                Ok(fallback)
            }
        },
    }
}

fn launch_input_from_filesystem_sidecar(
    dispatch: &DispatchQueueRecord,
    input: WorkerDispatchInput,
) -> Result<WorkerDispatchExplicitLaunchInput, WorkerDispatchLaunchInputError> {
    let dispatch_id = input.dispatch_id.clone();
    let fields = input.resolved_execute_fields().map_err(|source| {
        WorkerDispatchLaunchInputError::Invalid {
            dispatch_id: dispatch_id.clone(),
            source,
        }
    })?;
    let triggering_event_id = fields.triggering_event_id;

    if dispatch_id.as_str() != dispatch.dispatch_id.as_str() {
        return Err(WorkerDispatchLaunchInputError::DispatchIdMismatch {
            expected_dispatch_id: dispatch.dispatch_id.clone(),
            actual_dispatch_id: dispatch_id,
        });
    }

    if triggering_event_id.as_str() != dispatch.triggering_event_id.as_str() {
        return Err(WorkerDispatchLaunchInputError::TriggeringEventMismatch {
            dispatch_id,
            expected_triggering_event_id: dispatch.triggering_event_id.clone(),
            actual_triggering_event_id: triggering_event_id,
        });
    }

    Ok(WorkerDispatchExplicitLaunchInput {
        worker_id: fields.worker_id,
        project_base_path: fields.project_base_path,
        metadata_path: fields.metadata_path,
        triggering_envelope: fields.triggering_envelope,
        execution_flags: fields.execution_flags,
    })
}

fn ral_identity_from_dispatch(dispatch: &DispatchQueueRecord) -> RalJournalIdentity {
    RalJournalIdentity {
        project_id: dispatch.ral.project_id.clone(),
        agent_pubkey: dispatch.ral.agent_pubkey.clone(),
        conversation_id: dispatch.ral.conversation_id.clone(),
        ral_number: dispatch.ral.ral_number,
    }
}

impl<S> fmt::Debug for WorkerDispatchAdmissionStartError<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Admission { source } => formatter
                .debug_struct("Admission")
                .field("source", source)
                .finish(),
            Self::LaunchInput { admission, source } => formatter
                .debug_struct("LaunchInput")
                .field("admission", admission)
                .field("source", source)
                .finish(),
            Self::LaunchPlan { admission, source } => formatter
                .debug_struct("LaunchPlan")
                .field("admission", admission)
                .field("source", source)
                .finish(),
            Self::DelegationSnapshot { admission, source } => formatter
                .debug_struct("DelegationSnapshot")
                .field("admission", admission)
                .field("source", source)
                .finish(),
            Self::LeaseAppend { context, source } => formatter
                .debug_struct("LeaseAppend")
                .field("context", context)
                .field("source", source)
                .finish(),
            Self::DispatchStart { context, source } => formatter
                .debug_struct("DispatchStart")
                .field("context", context)
                .field("source", source)
                .finish(),
            Self::RuntimeRegister { context, source } => formatter
                .debug_struct("RuntimeRegister")
                .field("context", &RuntimeRegisterDebugContext(context.as_ref()))
                .field("source", source)
                .finish(),
        }
    }
}

impl<S> fmt::Display for WorkerDispatchAdmissionStartError<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Admission { source } => {
                write!(formatter, "worker dispatch admission planning failed: {source}")
            }
            Self::LaunchInput { source, .. } => {
                write!(formatter, "worker dispatch launch input resolution failed: {source}")
            }
            Self::LaunchPlan { source, .. } => {
                write!(formatter, "worker dispatch launch planning failed: {source}")
            }
            Self::DelegationSnapshot { source, .. } => {
                write!(formatter, "worker dispatch delegation snapshot load failed: {source}")
            }
            Self::LeaseAppend { source, .. } => {
                write!(formatter, "worker dispatch lease append failed: {source}")
            }
            Self::DispatchStart { source, .. } => write!(
                formatter,
                "worker dispatch start failed after the dispatch queue lease was appended: {source}",
            ),
            Self::RuntimeRegister { source, .. } => write!(
                formatter,
                "worker runtime registration failed after the worker dispatch was started: {source}",
            ),
        }
    }
}

impl<S> Error for WorkerDispatchAdmissionStartError<S>
where
    S: 'static,
{
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Admission { source } => Some(source.as_ref()),
            Self::LaunchInput { source, .. } => Some(source.as_ref()),
            Self::LaunchPlan { source, .. } => Some(source.as_ref()),
            Self::DelegationSnapshot { source, .. } => Some(source.as_ref()),
            Self::LeaseAppend { source, .. } => Some(source.as_ref()),
            Self::DispatchStart { source, .. } => Some(source.as_ref()),
            Self::RuntimeRegister { source, .. } => Some(source.as_ref()),
        }
    }
}

struct RuntimeRegisterDebugContext<'a, S>(&'a StartedWorkerDispatchAdmission<S>);

impl<S> fmt::Debug for RuntimeRegisterDebugContext<'_, S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StartedWorkerDispatchAdmission")
            .field("context", &self.0.context)
            .field("runtime_started", &self.0.runtime_started)
            .field("started", &"<started worker dispatch retained>")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        append_dispatch_queue_record, build_dispatch_queue_record, dispatch_queue_path,
        replay_dispatch_queue, replay_dispatch_queue_records,
    };
    use crate::ral_lock::{build_ral_lock_info, read_ral_lock_info};
    use crate::scheduled_task_dispatch_input::{
        ScheduledTaskDispatchInput, ScheduledTaskDispatchTaskDiagnosticMetadata,
        ScheduledTaskDispatchTaskKind, write_create_or_compare_equal,
    };
    use crate::worker_dispatch::execution::{
        BootedWorkerDispatch, WorkerDispatchSession, WorkerDispatchSpawner,
    };
    use crate::worker_launch_lock::release_worker_launch_locks;
    use crate::worker_process::{AgentWorkerProcessConfig, AgentWorkerReady};
    use crate::worker_protocol::{
        AGENT_WORKER_MAX_FRAME_BYTES, AGENT_WORKER_PROTOCOL_ENCODING,
        AGENT_WORKER_PROTOCOL_VERSION, AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
        AGENT_WORKER_STREAM_BATCH_MS, WorkerProtocolConfig,
    };
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct RecordingSession {
        messages: Vec<Value>,
        send_error: Option<FakeWorkerError>,
    }

    impl WorkerDispatchSession for RecordingSession {
        type Error = FakeWorkerError;

        fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error> {
            if let Some(error) = self.send_error.clone() {
                return Err(error);
            }

            self.messages.push(message.clone());
            Ok(())
        }
    }

    #[derive(Debug, Clone)]
    struct RecordingSpawner {
        spawn_calls: Vec<(AgentWorkerCommand, AgentWorkerProcessConfig)>,
        ready: AgentWorkerReady,
        session: RecordingSession,
        spawn_error: Option<FakeWorkerError>,
    }

    impl WorkerDispatchSpawner for RecordingSpawner {
        type Session = RecordingSession;
        type Error = FakeWorkerError;

        fn spawn_worker(
            &mut self,
            command: &AgentWorkerCommand,
            config: &AgentWorkerProcessConfig,
        ) -> Result<BootedWorkerDispatch<Self::Session>, Self::Error> {
            self.spawn_calls.push((command.clone(), config.clone()));

            if let Some(error) = self.spawn_error.clone() {
                return Err(error);
            }

            Ok(BootedWorkerDispatch {
                ready: self.ready.clone(),
                session: self.session.clone(),
            })
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
    fn starts_admitted_dispatch_after_appending_lease_and_registers_runtime_state() {
        let daemon_dir = unique_temp_daemon_dir();
        let queued = dispatch_record(1, DispatchQueueStatus::Queued);
        append_dispatch_queue_record(&daemon_dir, &queued).expect("queued record must append");
        let dispatch_state =
            replay_dispatch_queue_records(vec![queued]).expect("queue state must replay");
        let mut runtime_state = WorkerRuntimeState::default();
        let command = worker_command();
        let config = AgentWorkerProcessConfig {
            boot_timeout: Duration::from_millis(250),
        };
        let mut spawner = recording_spawner(ready_message("worker-a"), None, None);

        let outcome = apply_worker_dispatch_admission_start(
            &mut spawner,
            input(
                &daemon_dir,
                &dispatch_state,
                &mut runtime_state,
                command.clone(),
                &config,
            ),
        )
        .expect("dispatch admission start must succeed");

        let started = match outcome {
            WorkerDispatchAdmissionStartOutcome::Started(started) => *started,
            other => panic!("expected started dispatch, got {other:?}"),
        };
        assert_eq!(spawner.spawn_calls, vec![(command.clone(), config.clone())]);
        assert_eq!(
            started.started.dispatch.session.messages,
            vec![started.context.launch_plan.execute_message.clone()]
        );
        assert_eq!(started.runtime_started.worker_id, "worker-a");
        assert_eq!(started.runtime_started.dispatch_id, "dispatch-a");
        assert_eq!(started.runtime_started.claim_token, "claim-a");
        assert_eq!(
            runtime_state
                .get_worker_by_dispatch("dispatch-a")
                .expect("runtime dispatch must register")
                .worker_id,
            "worker-a"
        );
        let queue = replay_dispatch_queue(&daemon_dir).expect("queue must replay");
        assert!(queue.queued.is_empty());
        assert_eq!(queue.leased.len(), 1);
        assert_eq!(queue.leased[0], started.context.admission.leased_record);
        assert_eq!(
            read_ral_lock_info(&started.started.locks.allocation.path)
                .expect("allocation lock must read"),
            Some(build_ral_lock_info(100, "host-a", 1_000))
        );

        release_worker_launch_locks(started.started.locks).expect("locks must release");
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn refreshes_lease_sequence_against_current_dispatch_queue_tail() {
        let daemon_dir = unique_temp_daemon_dir();
        let queued = dispatch_record(1, DispatchQueueStatus::Queued);
        append_dispatch_queue_record(&daemon_dir, &queued).expect("queued record must append");
        let dispatch_state =
            replay_dispatch_queue_records(vec![queued]).expect("queue state must replay");
        let mut concurrent = dispatch_record(2, DispatchQueueStatus::Queued);
        concurrent.dispatch_id = "dispatch-b".to_string();
        concurrent.triggering_event_id = "event-b".to_string();
        concurrent.claim_token = "claim-b".to_string();
        append_dispatch_queue_record(&daemon_dir, &concurrent)
            .expect("concurrent queued record must append");
        let mut runtime_state = WorkerRuntimeState::default();
        let command = worker_command();
        let config = AgentWorkerProcessConfig::default();
        let mut spawner = recording_spawner(ready_message("worker-a"), None, None);

        let outcome = apply_worker_dispatch_admission_start(
            &mut spawner,
            input(
                &daemon_dir,
                &dispatch_state,
                &mut runtime_state,
                command,
                &config,
            ),
        )
        .expect("dispatch admission start must succeed");

        let started = match outcome {
            WorkerDispatchAdmissionStartOutcome::Started(started) => *started,
            other => panic!("expected started dispatch, got {other:?}"),
        };
        assert_eq!(started.context.admission.leased_record.sequence, 3);
        let queue = replay_dispatch_queue(&daemon_dir).expect("queue must replay");
        assert_eq!(queue.last_sequence, 3);
        assert_eq!(
            queue
                .latest_record("dispatch-a")
                .expect("dispatch-a must remain tracked")
                .status,
            DispatchQueueStatus::Leased
        );
        assert_eq!(
            queue
                .latest_record("dispatch-b")
                .expect("dispatch-b must remain tracked")
                .status,
            DispatchQueueStatus::Queued
        );

        release_worker_launch_locks(started.started.locks).expect("locks must release");
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn filesystem_sidecar_input_drives_execute_message_fields() {
        let daemon_dir = unique_temp_daemon_dir();
        let queued = dispatch_record(1, DispatchQueueStatus::Queued);
        append_dispatch_queue_record(&daemon_dir, &queued).expect("queued record must append");
        let dispatch_state =
            replay_dispatch_queue_records(vec![queued]).expect("queue state must replay");
        write_create_or_compare_equal(
            &daemon_dir,
            &scheduled_task_dispatch_input("dispatch-a", "event-a"),
        )
        .expect("sidecar input must write");
        let mut runtime_state = WorkerRuntimeState::default();
        let config = AgentWorkerProcessConfig::default();
        let mut spawner = recording_spawner(ready_message("sidecar-worker-a"), None, None);

        let outcome = apply_worker_dispatch_admission_start(
            &mut spawner,
            input(
                &daemon_dir,
                &dispatch_state,
                &mut runtime_state,
                worker_command(),
                &config,
            ),
        )
        .expect("sidecar-backed dispatch admission start must succeed");

        let started = match outcome {
            WorkerDispatchAdmissionStartOutcome::Started(started) => *started,
            other => panic!("expected started dispatch, got {other:?}"),
        };
        let execute = &started.context.launch_plan.execute_message;
        assert_eq!(execute["projectBasePath"], json!("/sidecar/repo"));
        assert_eq!(
            execute["metadataPath"],
            json!("/sidecar/repo/.tenex/project.json")
        );
        assert_eq!(
            execute["triggeringEnvelope"]["content"],
            json!("from sidecar")
        );
        assert_eq!(
            execute["executionFlags"],
            json!({
                "isDelegationCompletion": true,
                "hasPendingDelegations": true,
                "debug": true,
            })
        );
        assert_eq!(
            started.started.dispatch.session.messages,
            vec![execute.clone()]
        );
        assert_eq!(
            spawner.spawn_calls[0].0.env.get("TENEX_AGENT_WORKER_ID"),
            Some(&"sidecar-worker-a".to_string())
        );

        release_worker_launch_locks(started.started.locks).expect("locks must release");
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn required_filesystem_sidecar_missing_fails_before_lease_or_spawn() {
        let daemon_dir = unique_temp_daemon_dir();
        let queued = dispatch_record(1, DispatchQueueStatus::Queued);
        append_dispatch_queue_record(&daemon_dir, &queued).expect("queued record must append");
        let dispatch_state =
            replay_dispatch_queue_records(vec![queued]).expect("queue state must replay");
        let mut runtime_state = WorkerRuntimeState::default();
        let config = AgentWorkerProcessConfig::default();
        let mut spawner = recording_spawner(ready_message("worker-a"), None, None);
        let mut input = input(
            &daemon_dir,
            &dispatch_state,
            &mut runtime_state,
            worker_command(),
            &config,
        );
        input.launch_input = WorkerDispatchLaunchInputSource::FilesystemSidecarRequired;

        let error = apply_worker_dispatch_admission_start(&mut spawner, input)
            .expect_err("missing required sidecar must fail before spawn");

        match error {
            WorkerDispatchAdmissionStartError::LaunchInput { admission, source } => {
                assert_eq!(admission.leased_record.dispatch_id, "dispatch-a");
                assert!(matches!(
                    *source,
                    WorkerDispatchLaunchInputError::MissingFilesystemDispatchInput { dispatch_id }
                    if dispatch_id == "dispatch-a"
                ));
            }
            other => panic!("expected launch input error, got {other:?}"),
        }
        assert!(spawner.spawn_calls.is_empty());
        assert!(runtime_state.is_empty());
        let queue = replay_dispatch_queue(&daemon_dir).expect("queue must replay");
        assert_eq!(queue.queued.len(), 1);
        assert!(queue.leased.is_empty());
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn conflicting_filesystem_sidecar_fails_before_lease_or_spawn() {
        let daemon_dir = unique_temp_daemon_dir();
        let queued = dispatch_record(1, DispatchQueueStatus::Queued);
        append_dispatch_queue_record(&daemon_dir, &queued).expect("queued record must append");
        let dispatch_state =
            replay_dispatch_queue_records(vec![queued]).expect("queue state must replay");
        write_create_or_compare_equal(
            &daemon_dir,
            &scheduled_task_dispatch_input("dispatch-a", "event-other"),
        )
        .expect("conflicting sidecar input must write");
        let mut runtime_state = WorkerRuntimeState::default();
        let config = AgentWorkerProcessConfig::default();
        let mut spawner = recording_spawner(ready_message("worker-a"), None, None);

        let error = apply_worker_dispatch_admission_start(
            &mut spawner,
            input(
                &daemon_dir,
                &dispatch_state,
                &mut runtime_state,
                worker_command(),
                &config,
            ),
        )
        .expect_err("conflicting sidecar must fail before spawn");

        match error {
            WorkerDispatchAdmissionStartError::LaunchInput { admission, source } => {
                assert_eq!(admission.leased_record.dispatch_id, "dispatch-a");
                assert!(matches!(
                    *source,
                    WorkerDispatchLaunchInputError::TriggeringEventMismatch {
                        dispatch_id,
                        expected_triggering_event_id,
                        actual_triggering_event_id,
                    } if dispatch_id == "dispatch-a"
                        && expected_triggering_event_id == "event-a"
                        && actual_triggering_event_id == "event-other"
                ));
            }
            other => panic!("expected launch input error, got {other:?}"),
        }
        assert!(spawner.spawn_calls.is_empty());
        assert!(runtime_state.is_empty());
        let queue = replay_dispatch_queue(&daemon_dir).expect("queue must replay");
        assert_eq!(queue.queued.len(), 1);
        assert!(queue.leased.is_empty());
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn returns_not_admitted_without_appending_or_spawning() {
        let daemon_dir = unique_temp_daemon_dir();
        let dispatch_state = DispatchQueueState::default();
        let mut runtime_state = WorkerRuntimeState::default();
        let config = AgentWorkerProcessConfig::default();
        let mut spawner = recording_spawner(ready_message("worker-a"), None, None);

        let outcome = apply_worker_dispatch_admission_start(
            &mut spawner,
            input(
                &daemon_dir,
                &dispatch_state,
                &mut runtime_state,
                worker_command(),
                &config,
            ),
        )
        .expect("empty queue is not an error");

        assert!(matches!(
            outcome,
            WorkerDispatchAdmissionStartOutcome::NotAdmitted {
                reason: WorkerDispatchAdmissionBlockedReason::NoQueuedDispatches,
                blocked_candidates,
            } if blocked_candidates.is_empty()
        ));
        assert!(spawner.spawn_calls.is_empty());
        assert!(runtime_state.is_empty());
        assert!(
            replay_dispatch_queue(&daemon_dir)
                .expect("missing queue file replays")
                .queued
                .is_empty()
        );
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn reports_launch_plan_failure_before_appending_lease() {
        let daemon_dir = unique_temp_daemon_dir();
        let queued = dispatch_record(1, DispatchQueueStatus::Queued);
        append_dispatch_queue_record(&daemon_dir, &queued).expect("queued record must append");
        let dispatch_state =
            replay_dispatch_queue_records(vec![queued]).expect("queue state must replay");
        let mut runtime_state = WorkerRuntimeState::default();
        let config = AgentWorkerProcessConfig::default();
        let mut spawner = recording_spawner(ready_message("worker-a"), None, None);
        let mut input = input(
            &daemon_dir,
            &dispatch_state,
            &mut runtime_state,
            worker_command(),
            &config,
        );
        explicit_launch_input_mut(&mut input).triggering_envelope =
            triggering_envelope("event-other");

        let error = apply_worker_dispatch_admission_start(&mut spawner, input)
            .expect_err("launch mismatch must fail before lease append");

        match error {
            WorkerDispatchAdmissionStartError::LaunchPlan { admission, source } => {
                assert_eq!(admission.leased_record.dispatch_id, "dispatch-a");
                assert!(matches!(
                    *source,
                    WorkerLaunchError::Protocol(
                        crate::worker_protocol::WorkerProtocolError::TriggeringEnvelopeMismatch { .. }
                    )
                ));
            }
            other => panic!("expected launch plan error, got {other:?}"),
        }
        assert!(spawner.spawn_calls.is_empty());
        assert!(runtime_state.is_empty());
        let queue = replay_dispatch_queue(&daemon_dir).expect("queue must replay");
        assert_eq!(queue.queued.len(), 1);
        assert!(queue.leased.is_empty());
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn returns_lease_context_when_dispatch_start_fails_after_lease_append() {
        let daemon_dir = unique_temp_daemon_dir();
        let queued = dispatch_record(1, DispatchQueueStatus::Queued);
        append_dispatch_queue_record(&daemon_dir, &queued).expect("queued record must append");
        let dispatch_state =
            replay_dispatch_queue_records(vec![queued]).expect("queue state must replay");
        let mut runtime_state = WorkerRuntimeState::default();
        let config = AgentWorkerProcessConfig::default();
        let mut spawner = recording_spawner(
            ready_message("worker-a"),
            Some(FakeWorkerError("spawn failed")),
            None,
        );

        let error = apply_worker_dispatch_admission_start(
            &mut spawner,
            input(
                &daemon_dir,
                &dispatch_state,
                &mut runtime_state,
                worker_command(),
                &config,
            ),
        )
        .expect_err("spawn failure must be reported with lease context");

        match error {
            WorkerDispatchAdmissionStartError::DispatchStart { context, source } => {
                assert_eq!(context.admission.leased_record.dispatch_id, "dispatch-a");
                assert!(matches!(*source, WorkerDispatchStartError::Dispatch(_)));
            }
            other => panic!("expected dispatch start error, got {other:?}"),
        }
        assert_eq!(spawner.spawn_calls.len(), 1);
        assert!(runtime_state.is_empty());
        let queue = replay_dispatch_queue(&daemon_dir).expect("queue must replay");
        assert!(queue.queued.is_empty());
        assert_eq!(queue.leased.len(), 1);
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn returns_started_dispatch_and_locks_when_runtime_registration_fails() {
        let daemon_dir = unique_temp_daemon_dir();
        let queued = dispatch_record(1, DispatchQueueStatus::Queued);
        append_dispatch_queue_record(&daemon_dir, &queued).expect("queued record must append");
        let dispatch_state =
            replay_dispatch_queue_records(vec![queued]).expect("queue state must replay");
        let mut runtime_state = WorkerRuntimeState::default();
        runtime_state
            .register_started_dispatch(WorkerRuntimeStartedDispatch {
                worker_id: "worker-a".to_string(),
                pid: 999,
                dispatch_id: "dispatch-existing".to_string(),
                identity: RalJournalIdentity {
                    project_id: "project-existing".to_string(),
                    agent_pubkey: "agent-existing".to_string(),
                    conversation_id: "conversation-existing".to_string(),
                    ral_number: 9,
                },
                claim_token: "claim-existing".to_string(),
                started_at: 500,
            })
            .expect("existing runtime worker must register");
        let config = AgentWorkerProcessConfig::default();
        let mut spawner = recording_spawner(ready_message("worker-a"), None, None);

        let error = apply_worker_dispatch_admission_start(
            &mut spawner,
            input(
                &daemon_dir,
                &dispatch_state,
                &mut runtime_state,
                worker_command(),
                &config,
            ),
        )
        .expect_err("duplicate worker id must return started dispatch context");

        match error {
            WorkerDispatchAdmissionStartError::RuntimeRegister { context, source } => {
                assert_eq!(
                    *source,
                    WorkerRuntimeStateError::DuplicateWorker {
                        worker_id: "worker-a".to_string()
                    }
                );
                assert_eq!(context.runtime_started.dispatch_id, "dispatch-a");
                assert_eq!(context.started.dispatch.ready.worker_id, "worker-a");
                assert_eq!(
                    context.started.dispatch.session.messages,
                    vec![context.context.launch_plan.execute_message.clone()]
                );
                assert_eq!(
                    read_ral_lock_info(&context.started.locks.state.path)
                        .expect("state lock must read"),
                    Some(build_ral_lock_info(100, "host-a", 1_000))
                );
                release_worker_launch_locks(context.started.locks).expect("locks must release");
            }
            other => panic!("expected runtime register error, got {other:?}"),
        }
        assert!(runtime_state.get_worker_by_dispatch("dispatch-a").is_none());
        let queue = replay_dispatch_queue(&daemon_dir).expect("queue must replay");
        assert_eq!(queue.leased.len(), 1);
        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn reports_append_failure_without_spawning_or_registering_runtime() {
        let daemon_dir = unique_temp_daemon_dir();
        let queued = dispatch_record(1, DispatchQueueStatus::Queued);
        let dispatch_state =
            replay_dispatch_queue_records(vec![queued]).expect("queue state must replay");
        fs::create_dir_all(dispatch_queue_path(&daemon_dir)).expect("queue path dir must build");
        let mut runtime_state = WorkerRuntimeState::default();
        let config = AgentWorkerProcessConfig::default();
        let mut spawner = recording_spawner(ready_message("worker-a"), None, None);

        let error = apply_worker_dispatch_admission_start(
            &mut spawner,
            input(
                &daemon_dir,
                &dispatch_state,
                &mut runtime_state,
                worker_command(),
                &config,
            ),
        )
        .expect_err("append failure must be reported");

        match error {
            WorkerDispatchAdmissionStartError::LeaseAppend { context, .. } => {
                assert_eq!(context.admission.leased_record.dispatch_id, "dispatch-a");
            }
            other => panic!("expected lease append error, got {other:?}"),
        }
        assert!(spawner.spawn_calls.is_empty());
        assert!(runtime_state.is_empty());
        cleanup_temp_dir(daemon_dir);
    }

    fn input<'a>(
        daemon_dir: &'a Path,
        dispatch_state: &'a DispatchQueueState,
        runtime_state: &'a mut WorkerRuntimeState,
        command: AgentWorkerCommand,
        config: &'a AgentWorkerProcessConfig,
    ) -> WorkerDispatchAdmissionStartInput<'a> {
        WorkerDispatchAdmissionStartInput {
            daemon_dir,
            dispatch_state,
            runtime_state,
            limits: WorkerConcurrencyLimits {
                global: None,
                per_project: None,
                per_agent: None,
            },
            lease_sequence: 2,
            lease_timestamp: 1_710_000_700_001,
            lease_correlation_id: "lease-correlation".to_string(),
            execute_sequence: 3,
            execute_timestamp: 1_710_000_700_002,
            launch_input: WorkerDispatchLaunchInputSource::FilesystemSidecarWithExplicitFallback(
                explicit_launch_input("event-a"),
            ),
            lock_owner: build_ral_lock_info(100, "host-a", 1_000),
            command,
            worker_config: config,
            started_at: 1_710_000_700_003,
        }
    }

    fn dispatch_record(sequence: u64, status: DispatchQueueStatus) -> DispatchQueueRecord {
        build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence,
            timestamp: 1_710_000_700_000 + sequence,
            correlation_id: "queued-correlation".to_string(),
            dispatch_id: "dispatch-a".to_string(),
            ral: DispatchRalIdentity {
                project_id: "project-a".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-a".to_string(),
                ral_number: 1,
            },
            triggering_event_id: "event-a".to_string(),
            claim_token: "claim-a".to_string(),
            status,
        })
    }

    fn explicit_launch_input(triggering_event_id: &str) -> WorkerDispatchExplicitLaunchInput {
        WorkerDispatchExplicitLaunchInput {
            worker_id: None,
            project_base_path: "/repo".to_string(),
            metadata_path: "/metadata.json".to_string(),
            triggering_envelope: triggering_envelope(triggering_event_id),
            execution_flags: AgentWorkerExecutionFlags {
                is_delegation_completion: false,
                has_pending_delegations: false,
                pending_delegation_ids: Vec::new(),
                debug: false,
            },
        }
    }

    fn explicit_launch_input_mut<'input>(
        input: &'input mut WorkerDispatchAdmissionStartInput<'_>,
    ) -> &'input mut WorkerDispatchExplicitLaunchInput {
        match &mut input.launch_input {
            WorkerDispatchLaunchInputSource::FilesystemSidecarWithExplicitFallback(fallback) => {
                fallback
            }
            WorkerDispatchLaunchInputSource::FilesystemSidecarRequired => {
                panic!("test input must include explicit fallback")
            }
        }
    }

    fn scheduled_task_dispatch_input(
        dispatch_id: &str,
        triggering_event_id: &str,
    ) -> ScheduledTaskDispatchInput {
        ScheduledTaskDispatchInput {
            dispatch_id: dispatch_id.to_string(),
            triggering_event_id: triggering_event_id.to_string(),
            worker_id: "sidecar-worker-a".to_string(),
            project_base_path: "/sidecar/repo".to_string(),
            metadata_path: "/sidecar/repo/.tenex/project.json".to_string(),
            triggering_envelope: {
                let mut envelope = triggering_envelope(triggering_event_id);
                envelope["content"] = json!("from sidecar");
                envelope
            },
            execution_flags: AgentWorkerExecutionFlags {
                is_delegation_completion: true,
                has_pending_delegations: true,
                pending_delegation_ids: Vec::new(),
                debug: true,
            },
            task_diagnostic_metadata: ScheduledTaskDispatchTaskDiagnosticMetadata {
                project_d_tag: "project-a".to_string(),
                project_ref: "project-a".to_string(),
                task_id: "task-a".to_string(),
                title: "Nightly task".to_string(),
                from_pubkey: "owner-a".to_string(),
                target_agent: "agent-a".to_string(),
                target_channel: None,
                schedule: "0 0 * * *".to_string(),
                kind: ScheduledTaskDispatchTaskKind::Cron,
                due_at: 1_710_000_700,
                last_run: Some(1_710_000_600),
            },
        }
    }

    fn worker_command() -> AgentWorkerCommand {
        AgentWorkerCommand::new("bun")
            .arg("run")
            .arg("src/agents/execution/worker/agent-worker.ts")
            .current_dir("/repo")
            .env("TENEX_AGENT_WORKER_ENGINE", "agent")
    }

    fn recording_spawner(
        ready: AgentWorkerReady,
        spawn_error: Option<FakeWorkerError>,
        send_error: Option<FakeWorkerError>,
    ) -> RecordingSpawner {
        RecordingSpawner {
            spawn_calls: Vec::new(),
            ready,
            session: RecordingSession {
                messages: Vec::new(),
                send_error,
            },
            spawn_error,
        }
    }

    fn ready_message(worker_id: &str) -> AgentWorkerReady {
        AgentWorkerReady {
            worker_id: worker_id.to_string(),
            pid: 123,
            protocol: protocol_config(),
            message: json!({
                "version": AGENT_WORKER_PROTOCOL_VERSION,
                "type": "ready",
                "correlationId": worker_id,
                "sequence": 1,
                "timestamp": 1710000700000_u64,
                "workerId": worker_id,
                "pid": 123_u64,
                "protocol": protocol_config_json(),
            }),
        }
    }

    fn protocol_config_json() -> Value {
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

    fn protocol_config() -> WorkerProtocolConfig {
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

    fn triggering_envelope(native_id: &str) -> Value {
        json!({
            "transport": "nostr",
            "principal": {
                "id": "nostr:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "transport": "nostr",
                "linkedPubkey": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "kind": "human"
            },
            "channel": {
                "id": "conversation:conversation-a",
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
                    "id": "nostr:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "transport": "nostr",
                    "linkedPubkey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "kind": "agent"
                }
            ],
            "content": "hello",
            "occurredAt": 1710000700000_u64,
            "capabilities": ["reply", "delegate"],
            "metadata": {}
        })
    }

    fn unique_temp_daemon_dir() -> std::path::PathBuf {
        let index = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "tenex-worker-dispatch-admission-start-{}-{index}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time must be after unix epoch")
                .as_nanos()
        ))
    }

    fn cleanup_temp_dir(path: std::path::PathBuf) {
        let _ = fs::remove_dir_all(path);
    }
}
