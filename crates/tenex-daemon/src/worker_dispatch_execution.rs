use std::error::Error;

use serde_json::Value;
use thiserror::Error;

use crate::worker_dispatch_spawn::WorkerDispatchSpawnPlan;
use crate::worker_process::{
    AgentWorkerCommand, AgentWorkerProcess, AgentWorkerProcessConfig, AgentWorkerReady,
    WorkerProcessError,
};
use crate::worker_protocol::{WorkerProtocolError, validate_agent_worker_protocol_message};

pub trait WorkerDispatchSession {
    type Error: Error + Send + Sync + 'static;

    fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error>;

    fn is_worker_pipe_closed_error(_error: &Self::Error) -> bool {
        false
    }
}

pub trait WorkerDispatchSpawner {
    type Session: WorkerDispatchSession;
    type Error: Error + Send + Sync + 'static;

    fn spawn_worker(
        &mut self,
        command: &AgentWorkerCommand,
        config: &AgentWorkerProcessConfig,
    ) -> Result<BootedWorkerDispatch<Self::Session>, Self::Error>;
}

#[derive(Debug)]
pub struct BootedWorkerDispatch<S> {
    pub ready: AgentWorkerReady,
    pub session: S,
}

#[derive(Debug)]
pub struct StartedWorkerDispatch<S> {
    pub ready: AgentWorkerReady,
    pub session: S,
}

