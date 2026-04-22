use std::error::Error;
use std::fmt;
use std::path::Path;

use serde_json::Value;

use crate::dispatch_queue::{
    DispatchQueueError, DispatchQueueRecord, DispatchQueueState, append_dispatch_queue_record,
};
use crate::ral_journal::RalJournalIdentity;
use crate::ral_lock::RalLockInfo;
use crate::worker_concurrency::WorkerConcurrencyLimits;
use crate::worker_dispatch_admission::{
    AdmittedWorkerDispatch, WorkerDispatchAdmissionBlockedCandidate,
    WorkerDispatchAdmissionBlockedReason, WorkerDispatchAdmissionError,
    WorkerDispatchAdmissionInput, WorkerDispatchAdmissionPlan, plan_worker_dispatch_admission,
};
use crate::worker_dispatch_execution::WorkerDispatchSpawner;
use crate::worker_dispatch_start::{
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
    pub project_base_path: String,
    pub metadata_path: String,
    pub triggering_envelope: Value,
    pub execution_flags: AgentWorkerExecutionFlags,
    pub lock_owner: RalLockInfo,
    pub command: AgentWorkerCommand,
    pub worker_config: &'a AgentWorkerProcessConfig,
    pub started_at: u64,
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

pub enum WorkerDispatchAdmissionStartError<S> {
    Admission {
        source: Box<WorkerDispatchAdmissionError>,
    },
    LaunchPlan {
        admission: Box<AdmittedWorkerDispatch>,
        source: Box<WorkerLaunchError>,
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
        project_base_path,
        metadata_path,
        triggering_envelope,
        execution_flags,
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
        correlation_id: lease_correlation_id,
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

    let launch_plan = plan_launch_for_admitted_dispatch(
        &admitted,
        execute_sequence,
        execute_timestamp,
        project_base_path,
        metadata_path,
        triggering_envelope,
        execution_flags,
    )
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
            command,
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

fn plan_launch_for_admitted_dispatch(
    admitted: &AdmittedWorkerDispatch,
    sequence: u64,
    timestamp: u64,
    project_base_path: String,
    metadata_path: String,
    triggering_envelope: Value,
    execution_flags: AgentWorkerExecutionFlags,
) -> Result<WorkerLaunchPlan, WorkerLaunchError> {
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
            Self::LaunchPlan { admission, source } => formatter
                .debug_struct("LaunchPlan")
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
            Self::Admission { .. } => {
                formatter.write_str("worker dispatch admission planning failed")
            }
            Self::LaunchPlan { .. } => {
                formatter.write_str("worker dispatch launch planning failed")
            }
            Self::LeaseAppend { .. } => formatter.write_str("worker dispatch lease append failed"),
            Self::DispatchStart { .. } => formatter.write_str(
                "worker dispatch start failed after the dispatch queue lease was appended",
            ),
            Self::RuntimeRegister { .. } => formatter.write_str(
                "worker runtime registration failed after the worker dispatch was started",
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
            Self::LaunchPlan { source, .. } => Some(source.as_ref()),
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
    use crate::worker_dispatch_execution::{
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
        input.triggering_envelope = triggering_envelope("event-other");

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
            project_base_path: "/repo".to_string(),
            metadata_path: "/metadata.json".to_string(),
            triggering_envelope: triggering_envelope("event-a"),
            execution_flags: AgentWorkerExecutionFlags {
                is_delegation_completion: false,
                has_pending_delegations: false,
                debug: false,
            },
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
