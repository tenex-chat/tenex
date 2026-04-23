use std::collections::BTreeMap;

use thiserror::Error;

use crate::ral_journal::RalJournalIdentity;
use crate::worker_abort::{WorkerAbortDecisionInput, WorkerAbortProcessStatus, WorkerAbortSignal};
use crate::worker_concurrency::{
    ActiveDispatchConcurrencySnapshot, ActiveWorkerConcurrencySnapshot,
};
use crate::worker_heartbeat::WorkerHeartbeatSnapshot;
use crate::worker_process::AgentWorkerReady;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerRuntimeStartedDispatch {
    pub worker_id: String,
    pub pid: u64,
    pub dispatch_id: String,
    pub identity: RalJournalIdentity,
    pub claim_token: String,
    pub started_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveWorkerRuntimeSnapshot {
    pub worker_id: String,
    pub pid: u64,
    pub dispatch_id: String,
    pub identity: RalJournalIdentity,
    pub claim_token: String,
    pub started_at: u64,
    pub last_heartbeat: Option<WorkerHeartbeatSnapshot>,
    pub graceful_signal: Option<WorkerRuntimeGracefulSignal>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerRuntimeGracefulSignal {
    pub signal: WorkerAbortSignal,
    pub sent_at: u64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerRuntimeAbortDecisionContext {
    pub process_status: WorkerAbortProcessStatus,
    pub signal: WorkerAbortSignal,
    pub reason: String,
    pub now: u64,
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkerRuntimeState {
    workers: BTreeMap<String, ActiveWorkerRuntimeSnapshot>,
    dispatch_to_worker: BTreeMap<String, String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkerRuntimeStateError {
    #[error("worker {worker_id} is already active")]
    DuplicateWorker { worker_id: String },
    #[error("dispatch {dispatch_id} is already active on worker {worker_id}")]
    DuplicateDispatch {
        dispatch_id: String,
        worker_id: String,
    },
    #[error("worker {worker_id} is not active")]
    UnknownWorker { worker_id: String },
    #[error("dispatch {dispatch_id} is not active")]
    UnknownDispatch { dispatch_id: String },
    #[error("heartbeat worker {actual} does not match expected worker {expected}")]
    HeartbeatWorkerMismatch { expected: String, actual: String },
    #[error("heartbeat identity does not match worker runtime identity for worker {worker_id}")]
    HeartbeatIdentityMismatch {
        worker_id: String,
        expected: Box<RalJournalIdentity>,
        actual: Box<RalJournalIdentity>,
    },
    #[error("worker {worker_id} has no heartbeat snapshot")]
    MissingHeartbeat { worker_id: String },
}

pub type WorkerRuntimeStateResult<T> = Result<T, WorkerRuntimeStateError>;

impl WorkerRuntimeStartedDispatch {
    pub fn from_ready(
        ready: &AgentWorkerReady,
        dispatch_id: impl Into<String>,
        identity: RalJournalIdentity,
        claim_token: impl Into<String>,
        started_at: u64,
    ) -> Self {
        Self {
            worker_id: ready.worker_id.clone(),
            pid: ready.pid,
            dispatch_id: dispatch_id.into(),
            identity,
            claim_token: claim_token.into(),
            started_at,
        }
    }
}

impl WorkerRuntimeState {
    pub fn len(&self) -> usize {
        self.workers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.workers.is_empty()
    }

    pub fn workers(&self) -> impl Iterator<Item = &ActiveWorkerRuntimeSnapshot> {
        self.workers.values()
    }

    pub fn get_worker(&self, worker_id: &str) -> Option<&ActiveWorkerRuntimeSnapshot> {
        self.workers.get(worker_id)
    }

    pub fn get_worker_by_dispatch(
        &self,
        dispatch_id: &str,
    ) -> Option<&ActiveWorkerRuntimeSnapshot> {
        self.dispatch_to_worker
            .get(dispatch_id)
            .and_then(|worker_id| self.workers.get(worker_id))
    }

    pub fn register_started_dispatch(
        &mut self,
        started: WorkerRuntimeStartedDispatch,
    ) -> WorkerRuntimeStateResult<()> {
        if self.workers.contains_key(&started.worker_id) {
            return Err(WorkerRuntimeStateError::DuplicateWorker {
                worker_id: started.worker_id,
            });
        }

        if let Some(worker_id) = self.dispatch_to_worker.get(&started.dispatch_id) {
            return Err(WorkerRuntimeStateError::DuplicateDispatch {
                dispatch_id: started.dispatch_id,
                worker_id: worker_id.clone(),
            });
        }

        let worker_id = started.worker_id.clone();
        let dispatch_id = started.dispatch_id.clone();
        self.workers.insert(
            worker_id.clone(),
            ActiveWorkerRuntimeSnapshot {
                worker_id: started.worker_id,
                pid: started.pid,
                dispatch_id: started.dispatch_id,
                identity: started.identity,
                claim_token: started.claim_token,
                started_at: started.started_at,
                last_heartbeat: None,
                graceful_signal: None,
            },
        );
        self.dispatch_to_worker.insert(dispatch_id, worker_id);
        Ok(())
    }

    pub fn update_worker_heartbeat(
        &mut self,
        worker_id: &str,
        heartbeat: WorkerHeartbeatSnapshot,
    ) -> WorkerRuntimeStateResult<()> {
        let worker = self.workers.get_mut(worker_id).ok_or_else(|| {
            WorkerRuntimeStateError::UnknownWorker {
                worker_id: worker_id.to_string(),
            }
        })?;

        if heartbeat.worker_id != worker.worker_id {
            return Err(WorkerRuntimeStateError::HeartbeatWorkerMismatch {
                expected: worker.worker_id.clone(),
                actual: heartbeat.worker_id,
            });
        }

        if heartbeat.identity != worker.identity {
            return Err(WorkerRuntimeStateError::HeartbeatIdentityMismatch {
                worker_id: worker.worker_id.clone(),
                expected: Box::new(worker.identity.clone()),
                actual: Box::new(heartbeat.identity),
            });
        }

        worker.last_heartbeat = Some(heartbeat);
        Ok(())
    }

    pub fn mark_graceful_signal_sent(
        &mut self,
        worker_id: &str,
        graceful_signal: WorkerRuntimeGracefulSignal,
    ) -> WorkerRuntimeStateResult<()> {
        let worker = self.workers.get_mut(worker_id).ok_or_else(|| {
            WorkerRuntimeStateError::UnknownWorker {
                worker_id: worker_id.to_string(),
            }
        })?;
        worker.graceful_signal = Some(graceful_signal);
        Ok(())
    }

    pub fn remove_terminal_worker(
        &mut self,
        worker_id: &str,
    ) -> WorkerRuntimeStateResult<ActiveWorkerRuntimeSnapshot> {
        let worker = self.workers.remove(worker_id).ok_or_else(|| {
            WorkerRuntimeStateError::UnknownWorker {
                worker_id: worker_id.to_string(),
            }
        })?;
        self.dispatch_to_worker.remove(&worker.dispatch_id);
        Ok(worker)
    }

    pub fn remove_terminal_dispatch(
        &mut self,
        dispatch_id: &str,
    ) -> WorkerRuntimeStateResult<ActiveWorkerRuntimeSnapshot> {
        let worker_id = self
            .dispatch_to_worker
            .get(dispatch_id)
            .cloned()
            .ok_or_else(|| WorkerRuntimeStateError::UnknownDispatch {
                dispatch_id: dispatch_id.to_string(),
            })?;
        self.remove_terminal_worker(&worker_id)
    }

    pub fn agent_pubkeys_for_conversation(
        &self,
        project_id: &str,
        conversation_id: &str,
    ) -> Vec<String> {
        let mut seen = std::collections::BTreeSet::new();
        self.workers
            .values()
            .filter(|worker| {
                worker.identity.project_id == project_id
                    && worker.identity.conversation_id == conversation_id
            })
            .filter_map(|worker| {
                if seen.insert(worker.identity.agent_pubkey.clone()) {
                    Some(worker.identity.agent_pubkey.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    pub fn to_active_worker_concurrency_snapshots(&self) -> Vec<ActiveWorkerConcurrencySnapshot> {
        self.workers
            .values()
            .map(ActiveWorkerRuntimeSnapshot::to_active_worker_concurrency_snapshot)
            .collect()
    }

    pub fn to_active_dispatch_concurrency_snapshots(
        &self,
    ) -> Vec<ActiveDispatchConcurrencySnapshot> {
        self.workers
            .values()
            .map(ActiveWorkerRuntimeSnapshot::to_active_dispatch_concurrency_snapshot)
            .collect()
    }

    pub fn to_abort_decision_input<'a>(
        &'a self,
        worker_id: &str,
        context: WorkerRuntimeAbortDecisionContext,
    ) -> WorkerRuntimeStateResult<WorkerAbortDecisionInput<'a>> {
        let worker =
            self.workers
                .get(worker_id)
                .ok_or_else(|| WorkerRuntimeStateError::UnknownWorker {
                    worker_id: worker_id.to_string(),
                })?;
        worker.to_abort_decision_input(context)
    }
}

impl ActiveWorkerRuntimeSnapshot {
    pub fn to_active_worker_concurrency_snapshot(&self) -> ActiveWorkerConcurrencySnapshot {
        ActiveWorkerConcurrencySnapshot {
            worker_id: self.worker_id.clone(),
            dispatch_id: Some(self.dispatch_id.clone()),
            project_id: self.identity.project_id.clone(),
            agent_pubkey: self.identity.agent_pubkey.clone(),
        }
    }

    pub fn to_active_dispatch_concurrency_snapshot(&self) -> ActiveDispatchConcurrencySnapshot {
        ActiveDispatchConcurrencySnapshot {
            dispatch_id: self.dispatch_id.clone(),
            project_id: self.identity.project_id.clone(),
            agent_pubkey: self.identity.agent_pubkey.clone(),
        }
    }

    pub fn to_abort_decision_input(
        &self,
        context: WorkerRuntimeAbortDecisionContext,
    ) -> WorkerRuntimeStateResult<WorkerAbortDecisionInput<'_>> {
        let heartbeat = self.last_heartbeat.as_ref().ok_or_else(|| {
            WorkerRuntimeStateError::MissingHeartbeat {
                worker_id: self.worker_id.clone(),
            }
        })?;
        let signal = self
            .graceful_signal
            .as_ref()
            .map(|graceful_signal| graceful_signal.signal)
            .unwrap_or(context.signal);
        let reason = self
            .graceful_signal
            .as_ref()
            .map(|graceful_signal| graceful_signal.reason.clone())
            .unwrap_or(context.reason);

        Ok(WorkerAbortDecisionInput {
            worker_id: self.worker_id.clone(),
            identity: self.identity.clone(),
            heartbeat,
            process_status: context.process_status,
            signal,
            graceful_signal_sent_at: self
                .graceful_signal
                .as_ref()
                .map(|graceful_signal| graceful_signal.sent_at),
            reason,
            now: context.now,
            sequence: context.sequence,
            timestamp: context.timestamp,
            correlation_id: context.correlation_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_heartbeat::WorkerHeartbeatState;
    use crate::worker_protocol::{
        AGENT_WORKER_MAX_FRAME_BYTES, AGENT_WORKER_PROTOCOL_ENCODING,
        AGENT_WORKER_PROTOCOL_VERSION, AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
        AGENT_WORKER_STREAM_BATCH_MS, WorkerProtocolConfig,
    };
    use serde_json::json;

    #[test]
    fn registers_updates_marks_and_removes_active_worker() {
        let mut state = WorkerRuntimeState::default();
        let started = started_dispatch("worker-a", "dispatch-a", identity("project-a", "agent-a"));

        state
            .register_started_dispatch(started.clone())
            .expect("started dispatch must register");

        assert_eq!(state.len(), 1);
        assert_eq!(
            state
                .get_worker("worker-a")
                .expect("worker must exist")
                .worker_id,
            "worker-a"
        );
        assert_eq!(
            state
                .get_worker_by_dispatch("dispatch-a")
                .expect("dispatch index must resolve")
                .dispatch_id,
            "dispatch-a"
        );

        let heartbeat = heartbeat("worker-a", started.identity.clone(), 20);
        state
            .update_worker_heartbeat("worker-a", heartbeat.clone())
            .expect("heartbeat must update");
        state
            .mark_graceful_signal_sent(
                "worker-a",
                WorkerRuntimeGracefulSignal {
                    signal: WorkerAbortSignal::Abort,
                    sent_at: 2_000,
                    reason: "heartbeat missed".to_string(),
                },
            )
            .expect("graceful marker must update");

        let worker = state.get_worker("worker-a").expect("worker must exist");
        assert_eq!(worker.last_heartbeat, Some(heartbeat));
        assert_eq!(
            worker.graceful_signal,
            Some(WorkerRuntimeGracefulSignal {
                signal: WorkerAbortSignal::Abort,
                sent_at: 2_000,
                reason: "heartbeat missed".to_string(),
            })
        );

        let removed = state
            .remove_terminal_worker("worker-a")
            .expect("terminal worker must remove");
        assert_eq!(removed.worker_id, "worker-a");
        assert!(state.is_empty());
        assert!(state.get_worker_by_dispatch("dispatch-a").is_none());
    }

    #[test]
    fn rejects_duplicate_worker_and_duplicate_dispatch_without_mutating_registry() {
        let mut state = WorkerRuntimeState::default();
        state
            .register_started_dispatch(started_dispatch(
                "worker-a",
                "dispatch-a",
                identity("project-a", "agent-a"),
            ))
            .expect("initial worker must register");

        assert_eq!(
            state.register_started_dispatch(started_dispatch(
                "worker-a",
                "dispatch-b",
                identity("project-a", "agent-a"),
            )),
            Err(WorkerRuntimeStateError::DuplicateWorker {
                worker_id: "worker-a".to_string()
            })
        );
        assert_eq!(
            state.register_started_dispatch(started_dispatch(
                "worker-b",
                "dispatch-a",
                identity("project-a", "agent-a"),
            )),
            Err(WorkerRuntimeStateError::DuplicateDispatch {
                dispatch_id: "dispatch-a".to_string(),
                worker_id: "worker-a".to_string(),
            })
        );

        assert_eq!(state.len(), 1);
        assert!(state.get_worker("worker-a").is_some());
        assert!(state.get_worker("worker-b").is_none());
        assert!(state.get_worker_by_dispatch("dispatch-a").is_some());
        assert!(state.get_worker_by_dispatch("dispatch-b").is_none());
    }

    #[test]
    fn validates_heartbeat_worker_and_identity_before_updating() {
        let mut state = WorkerRuntimeState::default();
        let expected_identity = identity("project-a", "agent-a");
        state
            .register_started_dispatch(started_dispatch(
                "worker-a",
                "dispatch-a",
                expected_identity.clone(),
            ))
            .expect("initial worker must register");

        assert_eq!(
            state.update_worker_heartbeat(
                "worker-a",
                heartbeat("worker-b", expected_identity.clone(), 20)
            ),
            Err(WorkerRuntimeStateError::HeartbeatWorkerMismatch {
                expected: "worker-a".to_string(),
                actual: "worker-b".to_string(),
            })
        );
        assert_eq!(
            state
                .get_worker("worker-a")
                .expect("worker must exist")
                .last_heartbeat,
            None
        );

        let actual_identity = identity("project-b", "agent-a");
        assert_eq!(
            state.update_worker_heartbeat(
                "worker-a",
                heartbeat("worker-a", actual_identity.clone(), 21)
            ),
            Err(WorkerRuntimeStateError::HeartbeatIdentityMismatch {
                worker_id: "worker-a".to_string(),
                expected: Box::new(expected_identity.clone()),
                actual: Box::new(actual_identity),
            })
        );
        assert_eq!(
            state
                .get_worker("worker-a")
                .expect("worker must exist")
                .last_heartbeat,
            None
        );

        state
            .update_worker_heartbeat("worker-a", heartbeat("worker-a", expected_identity, 22))
            .expect("matching heartbeat must update");
        assert_eq!(
            state
                .get_worker("worker-a")
                .expect("worker must exist")
                .last_heartbeat
                .as_ref()
                .expect("heartbeat must be present")
                .sequence,
            22
        );
    }

    #[test]
    fn converts_active_workers_to_concurrency_snapshots() {
        let mut state = WorkerRuntimeState::default();
        state
            .register_started_dispatch(started_dispatch(
                "worker-a",
                "dispatch-a",
                identity("project-a", "agent-a"),
            ))
            .expect("worker a must register");
        state
            .register_started_dispatch(started_dispatch(
                "worker-b",
                "dispatch-b",
                identity("project-b", "agent-b"),
            ))
            .expect("worker b must register");

        assert_eq!(
            state.to_active_worker_concurrency_snapshots(),
            vec![
                ActiveWorkerConcurrencySnapshot {
                    worker_id: "worker-a".to_string(),
                    dispatch_id: Some("dispatch-a".to_string()),
                    project_id: "project-a".to_string(),
                    agent_pubkey: "agent-a".to_string(),
                },
                ActiveWorkerConcurrencySnapshot {
                    worker_id: "worker-b".to_string(),
                    dispatch_id: Some("dispatch-b".to_string()),
                    project_id: "project-b".to_string(),
                    agent_pubkey: "agent-b".to_string(),
                },
            ]
        );
        assert_eq!(
            state.to_active_dispatch_concurrency_snapshots(),
            vec![
                ActiveDispatchConcurrencySnapshot {
                    dispatch_id: "dispatch-a".to_string(),
                    project_id: "project-a".to_string(),
                    agent_pubkey: "agent-a".to_string(),
                },
                ActiveDispatchConcurrencySnapshot {
                    dispatch_id: "dispatch-b".to_string(),
                    project_id: "project-b".to_string(),
                    agent_pubkey: "agent-b".to_string(),
                },
            ]
        );
    }

    #[test]
    fn builds_abort_input_from_latest_heartbeat_and_graceful_marker() {
        let mut state = WorkerRuntimeState::default();
        let worker_identity = identity("project-a", "agent-a");
        state
            .register_started_dispatch(started_dispatch(
                "worker-a",
                "dispatch-a",
                worker_identity.clone(),
            ))
            .expect("worker must register");

        assert_eq!(
            state.to_abort_decision_input("worker-a", abort_context()),
            Err(WorkerRuntimeStateError::MissingHeartbeat {
                worker_id: "worker-a".to_string()
            })
        );

        let heartbeat = heartbeat("worker-a", worker_identity.clone(), 20);
        state
            .update_worker_heartbeat("worker-a", heartbeat.clone())
            .expect("heartbeat must update");
        state
            .mark_graceful_signal_sent(
                "worker-a",
                WorkerRuntimeGracefulSignal {
                    signal: WorkerAbortSignal::Shutdown,
                    sent_at: 1_900,
                    reason: "shutdown requested".to_string(),
                },
            )
            .expect("graceful marker must update");

        let input = state
            .to_abort_decision_input("worker-a", abort_context())
            .expect("abort input must build");
        assert_eq!(input.worker_id, "worker-a");
        assert_eq!(input.identity, worker_identity);
        assert_eq!(input.heartbeat, &heartbeat);
        assert_eq!(input.process_status, WorkerAbortProcessStatus::Running);
        assert_eq!(input.signal, WorkerAbortSignal::Shutdown);
        assert_eq!(input.graceful_signal_sent_at, Some(1_900));
        assert_eq!(input.reason, "shutdown requested");
        assert_eq!(input.now, 2_500);
        assert_eq!(input.sequence, 44);
        assert_eq!(input.timestamp, 2_501);
        assert_eq!(input.correlation_id, "abort-correlation");
    }

    #[test]
    fn builds_started_dispatch_from_ready_message() {
        let ready = AgentWorkerReady {
            worker_id: "worker-ready".to_string(),
            pid: 12_345,
            protocol: WorkerProtocolConfig {
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
            },
            message: json!({"type": "ready"}),
        };
        let worker_identity = identity("project-a", "agent-a");

        assert_eq!(
            WorkerRuntimeStartedDispatch::from_ready(
                &ready,
                "dispatch-ready",
                worker_identity.clone(),
                "claim-ready",
                10_000
            ),
            WorkerRuntimeStartedDispatch {
                worker_id: "worker-ready".to_string(),
                pid: 12_345,
                dispatch_id: "dispatch-ready".to_string(),
                identity: worker_identity,
                claim_token: "claim-ready".to_string(),
                started_at: 10_000,
            }
        );
    }

    #[test]
    fn agent_pubkeys_for_conversation_filters_by_project_and_conversation() {
        let mut state = WorkerRuntimeState::default();

        let workers = [
            (
                "worker-a",
                "dispatch-a",
                "project-a",
                "agent-a",
                "conversation-x",
            ),
            (
                "worker-b",
                "dispatch-b",
                "project-a",
                "agent-b",
                "conversation-x",
            ),
            (
                "worker-c",
                "dispatch-c",
                "project-a",
                "agent-c",
                "conversation-y",
            ),
            (
                "worker-d",
                "dispatch-d",
                "project-b",
                "agent-d",
                "conversation-x",
            ),
        ];

        for (worker_id, dispatch_id, project_id, agent_pubkey, conversation_id) in workers {
            let identity = RalJournalIdentity {
                project_id: project_id.to_string(),
                agent_pubkey: agent_pubkey.to_string(),
                conversation_id: conversation_id.to_string(),
                ral_number: 1,
            };
            state
                .register_started_dispatch(started_dispatch(worker_id, dispatch_id, identity))
                .expect("worker must register");
        }

        assert_eq!(
            state.agent_pubkeys_for_conversation("project-a", "conversation-x"),
            vec!["agent-a".to_string(), "agent-b".to_string()]
        );
        assert_eq!(
            state.agent_pubkeys_for_conversation("project-a", "conversation-y"),
            vec!["agent-c".to_string()]
        );
        assert_eq!(
            state.agent_pubkeys_for_conversation("project-b", "conversation-x"),
            vec!["agent-d".to_string()]
        );
        assert!(
            state
                .agent_pubkeys_for_conversation("project-a", "conversation-unknown")
                .is_empty()
        );
    }

    fn started_dispatch(
        worker_id: &str,
        dispatch_id: &str,
        identity: RalJournalIdentity,
    ) -> WorkerRuntimeStartedDispatch {
        WorkerRuntimeStartedDispatch {
            worker_id: worker_id.to_string(),
            pid: 10_000,
            dispatch_id: dispatch_id.to_string(),
            identity,
            claim_token: format!("claim-{dispatch_id}"),
            started_at: 1_000,
        }
    }

    fn heartbeat(
        worker_id: &str,
        identity: RalJournalIdentity,
        sequence: u64,
    ) -> WorkerHeartbeatSnapshot {
        WorkerHeartbeatSnapshot {
            worker_id: worker_id.to_string(),
            correlation_id: "heartbeat-correlation".to_string(),
            sequence,
            worker_timestamp: 1_234,
            observed_at: 1_235,
            identity,
            state: WorkerHeartbeatState::Streaming,
            active_tool_count: 1,
            accumulated_runtime_ms: 500,
        }
    }

    fn identity(project_id: &str, agent_pubkey: &str) -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: project_id.to_string(),
            agent_pubkey: agent_pubkey.to_string(),
            conversation_id: "conversation-a".to_string(),
            ral_number: 3,
        }
    }

    fn abort_context() -> WorkerRuntimeAbortDecisionContext {
        WorkerRuntimeAbortDecisionContext {
            process_status: WorkerAbortProcessStatus::Running,
            signal: WorkerAbortSignal::Abort,
            reason: "heartbeat missed".to_string(),
            now: 2_500,
            sequence: 44,
            timestamp: 2_501,
            correlation_id: "abort-correlation".to_string(),
        }
    }
}