#[derive(Debug, Error)]
pub enum WorkerDispatchExecutionError {
    #[error("worker dispatch execute message is invalid: {0}")]
    InvalidExecuteMessage(#[from] WorkerProtocolError),
    #[error("worker dispatch message must be execute, got {actual}")]
    UnexpectedMessageType { actual: String },
    #[error("worker dispatch spawn failed: {0}")]
    Spawn(#[source] Box<dyn Error + Send + Sync>),
    #[error("worker dispatch execute send failed: {0}")]
    SendExecute(#[source] Box<dyn Error + Send + Sync>),
}

pub type WorkerDispatchExecutionResult<T> = Result<T, WorkerDispatchExecutionError>;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentWorkerProcessDispatchSpawner;

impl WorkerDispatchSpawner for AgentWorkerProcessDispatchSpawner {
    type Session = AgentWorkerProcess;
    type Error = WorkerProcessError;

    fn spawn_worker(
        &mut self,
        command: &AgentWorkerCommand,
        config: &AgentWorkerProcessConfig,
    ) -> Result<BootedWorkerDispatch<Self::Session>, Self::Error> {
        let booted = AgentWorkerProcess::spawn(command, config)?;

        Ok(BootedWorkerDispatch {
            ready: booted.ready,
            session: booted.process,
        })
    }
}

impl WorkerDispatchSession for AgentWorkerProcess {
    type Error = WorkerProcessError;

    fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error> {
        self.send_message(message)
    }

    fn is_worker_pipe_closed_error(error: &Self::Error) -> bool {
        error.is_worker_input_closed()
    }
}

pub fn start_worker_dispatch<S>(
    spawner: &mut S,
    config: &AgentWorkerProcessConfig,
    plan: &WorkerDispatchSpawnPlan,
) -> WorkerDispatchExecutionResult<StartedWorkerDispatch<S::Session>>
where
    S: WorkerDispatchSpawner,
{
    validate_worker_dispatch_execute_message(&plan.execute_message)?;

    let BootedWorkerDispatch { ready, mut session } =
        spawner
            .spawn_worker(&plan.command, config)
            .map_err(|error| WorkerDispatchExecutionError::Spawn(Box::new(error)))?;

    session
        .send_worker_message(&plan.execute_message)
        .map_err(|error| WorkerDispatchExecutionError::SendExecute(Box::new(error)))?;

    Ok(StartedWorkerDispatch { ready, session })
}

pub fn validate_worker_dispatch_execute_message(
    message: &Value,
) -> WorkerDispatchExecutionResult<()> {
    validate_agent_worker_protocol_message(message)?;

    let message_type = message
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("<missing>");

    if message_type != "execute" {
        return Err(WorkerDispatchExecutionError::UnexpectedMessageType {
            actual: message_type.to_string(),
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_dispatch_spawn::WorkerDispatchSpawnPlan;
    use crate::worker_process::AgentWorkerCommand;
    use crate::worker_protocol::{
        AGENT_WORKER_MAX_FRAME_BYTES, AGENT_WORKER_PROTOCOL_ENCODING,
        AGENT_WORKER_PROTOCOL_VERSION, AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
        AGENT_WORKER_STREAM_BATCH_MS, WorkerProtocolConfig,
    };
    use serde_json::json;
    use std::fmt;
    use std::time::Duration;

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
    fn worker_dispatch_execution_spawns_planned_command_and_sends_execute() {
        let plan = spawn_plan();
        let config = AgentWorkerProcessConfig {
            boot_timeout: Duration::from_millis(250),
        };
        let mut spawner = recording_spawner(None, None);

        let started =
            start_worker_dispatch(&mut spawner, &config, &plan).expect("dispatch must start");

        assert_eq!(
            spawner.spawn_calls,
            vec![(plan.command.clone(), config.clone())]
        );
        assert_eq!(started.ready, ready_message());
        assert_eq!(started.session.messages, vec![plan.execute_message]);
    }

    #[test]
    fn worker_dispatch_execution_rejects_non_execute_before_spawning() {
        let mut plan = spawn_plan();
        plan.execute_message = json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "ping",
            "correlationId": "correlation-a",
            "sequence": 3,
            "timestamp": 1710000700000_u64,
            "timeoutMs": 5_000_u64,
        });
        let mut spawner = recording_spawner(None, None);

        let error =
            start_worker_dispatch(&mut spawner, &AgentWorkerProcessConfig::default(), &plan)
                .expect_err("non-execute message must be rejected");

        match error {
            WorkerDispatchExecutionError::UnexpectedMessageType { actual } => {
                assert_eq!(actual, "ping");
            }
            other => panic!("expected unexpected message type, got {other:?}"),
        }
        assert!(spawner.spawn_calls.is_empty());
    }

    #[test]
    fn worker_dispatch_execution_rejects_invalid_execute_before_spawning() {
        let mut plan = spawn_plan();
        plan.execute_message = json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "execute",
            "correlationId": "correlation-a",
            "sequence": 3,
            "timestamp": 1710000700000_u64,
        });
        let mut spawner = recording_spawner(None, None);

        let error =
            start_worker_dispatch(&mut spawner, &AgentWorkerProcessConfig::default(), &plan)
                .expect_err("malformed execute must be rejected");

        assert!(matches!(
            error,
            WorkerDispatchExecutionError::InvalidExecuteMessage(WorkerProtocolError::MissingField(
                "projectId"
            ))
        ));
        assert!(spawner.spawn_calls.is_empty());
    }

    #[test]
    fn worker_dispatch_execution_returns_spawn_error_without_send() {
        let plan = spawn_plan();
        let mut spawner = recording_spawner(Some(FakeWorkerError("spawn failed")), None);

        let error =
            start_worker_dispatch(&mut spawner, &AgentWorkerProcessConfig::default(), &plan)
                .expect_err("spawn error must propagate");

        match error {
            WorkerDispatchExecutionError::Spawn(source) => {
                assert_eq!(source.to_string(), "spawn failed");
            }
            other => panic!("expected spawn error, got {other:?}"),
        }
        assert_eq!(spawner.spawn_calls.len(), 1);
    }

    #[test]
    fn worker_dispatch_execution_returns_send_error_after_spawn() {
        let plan = spawn_plan();
        let mut spawner = recording_spawner(None, Some(FakeWorkerError("send failed")));

        let error =
            start_worker_dispatch(&mut spawner, &AgentWorkerProcessConfig::default(), &plan)
                .expect_err("send error must propagate");

        match error {
            WorkerDispatchExecutionError::SendExecute(source) => {
                assert_eq!(source.to_string(), "send failed");
            }
            other => panic!("expected send error, got {other:?}"),
        }
        assert_eq!(spawner.spawn_calls.len(), 1);
    }

    fn spawn_plan() -> WorkerDispatchSpawnPlan {
        WorkerDispatchSpawnPlan {
            command: AgentWorkerCommand::new("bun")
                .arg("run")
                .arg("src/agents/execution/worker/agent-worker.ts")
                .current_dir("/repo")
                .env("TENEX_AGENT_WORKER_ENGINE", "agent"),
            execute_message: execute_message(),
        }
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
}
