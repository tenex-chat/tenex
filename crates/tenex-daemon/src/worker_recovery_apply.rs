use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::ral_journal::{
    RalJournalError, RalJournalEvent, RalJournalRecord, append_ral_journal_record,
    replay_ral_journal,
};
use crate::ral_scheduler::{RalOrphanReconciliationAction, RalOrphanReconciliationPlan};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerRecoveryApplyInput {
    pub daemon_dir: PathBuf,
    pub records: Vec<RalJournalRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerOrphanReconciliationApplyInput {
    pub daemon_dir: PathBuf,
    pub plan: RalOrphanReconciliationPlan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedWorkerRecovery {
    pub records: Vec<RalJournalRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedWorkerOrphanReconciliation {
    pub actions: Vec<RalOrphanReconciliationAction>,
    pub records: Vec<RalJournalRecord>,
}

#[derive(Debug, Error)]
pub enum WorkerRecoveryApplyError {
    #[error(
        "planned recovery record sequence {sequence} is a {event_type} event, expected crashed"
    )]
    UnexpectedEvent {
        sequence: u64,
        event_type: &'static str,
    },
    #[error(
        "planned recovery record sequence {sequence} is not greater than previous planned sequence {previous_sequence}"
    )]
    NonIncreasingPlannedSequence {
        sequence: u64,
        previous_sequence: u64,
    },
    #[error(
        "planned recovery record sequence {sequence} is not greater than current RAL journal sequence {last_sequence}"
    )]
    StalePlannedSequence { sequence: u64, last_sequence: u64 },
    #[error("failed to replay RAL journal before applying recovery records: {source}")]
    RalReplay {
        #[source]
        source: Box<RalJournalError>,
    },
    #[error(
        "failed to append RAL recovery record after applying {applied_count} records: {source}"
    )]
    RalAppend {
        applied_count: usize,
        applied_records: Vec<RalJournalRecord>,
        #[source]
        source: Box<RalJournalError>,
    },
}

pub fn apply_worker_recovery_records(
    input: WorkerRecoveryApplyInput,
) -> Result<AppliedWorkerRecovery, WorkerRecoveryApplyError> {
    let WorkerRecoveryApplyInput {
        daemon_dir,
        records,
    } = input;

    validate_planned_recovery_records(&daemon_dir, &records)?;

    let mut applied_records = Vec::with_capacity(records.len());
    for record in records {
        if let Err(source) = append_ral_journal_record(&daemon_dir, &record) {
            return Err(WorkerRecoveryApplyError::RalAppend {
                applied_count: applied_records.len(),
                applied_records,
                source: Box::new(source),
            });
        }
        applied_records.push(record);
    }

    Ok(AppliedWorkerRecovery {
        records: applied_records,
    })
}

pub fn apply_worker_orphan_reconciliation(
    input: WorkerOrphanReconciliationApplyInput,
) -> Result<AppliedWorkerOrphanReconciliation, WorkerRecoveryApplyError> {
    let WorkerOrphanReconciliationApplyInput { daemon_dir, plan } = input;
    let records = plan
        .actions
        .iter()
        .map(|action| action.record.clone())
        .collect::<Vec<_>>();

    let applied = apply_worker_recovery_records(WorkerRecoveryApplyInput {
        daemon_dir,
        records,
    })?;

    Ok(AppliedWorkerOrphanReconciliation {
        actions: plan.actions,
        records: applied.records,
    })
}

fn validate_planned_recovery_records(
    daemon_dir: &Path,
    records: &[RalJournalRecord],
) -> Result<(), WorkerRecoveryApplyError> {
    let mut previous_sequence = None;
    for record in records {
        if !matches!(record.event, RalJournalEvent::Crashed { .. }) {
            return Err(WorkerRecoveryApplyError::UnexpectedEvent {
                sequence: record.sequence,
                event_type: ral_journal_event_type(&record.event),
            });
        }

        if let Some(previous_sequence) = previous_sequence
            && record.sequence <= previous_sequence
        {
            return Err(WorkerRecoveryApplyError::NonIncreasingPlannedSequence {
                sequence: record.sequence,
                previous_sequence,
            });
        }
        previous_sequence = Some(record.sequence);
    }

    let Some(first_record) = records.first() else {
        return Ok(());
    };

    let replay =
        replay_ral_journal(daemon_dir).map_err(|source| WorkerRecoveryApplyError::RalReplay {
            source: Box::new(source),
        })?;

    if first_record.sequence <= replay.last_sequence {
        return Err(WorkerRecoveryApplyError::StalePlannedSequence {
            sequence: first_record.sequence,
            last_sequence: replay.last_sequence,
        });
    }

    Ok(())
}

