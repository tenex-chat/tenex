use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::dispatch_queue::{DispatchQueueState, DispatchQueueStatus};
use crate::publish_outbox::{
    PublishOutboxDiagnostics, PublishOutboxFailureDiagnostic, PublishOutboxPendingDiagnostic,
};
use crate::ral_journal::RalJournalIdentity;
use crate::worker_heartbeat::{
    WorkerHeartbeatFreshness, WorkerHeartbeatFreshnessConfig, WorkerHeartbeatSnapshot,
    WorkerHeartbeatState, classify_worker_heartbeat_freshness,
};
use crate::worker_lifecycle::abort::WorkerAbortSignal;
use crate::worker_runtime_state::{
    ActiveWorkerRuntimeSnapshot, WorkerRuntimeGracefulSignal, WorkerRuntimeState,
};

pub const WORKER_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerDiagnosticsInput<'a> {
    pub inspected_at: u64,
    pub runtime_state: &'a WorkerRuntimeState,
    pub dispatch_queue: &'a DispatchQueueState,
    pub publish_outbox: &'a PublishOutboxDiagnostics,
    pub heartbeat_freshness: WorkerHeartbeatFreshnessConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDiagnosticsSnapshot {
    pub schema_version: u32,
    pub inspected_at: u64,
    pub active_workers: Vec<WorkerDiagnosticsActiveWorker>,
    pub dispatch_queue: WorkerDiagnosticsDispatchQueueSummary,
    pub concurrency: WorkerDiagnosticsConcurrencySummary,
    pub publish_outbox: WorkerDiagnosticsPublishOutboxSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDiagnosticsActiveWorker {
    pub worker_id: String,
    pub pid: u64,
    pub dispatch_id: String,
    pub identity: RalJournalIdentity,
    pub claim_token_present: bool,
    pub started_at: u64,
    pub graceful_signal: Option<WorkerDiagnosticsGracefulSignal>,
    pub heartbeat: Option<WorkerDiagnosticsHeartbeatSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDiagnosticsGracefulSignal {
    pub signal: WorkerDiagnosticsGracefulSignalKind,
    pub sent_at: u64,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerDiagnosticsGracefulSignalKind {
    Abort,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDiagnosticsHeartbeatSummary {
    pub correlation_id: String,
    pub sequence: u64,
    pub worker_timestamp: u64,
    pub observed_at: u64,
    pub state: WorkerDiagnosticsHeartbeatState,
    pub active_tool_count: u64,
    pub accumulated_runtime_ms: u64,
    pub freshness: WorkerDiagnosticsHeartbeatFreshnessSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerDiagnosticsHeartbeatState {
    Starting,
    Streaming,
    Acting,
    Waiting,
    Idle,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDiagnosticsHeartbeatFreshnessSummary {
    pub status: WorkerDiagnosticsHeartbeatFreshnessStatus,
    pub deadline_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missed_by_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerDiagnosticsHeartbeatFreshnessStatus {
    Fresh,
    Missed,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDiagnosticsDispatchQueueSummary {
    pub last_sequence: u64,
    pub queued_count: usize,
    pub leased_count: usize,
    pub terminal_count: usize,
    pub completed_count: usize,
    pub cancelled_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDiagnosticsConcurrencySummary {
    pub active_execution_count: u64,
    pub active_worker_count: u64,
    pub leased_dispatch_count: u64,
    pub projects: Vec<WorkerDiagnosticsProjectConcurrencySummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDiagnosticsProjectConcurrencySummary {
    pub project_id: String,
    pub active_count: u64,
    pub agents: Vec<WorkerDiagnosticsAgentConcurrencySummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDiagnosticsAgentConcurrencySummary {
    pub agent_pubkey: String,
    pub active_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDiagnosticsPublishOutboxSummary {
    pub schema_version: u32,
    pub inspected_at: u64,
    pub pending_count: usize,
    pub published_count: usize,
    pub failed_count: usize,
    pub retryable_failed_count: usize,
    pub retry_due_count: usize,
    pub permanent_failed_count: usize,
    pub tmp_file_count: usize,
    pub oldest_pending: Option<PublishOutboxPendingDiagnostic>,
    pub next_retry_at: Option<u64>,
    pub latest_failure: Option<PublishOutboxFailureDiagnostic>,
}

pub fn build_worker_diagnostics_snapshot(
    input: WorkerDiagnosticsInput<'_>,
) -> WorkerDiagnosticsSnapshot {
    WorkerDiagnosticsSnapshot {
        schema_version: WORKER_DIAGNOSTICS_SCHEMA_VERSION,
        inspected_at: input.inspected_at,
        active_workers: input
            .runtime_state
            .workers()
            .flat_map(|worker| {
                active_worker_diagnostics(worker, input.inspected_at, input.heartbeat_freshness)
            })
            .collect(),
        dispatch_queue: dispatch_queue_summary(input.dispatch_queue),
        concurrency: concurrency_summary(input.runtime_state, input.dispatch_queue),
        publish_outbox: publish_outbox_summary(input.publish_outbox),
    }
}

fn active_worker_diagnostics(
    worker: &ActiveWorkerRuntimeSnapshot,
    inspected_at: u64,
    heartbeat_freshness: WorkerHeartbeatFreshnessConfig,
) -> Vec<WorkerDiagnosticsActiveWorker> {
    worker
        .executions
        .iter()
        .map(|slot| WorkerDiagnosticsActiveWorker {
            worker_id: worker.worker_id.clone(),
            pid: worker.pid,
            dispatch_id: slot.dispatch_id.clone(),
            identity: slot.identity.clone(),
            claim_token_present: !slot.claim_token.is_empty(),
            started_at: slot.started_at,
            graceful_signal: worker
                .graceful_signal
                .as_ref()
                .map(graceful_signal_diagnostics),
            heartbeat: slot
                .last_heartbeat
                .as_ref()
                .map(|heartbeat| heartbeat_summary(heartbeat, inspected_at, heartbeat_freshness)),
        })
        .collect()
}

fn graceful_signal_diagnostics(
    graceful_signal: &WorkerRuntimeGracefulSignal,
) -> WorkerDiagnosticsGracefulSignal {
    WorkerDiagnosticsGracefulSignal {
        signal: graceful_signal.signal.into(),
        sent_at: graceful_signal.sent_at,
        reason: graceful_signal.reason.clone(),
    }
}

fn heartbeat_summary(
    snapshot: &WorkerHeartbeatSnapshot,
    inspected_at: u64,
    config: WorkerHeartbeatFreshnessConfig,
) -> WorkerDiagnosticsHeartbeatSummary {
    WorkerDiagnosticsHeartbeatSummary {
        correlation_id: snapshot.correlation_id.clone(),
        sequence: snapshot.sequence,
        worker_timestamp: snapshot.worker_timestamp,
        observed_at: snapshot.observed_at,
        state: snapshot.state.into(),
        active_tool_count: snapshot.active_tool_count,
        accumulated_runtime_ms: snapshot.accumulated_runtime_ms,
        freshness: classify_worker_heartbeat_freshness(snapshot, inspected_at, config).into(),
    }
}

fn dispatch_queue_summary(state: &DispatchQueueState) -> WorkerDiagnosticsDispatchQueueSummary {
    let completed_count = state
        .terminal
        .iter()
        .filter(|record| record.status == DispatchQueueStatus::Completed)
        .count();
    let cancelled_count = state
        .terminal
        .iter()
        .filter(|record| record.status == DispatchQueueStatus::Cancelled)
        .count();

    WorkerDiagnosticsDispatchQueueSummary {
        last_sequence: state.last_sequence,
        queued_count: state.queued.len(),
        leased_count: state.leased.len(),
        terminal_count: state.terminal.len(),
        completed_count,
        cancelled_count,
    }
}

fn concurrency_summary(
    runtime_state: &WorkerRuntimeState,
    dispatch_queue: &DispatchQueueState,
) -> WorkerDiagnosticsConcurrencySummary {
    let scopes = active_execution_scopes(runtime_state, dispatch_queue);
    let projects = project_concurrency_summaries(&scopes);

    WorkerDiagnosticsConcurrencySummary {
        active_execution_count: scopes.len() as u64,
        active_worker_count: runtime_state.len() as u64,
        leased_dispatch_count: dispatch_queue.leased.len() as u64,
        projects,
    }
}

fn active_execution_scopes(
    runtime_state: &WorkerRuntimeState,
    dispatch_queue: &DispatchQueueState,
) -> BTreeMap<String, ActiveExecutionScope> {
    let mut scopes = BTreeMap::<String, ActiveExecutionScope>::new();

    for dispatch in &dispatch_queue.leased {
        scopes.insert(
            dispatch.dispatch_id.clone(),
            ActiveExecutionScope {
                project_id: dispatch.ral.project_id.clone(),
                agent_pubkey: dispatch.ral.agent_pubkey.clone(),
            },
        );
    }

    for worker in runtime_state.workers() {
        for slot in &worker.executions {
            scopes.insert(
                slot.dispatch_id.clone(),
                ActiveExecutionScope {
                    project_id: slot.identity.project_id.clone(),
                    agent_pubkey: slot.identity.agent_pubkey.clone(),
                },
            );
        }
    }

    scopes
}

fn project_concurrency_summaries(
    scopes: &BTreeMap<String, ActiveExecutionScope>,
) -> Vec<WorkerDiagnosticsProjectConcurrencySummary> {
    let mut projects = BTreeMap::<String, BTreeMap<String, u64>>::new();

    for scope in scopes.values() {
        let agents = projects.entry(scope.project_id.clone()).or_default();
        *agents.entry(scope.agent_pubkey.clone()).or_default() += 1;
    }

    projects
        .into_iter()
        .map(|(project_id, agents)| {
            let agents: Vec<WorkerDiagnosticsAgentConcurrencySummary> = agents
                .into_iter()
                .map(
                    |(agent_pubkey, active_count)| WorkerDiagnosticsAgentConcurrencySummary {
                        agent_pubkey,
                        active_count,
                    },
                )
                .collect();
            let active_count = agents.iter().map(|agent| agent.active_count).sum();

            WorkerDiagnosticsProjectConcurrencySummary {
                project_id,
                active_count,
                agents,
            }
        })
        .collect()
}

fn publish_outbox_summary(
    diagnostics: &PublishOutboxDiagnostics,
) -> WorkerDiagnosticsPublishOutboxSummary {
    WorkerDiagnosticsPublishOutboxSummary {
        schema_version: diagnostics.schema_version,
        inspected_at: diagnostics.inspected_at,
        pending_count: diagnostics.pending_count,
        published_count: diagnostics.published_count,
        failed_count: diagnostics.failed_count,
        retryable_failed_count: diagnostics.retryable_failed_count,
        retry_due_count: diagnostics.retry_due_count,
        permanent_failed_count: diagnostics.permanent_failed_count,
        tmp_file_count: diagnostics.tmp_file_count,
        oldest_pending: diagnostics.oldest_pending.clone(),
        next_retry_at: diagnostics.next_retry_at,
        latest_failure: diagnostics.latest_failure.clone(),
    }
}

impl From<WorkerAbortSignal> for WorkerDiagnosticsGracefulSignalKind {
    fn from(signal: WorkerAbortSignal) -> Self {
        match signal {
            WorkerAbortSignal::Abort => Self::Abort,
            WorkerAbortSignal::Shutdown => Self::Shutdown,
        }
    }
}

impl From<WorkerHeartbeatState> for WorkerDiagnosticsHeartbeatState {
    fn from(state: WorkerHeartbeatState) -> Self {
        match state {
            WorkerHeartbeatState::Starting => Self::Starting,
            WorkerHeartbeatState::Streaming => Self::Streaming,
            WorkerHeartbeatState::Acting => Self::Acting,
            WorkerHeartbeatState::Waiting => Self::Waiting,
            WorkerHeartbeatState::Idle => Self::Idle,
        }
    }
}

impl From<WorkerHeartbeatFreshness> for WorkerDiagnosticsHeartbeatFreshnessSummary {
    fn from(freshness: WorkerHeartbeatFreshness) -> Self {
        match freshness {
            WorkerHeartbeatFreshness::Fresh {
                deadline_at,
                remaining_ms,
            } => Self {
                status: WorkerDiagnosticsHeartbeatFreshnessStatus::Fresh,
                deadline_at,
                remaining_ms: Some(remaining_ms),
                missed_by_ms: None,
            },
            WorkerHeartbeatFreshness::Missed {
                deadline_at,
                missed_by_ms,
            } => Self {
                status: WorkerDiagnosticsHeartbeatFreshnessStatus::Missed,
                deadline_at,
                remaining_ms: None,
                missed_by_ms: Some(missed_by_ms),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveExecutionScope {
    project_id: String,
    agent_pubkey: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecord, DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        build_dispatch_queue_record, replay_dispatch_queue_records,
    };
    use crate::publish_outbox::{
        PUBLISH_OUTBOX_DIAGNOSTICS_SCHEMA_VERSION, PublishOutboxFailureDiagnostic,
        PublishOutboxPendingDiagnostic,
    };
    use crate::worker_runtime_state::{WorkerRuntimeStartedDispatch, WorkerRuntimeState};
    use serde_json::json;

    #[test]
    fn builds_serializable_diagnostics_snapshot_from_explicit_state() {
        let mut runtime_state = WorkerRuntimeState::default();
        runtime_state
            .register_started_dispatch(started_dispatch(
                "worker-a",
                41,
                "dispatch-a",
                identity("project-a", "agent-a", 7),
                "claim-a",
                1_000,
            ))
            .expect("worker-a should register");
        runtime_state
            .register_started_dispatch(started_dispatch(
                "worker-b",
                42,
                "dispatch-b",
                identity("project-a", "agent-b", 8),
                "",
                1_500,
            ))
            .expect("worker-b should register");
        runtime_state
            .update_worker_heartbeat(
                "worker-a",
                heartbeat("worker-a", identity("project-a", "agent-a", 7), 2_000),
            )
            .expect("heartbeat should update");
        runtime_state
            .mark_graceful_signal_sent(
                "worker-a",
                WorkerRuntimeGracefulSignal {
                    signal: WorkerAbortSignal::Shutdown,
                    sent_at: 11_000,
                    reason: "operator requested drain".to_string(),
                },
            )
            .expect("signal should mark");

        let dispatch_queue = replay_dispatch_queue_records(vec![
            dispatch_record(
                1,
                "dispatch-queued",
                "project-a",
                "agent-a",
                DispatchQueueStatus::Queued,
            ),
            dispatch_record(
                2,
                "dispatch-a",
                "project-a",
                "agent-a",
                DispatchQueueStatus::Leased,
            ),
            dispatch_record(
                3,
                "dispatch-completed",
                "project-b",
                "agent-c",
                DispatchQueueStatus::Completed,
            ),
            dispatch_record(
                4,
                "dispatch-cancelled",
                "project-b",
                "agent-c",
                DispatchQueueStatus::Cancelled,
            ),
        ])
        .expect("dispatch queue should replay");
        let publish_outbox = publish_outbox_diagnostics();

        let snapshot = build_worker_diagnostics_snapshot(WorkerDiagnosticsInput {
            inspected_at: 13_000,
            runtime_state: &runtime_state,
            dispatch_queue: &dispatch_queue,
            publish_outbox: &publish_outbox,
            heartbeat_freshness: WorkerHeartbeatFreshnessConfig {
                interval_ms: 5_000,
                missed_threshold: 2,
            },
        });

        assert_eq!(snapshot.schema_version, WORKER_DIAGNOSTICS_SCHEMA_VERSION);
        assert_eq!(snapshot.active_workers.len(), 2);
        assert_eq!(snapshot.active_workers[0].worker_id, "worker-a");
        assert_eq!(
            snapshot.active_workers[0]
                .heartbeat
                .as_ref()
                .expect("heartbeat should be present")
                .freshness,
            WorkerDiagnosticsHeartbeatFreshnessSummary {
                status: WorkerDiagnosticsHeartbeatFreshnessStatus::Missed,
                deadline_at: 12_000,
                remaining_ms: None,
                missed_by_ms: Some(1_000),
            }
        );
        assert_eq!(
            snapshot.active_workers[0].graceful_signal,
            Some(WorkerDiagnosticsGracefulSignal {
                signal: WorkerDiagnosticsGracefulSignalKind::Shutdown,
                sent_at: 11_000,
                reason: "operator requested drain".to_string(),
            })
        );
        assert!(snapshot.active_workers[0].claim_token_present);
        assert_eq!(snapshot.active_workers[1].worker_id, "worker-b");
        assert!(!snapshot.active_workers[1].claim_token_present);
        assert_eq!(snapshot.active_workers[1].heartbeat, None);

        assert_eq!(
            snapshot.dispatch_queue,
            WorkerDiagnosticsDispatchQueueSummary {
                last_sequence: 4,
                queued_count: 1,
                leased_count: 1,
                terminal_count: 2,
                completed_count: 1,
                cancelled_count: 1,
            }
        );
        assert_eq!(snapshot.concurrency.active_execution_count, 2);
        assert_eq!(snapshot.concurrency.active_worker_count, 2);
        assert_eq!(snapshot.concurrency.leased_dispatch_count, 1);
        assert_eq!(snapshot.concurrency.projects.len(), 1);
        assert_eq!(
            snapshot.concurrency.projects[0],
            WorkerDiagnosticsProjectConcurrencySummary {
                project_id: "project-a".to_string(),
                active_count: 2,
                agents: vec![
                    WorkerDiagnosticsAgentConcurrencySummary {
                        agent_pubkey: "agent-a".to_string(),
                        active_count: 1,
                    },
                    WorkerDiagnosticsAgentConcurrencySummary {
                        agent_pubkey: "agent-b".to_string(),
                        active_count: 1,
                    },
                ],
            }
        );
        assert_eq!(snapshot.publish_outbox.pending_count, 3);
        assert_eq!(
            snapshot
                .publish_outbox
                .latest_failure
                .as_ref()
                .unwrap()
                .event_id,
            "event-failed"
        );

        let serialized = serde_json::to_value(&snapshot).expect("snapshot should serialize");
        assert_eq!(serialized["schemaVersion"], json!(1));
        assert_eq!(
            serialized["activeWorkers"][0]["heartbeat"]["freshness"],
            json!({
                "status": "missed",
                "deadlineAt": 12_000,
                "missedByMs": 1_000,
            })
        );
        assert_eq!(
            serde_json::from_value::<WorkerDiagnosticsSnapshot>(serialized)
                .expect("snapshot should deserialize"),
            snapshot
        );
    }

    #[test]
    fn counts_leased_dispatches_without_active_workers() {
        let runtime_state = WorkerRuntimeState::default();
        let dispatch_queue = replay_dispatch_queue_records(vec![
            dispatch_record(
                1,
                "dispatch-a",
                "project-a",
                "agent-a",
                DispatchQueueStatus::Leased,
            ),
            dispatch_record(
                2,
                "dispatch-b",
                "project-a",
                "agent-a",
                DispatchQueueStatus::Leased,
            ),
            dispatch_record(
                3,
                "dispatch-c",
                "project-b",
                "agent-c",
                DispatchQueueStatus::Leased,
            ),
        ])
        .expect("dispatch queue should replay");

        let snapshot = build_worker_diagnostics_snapshot(WorkerDiagnosticsInput {
            inspected_at: 10,
            runtime_state: &runtime_state,
            dispatch_queue: &dispatch_queue,
            publish_outbox: &empty_publish_outbox_diagnostics(),
            heartbeat_freshness: WorkerHeartbeatFreshnessConfig::default(),
        });

        assert_eq!(snapshot.active_workers, Vec::new());
        assert_eq!(snapshot.concurrency.active_execution_count, 3);
        assert_eq!(snapshot.concurrency.active_worker_count, 0);
        assert_eq!(snapshot.concurrency.leased_dispatch_count, 3);
        assert_eq!(
            snapshot.concurrency.projects,
            vec![
                WorkerDiagnosticsProjectConcurrencySummary {
                    project_id: "project-a".to_string(),
                    active_count: 2,
                    agents: vec![WorkerDiagnosticsAgentConcurrencySummary {
                        agent_pubkey: "agent-a".to_string(),
                        active_count: 2,
                    }],
                },
                WorkerDiagnosticsProjectConcurrencySummary {
                    project_id: "project-b".to_string(),
                    active_count: 1,
                    agents: vec![WorkerDiagnosticsAgentConcurrencySummary {
                        agent_pubkey: "agent-c".to_string(),
                        active_count: 1,
                    }],
                },
            ]
        );
    }

    #[test]
    fn reports_fresh_heartbeat_before_deadline() {
        let mut runtime_state = WorkerRuntimeState::default();
        runtime_state
            .register_started_dispatch(started_dispatch(
                "worker-a",
                41,
                "dispatch-a",
                identity("project-a", "agent-a", 7),
                "claim-a",
                1_000,
            ))
            .expect("worker should register");
        runtime_state
            .update_worker_heartbeat(
                "worker-a",
                heartbeat("worker-a", identity("project-a", "agent-a", 7), 2_000),
            )
            .expect("heartbeat should update");

        let snapshot = build_worker_diagnostics_snapshot(WorkerDiagnosticsInput {
            inspected_at: 7_000,
            runtime_state: &runtime_state,
            dispatch_queue: &DispatchQueueState::default(),
            publish_outbox: &empty_publish_outbox_diagnostics(),
            heartbeat_freshness: WorkerHeartbeatFreshnessConfig {
                interval_ms: 5_000,
                missed_threshold: 2,
            },
        });

        assert_eq!(
            snapshot.active_workers[0]
                .heartbeat
                .as_ref()
                .expect("heartbeat should be present")
                .freshness,
            WorkerDiagnosticsHeartbeatFreshnessSummary {
                status: WorkerDiagnosticsHeartbeatFreshnessStatus::Fresh,
                deadline_at: 12_000,
                remaining_ms: Some(5_000),
                missed_by_ms: None,
            }
        );
    }

    fn started_dispatch(
        worker_id: &str,
        pid: u64,
        dispatch_id: &str,
        identity: RalJournalIdentity,
        claim_token: &str,
        started_at: u64,
    ) -> WorkerRuntimeStartedDispatch {
        WorkerRuntimeStartedDispatch {
            worker_id: worker_id.to_string(),
            pid,
            dispatch_id: dispatch_id.to_string(),
            identity,
            claim_token: claim_token.to_string(),
            started_at,
        }
    }

    fn heartbeat(
        worker_id: &str,
        identity: RalJournalIdentity,
        observed_at: u64,
    ) -> WorkerHeartbeatSnapshot {
        WorkerHeartbeatSnapshot {
            worker_id: worker_id.to_string(),
            correlation_id: format!("heartbeat-{worker_id}"),
            sequence: 12,
            worker_timestamp: observed_at - 10,
            observed_at,
            identity,
            state: WorkerHeartbeatState::Streaming,
            active_tool_count: 2,
            accumulated_runtime_ms: 9_000,
        }
    }

    fn dispatch_record(
        sequence: u64,
        dispatch_id: &str,
        project_id: &str,
        agent_pubkey: &str,
        status: DispatchQueueStatus,
    ) -> DispatchQueueRecord {
        build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence,
            timestamp: sequence * 100,
            correlation_id: format!("correlation-{sequence}"),
            dispatch_id: dispatch_id.to_string(),
            ral: DispatchRalIdentity {
                project_id: project_id.to_string(),
                agent_pubkey: agent_pubkey.to_string(),
                conversation_id: "conversation-a".to_string(),
                ral_number: sequence,
            },
            triggering_event_id: format!("triggering-event-{sequence}"),
            claim_token: format!("claim-{sequence}"),
            status,
        })
    }

    fn identity(project_id: &str, agent_pubkey: &str, ral_number: u64) -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: project_id.to_string(),
            agent_pubkey: agent_pubkey.to_string(),
            conversation_id: "conversation-a".to_string(),
            ral_number,
        }
    }

    fn publish_outbox_diagnostics() -> PublishOutboxDiagnostics {
        PublishOutboxDiagnostics {
            schema_version: PUBLISH_OUTBOX_DIAGNOSTICS_SCHEMA_VERSION,
            inspected_at: 12_345,
            pending_count: 3,
            published_count: 5,
            failed_count: 2,
            retryable_failed_count: 1,
            retry_due_count: 1,
            permanent_failed_count: 1,
            tmp_file_count: 1,
            oldest_pending: Some(PublishOutboxPendingDiagnostic {
                event_id: "event-pending".to_string(),
                accepted_at: 1_000,
                request_id: "request-pending".to_string(),
                project_id: "project-a".to_string(),
                conversation_id: "conversation-a".to_string(),
                agent_pubkey: "agent-a".to_string(),
            }),
            next_retry_at: Some(20_000),
            latest_failure: Some(PublishOutboxFailureDiagnostic {
                event_id: "event-failed".to_string(),
                request_id: "request-failed".to_string(),
                project_id: "project-a".to_string(),
                conversation_id: "conversation-a".to_string(),
                agent_pubkey: "agent-a".to_string(),
                attempt_count: 2,
                attempted_at: 12_000,
                error: Some("relay rejected event".to_string()),
                retryable: true,
                next_attempt_at: Some(20_000),
            }),
        }
    }

    fn empty_publish_outbox_diagnostics() -> PublishOutboxDiagnostics {
        PublishOutboxDiagnostics {
            schema_version: PUBLISH_OUTBOX_DIAGNOSTICS_SCHEMA_VERSION,
            inspected_at: 0,
            pending_count: 0,
            published_count: 0,
            failed_count: 0,
            retryable_failed_count: 0,
            retry_due_count: 0,
            permanent_failed_count: 0,
            tmp_file_count: 0,
            oldest_pending: None,
            next_retry_at: None,
            latest_failure: None,
        }
    }
}
