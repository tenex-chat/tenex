use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::dispatch_queue::{DispatchQueueState, replay_dispatch_queue};
use crate::filesystem_state::{
    DaemonStatusData, FilesystemStateError, LockInfo, RestartStateData, read_lock_info_file,
    read_restart_state_file, read_status_file,
};
use crate::publish_outbox::{PublishOutboxDiagnostics, PublishOutboxError, inspect_publish_outbox};
use crate::ral_journal::{RalJournalError, RalJournalReplay, RalReplayStatus, replay_ral_journal};
use crate::routing_shadow_log::{
    RoutingShadowLogDiagnostics, RoutingShadowLogError, replay_routing_shadow_log,
};
use crate::telegram_outbox::{
    TelegramOutboxDiagnostics, TelegramOutboxError, inspect_telegram_outbox,
};
use crate::worker_diagnostics::{
    WorkerDiagnosticsActiveWorker, WorkerDiagnosticsAgentConcurrencySummary,
    WorkerDiagnosticsDispatchQueueSummary, WorkerDiagnosticsGracefulSignal,
    WorkerDiagnosticsHeartbeatSummary, WorkerDiagnosticsProjectConcurrencySummary,
};
use crate::worker_heartbeat::{
    WorkerHeartbeatFreshnessConfig, classify_worker_heartbeat_freshness,
};
use crate::worker_runtime_state::{ActiveWorkerRuntimeSnapshot, WorkerRuntimeState};

pub const DAEMON_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
pub const DAEMON_RAL_JOURNAL_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
pub const DAEMON_WORKER_RUNTIME_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonDiagnosticsInput<'a> {
    pub daemon_dir: &'a Path,
    pub inspected_at: u64,
    pub worker_runtime_state: Option<&'a WorkerRuntimeState>,
}

