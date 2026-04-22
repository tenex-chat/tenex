use std::path::Path;

use thiserror::Error;

use crate::ral_lock::RalLockInfo;
use crate::worker_dispatch_execution::{
    StartedWorkerDispatch, WorkerDispatchExecutionError, WorkerDispatchSpawner,
    start_worker_dispatch,
};
use crate::worker_dispatch_spawn::plan_worker_dispatch_spawn;
use crate::worker_launch::WorkerLaunchPlan;
use crate::worker_launch_lock::{
    WorkerLaunchLockError, WorkerLaunchLocks, acquire_worker_launch_locks,
    release_worker_launch_locks,
};
use crate::worker_process::{AgentWorkerCommand, AgentWorkerProcessConfig};

#[derive(Debug)]
pub struct WorkerDispatchStartInput<'a> {
    pub daemon_dir: &'a Path,
    pub launch_plan: &'a WorkerLaunchPlan,
    pub lock_owner: &'a RalLockInfo,
    pub command: AgentWorkerCommand,
    pub worker_config: &'a AgentWorkerProcessConfig,
}

#[derive(Debug)]
pub struct LockScopedStartedWorkerDispatch<S> {
    pub dispatch: StartedWorkerDispatch<S>,
    pub locks: WorkerLaunchLocks,
}

#[derive(Debug, Error)]
pub enum WorkerDispatchStartError {
    #[error("worker dispatch launch lock acquisition failed: {0}")]
    Lock(#[source] Box<WorkerLaunchLockError>),
    #[error("worker dispatch start failed after locks were acquired: {0}")]
    Dispatch(#[source] Box<WorkerDispatchExecutionError>),
    #[error(
        "failed to release worker launch locks after dispatch start failed: start={start_error}; release={release_error}"
    )]
    LockRollbackFailed {
        start_error: Box<WorkerDispatchExecutionError>,
        release_error: Box<WorkerLaunchLockError>,
    },
}

pub type WorkerDispatchStartResult<T> = Result<T, WorkerDispatchStartError>;

impl From<WorkerLaunchLockError> for WorkerDispatchStartError {
    fn from(error: WorkerLaunchLockError) -> Self {
        Self::Lock(Box::new(error))
    }
}