fn ral_journal_event_type(event: &RalJournalEvent) -> &'static str {
    match event {
        RalJournalEvent::Allocated { .. } => "allocated",
        RalJournalEvent::Claimed { .. } => "claimed",
        RalJournalEvent::DelegationRegistered { .. } => "delegation_registered",
        RalJournalEvent::WaitingForDelegation { .. } => "waiting_for_delegation",
        RalJournalEvent::DelegationCompleted { .. } => "delegation_completed",
        RalJournalEvent::DelegationKilled { .. } => "delegation_killed",
        RalJournalEvent::Completed { .. } => "completed",
        RalJournalEvent::NoResponse { .. } => "no_response",
        RalJournalEvent::Error { .. } => "error",
        RalJournalEvent::Aborted { .. } => "aborted",
        RalJournalEvent::Crashed { .. } => "crashed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalIdentity, RalReplayStatus,
        append_ral_journal_record, read_ral_journal_records, replay_ral_journal,
    };
    use crate::ral_scheduler::{
        RalNamespace, RalOrphanReconciliationInput, RalOrphanReconciliationReason, RalScheduler,
    };
    use std::collections::HashSet;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn applies_orphan_reconciliation_plan_to_ral_journal() {
        let daemon_dir = unique_temp_daemon_dir();
        let missing_a = namespace("project-a", "agent-a", "conversation-a");
        let missing_b = namespace("project-b", "agent-b", "conversation-b");
        append_claimed_ral(
            &daemon_dir,
            &missing_b,
            1,
            "trigger-b",
            "worker-b",
            "claim-b",
        );
        append_claimed_ral(
            &daemon_dir,
            &missing_a,
            3,
            "trigger-a",
            "worker-a",
            "claim-a",
        );

        let scheduler = RalScheduler::from_daemon_dir(&daemon_dir).expect("scheduler must replay");
        let plan = scheduler
            .plan_orphan_reconciliation(RalOrphanReconciliationInput {
                live_worker_ids: HashSet::new(),
                next_sequence: 5,
                timestamp: 1710000500000,
                correlation_id: "reconcile-a".to_string(),
                writer_version: "test-version".to_string(),
            })
            .expect("reconciliation plan must build");

        let receipt = apply_worker_orphan_reconciliation(WorkerOrphanReconciliationApplyInput {
            daemon_dir: daemon_dir.clone(),
            plan: plan.clone(),
        })
        .expect("reconciliation records must apply");

        assert_eq!(receipt.actions, plan.actions);
        assert_eq!(
            receipt
                .actions
                .iter()
                .map(|action| action.reason)
                .collect::<Vec<_>>(),
            vec![
                RalOrphanReconciliationReason::ClaimedWorkerMissing,
                RalOrphanReconciliationReason::ClaimedWorkerMissing
            ]
        );
        assert_eq!(
            receipt
                .records
                .iter()
                .map(|record| record.sequence)
                .collect::<Vec<_>>(),
            vec![5, 6]
        );

        let replay = replay_ral_journal(&daemon_dir).expect("journal replay must succeed");
        assert_eq!(replay.last_sequence, 6);
        for identity in [missing_a.identity(1), missing_b.identity(1)] {
            let entry = replay
                .states
                .get(&identity)
                .expect("reconciled RAL must replay");
            assert_eq!(entry.status, RalReplayStatus::Crashed);
            assert_eq!(entry.active_claim_token, None);
            let expected_crash_reason = format!(
                "worker {} was not live during RAL reconciliation",
                entry.worker_id.as_deref().expect("worker id must remain")
            );
            assert_eq!(
                entry.crash_reason.as_deref(),
                Some(expected_crash_reason.as_str())
            );
        }

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn applies_raw_planned_recovery_records_and_reports_applied_records() {
        let daemon_dir = unique_temp_daemon_dir();
        let namespace = namespace("project-a", "agent-a", "conversation-a");
        append_claimed_ral(
            &daemon_dir,
            &namespace,
            1,
            "trigger-a",
            "worker-missing",
            "claim-a",
        );
        let crash_record = crashed_record(
            3,
            namespace.identity(1),
            "worker-missing",
            Some("claim-a"),
            "worker worker-missing was not live during RAL reconciliation",
        );

        let receipt = apply_worker_recovery_records(WorkerRecoveryApplyInput {
            daemon_dir: daemon_dir.clone(),
            records: vec![crash_record.clone()],
        })
        .expect("raw recovery record must apply");

        assert_eq!(receipt.records, vec![crash_record]);
        let replay = replay_ral_journal(&daemon_dir).expect("journal replay must succeed");
        let entry = replay
            .states
            .get(&namespace.identity(1))
            .expect("crashed RAL must replay");
        assert_eq!(entry.status, RalReplayStatus::Crashed);
        assert_eq!(entry.active_claim_token, None);
        assert_eq!(
            entry.crash_reason.as_deref(),
            Some("worker worker-missing was not live during RAL reconciliation")
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn empty_recovery_apply_is_a_noop() {
        let daemon_dir = unique_temp_daemon_dir();

        let receipt = apply_worker_recovery_records(WorkerRecoveryApplyInput {
            daemon_dir: daemon_dir.clone(),
            records: vec![],
        })
        .expect("empty recovery apply must succeed");

        assert!(receipt.records.is_empty());
        assert!(!daemon_dir.exists());
    }

    #[test]
    fn rejects_non_crash_records_without_appending() {
        let daemon_dir = unique_temp_daemon_dir();
        let namespace = namespace("project-a", "agent-a", "conversation-a");
        append_claimed_ral(
            &daemon_dir,
            &namespace,
            1,
            "trigger-a",
            "worker-a",
            "claim-a",
        );
        let invalid = RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            "test-version",
            3,
            1710000500003,
            "correlation-invalid",
            RalJournalEvent::Claimed {
                identity: namespace.identity(1),
                worker_id: "worker-a".to_string(),
                claim_token: "claim-a".to_string(),
            },
        );

        let error = apply_worker_recovery_records(WorkerRecoveryApplyInput {
            daemon_dir: daemon_dir.clone(),
            records: vec![invalid],
        })
        .expect_err("non-crash record must be rejected");

        assert!(matches!(
            error,
            WorkerRecoveryApplyError::UnexpectedEvent {
                sequence: 3,
                event_type: "claimed"
            }
        ));
        assert_eq!(
            read_ral_journal_records(&daemon_dir)
                .expect("journal records must read")
                .len(),
            2
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn rejects_stale_recovery_sequences_without_appending() {
        let daemon_dir = unique_temp_daemon_dir();
        let namespace = namespace("project-a", "agent-a", "conversation-a");
        append_claimed_ral(
            &daemon_dir,
            &namespace,
            1,
            "trigger-a",
            "worker-missing",
            "claim-a",
        );
        let stale = crashed_record(
            2,
            namespace.identity(1),
            "worker-missing",
            Some("claim-a"),
            "stale",
        );

        let error = apply_worker_recovery_records(WorkerRecoveryApplyInput {
            daemon_dir: daemon_dir.clone(),
            records: vec![stale],
        })
        .expect_err("stale record must be rejected");

        assert!(matches!(
            error,
            WorkerRecoveryApplyError::StalePlannedSequence {
                sequence: 2,
                last_sequence: 2
            }
        ));
        assert_eq!(
            replay_ral_journal(&daemon_dir)
                .expect("journal replay must succeed")
                .last_sequence,
            2
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn rejects_non_increasing_planned_sequences_without_appending() {
        let daemon_dir = unique_temp_daemon_dir();
        let namespace = namespace("project-a", "agent-a", "conversation-a");
        append_claimed_ral(
            &daemon_dir,
            &namespace,
            1,
            "trigger-a",
            "worker-missing",
            "claim-a",
        );
        let first = crashed_record(
            4,
            namespace.identity(1),
            "worker-missing",
            Some("claim-a"),
            "first",
        );
        let duplicate = crashed_record(
            4,
            namespace.identity(1),
            "worker-missing",
            Some("claim-a"),
            "duplicate",
        );

        let error = apply_worker_recovery_records(WorkerRecoveryApplyInput {
            daemon_dir: daemon_dir.clone(),
            records: vec![first, duplicate],
        })
        .expect_err("duplicate sequence must be rejected");

        assert!(matches!(
            error,
            WorkerRecoveryApplyError::NonIncreasingPlannedSequence {
                sequence: 4,
                previous_sequence: 4
            }
        ));
        assert_eq!(
            read_ral_journal_records(&daemon_dir)
                .expect("journal records must read")
                .len(),
            2
        );

        cleanup_temp_dir(daemon_dir);
    }

    fn append_claimed_ral(
        daemon_dir: &Path,
        namespace: &RalNamespace,
        first_sequence: u64,
        triggering_event_id: &str,
        worker_id: &str,
        claim_token: &str,
    ) {
        append_ral_journal_record(
            daemon_dir,
            &RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "test-version",
                first_sequence,
                1710000400000 + first_sequence,
                format!("correlation-{first_sequence}"),
                RalJournalEvent::Allocated {
                    identity: namespace.identity(1),
                    triggering_event_id: Some(triggering_event_id.to_string()),
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
                1710000400000 + first_sequence + 1,
                format!("correlation-{}", first_sequence + 1),
                RalJournalEvent::Claimed {
                    identity: namespace.identity(1),
                    worker_id: worker_id.to_string(),
                    claim_token: claim_token.to_string(),
                },
            ),
        )
        .expect("claim record must append");
    }

    fn crashed_record(
        sequence: u64,
        identity: RalJournalIdentity,
        worker_id: &str,
        claim_token: Option<&str>,
        crash_reason: &str,
    ) -> RalJournalRecord {
        RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            "test-version",
            sequence,
            1710000500000 + sequence,
            format!("correlation-recovery-{sequence}"),
            RalJournalEvent::Crashed {
                identity,
                worker_id: worker_id.to_string(),
                claim_token: claim_token.map(ToString::to_string),
                crash_reason: crash_reason.to_string(),
                last_heartbeat_at: None,
            },
        )
    }

    fn namespace(project_id: &str, agent_pubkey: &str, conversation_id: &str) -> RalNamespace {
        RalNamespace {
            project_id: project_id.to_string(),
            agent_pubkey: agent_pubkey.to_string(),
            conversation_id: conversation_id.to_string(),
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "tenex-worker-recovery-apply-test-{nanos}-{counter}"
        ))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if let Err(error) = fs::remove_dir_all(path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            panic!("temp daemon dir cleanup must succeed: {error}");
        }
    }
}