#[derive(Debug, Error)]
pub enum DaemonDiagnosticsError {
    #[error("filesystem state error: {0}")]
    Filesystem(#[from] FilesystemStateError),
    #[error("dispatch queue error: {0}")]
    DispatchQueue(#[from] crate::dispatch_queue::DispatchQueueError),
    #[error("RAL journal error: {0}")]
    RalJournal(#[from] RalJournalError),
    #[error("publish outbox error: {0}")]
    PublishOutbox(#[from] PublishOutboxError),
    #[error("routing shadow log error: {0}")]
    RoutingShadowLog(#[from] RoutingShadowLogError),
    #[error("telegram outbox error: {0}")]
    TelegramOutbox(#[from] TelegramOutboxError),
}

pub type DaemonDiagnosticsResult<T> = Result<T, DaemonDiagnosticsError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonDiagnosticsSnapshot {
    pub schema_version: u32,
    pub inspected_at: u64,
    pub daemon: DaemonStatusControlView,
    pub dispatch_queue: WorkerDiagnosticsDispatchQueueSummary,
    pub ral_journal: DaemonRalJournalDiagnostics,
    pub publish_outbox: PublishOutboxDiagnostics,
    pub routing_shadow_log: RoutingShadowLogDiagnostics,
    pub telegram_outbox: TelegramOutboxDiagnostics,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_runtime: Option<DaemonWorkerRuntimeDiagnostics>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatusControlView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lockfile: Option<LockInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<DaemonStatusData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_state: Option<RestartStateData>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRalJournalDiagnostics {
    pub schema_version: u32,
    pub last_sequence: u64,
    pub state_count: usize,
    pub active_count: usize,
    pub terminal_count: usize,
    pub allocated_count: usize,
    pub claimed_count: usize,
    pub waiting_for_delegation_count: usize,
    pub completed_count: usize,
    pub no_response_count: usize,
    pub error_count: usize,
    pub aborted_count: usize,
    pub crashed_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_updated_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonWorkerRuntimeDiagnostics {
    pub schema_version: u32,
    pub inspected_at: u64,
    pub active_worker_count: usize,
    pub active_workers: Vec<WorkerDiagnosticsActiveWorker>,
    pub projects: Vec<WorkerDiagnosticsProjectConcurrencySummary>,
}

pub fn inspect_daemon_diagnostics(
    input: DaemonDiagnosticsInput<'_>,
) -> DaemonDiagnosticsResult<DaemonDiagnosticsSnapshot> {
    let daemon = read_daemon_status_control_view(input.daemon_dir)?;
    let dispatch_queue = dispatch_queue_summary(&replay_dispatch_queue(input.daemon_dir)?);
    let ral_journal = ral_journal_summary(&replay_ral_journal(input.daemon_dir)?);
    let publish_outbox = inspect_publish_outbox(input.daemon_dir, input.inspected_at)?;
    let routing_shadow_log = replay_routing_shadow_log(input.daemon_dir)?.diagnostics;
    let telegram_outbox = inspect_telegram_outbox(input.daemon_dir, input.inspected_at)?;
    let worker_runtime = input
        .worker_runtime_state
        .map(|runtime_state| build_worker_runtime_summary(runtime_state, input.inspected_at));

    Ok(DaemonDiagnosticsSnapshot {
        schema_version: DAEMON_DIAGNOSTICS_SCHEMA_VERSION,
        inspected_at: input.inspected_at,
        daemon,
        dispatch_queue,
        ral_journal,
        publish_outbox,
        routing_shadow_log,
        telegram_outbox,
        worker_runtime,
    })
}

fn read_daemon_status_control_view(
    daemon_dir: impl AsRef<Path>,
) -> DaemonDiagnosticsResult<DaemonStatusControlView> {
    Ok(DaemonStatusControlView {
        lockfile: read_lock_info_file(daemon_dir.as_ref())?,
        status: read_status_file(daemon_dir.as_ref())?,
        restart_state: read_restart_state_file(daemon_dir.as_ref())?,
    })
}

fn dispatch_queue_summary(replay: &DispatchQueueState) -> WorkerDiagnosticsDispatchQueueSummary {
    let completed_count = replay
        .terminal
        .iter()
        .filter(|record| record.status == crate::dispatch_queue::DispatchQueueStatus::Completed)
        .count();
    let cancelled_count = replay
        .terminal
        .iter()
        .filter(|record| record.status == crate::dispatch_queue::DispatchQueueStatus::Cancelled)
        .count();

    WorkerDiagnosticsDispatchQueueSummary {
        last_sequence: replay.last_sequence,
        queued_count: replay.queued.len(),
        leased_count: replay.leased.len(),
        terminal_count: replay.terminal.len(),
        completed_count,
        cancelled_count,
    }
}

fn ral_journal_summary(replay: &RalJournalReplay) -> DaemonRalJournalDiagnostics {
    let mut allocated_count = 0;
    let mut claimed_count = 0;
    let mut waiting_for_delegation_count = 0;
    let mut completed_count = 0;
    let mut no_response_count = 0;
    let mut error_count = 0;
    let mut aborted_count = 0;
    let mut crashed_count = 0;
    let mut latest_updated_at: Option<u64> = None;

    for entry in replay.states.values() {
        latest_updated_at = Some(
            latest_updated_at.map_or(entry.updated_at, |current| current.max(entry.updated_at)),
        );

        match entry.status {
            RalReplayStatus::Allocated => allocated_count += 1,
            RalReplayStatus::Claimed => claimed_count += 1,
            RalReplayStatus::WaitingForDelegation => waiting_for_delegation_count += 1,
            RalReplayStatus::Completed => completed_count += 1,
            RalReplayStatus::NoResponse => no_response_count += 1,
            RalReplayStatus::Error => error_count += 1,
            RalReplayStatus::Aborted => aborted_count += 1,
            RalReplayStatus::Crashed => crashed_count += 1,
        }
    }

    let active_count = allocated_count + claimed_count + waiting_for_delegation_count;
    let terminal_count =
        completed_count + no_response_count + error_count + aborted_count + crashed_count;

    DaemonRalJournalDiagnostics {
        schema_version: DAEMON_RAL_JOURNAL_DIAGNOSTICS_SCHEMA_VERSION,
        last_sequence: replay.last_sequence,
        state_count: replay.states.len(),
        active_count,
        terminal_count,
        allocated_count,
        claimed_count,
        waiting_for_delegation_count,
        completed_count,
        no_response_count,
        error_count,
        aborted_count,
        crashed_count,
        latest_updated_at,
    }
}

fn build_worker_runtime_summary(
    runtime_state: &WorkerRuntimeState,
    inspected_at: u64,
) -> DaemonWorkerRuntimeDiagnostics {
    let active_workers = runtime_state
        .workers()
        .map(|worker| active_worker_diagnostics(worker, inspected_at))
        .collect::<Vec<_>>();
    let projects = worker_projects_summary(&active_workers);

    DaemonWorkerRuntimeDiagnostics {
        schema_version: DAEMON_WORKER_RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
        inspected_at,
        active_worker_count: active_workers.len(),
        active_workers,
        projects,
    }
}

fn active_worker_diagnostics(
    worker: &ActiveWorkerRuntimeSnapshot,
    inspected_at: u64,
) -> WorkerDiagnosticsActiveWorker {
    WorkerDiagnosticsActiveWorker {
        worker_id: worker.worker_id.clone(),
        pid: worker.pid,
        dispatch_id: worker.dispatch_id.clone(),
        identity: worker.identity.clone(),
        claim_token_present: !worker.claim_token.is_empty(),
        started_at: worker.started_at,
        graceful_signal: worker
            .graceful_signal
            .as_ref()
            .map(graceful_signal_diagnostics),
        heartbeat: worker
            .last_heartbeat
            .as_ref()
            .map(|heartbeat| heartbeat_summary(heartbeat, inspected_at)),
    }
}

fn graceful_signal_diagnostics(
    graceful_signal: &crate::worker_runtime_state::WorkerRuntimeGracefulSignal,
) -> WorkerDiagnosticsGracefulSignal {
    WorkerDiagnosticsGracefulSignal {
        signal: graceful_signal.signal.into(),
        sent_at: graceful_signal.sent_at,
        reason: graceful_signal.reason.clone(),
    }
}

fn heartbeat_summary(
    snapshot: &crate::worker_heartbeat::WorkerHeartbeatSnapshot,
    inspected_at: u64,
) -> WorkerDiagnosticsHeartbeatSummary {
    WorkerDiagnosticsHeartbeatSummary {
        correlation_id: snapshot.correlation_id.clone(),
        sequence: snapshot.sequence,
        worker_timestamp: snapshot.worker_timestamp,
        observed_at: snapshot.observed_at,
        state: snapshot.state.into(),
        active_tool_count: snapshot.active_tool_count,
        accumulated_runtime_ms: snapshot.accumulated_runtime_ms,
        freshness: classify_worker_heartbeat_freshness(
            snapshot,
            inspected_at,
            WorkerHeartbeatFreshnessConfig::default(),
        )
        .into(),
    }
}

fn worker_projects_summary(
    active_workers: &[WorkerDiagnosticsActiveWorker],
) -> Vec<WorkerDiagnosticsProjectConcurrencySummary> {
    let mut projects = BTreeMap::<String, BTreeMap<String, u64>>::new();

    for worker in active_workers {
        let agents = projects
            .entry(worker.identity.project_id.clone())
            .or_default();
        *agents
            .entry(worker.identity.agent_pubkey.clone())
            .or_default() += 1;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_worker_runtime::{
        DaemonWorkerRuntimeInput, DaemonWorkerRuntimeOutcome, DaemonWorkerTerminalRuntimeInput,
        run_daemon_worker_runtime_once,
    };
    use crate::dispatch_queue::{
        DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        append_dispatch_queue_record, build_dispatch_queue_record, dispatch_queue_path,
    };
    use crate::filesystem_state::{
        DaemonStatusData, RuntimeStatusEntry, build_lock_info, build_restart_state,
        save_restart_state_file, write_lock_info_file, write_status_file,
    };
    use crate::nostr_event::Nip01EventFixture;
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use crate::publish_outbox::{
        PublishOutboxRecord, failed_publish_outbox_record_path, pending_publish_outbox_record_path,
        published_publish_outbox_record_path,
    };
    use crate::ral_journal::{
        RalDelegationType, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
        RalPendingDelegation, RalTerminalSummary, append_ral_journal_record, ral_journal_path,
    };
    use crate::ral_lock::build_ral_lock_info;
    use crate::routing::{ProjectFixture, RoutingEvent};
    use crate::routing_shadow::{RoutingShadowInput, build_routing_shadow_record};
    use crate::routing_shadow_log::append_routing_shadow_record;
    use crate::telegram_outbox::{
        TelegramOutboxRecord, delivered_telegram_outbox_record_path,
        failed_telegram_outbox_record_path, pending_telegram_outbox_record_path,
    };
    use crate::worker_abort::WorkerAbortSignal;
    use crate::worker_dispatch_execution::{
        BootedWorkerDispatch, WorkerDispatchSession, WorkerDispatchSpawner,
    };
    use crate::worker_frame_pump::WorkerFrameReceiver;
    use crate::worker_heartbeat::{WorkerHeartbeatSnapshot, WorkerHeartbeatState};
    use crate::worker_message_flow::WorkerMessagePublishContext;
    use crate::worker_process::{AgentWorkerCommand, AgentWorkerProcessConfig, AgentWorkerReady};
    use crate::worker_protocol::{
        AGENT_WORKER_MAX_FRAME_BYTES, AGENT_WORKER_PROTOCOL_ENCODING,
        AGENT_WORKER_PROTOCOL_VERSION, AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
        AGENT_WORKER_STREAM_BATCH_MS, AgentWorkerExecutionFlags, WorkerProtocolConfig,
        encode_agent_worker_protocol_frame,
    };
    use crate::worker_runtime_state::{
        WorkerRuntimeGracefulSignal, WorkerRuntimeStartedDispatch, WorkerRuntimeState,
    };
    use crate::worker_session_loop::{WorkerSessionLoopFinalReason, WorkerSessionLoopOutcome};
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::error::Error;
    use std::fmt;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const PUBLISH_OUTBOX_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/daemon/publish-outbox.compat.json");
    const TELEGRAM_OUTBOX_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/daemon/telegram-outbox.compat.json");

    static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn inspects_empty_daemon_diagnostics() {
        let daemon_dir = unique_temp_daemon_dir();

        let snapshot = inspect_daemon_diagnostics(DaemonDiagnosticsInput {
            daemon_dir: &daemon_dir,
            inspected_at: 1_710_001_000_000,
            worker_runtime_state: None,
        })
        .expect("empty diagnostics must inspect");

        assert_eq!(snapshot.schema_version, DAEMON_DIAGNOSTICS_SCHEMA_VERSION);
        assert_eq!(snapshot.inspected_at, 1_710_001_000_000);
        assert_eq!(
            snapshot.daemon,
            DaemonStatusControlView {
                lockfile: None,
                status: None,
                restart_state: None,
            }
        );
        assert_eq!(snapshot.dispatch_queue.last_sequence, 0);
        assert_eq!(snapshot.dispatch_queue.queued_count, 0);
        assert_eq!(snapshot.dispatch_queue.leased_count, 0);
        assert_eq!(snapshot.dispatch_queue.terminal_count, 0);
        assert_eq!(snapshot.ral_journal.state_count, 0);
        assert_eq!(snapshot.ral_journal.active_count, 0);
        assert_eq!(snapshot.ral_journal.terminal_count, 0);
        assert_eq!(snapshot.publish_outbox.pending_count, 0);
        assert_eq!(snapshot.publish_outbox.published_count, 0);
        assert_eq!(snapshot.publish_outbox.failed_count, 0);
        assert_eq!(snapshot.routing_shadow_log.record_count, 0);
        assert_eq!(snapshot.telegram_outbox.pending_count, 0);
        assert_eq!(snapshot.telegram_outbox.delivered_count, 0);
        assert_eq!(snapshot.telegram_outbox.failed_count, 0);
        assert!(snapshot.worker_runtime.is_none());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn inspects_populated_daemon_diagnostics_from_filesystem_records() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = serde_json::from_str::<Value>(PUBLISH_OUTBOX_FIXTURE)
            .expect("publish outbox fixture must parse");
        let telegram_fixture = serde_json::from_str::<Value>(TELEGRAM_OUTBOX_FIXTURE)
            .expect("telegram outbox fixture must parse");

        write_lock_info_file(
            &daemon_dir,
            &build_lock_info(4_242, "tenex-host", 1_710_001_000_000),
        )
        .expect("lockfile write must succeed");
        write_status_file(
            &daemon_dir,
            &DaemonStatusData {
                pid: 4_242,
                started_at: "2024-03-09T10:00:00.000Z".to_string(),
                known_projects: 1,
                runtimes: vec![RuntimeStatusEntry {
                    project_id: "project-alpha".to_string(),
                    title: "Alpha".to_string(),
                    agent_count: 1,
                    start_time: Some("2024-03-09T10:00:00.000Z".to_string()),
                    last_event_time: Some("2024-03-09T10:05:00.000Z".to_string()),
                    event_count: 3,
                }],
                updated_at: "2024-03-09T10:05:00.000Z".to_string(),
            },
        )
        .expect("status write must succeed");
        save_restart_state_file(
            &daemon_dir,
            &build_restart_state(
                1_710_001_000_500,
                vec!["project-alpha".to_string()],
                4_242,
                "tenex-host",
            ),
        )
        .expect("restart state write must succeed");

        append_dispatch_queue_record(
            &daemon_dir,
            &build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 1,
                timestamp: 1_710_001_000_100,
                correlation_id: "corr-1".to_string(),
                dispatch_id: "dispatch-queued".to_string(),
                ral: DispatchRalIdentity {
                    project_id: "project-alpha".to_string(),
                    agent_pubkey:
                        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                            .to_string(),
                    conversation_id: "conversation-alpha".to_string(),
                    ral_number: 1,
                },
                triggering_event_id: "event-queued".to_string(),
                claim_token: "claim-queued".to_string(),
                status: DispatchQueueStatus::Queued,
            }),
        )
        .expect("queued dispatch record must write");
        append_dispatch_queue_record(
            &daemon_dir,
            &build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 2,
                timestamp: 1_710_001_000_200,
                correlation_id: "corr-2".to_string(),
                dispatch_id: "dispatch-leased".to_string(),
                ral: DispatchRalIdentity {
                    project_id: "project-alpha".to_string(),
                    agent_pubkey:
                        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                            .to_string(),
                    conversation_id: "conversation-alpha".to_string(),
                    ral_number: 2,
                },
                triggering_event_id: "event-leased".to_string(),
                claim_token: "claim-leased".to_string(),
                status: DispatchQueueStatus::Leased,
            }),
        )
        .expect("leased dispatch record must write");
        append_dispatch_queue_record(
            &daemon_dir,
            &build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 3,
                timestamp: 1_710_001_000_300,
                correlation_id: "corr-3".to_string(),
                dispatch_id: "dispatch-completed".to_string(),
                ral: DispatchRalIdentity {
                    project_id: "project-beta".to_string(),
                    agent_pubkey:
                        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                            .to_string(),
                    conversation_id: "conversation-beta".to_string(),
                    ral_number: 1,
                },
                triggering_event_id: "event-completed".to_string(),
                claim_token: "claim-completed".to_string(),
                status: DispatchQueueStatus::Completed,
            }),
        )
        .expect("completed dispatch record must write");
        append_dispatch_queue_record(
            &daemon_dir,
            &build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 4,
                timestamp: 1_710_001_000_400,
                correlation_id: "corr-4".to_string(),
                dispatch_id: "dispatch-cancelled".to_string(),
                ral: DispatchRalIdentity {
                    project_id: "project-beta".to_string(),
                    agent_pubkey:
                        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                            .to_string(),
                    conversation_id: "conversation-beta".to_string(),
                    ral_number: 2,
                },
                triggering_event_id: "event-cancelled".to_string(),
                claim_token: "claim-cancelled".to_string(),
                status: DispatchQueueStatus::Cancelled,
            }),
        )
        .expect("cancelled dispatch record must write");

        append_ral_journal_record(
            &daemon_dir,
            &RalJournalRecord::new(
                "rust-daemon",
                "test-version",
                1,
                1_710_001_000_100,
                "corr-ral-1",
                RalJournalEvent::Allocated {
                    identity: RalJournalIdentity {
                        project_id: "project-alpha".to_string(),
                        agent_pubkey:
                            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                                .to_string(),
                        conversation_id: "conversation-alpha".to_string(),
                        ral_number: 1,
                    },
                    triggering_event_id: Some("trigger-1".to_string()),
                },
            ),
        )
        .expect("RAL allocated record must append");
        append_ral_journal_record(
            &daemon_dir,
            &RalJournalRecord::new(
                "rust-daemon",
                "test-version",
                2,
                1_710_001_000_200,
                "corr-ral-2",
                RalJournalEvent::Claimed {
                    identity: RalJournalIdentity {
                        project_id: "project-alpha".to_string(),
                        agent_pubkey:
                            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                                .to_string(),
                        conversation_id: "conversation-alpha".to_string(),
                        ral_number: 1,
                    },
                    worker_id: "worker-alpha".to_string(),
                    claim_token: "claim-1".to_string(),
                },
            ),
        )
        .expect("RAL claimed record must append");
        append_ral_journal_record(
            &daemon_dir,
            &RalJournalRecord::new(
                "rust-daemon",
                "test-version",
                3,
                1_710_001_000_300,
                "corr-ral-3",
                RalJournalEvent::WaitingForDelegation {
                    identity: RalJournalIdentity {
                        project_id: "project-alpha".to_string(),
                        agent_pubkey:
                            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                                .to_string(),
                        conversation_id: "conversation-alpha".to_string(),
                        ral_number: 1,
                    },
                    worker_id: "worker-alpha".to_string(),
                    claim_token: "claim-1".to_string(),
                    pending_delegations: vec![RalPendingDelegation {
                        delegation_conversation_id: "delegation-alpha".to_string(),
                        recipient_pubkey:
                            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                .to_string(),
                        sender_pubkey:
                            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                                .to_string(),
                        prompt: "Delegate the task".to_string(),
                        delegation_type: RalDelegationType::Standard,
                        ral_number: 1,
                        parent_delegation_conversation_id: None,
                        pending_sub_delegations: None,
                        deferred_completion: None,
                        followup_event_id: None,
                        project_id: Some("project-alpha".to_string()),
                        suggestions: None,
                        killed: None,
                        killed_at: None,
                    }],
                    terminal: RalTerminalSummary {
                        published_user_visible_event: false,
                        pending_delegations_remain: true,
                        accumulated_runtime_ms: 900,
                        final_event_ids: Vec::new(),
                        keep_worker_warm: true,
                    },
                },
            ),
        )
        .expect("RAL waiting record must append");
        append_ral_journal_record(
            &daemon_dir,
            &RalJournalRecord::new(
                "rust-daemon",
                "test-version",
                4,
                1_710_001_000_400,
                "corr-ral-4",
                RalJournalEvent::Allocated {
                    identity: RalJournalIdentity {
                        project_id: "project-beta".to_string(),
                        agent_pubkey:
                            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                .to_string(),
                        conversation_id: "conversation-beta".to_string(),
                        ral_number: 1,
                    },
                    triggering_event_id: Some("trigger-2".to_string()),
                },
            ),
        )
        .expect("second RAL allocated record must append");
        append_ral_journal_record(
            &daemon_dir,
            &RalJournalRecord::new(
                "rust-daemon",
                "test-version",
                5,
                1_710_001_000_500,
                "corr-ral-5",
                RalJournalEvent::Claimed {
                    identity: RalJournalIdentity {
                        project_id: "project-beta".to_string(),
                        agent_pubkey:
                            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                .to_string(),
                        conversation_id: "conversation-beta".to_string(),
                        ral_number: 1,
                    },
                    worker_id: "worker-beta".to_string(),
                    claim_token: "claim-2".to_string(),
                },
            ),
        )
        .expect("second RAL claimed record must append");
        append_ral_journal_record(
            &daemon_dir,
            &RalJournalRecord::new(
                "rust-daemon",
                "test-version",
                6,
                1_710_001_000_600,
                "corr-ral-6",
                RalJournalEvent::Completed {
                    identity: RalJournalIdentity {
                        project_id: "project-beta".to_string(),
                        agent_pubkey:
                            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                .to_string(),
                        conversation_id: "conversation-beta".to_string(),
                        ral_number: 1,
                    },
                    worker_id: "worker-beta".to_string(),
                    claim_token: "claim-2".to_string(),
                    terminal: RalTerminalSummary {
                        published_user_visible_event: true,
                        pending_delegations_remain: false,
                        accumulated_runtime_ms: 1_500,
                        final_event_ids: vec!["final-1".to_string()],
                        keep_worker_warm: false,
                    },
                },
            ),
        )
        .expect("completed RAL record must append");

        write_publish_outbox_record(
            &daemon_dir,
            "pending",
            serde_json::from_value(fixture["records"]["accepted"].clone())
                .expect("accepted publish record must parse"),
        );
        write_publish_outbox_record(
            &daemon_dir,
            "published",
            serde_json::from_value(fixture["records"]["published"].clone())
                .expect("published publish record must parse"),
        );
        write_publish_outbox_record(
            &daemon_dir,
            "failed",
            serde_json::from_value(fixture["records"]["failed"].clone())
                .expect("failed publish record must parse"),
        );

        write_telegram_outbox_record(
            &daemon_dir,
            "pending",
            serde_json::from_value(telegram_fixture["records"]["pendingHtml"].clone())
                .expect("pending telegram record must parse"),
        );
        write_telegram_outbox_record(
            &daemon_dir,
            "delivered",
            serde_json::from_value(telegram_fixture["records"]["delivered"].clone())
                .expect("delivered telegram record must parse"),
        );
        write_telegram_outbox_record(
            &daemon_dir,
            "failed",
            serde_json::from_value(telegram_fixture["records"]["failedRetryable"].clone())
                .expect("retryable telegram record must parse"),
        );
        write_telegram_outbox_record(
            &daemon_dir,
            "failed",
            serde_json::from_value(telegram_fixture["records"]["failedPermanent"].clone())
                .expect("permanent telegram record must parse"),
        );

        append_routing_shadow_record(
            &daemon_dir,
            &build_routing_shadow_record(RoutingShadowInput {
                observed_at: 1_710_001_000_700,
                writer_version: "test-version".to_string(),
                event: RoutingEvent {
                    id: "event-a".to_string(),
                    kind: 1,
                    pubkey:
                        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                            .to_string(),
                    content: "Hello".to_string(),
                    tags: vec![vec![
                        "a".to_string(),
                        "31933:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:project-alpha"
                            .to_string(),
                    ]],
                },
                projects: vec![ProjectFixture {
                    d_tag: "project-alpha".to_string(),
                    address:
                        "31933:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:project-alpha"
                            .to_string(),
                    title: "Alpha".to_string(),
                    agents: vec![crate::routing::AgentFixture {
                        pubkey:
                            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                                .to_string(),
                        slug: "alpha".to_string(),
                    }],
                }],
                active_project_ids: vec!["project-alpha".to_string()],
            }),
        )
        .expect("first routing shadow record must append");
        append_routing_shadow_record(
            &daemon_dir,
            &build_routing_shadow_record(RoutingShadowInput {
                observed_at: 1_710_001_000_800,
                writer_version: "test-version".to_string(),
                event: RoutingEvent {
                    id: "event-p".to_string(),
                    kind: 1,
                    pubkey:
                        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                            .to_string(),
                    content: "Hello".to_string(),
                    tags: vec![vec![
                        "p".to_string(),
                        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                            .to_string(),
                    ]],
                },
                projects: vec![ProjectFixture {
                    d_tag: "project-beta".to_string(),
                    address:
                        "31933:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:project-beta"
                            .to_string(),
                    title: "Beta".to_string(),
                    agents: vec![crate::routing::AgentFixture {
                        pubkey:
                            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                .to_string(),
                        slug: "beta".to_string(),
                    }],
                }],
                active_project_ids: vec!["project-beta".to_string()],
            }),
        )
        .expect("second routing shadow record must append");

        let mut runtime_state = WorkerRuntimeState::default();
        runtime_state
            .register_started_dispatch(WorkerRuntimeStartedDispatch {
                worker_id: "worker-alpha".to_string(),
                pid: 9_001,
                dispatch_id: "dispatch-runtime".to_string(),
                identity: RalJournalIdentity {
                    project_id: "project-alpha".to_string(),
                    agent_pubkey:
                        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                            .to_string(),
                    conversation_id: "conversation-alpha".to_string(),
                    ral_number: 1,
                },
                claim_token: "claim-runtime".to_string(),
                started_at: 1_710_001_000_250,
            })
            .expect("runtime dispatch must register");
        runtime_state
            .update_worker_heartbeat(
                "worker-alpha",
                WorkerHeartbeatSnapshot {
                    worker_id: "worker-alpha".to_string(),
                    correlation_id: "corr-runtime".to_string(),
                    sequence: 7,
                    worker_timestamp: 1_710_001_000_300,
                    observed_at: 1_710_001_000_350,
                    identity: RalJournalIdentity {
                        project_id: "project-alpha".to_string(),
                        agent_pubkey:
                            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                                .to_string(),
                        conversation_id: "conversation-alpha".to_string(),
                        ral_number: 1,
                    },
                    state: WorkerHeartbeatState::Streaming,
                    active_tool_count: 2,
                    accumulated_runtime_ms: 450,
                },
            )
            .expect("heartbeat must update");
        runtime_state
            .mark_graceful_signal_sent(
                "worker-alpha",
                WorkerRuntimeGracefulSignal {
                    signal: WorkerAbortSignal::Shutdown,
                    sent_at: 1_710_001_000_360,
                    reason: "draining".to_string(),
                },
            )
            .expect("graceful signal must update");

        let before = collect_file_manifest(&daemon_dir);
        let snapshot = inspect_daemon_diagnostics(DaemonDiagnosticsInput {
            daemon_dir: &daemon_dir,
            inspected_at: 1_710_001_000_900,
            worker_runtime_state: Some(&runtime_state),
        })
        .expect("populated diagnostics must inspect");
        let after = collect_file_manifest(&daemon_dir);

        assert_eq!(before, after);
        assert_eq!(
            snapshot.daemon.lockfile,
            Some(build_lock_info(4_242, "tenex-host", 1_710_001_000_000))
        );
        assert_eq!(
            snapshot
                .daemon
                .status
                .as_ref()
                .map(|status| status.known_projects),
            Some(1)
        );
        assert_eq!(
            snapshot.daemon.restart_state,
            Some(build_restart_state(
                1_710_001_000_500,
                vec!["project-alpha".to_string()],
                4_242,
                "tenex-host",
            ))
        );
        assert_eq!(snapshot.dispatch_queue.queued_count, 1);
        assert_eq!(snapshot.dispatch_queue.leased_count, 1);
        assert_eq!(snapshot.dispatch_queue.terminal_count, 2);
        assert_eq!(snapshot.dispatch_queue.completed_count, 1);
        assert_eq!(snapshot.dispatch_queue.cancelled_count, 1);
        assert_eq!(snapshot.ral_journal.state_count, 2);
        assert_eq!(snapshot.ral_journal.active_count, 1);
        assert_eq!(snapshot.ral_journal.terminal_count, 1);
        assert_eq!(snapshot.ral_journal.waiting_for_delegation_count, 1);
        assert_eq!(snapshot.ral_journal.completed_count, 1);
        assert_eq!(snapshot.publish_outbox.pending_count, 1);
        assert_eq!(snapshot.publish_outbox.published_count, 1);
        assert_eq!(snapshot.publish_outbox.failed_count, 1);
        assert_eq!(snapshot.publish_outbox.retryable_failed_count, 1);
        assert_eq!(snapshot.publish_outbox.retry_due_count, 0);
        assert_eq!(snapshot.routing_shadow_log.record_count, 2);
        assert_eq!(
            snapshot.routing_shadow_log.latest_observed_at,
            Some(1_710_001_000_800)
        );
        assert_eq!(
            snapshot.routing_shadow_log.distinct_decision_methods,
            vec!["a_tag".to_string(), "p_tag_agent".to_string()]
        );
        assert_eq!(
            snapshot.routing_shadow_log.distinct_target_project_ids,
            vec!["project-alpha".to_string(), "project-beta".to_string()]
        );
        assert_eq!(snapshot.telegram_outbox.pending_count, 1);
        assert_eq!(snapshot.telegram_outbox.delivered_count, 1);
        assert_eq!(snapshot.telegram_outbox.failed_count, 2);
        assert_eq!(snapshot.telegram_outbox.retryable_failed_count, 1);
        assert_eq!(snapshot.telegram_outbox.permanent_failed_count, 1);
        assert_eq!(
            snapshot
                .worker_runtime
                .as_ref()
                .map(|runtime| runtime.active_worker_count),
            Some(1)
        );
        assert_eq!(
            snapshot
                .worker_runtime
                .as_ref()
                .and_then(|runtime| runtime.active_workers.first())
                .and_then(|worker| worker.graceful_signal.as_ref())
                .map(|signal| signal.reason.as_str()),
            Some("draining")
        );
        assert_eq!(
            snapshot
                .worker_runtime
                .as_ref()
                .and_then(|runtime| runtime.projects.first())
                .map(|project| project.project_id.as_str()),
            Some("project-alpha")
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn inspects_completed_runtime_execution_from_files_only_after_terminal_cleanup() {
        let daemon_dir = unique_temp_daemon_dir();
        seed_runtime_execution_files(&daemon_dir);

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
                    accepted_at: 1_710_001_000_090,
                    result_sequence: 900,
                    result_timestamp: 1_710_001_000_100,
                    telegram_egress: None,
                }),
                4,
            ),
        )
        .expect("runtime execution must complete");

