use std::path::Path;

use thiserror::Error;

use crate::dispatch_queue::{DispatchQueueError, replay_dispatch_queue};
use crate::ral_lock::RalLockInfo;
use crate::worker_concurrency::WorkerConcurrencyLimits;
use crate::worker_dispatch_admission_start::{
    WorkerDispatchAdmissionStartError, WorkerDispatchAdmissionStartInput,
    WorkerDispatchAdmissionStartOutcome, WorkerDispatchLaunchInputSource,
    apply_worker_dispatch_admission_start,
};
use crate::worker_dispatch_execution::WorkerDispatchSpawner;
use crate::worker_process::{AgentWorkerCommand, AgentWorkerProcessConfig};
use crate::worker_runtime_state::WorkerRuntimeState;

#[derive(Debug)]
pub struct WorkerDispatchTickInput<'a> {
    pub daemon_dir: &'a Path,
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

#[derive(Debug, Error)]
pub enum WorkerDispatchTickError<S> {
    #[error("worker dispatch queue replay failed: {source}")]
    DispatchQueueReplay { source: Box<DispatchQueueError> },
    #[error("worker dispatch admission/start failed: {source}")]
    AdmissionStart {
        source: Box<WorkerDispatchAdmissionStartError<S>>,
    },
}

pub fn apply_worker_dispatch_tick<S>(
    spawner: &mut S,
    input: WorkerDispatchTickInput<'_>,
) -> Result<WorkerDispatchAdmissionStartOutcome<S::Session>, WorkerDispatchTickError<S::Session>>
where
    S: WorkerDispatchSpawner,
{
    let dispatch_state = replay_dispatch_queue(input.daemon_dir)?;

    apply_worker_dispatch_admission_start(
        spawner,
        WorkerDispatchAdmissionStartInput {
            daemon_dir: input.daemon_dir,
            dispatch_state: &dispatch_state,
            runtime_state: input.runtime_state,
            limits: input.limits,
            lease_sequence: input.lease_sequence,
            lease_timestamp: input.lease_timestamp,
            lease_correlation_id: input.lease_correlation_id,
            execute_sequence: input.execute_sequence,
            execute_timestamp: input.execute_timestamp,
            launch_input: input.launch_input,
            lock_owner: input.lock_owner,
            command: input.command,
            worker_config: input.worker_config,
            started_at: input.started_at,
        },
    )
    .map_err(Into::into)
}

impl<S> From<DispatchQueueError> for WorkerDispatchTickError<S> {
    fn from(source: DispatchQueueError) -> Self {
        Self::DispatchQueueReplay {
            source: Box::new(source),
        }
    }
}

