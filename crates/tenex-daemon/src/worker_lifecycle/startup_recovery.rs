use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;

use thiserror::Error;

use crate::ral_journal::RalJournalError;
use crate::ral_scheduler::{
    RalOrphanReconciliationInput, RalOrphanReconciliationPlan, RalScheduler, RalSchedulerError,
};
use crate::worker_lifecycle::recovery_apply::{
    AppliedWorkerOrphanReconciliation, WorkerOrphanReconciliationApplyInput,
    WorkerRecoveryApplyError, apply_worker_orphan_reconciliation,
};
use crate::worker_runtime_state::ActiveWorkerRuntimeSnapshot;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerStartupRecoveryLiveWorkers {
    WorkerIds(BTreeSet<String>),
    RuntimeSnapshots(Vec<ActiveWorkerRuntimeSnapshot>),
}

impl WorkerStartupRecoveryLiveWorkers {
    pub fn from_worker_ids<I, S>(worker_ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self::WorkerIds(worker_ids.into_iter().map(Into::into).collect())
    }

    pub fn from_runtime_snapshots<I>(runtime_snapshots: I) -> Self
    where
        I: IntoIterator<Item = ActiveWorkerRuntimeSnapshot>,
    {
        Self::RuntimeSnapshots(runtime_snapshots.into_iter().collect())
    }