pub fn start_lock_scoped_worker_dispatch<S>(
    spawner: &mut S,
    input: WorkerDispatchStartInput<'_>,
) -> WorkerDispatchStartResult<LockScopedStartedWorkerDispatch<S::Session>>
where
    S: WorkerDispatchSpawner,
{
    let locks = acquire_worker_launch_locks(input.daemon_dir, input.launch_plan, input.lock_owner)?;
    let spawn_plan = plan_worker_dispatch_spawn(input.launch_plan, input.command);

    match start_worker_dispatch(spawner, input.worker_config, &spawn_plan) {
        Ok(dispatch) => Ok(LockScopedStartedWorkerDispatch { dispatch, locks }),
        Err(start_error) => {
            if let Err(release_error) = release_worker_launch_locks(locks) {
                return Err(WorkerDispatchStartError::LockRollbackFailed {
                    start_error: Box::new(start_error),
                    release_error: Box::new(release_error),
                });
            }

            Err(WorkerDispatchStartError::Dispatch(Box::new(start_error)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ral_lock::{
        RalLockError, build_ral_lock_info, ral_allocation_lock_path, ral_state_lock_path,
        read_ral_lock_info, release_ral_lock, try_acquire_ral_lock,
    };
    use crate::worker_dispatch_execution::{
        BootedWorkerDispatch, WorkerDispatchExecutionError, WorkerDispatchSession,
    };
    use crate::worker_launch::{RalAllocationLockScope, RalStateLockScope};
    use crate::worker_process::{AgentWorkerProcessConfig, AgentWorkerReady};
    use crate::worker_protocol::{
        AGENT_WORKER_MAX_FRAME_BYTES, AGENT_WORKER_PROTOCOL_ENCODING,
        AGENT_WORKER_PROTOCOL_VERSION, AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
        AGENT_WORKER_STREAM_BATCH_MS, WorkerProtocolConfig, WorkerProtocolError,
    };
    use serde_json::{Value, json};
    use std::error::Error;
    use std::fmt;
    use std::path::PathBuf;
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
    fn lock_scoped_worker_dispatch_start_returns_dispatch_with_held_locks() {
        let daemon_dir = unique_temp_daemon_dir();
        let launch_plan = launch_plan();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let command = worker_command();
        let config = AgentWorkerProcessConfig {
            boot_timeout: Duration::from_millis(250),
        };
        let mut spawner = recording_spawner(None, None);

        let started = start_lock_scoped_worker_dispatch(
            &mut spawner,
            WorkerDispatchStartInput {
                daemon_dir: &daemon_dir,
                launch_plan: &launch_plan,
                lock_owner: &owner,
                command: command.clone(),
                worker_config: &config,
            },
        )
        .expect("dispatch must start");

        assert_eq!(spawner.spawn_calls, vec![(command, config)]);
        assert_eq!(started.dispatch.ready, ready_message());
        assert_eq!(
            started.dispatch.session.messages,
            vec![launch_plan.execute_message.clone()]
        );
        assert_eq!(
            read_ral_lock_info(&started.locks.allocation.path)
                .expect("allocation lock read must succeed"),
            Some(owner.clone())
        );
        assert_eq!(
            read_ral_lock_info(&started.locks.state.path).expect("state lock read must succeed"),
            Some(owner)
        );

        release_worker_launch_locks(started.locks).expect("locks must release");
        assert_launch_locks_released(&daemon_dir, &launch_plan);
        std::fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn lock_scoped_worker_dispatch_start_releases_locks_on_spawn_failure() {
        let daemon_dir = unique_temp_daemon_dir();
        let launch_plan = launch_plan();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let mut spawner = recording_spawner(Some(FakeWorkerError("spawn failed")), None);

        let error = start_lock_scoped_worker_dispatch(
            &mut spawner,
            WorkerDispatchStartInput {
                daemon_dir: &daemon_dir,
                launch_plan: &launch_plan,
                lock_owner: &owner,
                command: worker_command(),
                worker_config: &AgentWorkerProcessConfig::default(),
            },
        )
        .expect_err("spawn failure must roll back locks");

        assert_dispatch_error(error, "spawn failed");
        assert_eq!(spawner.spawn_calls.len(), 1);
        assert_launch_locks_released(&daemon_dir, &launch_plan);
        std::fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn lock_scoped_worker_dispatch_start_releases_locks_on_send_failure() {
        let daemon_dir = unique_temp_daemon_dir();
        let launch_plan = launch_plan();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let mut spawner = recording_spawner(None, Some(FakeWorkerError("send failed")));

        let error = start_lock_scoped_worker_dispatch(
            &mut spawner,
            WorkerDispatchStartInput {
                daemon_dir: &daemon_dir,
                launch_plan: &launch_plan,
                lock_owner: &owner,
                command: worker_command(),
                worker_config: &AgentWorkerProcessConfig::default(),
            },
        )
        .expect_err("send failure must roll back locks");

        assert_dispatch_error(error, "send failed");
        assert_eq!(spawner.spawn_calls.len(), 1);
        assert_launch_locks_released(&daemon_dir, &launch_plan);
        std::fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn lock_scoped_worker_dispatch_start_releases_locks_when_execute_is_rejected() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut launch_plan = launch_plan();
        launch_plan.execute_message = json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "execute",
            "correlationId": "correlation-a",
            "sequence": 3,
            "timestamp": 1710000700000_u64,
        });
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let mut spawner = recording_spawner(None, None);

        let error = start_lock_scoped_worker_dispatch(
            &mut spawner,
            WorkerDispatchStartInput {
                daemon_dir: &daemon_dir,
                launch_plan: &launch_plan,
                lock_owner: &owner,
                command: worker_command(),
                worker_config: &AgentWorkerProcessConfig::default(),
            },
        )
        .expect_err("invalid execute must roll back locks");

        match error {
            WorkerDispatchStartError::Dispatch(source) => {
                assert!(matches!(
                    *source,
                    WorkerDispatchExecutionError::InvalidExecuteMessage(
                        WorkerProtocolError::MissingField("projectId")
                    )
                ));
            }
            other => panic!("expected dispatch validation error, got {other:?}"),
        }
        assert!(spawner.spawn_calls.is_empty());
        assert_launch_locks_released(&daemon_dir, &launch_plan);
        std::fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn lock_scoped_worker_dispatch_start_does_not_spawn_when_lock_acquisition_fails() {
        let daemon_dir = unique_temp_daemon_dir();
        let launch_plan = launch_plan();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let other_owner = build_ral_lock_info(200, "host-a", 1_000);
        let state_path = ral_state_lock_path(&daemon_dir, &launch_plan.state_lock_scope)
            .expect("state path must build");
        let busy_state =
            try_acquire_ral_lock(&state_path, &other_owner).expect("busy state lock acquired");
        let mut spawner = recording_spawner(None, None);

        let error = start_lock_scoped_worker_dispatch(
            &mut spawner,
            WorkerDispatchStartInput {
                daemon_dir: &daemon_dir,
                launch_plan: &launch_plan,
                lock_owner: &owner,
                command: worker_command(),
                worker_config: &AgentWorkerProcessConfig::default(),
            },
        )
        .expect_err("busy state lock must prevent dispatch start");

        match error {
            WorkerDispatchStartError::Lock(source) => match *source {
                WorkerLaunchLockError::Lock(lock_error) => {
                    assert!(matches!(*lock_error, RalLockError::AlreadyHeld { .. }));
                }
                other => panic!("expected lock conflict, got {other:?}"),
            },
            other => panic!("expected lock error, got {other:?}"),
        }
        assert!(spawner.spawn_calls.is_empty());
        assert_eq!(
            read_ral_lock_info(
                ral_allocation_lock_path(&daemon_dir, &launch_plan.allocation_lock_scope)
                    .expect("allocation path must build")
            )
            .expect("allocation lock read must succeed"),
            None
        );
        assert_eq!(
            read_ral_lock_info(&state_path).expect("state lock read must succeed"),
            Some(other_owner)
        );

        release_ral_lock(&busy_state).expect("busy state release must succeed");
        std::fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    fn launch_plan() -> WorkerLaunchPlan {
        WorkerLaunchPlan {
            allocation_lock_scope: RalAllocationLockScope {
                project_id: "project-a".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-a".to_string(),
            },
            state_lock_scope: RalStateLockScope {
                project_id: "project-a".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-a".to_string(),
                ral_number: 1,
            },
            execute_message: execute_message(),
        }
    }

    fn worker_command() -> AgentWorkerCommand {
        AgentWorkerCommand::new("bun")
            .arg("run")
            .arg("src/agents/execution/worker/agent-worker.ts")
            .current_dir("/repo")
            .env("TENEX_AGENT_WORKER_ENGINE", "agent")
    }

    fn execute_message() -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "execute",
            "correlationId": "correlation-a",
            "sequence": 3,
            "timestamp": 1710000700000_u64,
            "projectId": "project-a",
            "projectBasePath": "/repo",
            "metadataPath": "/metadata.json",
            "agentPubkey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "conversationId": "conversation-a",
            "ralNumber": 1_u64,
            "ralClaimToken": "claim-a",
            "triggeringEnvelope": {
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
                    "id": "event-a",
                    "transport": "nostr",
                    "nativeId": "event-a"
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
            },
            "executionFlags": {
                "isDelegationCompletion": false,
                "hasPendingDelegations": false,
                "debug": false
            }
        })
    }

    fn recording_spawner(
        spawn_error: Option<FakeWorkerError>,
        send_error: Option<FakeWorkerError>,
    ) -> RecordingSpawner {
        RecordingSpawner {
            spawn_calls: Vec::new(),
            ready: ready_message(),
            session: RecordingSession {
                messages: Vec::new(),
                send_error,
            },
            spawn_error,
        }
    }

    fn ready_message() -> AgentWorkerReady {
        AgentWorkerReady {
            worker_id: "worker-a".to_string(),
            pid: 123,
            protocol: protocol_config(),
            message: json!({
                "version": AGENT_WORKER_PROTOCOL_VERSION,
                "type": "ready",
                "correlationId": "worker-a",
                "sequence": 1,
                "timestamp": 1710000700000_u64,
                "workerId": "worker-a",
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

    fn assert_dispatch_error(error: WorkerDispatchStartError, message: &str) {
        match error {
            WorkerDispatchStartError::Dispatch(source) => match *source {
                WorkerDispatchExecutionError::Spawn(source)
                | WorkerDispatchExecutionError::SendExecute(source) => {
                    assert_eq!(source.to_string(), message);
                }
                other => panic!("expected worker start error, got {other:?}"),
            },
            other => panic!("expected dispatch error, got {other:?}"),
        }
    }

    fn assert_launch_locks_released(daemon_dir: &Path, launch_plan: &WorkerLaunchPlan) {
        assert_eq!(
            read_ral_lock_info(
                ral_allocation_lock_path(daemon_dir, &launch_plan.allocation_lock_scope)
                    .expect("allocation path must build")
            )
            .expect("allocation lock read must succeed"),
            None
        );
        assert_eq!(
            read_ral_lock_info(
                ral_state_lock_path(daemon_dir, &launch_plan.state_lock_scope)
                    .expect("state path must build")
            )
            .expect("state lock read must succeed"),
            None
        );
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "tenex-worker-dispatch-start-test-{nanos}-{counter}"
        ))
    }
}