impl<S> From<WorkerDispatchAdmissionStartError<S>> for WorkerDispatchTickError<S> {
    fn from(source: WorkerDispatchAdmissionStartError<S>) -> Self {
        Self::AdmissionStart {
            source: Box::new(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecord, DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        append_dispatch_queue_record, build_dispatch_queue_record, replay_dispatch_queue,
    };
    use crate::scheduled_task_dispatch_input::{
        ScheduledTaskDispatchInput, ScheduledTaskDispatchTaskDiagnosticMetadata,
        ScheduledTaskDispatchTaskKind, write_create_or_compare_equal,
    };
    use crate::worker_dispatch_admission_start::WorkerDispatchExplicitLaunchInput;
    use crate::worker_dispatch_execution::{
        BootedWorkerDispatch, WorkerDispatchSession, WorkerDispatchSpawner,
    };
    use crate::worker_process::{AgentWorkerCommand, AgentWorkerReady};
    use crate::worker_protocol::{
        AGENT_WORKER_MAX_FRAME_BYTES, AGENT_WORKER_PROTOCOL_ENCODING,
        AGENT_WORKER_PROTOCOL_VERSION, AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
        AGENT_WORKER_STREAM_BATCH_MS, WorkerProtocolConfig,
    };
    use serde_json::{Value, json};
    use std::error::Error;
    use std::fmt;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

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
    fn worker_dispatch_tick_replays_the_queue_and_starts_an_admitted_dispatch() {
        let daemon_dir = unique_temp_daemon_dir();
        let queued = dispatch_record(1, DispatchQueueStatus::Queued);
        append_dispatch_queue_record(&daemon_dir, &queued).expect("queued record must append");
        let mut runtime_state = WorkerRuntimeState::default();
        let mut spawner = recording_spawner(ready_message("worker-a"), None, None);

        let outcome = apply_worker_dispatch_tick(
            &mut spawner,
            tick_input(
                &daemon_dir,
                &mut runtime_state,
                worker_command(),
                &worker_config(),
            ),
        )
        .expect("tick must admit and start");

        let started = match outcome {
            WorkerDispatchAdmissionStartOutcome::Started(started) => *started,
            other => panic!("expected started dispatch, got {other:?}"),
        };
        assert_eq!(spawner.spawn_calls.len(), 1);
        assert_eq!(
            started.started.dispatch.session.messages,
            vec![started.context.launch_plan.execute_message.clone()]
        );
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
        cleanup_temp_dir(&daemon_dir);
    }

    #[test]
    fn worker_dispatch_tick_uses_filesystem_sidecar_launch_input() {
        let daemon_dir = unique_temp_daemon_dir();
        let queued = dispatch_record(1, DispatchQueueStatus::Queued);
        append_dispatch_queue_record(&daemon_dir, &queued).expect("queued record must append");
        write_create_or_compare_equal(
            &daemon_dir,
            &scheduled_task_dispatch_input("dispatch-a", "event-a"),
        )
        .expect("sidecar input must write");
        let mut runtime_state = WorkerRuntimeState::default();
        let mut spawner = recording_spawner(ready_message("tick-sidecar-worker-a"), None, None);

        let outcome = apply_worker_dispatch_tick(
            &mut spawner,
            tick_input(
                &daemon_dir,
                &mut runtime_state,
                worker_command(),
                &worker_config(),
            ),
        )
        .expect("tick must admit and start from sidecar input");

        let started = match outcome {
            WorkerDispatchAdmissionStartOutcome::Started(started) => *started,
            other => panic!("expected started dispatch, got {other:?}"),
        };
        let execute = &started.context.launch_plan.execute_message;
        assert_eq!(execute["projectBasePath"], json!("/tick-sidecar/repo"));
        assert_eq!(
            execute["metadataPath"],
            json!("/tick-sidecar/repo/.tenex/project.json")
        );
        assert_eq!(
            execute["triggeringEnvelope"]["content"],
            json!("tick sidecar")
        );
        assert_eq!(execute["executionFlags"]["debug"], json!(true));
        assert_eq!(
            started.started.dispatch.session.messages,
            vec![execute.clone()]
        );
        assert_eq!(
            spawner.spawn_calls[0].0.env.get("TENEX_AGENT_WORKER_ID"),
            Some(&"tick-sidecar-worker-a".to_string())
        );
        cleanup_temp_dir(&daemon_dir);
    }

    #[test]
    fn worker_dispatch_tick_returns_not_admitted_when_no_dispatch_is_queued() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut runtime_state = WorkerRuntimeState::default();
        let mut spawner = recording_spawner(ready_message("worker-a"), None, None);

        let outcome = apply_worker_dispatch_tick(
            &mut spawner,
            tick_input(
                &daemon_dir,
                &mut runtime_state,
                worker_command(),
                &worker_config(),
            ),
        )
        .expect("empty queue is not an error");

        assert!(matches!(
            outcome,
            WorkerDispatchAdmissionStartOutcome::NotAdmitted {
                reason: crate::worker_dispatch_admission::WorkerDispatchAdmissionBlockedReason::NoQueuedDispatches,
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
        cleanup_temp_dir(&daemon_dir);
    }

    #[test]
    fn worker_dispatch_tick_preserves_partial_side_effect_context_on_spawn_failure() {
        let daemon_dir = unique_temp_daemon_dir();
        let queued = dispatch_record(1, DispatchQueueStatus::Queued);
        append_dispatch_queue_record(&daemon_dir, &queued).expect("queued record must append");
        let mut runtime_state = WorkerRuntimeState::default();
        let mut spawner = recording_spawner(
            ready_message("worker-a"),
            Some(FakeWorkerError("spawn failed")),
            None,
        );

        let error = apply_worker_dispatch_tick(
            &mut spawner,
            tick_input(
                &daemon_dir,
                &mut runtime_state,
                worker_command(),
                &worker_config(),
            ),
        )
        .expect_err("spawn failure must bubble through the tick");

        match error {
            WorkerDispatchTickError::AdmissionStart { source } => match *source {
                WorkerDispatchAdmissionStartError::DispatchStart { context, source } => {
                    assert_eq!(context.admission.leased_record.dispatch_id, "dispatch-a");
                    assert_eq!(
                        context.launch_plan.execute_message["type"],
                        json!("execute")
                    );
                    assert!(matches!(
                        *source,
                        crate::worker_dispatch_start::WorkerDispatchStartError::Dispatch(_)
                    ));
                }
                other => panic!("expected dispatch start error, got {other:?}"),
            },
            other => panic!("expected admission/start tick error, got {other:?}"),
        }
        assert_eq!(spawner.spawn_calls.len(), 1);
        let queue = replay_dispatch_queue(&daemon_dir).expect("queue must replay");
        assert_eq!(queue.queued.len(), 0);
        assert_eq!(queue.leased.len(), 1);
        cleanup_temp_dir(&daemon_dir);
    }

    fn tick_input<'a>(
        daemon_dir: &'a Path,
        runtime_state: &'a mut WorkerRuntimeState,
        command: AgentWorkerCommand,
        worker_config: &'a AgentWorkerProcessConfig,
    ) -> WorkerDispatchTickInput<'a> {
        WorkerDispatchTickInput {
            daemon_dir,
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
            lock_owner: crate::ral_lock::build_ral_lock_info(100, "host-a", 1_000),
            command,
            worker_config,
            started_at: 1_710_000_700_003,
        }
    }

    fn explicit_launch_input(triggering_event_id: &str) -> WorkerDispatchExplicitLaunchInput {
        WorkerDispatchExplicitLaunchInput {
            worker_id: None,
            project_base_path: "/repo".to_string(),
            metadata_path: "/metadata.json".to_string(),
            triggering_envelope: triggering_envelope(triggering_event_id),
            execution_flags: crate::worker_protocol::AgentWorkerExecutionFlags {
                is_delegation_completion: false,
                has_pending_delegations: false,
                pending_delegation_ids: Vec::new(),
                debug: false,
            },
        }
    }

    fn scheduled_task_dispatch_input(
        dispatch_id: &str,
        triggering_event_id: &str,
    ) -> ScheduledTaskDispatchInput {
        ScheduledTaskDispatchInput {
            dispatch_id: dispatch_id.to_string(),
            triggering_event_id: triggering_event_id.to_string(),
            worker_id: "tick-sidecar-worker-a".to_string(),
            project_base_path: "/tick-sidecar/repo".to_string(),
            metadata_path: "/tick-sidecar/repo/.tenex/project.json".to_string(),
            triggering_envelope: {
                let mut envelope = triggering_envelope(triggering_event_id);
                envelope["content"] = json!("tick sidecar");
                envelope
            },
            execution_flags: crate::worker_protocol::AgentWorkerExecutionFlags {
                is_delegation_completion: false,
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
                last_run: None,
            },
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

    fn worker_command() -> AgentWorkerCommand {
        AgentWorkerCommand::new("bun")
            .arg("run")
            .arg("src/agents/execution/worker/agent-worker.ts")
            .current_dir("/repo")
            .env("TENEX_AGENT_WORKER_ENGINE", "agent")
    }

    fn worker_config() -> AgentWorkerProcessConfig {
        AgentWorkerProcessConfig {
            boot_timeout: std::time::Duration::from_millis(250),
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
                "timestamp": 1710000700000_u64,
                "workerId": worker_id,
                "pid": 123_u64,
                "protocol": worker_protocol_config_json(),
            }),
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
            "metadata": {},
            "conversationId": "conversation-a",
            "agentPubkey": "a".repeat(64),
            "projectId": "project-a",
            "source": "nostr"
        })
    }

    fn unique_temp_daemon_dir() -> std::path::PathBuf {
        let suffix = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "tenex-daemon-worker-dispatch-tick-{}-{}",
            std::process::id(),
            suffix
        ))
    }

    fn cleanup_temp_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }
}