    pub fn worker_ids(&self) -> BTreeSet<String> {
        match self {
            Self::WorkerIds(worker_ids) => worker_ids.clone(),
            Self::RuntimeSnapshots(runtime_snapshots) => runtime_snapshots
                .iter()
                .map(|snapshot| snapshot.worker_id.clone())
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerStartupRecoveryInput {
    pub daemon_dir: PathBuf,
    pub live_workers: WorkerStartupRecoveryLiveWorkers,
    pub timestamp: u64,
    pub correlation_id: String,
    pub writer_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerStartupRecoveryPlan {
    pub daemon_dir: PathBuf,
    pub live_worker_ids: BTreeSet<String>,
    pub scheduler_last_sequence: u64,
    pub reconciliation_input: RalOrphanReconciliationInput,
    pub reconciliation_plan: RalOrphanReconciliationPlan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerStartupRecoveryOutcome {
    NoOrphans {
        plan: WorkerStartupRecoveryPlan,
    },
    Applied {
        plan: WorkerStartupRecoveryPlan,
        applied: AppliedWorkerOrphanReconciliation,
    },
}

#[derive(Debug, Error)]
pub enum WorkerStartupRecoveryError {
    #[error("failed to replay RAL scheduler from filesystem: {source}")]
    SchedulerReplay {
        #[source]
        source: Box<RalJournalError>,
    },
    #[error(
        "startup recovery cannot derive a next RAL journal sequence after replay sequence {last_sequence}"
    )]
    SequenceExhausted { last_sequence: u64 },
    #[error("failed to plan startup recovery from live workers: {source}")]
    Planning {
        #[source]
        source: Box<RalSchedulerError>,
    },
    #[error("failed to apply planned startup recovery records: {source}")]
    Apply {
        #[source]
        source: Box<WorkerRecoveryApplyError>,
    },
}

pub fn plan_worker_startup_recovery(
    input: WorkerStartupRecoveryInput,
) -> Result<WorkerStartupRecoveryPlan, WorkerStartupRecoveryError> {
    let WorkerStartupRecoveryInput {
        daemon_dir,
        live_workers,
        timestamp,
        correlation_id,
        writer_version,
    } = input;

    let scheduler = RalScheduler::from_daemon_dir(&daemon_dir).map_err(|source| {
        WorkerStartupRecoveryError::SchedulerReplay {
            source: Box::new(source),
        }
    })?;
    let live_worker_ids = live_workers.worker_ids();
    let next_sequence = scheduler.state().last_sequence.checked_add(1).ok_or(
        WorkerStartupRecoveryError::SequenceExhausted {
            last_sequence: scheduler.state().last_sequence,
        },
    )?;

    let reconciliation_input = RalOrphanReconciliationInput {
        live_worker_ids: live_worker_ids.iter().cloned().collect::<HashSet<_>>(),
        next_sequence,
        timestamp,
        correlation_id,
        writer_version,
    };
    let reconciliation_plan = scheduler
        .plan_orphan_reconciliation(reconciliation_input.clone())
        .map_err(|source| WorkerStartupRecoveryError::Planning {
            source: Box::new(source),
        })?;

    Ok(WorkerStartupRecoveryPlan {
        daemon_dir,
        live_worker_ids,
        scheduler_last_sequence: scheduler.state().last_sequence,
        reconciliation_input,
        reconciliation_plan,
    })
}

pub fn recover_worker_startup(
    input: WorkerStartupRecoveryInput,
) -> Result<WorkerStartupRecoveryOutcome, WorkerStartupRecoveryError> {
    let plan = plan_worker_startup_recovery(input)?;

    if plan.reconciliation_plan.actions.is_empty() {
        return Ok(WorkerStartupRecoveryOutcome::NoOrphans { plan });
    }

    let applied = apply_worker_orphan_reconciliation(WorkerOrphanReconciliationApplyInput {
        daemon_dir: plan.daemon_dir.clone(),
        plan: plan.reconciliation_plan.clone(),
    })
    .map_err(|source| WorkerStartupRecoveryError::Apply {
        source: Box::new(source),
    })?;

    Ok(WorkerStartupRecoveryOutcome::Applied { plan, applied })
}

pub fn live_worker_ids_from_snapshots(
    runtime_snapshots: &[ActiveWorkerRuntimeSnapshot],
) -> BTreeSet<String> {
    runtime_snapshots
        .iter()
        .map(|snapshot| snapshot.worker_id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
        RalReplayStatus, append_ral_journal_record, replay_ral_journal,
    };
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn startup_recovery_applies_crash_records_for_missing_workers() {
        let daemon_dir = unique_temp_daemon_dir();
        let live_identity = identity("project-a", "agent-a", "conversation-a", 1);
        let missing_identity = identity("project-b", "agent-b", "conversation-b", 1);
        append_claimed_ral(
            &daemon_dir,
            1,
            live_identity.clone(),
            "worker-live",
            "claim-live",
        );
        append_claimed_ral(
            &daemon_dir,
            3,
            missing_identity.clone(),
            "worker-missing",
            "claim-missing",
        );

        let outcome = recover_worker_startup(WorkerStartupRecoveryInput {
            daemon_dir: daemon_dir.clone(),
            live_workers: WorkerStartupRecoveryLiveWorkers::from_worker_ids(["worker-live"]),
            timestamp: 1710000600000,
            correlation_id: "startup-recovery".to_string(),
            writer_version: "test-version".to_string(),
        })
        .expect("startup recovery must succeed");

        match outcome {
            WorkerStartupRecoveryOutcome::Applied { plan, applied } => {
                assert_eq!(
                    plan.live_worker_ids,
                    ["worker-live".to_string()]
                        .into_iter()
                        .collect::<BTreeSet<_>>()
                );
                assert_eq!(plan.scheduler_last_sequence, 4);
                assert_eq!(plan.reconciliation_plan.actions.len(), 1);
                assert_eq!(applied.actions, plan.reconciliation_plan.actions);
                assert_eq!(applied.records.len(), 1);
                assert_eq!(applied.records[0].sequence, 5);
            }
            other => panic!("expected applied recovery, got {other:?}"),
        }

        let replay = replay_ral_journal(&daemon_dir).expect("journal replay must succeed");
        assert_eq!(replay.last_sequence, 5);
        let crashed = replay
            .states
            .get(&missing_identity)
            .expect("missing RAL must be reconciled");
        assert_eq!(crashed.status, RalReplayStatus::Crashed);
        assert_eq!(crashed.active_claim_token, None);
        assert_eq!(
            crashed.crash_reason.as_deref(),
            Some("worker worker-missing was not live during RAL reconciliation")
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn startup_recovery_accepts_runtime_snapshots() {
        let daemon_dir = unique_temp_daemon_dir();
        let live_identity = identity("project-a", "agent-a", "conversation-a", 1);
        let missing_identity = identity("project-a", "agent-b", "conversation-a", 1);
        append_claimed_ral(
            &daemon_dir,
            1,
            live_identity.clone(),
            "worker-live",
            "claim-live",
        );
        append_claimed_ral(
            &daemon_dir,
            3,
            missing_identity.clone(),
            "worker-missing",
            "claim-missing",
        );

        let outcome = recover_worker_startup(WorkerStartupRecoveryInput {
            daemon_dir: daemon_dir.clone(),
            live_workers: WorkerStartupRecoveryLiveWorkers::from_runtime_snapshots(vec![
                runtime_snapshot("worker-live", &live_identity, "dispatch-live"),
            ]),
            timestamp: 1710000601000,
            correlation_id: "startup-recovery-snapshot".to_string(),
            writer_version: "test-version".to_string(),
        })
        .expect("startup recovery must succeed");

        match outcome {
            WorkerStartupRecoveryOutcome::Applied { plan, applied } => {
                assert_eq!(
                    plan.live_worker_ids,
                    ["worker-live".to_string()]
                        .into_iter()
                        .collect::<BTreeSet<_>>()
                );
                assert_eq!(plan.reconciliation_input.timestamp, 1710000601000);
                assert_eq!(
                    plan.reconciliation_input.correlation_id,
                    "startup-recovery-snapshot"
                );
                assert_eq!(plan.reconciliation_plan.actions.len(), 1);
                assert_eq!(applied.records[0].sequence, 5);
            }
            other => panic!("expected applied recovery, got {other:?}"),
        }

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn startup_recovery_returns_no_orphans_for_live_claims() {
        let daemon_dir = unique_temp_daemon_dir();
        let identity = identity("project-a", "agent-a", "conversation-a", 1);
        append_claimed_ral(
            &daemon_dir,
            1,
            identity.clone(),
            "worker-live",
            "claim-live",
        );

        let outcome = recover_worker_startup(WorkerStartupRecoveryInput {
            daemon_dir: daemon_dir.clone(),
            live_workers: WorkerStartupRecoveryLiveWorkers::from_worker_ids(["worker-live"]),
            timestamp: 1710000602000,
            correlation_id: "startup-recovery-empty".to_string(),
            writer_version: "test-version".to_string(),
        })
        .expect("startup recovery must succeed");

        match outcome {
            WorkerStartupRecoveryOutcome::NoOrphans { plan } => {
                assert_eq!(
                    plan.live_worker_ids,
                    ["worker-live".to_string()]
                        .into_iter()
                        .collect::<BTreeSet<_>>()
                );
                assert!(plan.reconciliation_plan.actions.is_empty());
                assert_eq!(plan.scheduler_last_sequence, 2);
            }
            other => panic!("expected no-orphans recovery, got {other:?}"),
        }

        let replay = replay_ral_journal(&daemon_dir).expect("journal replay must succeed");
        assert_eq!(replay.last_sequence, 2);
        assert_eq!(
            replay
                .states
                .get(&identity)
                .expect("RAL must still replay")
                .status,
            RalReplayStatus::Claimed
        );

        cleanup_temp_dir(daemon_dir);
    }

    fn append_claimed_ral(
        daemon_dir: &Path,
        first_sequence: u64,
        identity: RalJournalIdentity,
        worker_id: &str,
        claim_token: &str,
    ) {
        append_ral_journal_record(
            daemon_dir,
            &RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "test-version",
                first_sequence,
                1710000500000 + first_sequence,
                format!("correlation-{first_sequence}"),
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some(format!("trigger-{}", first_sequence)),
                },
            ),
        )
        .expect("allocation record must append");

        append_ral_journal_record(
            daemon_dir,
            &RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "test-version",
                first_sequence + 1,
                1710000500000 + first_sequence + 1,
                format!("correlation-{}", first_sequence + 1),
                RalJournalEvent::Claimed {
                    identity,
                    worker_id: worker_id.to_string(),
                    claim_token: claim_token.to_string(),
                },
            ),
        )
        .expect("claim record must append");
    }

    fn runtime_snapshot(
        worker_id: &str,
        identity: &RalJournalIdentity,
        dispatch_id: &str,
    ) -> ActiveWorkerRuntimeSnapshot {
        ActiveWorkerRuntimeSnapshot {
            worker_id: worker_id.to_string(),
            pid: 9001,
            dispatch_id: dispatch_id.to_string(),
            identity: identity.clone(),
            claim_token: "claim-live".to_string(),
            started_at: 1710000500100,
            last_heartbeat: None,
            graceful_signal: None,
        }
    }

    fn identity(
        project_id: &str,
        agent_pubkey: &str,
        conversation_id: &str,
        ral_number: u64,
    ) -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: project_id.to_string(),
            agent_pubkey: agent_pubkey.to_string(),
            conversation_id: conversation_id.to_string(),
            ral_number,
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let suffix = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-worker-startup-recovery-{pid}-{millis}-{suffix}"
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must create");
        daemon_dir
    }

    fn cleanup_temp_dir(daemon_dir: PathBuf) {
        if daemon_dir.exists() {
            fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
        }
    }
}