        assert_eq!(
            outcome,
            DaemonWorkerRuntimeOutcome::SessionCompleted {
                dispatch_id: "dispatch-runtime".to_string(),
                worker_id: "worker-alpha".to_string(),
                session: WorkerSessionLoopOutcome {
                    frame_count: 2,
                    final_reason: WorkerSessionLoopFinalReason::TerminalResultHandled,
                },
            }
        );
        assert!(runtime_state.is_empty());
        assert!(
            sent_messages
                .lock()
                .expect("sent message lock must not be poisoned")
                .iter()
                .any(|message| message["type"] == "execute")
        );
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending publish outbox must read")
                .is_some()
        );

        let before = collect_file_manifest(&daemon_dir);
        let snapshot = inspect_daemon_diagnostics(DaemonDiagnosticsInput {
            daemon_dir: &daemon_dir,
            inspected_at: 1_710_001_000_400,
            worker_runtime_state: None,
        })
        .expect("runtime diagnostics must inspect");
        let after = collect_file_manifest(&daemon_dir);

        assert_eq!(before, after);
        assert_eq!(snapshot.dispatch_queue.queued_count, 0);
        assert_eq!(snapshot.dispatch_queue.leased_count, 0);
        assert_eq!(snapshot.dispatch_queue.terminal_count, 1);
        assert_eq!(snapshot.dispatch_queue.completed_count, 1);
        assert_eq!(snapshot.dispatch_queue.cancelled_count, 0);
        assert_eq!(snapshot.ral_journal.state_count, 1);
        assert_eq!(snapshot.ral_journal.active_count, 0);
        assert_eq!(snapshot.ral_journal.terminal_count, 1);
        assert_eq!(snapshot.ral_journal.completed_count, 1);
        assert_eq!(snapshot.publish_outbox.pending_count, 1);
        assert_eq!(snapshot.publish_outbox.published_count, 0);
        assert_eq!(snapshot.publish_outbox.failed_count, 0);
        assert!(snapshot.worker_runtime.is_none());

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn fails_closed_on_corrupt_dispatch_queue() {
        let daemon_dir = unique_temp_daemon_dir();
        write_corrupt_dispatch_queue_file(&daemon_dir);

        match inspect_daemon_diagnostics(DaemonDiagnosticsInput {
            daemon_dir: &daemon_dir,
            inspected_at: 1_710_001_000_000,
            worker_runtime_state: None,
        }) {
            Err(DaemonDiagnosticsError::DispatchQueue(
                crate::dispatch_queue::DispatchQueueError::Json { line, .. },
            )) => assert_eq!(line, 2),
            other => panic!("expected corrupt dispatch queue error, got {other:?}"),
        }

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn fails_closed_on_corrupt_ral_journal() {
        let daemon_dir = unique_temp_daemon_dir();
        write_corrupt_ral_journal_file(&daemon_dir);

        match inspect_daemon_diagnostics(DaemonDiagnosticsInput {
            daemon_dir: &daemon_dir,
            inspected_at: 1_710_001_000_000,
            worker_runtime_state: None,
        }) {
            Err(DaemonDiagnosticsError::RalJournal(RalJournalError::JsonLine { line, .. })) => {
                assert_eq!(line, 2)
            }
            other => panic!("expected corrupt RAL journal error, got {other:?}"),
        }

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn does_not_mutate_files_when_inspecting_diagnostics() {
        let daemon_dir = unique_temp_daemon_dir();
        write_publish_outbox_record(
            &daemon_dir,
            "pending",
            serde_json::from_value(
                serde_json::from_str::<Value>(PUBLISH_OUTBOX_FIXTURE)
                    .expect("publish outbox fixture must parse")["records"]["accepted"]
                    .clone(),
            )
            .expect("accepted publish record must parse"),
        );
        write_telegram_outbox_record(
            &daemon_dir,
            "pending",
            serde_json::from_value(
                serde_json::from_str::<Value>(TELEGRAM_OUTBOX_FIXTURE)
                    .expect("telegram outbox fixture must parse")["records"]["pendingHtml"]
                    .clone(),
            )
            .expect("pending telegram record must parse"),
        );

        let before = collect_file_manifest(&daemon_dir);
        let _ = inspect_daemon_diagnostics(DaemonDiagnosticsInput {
            daemon_dir: &daemon_dir,
            inspected_at: 1_710_001_000_000,
            worker_runtime_state: None,
        })
        .expect("diagnostics must inspect");
        let after = collect_file_manifest(&daemon_dir);

        assert_eq!(before, after);

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

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

    fn runtime_agent_pubkey() -> &'static str {
        "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"
    }

    fn seed_runtime_execution_files(daemon_dir: &Path) {
        append_dispatch_queue_record(
            daemon_dir,
            &build_dispatch_queue_record(DispatchQueueRecordParams {
                sequence: 1,
                timestamp: 1_710_001_000_001,
                correlation_id: "lease-dispatch-runtime".to_string(),
                dispatch_id: "dispatch-runtime".to_string(),
                ral: DispatchRalIdentity {
                    project_id: "project-alpha".to_string(),
                    agent_pubkey: runtime_agent_pubkey().to_string(),
                    conversation_id: "conversation-alpha".to_string(),
                    ral_number: 1,
                },
                triggering_event_id: "event-runtime".to_string(),
                claim_token: "claim-runtime".to_string(),
                status: DispatchQueueStatus::Queued,
            }),
        )
        .expect("runtime queued dispatch record must write");
        append_ral_journal_record(
            daemon_dir,
            &RalJournalRecord::new(
                "rust-daemon",
                "test-version",
                1,
                1_710_001_000_001,
                "corr-runtime-allocated",
                RalJournalEvent::Allocated {
                    identity: RalJournalIdentity {
                        project_id: "project-alpha".to_string(),
                        agent_pubkey: runtime_agent_pubkey().to_string(),
                        conversation_id: "conversation-alpha".to_string(),
                        ral_number: 1,
                    },
                    triggering_event_id: Some("event-runtime".to_string()),
                },
            ),
        )
        .expect("runtime allocated RAL record must append");
        append_ral_journal_record(
            daemon_dir,
            &RalJournalRecord::new(
                "rust-daemon",
                "test-version",
                2,
                1_710_001_000_002,
                "corr-runtime-claimed",
                RalJournalEvent::Claimed {
                    identity: RalJournalIdentity {
                        project_id: "project-alpha".to_string(),
                        agent_pubkey: runtime_agent_pubkey().to_string(),
                        conversation_id: "conversation-alpha".to_string(),
                        ral_number: 1,
                    },
                    worker_id: "worker-alpha".to_string(),
                    claim_token: "claim-runtime".to_string(),
                },
            ),
        )
        .expect("runtime claimed RAL record must append");
    }

    fn signed_event_fixture() -> Nip01EventFixture {
        serde_json::from_str(include_str!(
            "../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json"
        ))
        .expect("fixture must parse")
    }

    fn runtime_input<'a>(
        daemon_dir: &'a Path,
        runtime_state: &'a mut WorkerRuntimeState,
        worker_config: &'a AgentWorkerProcessConfig,
        publish: Option<WorkerMessagePublishContext<'a>>,
        max_frames: u64,
    ) -> DaemonWorkerRuntimeInput<'a> {
        DaemonWorkerRuntimeInput {
            daemon_dir,
            runtime_state,
            limits: crate::worker_concurrency::WorkerConcurrencyLimits {
                global: None,
                per_project: None,
                per_agent: None,
            },
            lease_sequence: 2,
            lease_timestamp: 1_710_001_000_010,
            lease_correlation_id: "lease-dispatch-runtime".to_string(),
            execute_sequence: 10,
            execute_timestamp: 1_710_001_000_020,
            project_base_path: "/repo".to_string(),
            metadata_path: "/repo/.tenex/project.json".to_string(),
            triggering_envelope: triggering_envelope("event-runtime"),
            execution_flags: AgentWorkerExecutionFlags {
                is_delegation_completion: false,
                has_pending_delegations: false,
                debug: false,
            },
            lock_owner: build_ral_lock_info(100, "host-alpha", 1_710_001_000_000),
            command: worker_command(),
            worker_config,
            started_at: 1_710_001_000_030,
            frame_observed_at: 1_710_001_000_040,
            publish,
            telegram_egress: None,
            terminal: DaemonWorkerTerminalRuntimeInput {
                journal_sequence: 3,
                journal_timestamp: 1_710_001_000_050,
                writer_version: "test-version".to_string(),
                resolved_pending_delegations: Vec::new(),
                dispatch_sequence: 3,
                dispatch_timestamp: 1_710_001_000_060,
                dispatch_correlation_id: "complete-dispatch-runtime".to_string(),
            },
            max_frames,
        }
    }

    fn worker_config() -> AgentWorkerProcessConfig {
        AgentWorkerProcessConfig {
            boot_timeout: Duration::from_millis(250),
        }
    }

    fn worker_command() -> AgentWorkerCommand {
        AgentWorkerCommand::new("bun")
            .arg("run")
            .arg("src/agents/execution/worker/agent-worker.ts")
            .current_dir("/repo")
            .env("TENEX_AGENT_WORKER_ENGINE", "agent")
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
                "id": format!("nostr:{}", runtime_agent_pubkey()),
                "transport": "nostr",
                "linkedPubkey": runtime_agent_pubkey(),
                "kind": "agent"
            }],
            "content": "hello",
            "occurredAt": 1_710_001_000_000_u64,
            "capabilities": ["reply", "delegate"],
            "metadata": {},
            "conversationId": "conversation-alpha",
            "agentPubkey": runtime_agent_pubkey(),
            "projectId": "project-alpha",
            "source": "nostr"
        })
    }

    fn publish_request_message(fixture: &Nip01EventFixture) -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_request",
            "correlationId": "runtime-alpha-publish",
            "sequence": 20,
            "timestamp": 1_710_001_000_100_u64,
            "projectId": "project-alpha",
            "agentPubkey": runtime_agent_pubkey(),
            "conversationId": "conversation-alpha",
            "ralNumber": 1_u64,
            "requestId": "publish-fixture-01",
            "waitForRelayOk": true,
            "timeoutMs": 30_000_u64,
            "runtimeEventClass": "complete",
            "event": &fixture.signed,
        })
    }

    fn complete_message(final_event_ids: Vec<String>) -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "complete",
            "correlationId": "runtime-alpha",
            "sequence": 21,
            "timestamp": 1_710_001_000_200_u64,
            "projectId": "project-alpha",
            "agentPubkey": runtime_agent_pubkey(),
            "conversationId": "conversation-alpha",
            "ralNumber": 1_u64,
            "finalRalState": "completed",
            "publishedUserVisibleEvent": true,
            "pendingDelegationsRemain": false,
            "accumulatedRuntimeMs": 900_u64,
            "finalEventIds": final_event_ids,
            "keepWorkerWarm": false,
        })
    }

    fn frame_for(message: &Value) -> Vec<u8> {
        encode_agent_worker_protocol_frame(message).expect("message must encode")
    }

    fn ready_message(worker_id: &str) -> AgentWorkerReady {
        AgentWorkerReady {
            worker_id: worker_id.to_string(),
            pid: 123,
            protocol: WorkerProtocolConfig {
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
            },
            message: json!({
                "version": AGENT_WORKER_PROTOCOL_VERSION,
                "type": "ready",
                "correlationId": worker_id,
                "sequence": 1,
                "timestamp": 1_710_001_000_000_u64,
                "workerId": worker_id,
                "pid": 123_u64,
                "protocol": {
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
                },
            }),
        }
    }

    fn write_publish_outbox_record(
        daemon_dir: &Path,
        status_dir: &str,
        record: PublishOutboxRecord,
    ) {
        let path = match status_dir {
            "pending" => pending_publish_outbox_record_path(daemon_dir, &record.event.id),
            "published" => published_publish_outbox_record_path(daemon_dir, &record.event.id),
            "failed" => failed_publish_outbox_record_path(daemon_dir, &record.event.id),
            other => panic!("unsupported publish outbox directory: {other}"),
        };
        write_json_record(&path, &record);
    }

    fn write_telegram_outbox_record(
        daemon_dir: &Path,
        status_dir: &str,
        record: TelegramOutboxRecord,
    ) {
        let path = match status_dir {
            "pending" => pending_telegram_outbox_record_path(daemon_dir, &record.record_id),
            "delivered" => delivered_telegram_outbox_record_path(daemon_dir, &record.record_id),
            "failed" => failed_telegram_outbox_record_path(daemon_dir, &record.record_id),
            other => panic!("unsupported telegram outbox directory: {other}"),
        };
        write_json_record(&path, &record);
    }

    fn write_corrupt_dispatch_queue_file(daemon_dir: &Path) {
        let path = dispatch_queue_path(daemon_dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("dispatch queue dir must be created");
        }
        let valid_head = build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence: 1,
            timestamp: 1,
            correlation_id: "corr-1".to_string(),
            dispatch_id: "dispatch-valid".to_string(),
            ral: DispatchRalIdentity {
                project_id: "project-alpha".to_string(),
                agent_pubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
                conversation_id: "conversation-alpha".to_string(),
                ral_number: 1,
            },
            triggering_event_id: "event-valid".to_string(),
            claim_token: "claim-valid".to_string(),
            status: DispatchQueueStatus::Queued,
        });
        let valid_tail = build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence: 3,
            timestamp: 3,
            correlation_id: "corr-3".to_string(),
            dispatch_id: "dispatch-tail".to_string(),
            ral: DispatchRalIdentity {
                project_id: "project-alpha".to_string(),
                agent_pubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
                conversation_id: "conversation-alpha".to_string(),
                ral_number: 2,
            },
            triggering_event_id: "event-tail".to_string(),
            claim_token: "claim-tail".to_string(),
            status: DispatchQueueStatus::Leased,
        });
        fs::write(
            &path,
            format!(
                "{}\n{{\"schemaVersion\":\n{}\n",
                serde_json::to_string(&valid_head)
                    .expect("valid dispatch head record must serialize"),
                serde_json::to_string(&valid_tail)
                    .expect("valid dispatch tail record must serialize")
            ),
        )
        .expect("corrupt dispatch queue write must succeed");
    }

    fn write_corrupt_ral_journal_file(daemon_dir: &Path) {
        let path = ral_journal_path(daemon_dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("RAL journal dir must be created");
        }
        fs::write(
            &path,
            b"{\"schemaVersion\":1,\"writer\":\"rust-daemon\",\"writerVersion\":\"test-version\",\"sequence\":1,\"timestamp\":1,\"correlationId\":\"corr-1\",\"event\":\"allocated\",\"projectId\":\"project-alpha\",\"agentPubkey\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"conversationId\":\"conversation-alpha\",\"ralNumber\":1}\n{\"schemaVersion\":\n{\"schemaVersion\":1,\"writer\":\"rust-daemon\",\"writerVersion\":\"test-version\",\"sequence\":3,\"timestamp\":3,\"correlationId\":\"corr-3\",\"event\":\"completed\",\"projectId\":\"project-alpha\",\"agentPubkey\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"conversationId\":\"conversation-alpha\",\"ralNumber\":1}\n",
        )
        .expect("corrupt RAL journal write must succeed");
    }

    fn write_json_record(path: &Path, record: &impl Serialize) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("record dir must be created");
        }
        fs::write(
            path,
            serde_json::to_string_pretty(record).expect("record must serialize"),
        )
        .expect("record write must succeed");
    }

    fn collect_file_manifest(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut manifest = Vec::new();
        collect_file_manifest_inner(root, root, &mut manifest);
        manifest.sort_by(|left, right| left.0.cmp(&right.0));
        manifest
    }

    fn collect_file_manifest_inner(
        root: &Path,
        path: &Path,
        manifest: &mut Vec<(PathBuf, Vec<u8>)>,
    ) {
        for entry in fs::read_dir(path).expect("directory must be readable") {
            let entry = entry.expect("directory entry must be readable");
            let entry_path = entry.path();
            if entry_path.is_dir() {
                collect_file_manifest_inner(root, &entry_path, manifest);
            } else {
                let relative = entry_path
                    .strip_prefix(root)
                    .expect("path must be under root")
                    .to_path_buf();
                manifest.push((
                    relative,
                    fs::read(&entry_path).expect("file bytes must be readable"),
                ));
            }
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-daemon-diagnostics-test-{}-{unique}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }
}
