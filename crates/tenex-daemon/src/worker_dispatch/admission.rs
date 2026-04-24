use thiserror::Error;

use crate::dispatch_queue::{
    DispatchQueueError, DispatchQueueLifecycleInput, DispatchQueueRecord, DispatchQueueState,
    plan_dispatch_queue_lease,
};
use crate::worker_concurrency::{
    ActiveDispatchConcurrencySnapshot, ActiveWorkerConcurrencySnapshot,
    WorkerConcurrencyBlockReason, WorkerConcurrencyCounts, WorkerConcurrencyDecision,
    WorkerConcurrencyLimits, WorkerConcurrencyPlanInput, WorkerConcurrencyTarget,
    plan_worker_concurrency,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerDispatchAdmissionInput<'a> {
    pub dispatch_state: &'a DispatchQueueState,
    pub active_workers: &'a [ActiveWorkerConcurrencySnapshot],
    pub active_dispatches: &'a [ActiveDispatchConcurrencySnapshot],
    pub limits: WorkerConcurrencyLimits,
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerDispatchAdmissionPlan {
    Admitted(Box<AdmittedWorkerDispatch>),
    NotAdmitted {
        reason: WorkerDispatchAdmissionBlockedReason,
        blocked_candidates: Vec<WorkerDispatchAdmissionBlockedCandidate>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmittedWorkerDispatch {
    pub selected_dispatch: DispatchQueueRecord,
    pub leased_record: DispatchQueueRecord,
    pub concurrency_counts: WorkerConcurrencyCounts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerDispatchAdmissionBlockedReason {
    NoQueuedDispatches,
    AllQueuedDispatchesBlockedByConcurrency,
    SelectedDispatchBlockedByLaunchLock,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerDispatchAdmissionBlockedCandidate {
    pub dispatch_id: String,
    pub reason: WorkerConcurrencyBlockReason,
    pub counts: WorkerConcurrencyCounts,
}

#[derive(Debug, Error)]
pub enum WorkerDispatchAdmissionError {
    #[error("dispatch queue error while planning dispatch admission: {source}")]
    DispatchQueue { source: Box<DispatchQueueError> },
}

pub type WorkerDispatchAdmissionResult<T> = Result<T, WorkerDispatchAdmissionError>;

pub fn plan_worker_dispatch_admission(
    input: WorkerDispatchAdmissionInput<'_>,
) -> WorkerDispatchAdmissionResult<WorkerDispatchAdmissionPlan> {
    let mut queued = input.dispatch_state.queued.iter().collect::<Vec<_>>();
    queued.sort_by(|left, right| {
        left.sequence
            .cmp(&right.sequence)
            .then_with(|| left.dispatch_id.cmp(&right.dispatch_id))
    });

    if queued.is_empty() {
        return Ok(WorkerDispatchAdmissionPlan::NotAdmitted {
            reason: WorkerDispatchAdmissionBlockedReason::NoQueuedDispatches,
            blocked_candidates: Vec::new(),
        });
    }

    let active_dispatches = active_dispatches_with_leased_queue(&input);
    let mut blocked_candidates = Vec::new();

    for dispatch in queued {
        let target = WorkerConcurrencyTarget::from_dispatch(dispatch);
        match plan_worker_concurrency(WorkerConcurrencyPlanInput {
            target: &target,
            active_workers: input.active_workers,
            active_dispatches: &active_dispatches,
            limits: input.limits,
        }) {
            WorkerConcurrencyDecision::StartAllowed { counts } => {
                let leased_record = plan_dispatch_queue_lease(
                    input.dispatch_state,
                    DispatchQueueLifecycleInput {
                        dispatch_id: dispatch.dispatch_id.clone(),
                        sequence: input.sequence,
                        timestamp: input.timestamp,
                        correlation_id: input.correlation_id,
                    },
                )?;

                return Ok(WorkerDispatchAdmissionPlan::Admitted(Box::new(
                    AdmittedWorkerDispatch {
                        selected_dispatch: dispatch.clone(),
                        leased_record,
                        concurrency_counts: counts,
                    },
                )));
            }
            WorkerConcurrencyDecision::Blocked { reason, counts } => {
                blocked_candidates.push(WorkerDispatchAdmissionBlockedCandidate {
                    dispatch_id: dispatch.dispatch_id.clone(),
                    reason,
                    counts,
                });
            }
        }
    }

    Ok(WorkerDispatchAdmissionPlan::NotAdmitted {
        reason: WorkerDispatchAdmissionBlockedReason::AllQueuedDispatchesBlockedByConcurrency,
        blocked_candidates,
    })
}

fn active_dispatches_with_leased_queue(
    input: &WorkerDispatchAdmissionInput<'_>,
) -> Vec<ActiveDispatchConcurrencySnapshot> {
    let mut active_dispatches = input.active_dispatches.to_vec();
    active_dispatches.extend(
        input
            .dispatch_state
            .leased
            .iter()
            .map(ActiveDispatchConcurrencySnapshot::from_dispatch),
    );
    active_dispatches
}

impl From<DispatchQueueError> for WorkerDispatchAdmissionError {
    fn from(source: DispatchQueueError) -> Self {
        Self::DispatchQueue {
            source: Box::new(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        build_dispatch_queue_record,
    };

    #[test]
    fn admits_oldest_allowed_dispatch_and_plans_lease() {
        let oldest = dispatch_record(2, "dispatch-oldest", "project-a", "agent-a");
        let newest = dispatch_record(3, "dispatch-newest", "project-a", "agent-a");
        let state = DispatchQueueState {
            last_sequence: 3,
            queued: vec![newest.clone(), oldest.clone()],
            leased: Vec::new(),
            terminal: Vec::new(),
        };

        let plan = plan_worker_dispatch_admission(input(
            &state,
            &[],
            &[],
            WorkerConcurrencyLimits {
                global: Some(1),
                per_project: Some(1),
                per_agent: Some(1),
            },
            4,
        ))
        .expect("admission must plan");

        assert_eq!(
            plan,
            WorkerDispatchAdmissionPlan::Admitted(Box::new(AdmittedWorkerDispatch {
                selected_dispatch: oldest.clone(),
                leased_record: build_dispatch_queue_record(DispatchQueueRecordParams {
                    sequence: 4,
                    timestamp: 1_710_000_000_004,
                    correlation_id: "admit-correlation".to_string(),
                    dispatch_id: oldest.dispatch_id.clone(),
                    ral: oldest.ral.clone(),
                    triggering_event_id: oldest.triggering_event_id.clone(),
                    claim_token: oldest.claim_token.clone(),
                    status: DispatchQueueStatus::Leased,
                }),
                concurrency_counts: WorkerConcurrencyCounts::default(),
            }))
        );
    }

    #[test]
    fn skips_blocked_candidate_and_leases_next_allowed_dispatch() {
        let blocked = dispatch_record(1, "dispatch-blocked", "project-a", "agent-a");
        let allowed = dispatch_record(2, "dispatch-allowed", "project-b", "agent-b");
        let state = DispatchQueueState {
            last_sequence: 2,
            queued: vec![blocked, allowed.clone()],
            leased: Vec::new(),
            terminal: Vec::new(),
        };
        let active_workers = [active_worker(
            "worker-a",
            Some("dispatch-active"),
            "project-a",
            "agent-a",
        )];

        let plan = plan_worker_dispatch_admission(input(
            &state,
            &active_workers,
            &[],
            WorkerConcurrencyLimits {
                global: Some(10),
                per_project: Some(1),
                per_agent: Some(10),
            },
            3,
        ))
        .expect("admission must skip blocked candidate");

        match plan {
            WorkerDispatchAdmissionPlan::Admitted(admitted) => {
                let AdmittedWorkerDispatch {
                    selected_dispatch,
                    leased_record,
                    concurrency_counts,
                } = *admitted;
                assert_eq!(selected_dispatch, allowed);
                assert_eq!(leased_record.dispatch_id, "dispatch-allowed");
                assert_eq!(leased_record.status, DispatchQueueStatus::Leased);
                assert_eq!(
                    concurrency_counts,
                    WorkerConcurrencyCounts {
                        global: 1,
                        project: 0,
                        agent: 0,
                    }
                );
            }
            other => panic!("expected admitted plan, got {other:?}"),
        }
    }

    #[test]
    fn reports_no_queued_dispatches() {
        let state = DispatchQueueState {
            last_sequence: 1,
            queued: Vec::new(),
            leased: vec![
                dispatch_record(1, "dispatch-leased", "project-a", "agent-a")
                    .with_status(DispatchQueueStatus::Leased),
            ],
            terminal: Vec::new(),
        };

        let plan = plan_worker_dispatch_admission(input(
            &state,
            &[],
            &[],
            WorkerConcurrencyLimits::default(),
            2,
        ))
        .expect("empty queue must be a plan");

        assert_eq!(
            plan,
            WorkerDispatchAdmissionPlan::NotAdmitted {
                reason: WorkerDispatchAdmissionBlockedReason::NoQueuedDispatches,
                blocked_candidates: Vec::new(),
            }
        );
    }

    #[test]
    fn reports_all_blocked_candidates_in_queue_order() {
        let first = dispatch_record(1, "dispatch-a", "project-a", "agent-a");
        let second = dispatch_record(2, "dispatch-b", "project-b", "agent-b");
        let state = DispatchQueueState {
            last_sequence: 2,
            queued: vec![second, first],
            leased: Vec::new(),
            terminal: Vec::new(),
        };

        let plan = plan_worker_dispatch_admission(input(
            &state,
            &[],
            &[],
            WorkerConcurrencyLimits {
                global: Some(0),
                per_project: None,
                per_agent: None,
            },
            3,
        ))
        .expect("blocked queue must be a plan");

        assert_eq!(
            plan,
            WorkerDispatchAdmissionPlan::NotAdmitted {
                reason:
                    WorkerDispatchAdmissionBlockedReason::AllQueuedDispatchesBlockedByConcurrency,
                blocked_candidates: vec![
                    WorkerDispatchAdmissionBlockedCandidate {
                        dispatch_id: "dispatch-a".to_string(),
                        reason: WorkerConcurrencyBlockReason::GlobalLimitReached { limit: 0 },
                        counts: WorkerConcurrencyCounts::default(),
                    },
                    WorkerDispatchAdmissionBlockedCandidate {
                        dispatch_id: "dispatch-b".to_string(),
                        reason: WorkerConcurrencyBlockReason::GlobalLimitReached { limit: 0 },
                        counts: WorkerConcurrencyCounts::default(),
                    },
                ],
            }
        );
    }

    #[test]
    fn counts_leased_queue_records_as_active_dispatches() {
        let queued = dispatch_record(1, "dispatch-queued", "project-a", "agent-b");
        let leased = dispatch_record(2, "dispatch-leased", "project-a", "agent-a")
            .with_status(DispatchQueueStatus::Leased);
        let state = DispatchQueueState {
            last_sequence: 2,
            queued: vec![queued],
            leased: vec![leased],
            terminal: Vec::new(),
        };

        let plan = plan_worker_dispatch_admission(input(
            &state,
            &[],
            &[],
            WorkerConcurrencyLimits {
                global: Some(10),
                per_project: Some(1),
                per_agent: Some(10),
            },
            3,
        ))
        .expect("blocked queue must be a plan");

        assert_eq!(
            plan,
            WorkerDispatchAdmissionPlan::NotAdmitted {
                reason:
                    WorkerDispatchAdmissionBlockedReason::AllQueuedDispatchesBlockedByConcurrency,
                blocked_candidates: vec![WorkerDispatchAdmissionBlockedCandidate {
                    dispatch_id: "dispatch-queued".to_string(),
                    reason: WorkerConcurrencyBlockReason::ProjectLimitReached {
                        project_id: "project-a".to_string(),
                        limit: 1,
                    },
                    counts: WorkerConcurrencyCounts {
                        global: 1,
                        project: 1,
                        agent: 0,
                    },
                }],
            }
        );
    }

    #[test]
    fn skips_same_conversation_candidate_and_admits_next_available_dispatch() {
        let blocked = dispatch_record_with_conversation(
            1,
            "dispatch-blocked",
            "project-a",
            "agent-a",
            "conversation-a",
        );
        let allowed = dispatch_record_with_conversation(
            2,
            "dispatch-allowed",
            "project-a",
            "agent-a",
            "conversation-b",
        );
        let state = DispatchQueueState {
            last_sequence: 2,
            queued: vec![allowed.clone(), blocked],
            leased: Vec::new(),
            terminal: Vec::new(),
        };
        let active_workers = [active_worker_with_conversation(
            "worker-a",
            Some("dispatch-active"),
            "project-a",
            "agent-a",
            "conversation-a",
        )];

        let plan = plan_worker_dispatch_admission(input(
            &state,
            &active_workers,
            &[],
            WorkerConcurrencyLimits::default(),
            3,
        ))
        .expect("admission must skip same-conversation candidate");

        match plan {
            WorkerDispatchAdmissionPlan::Admitted(admitted) => {
                assert_eq!(admitted.selected_dispatch, allowed);
                assert_eq!(admitted.leased_record.dispatch_id, "dispatch-allowed");
            }
            other => panic!("expected admitted plan, got {other:?}"),
        }
    }

    #[test]
    fn reports_same_conversation_leased_dispatch_as_blocked_candidate() {
        let queued = dispatch_record_with_conversation(
            1,
            "dispatch-queued",
            "project-a",
            "agent-a",
            "conversation-a",
        );
        let leased = dispatch_record_with_conversation(
            2,
            "dispatch-leased",
            "project-a",
            "agent-a",
            "conversation-a",
        )
        .with_status(DispatchQueueStatus::Leased);
        let state = DispatchQueueState {
            last_sequence: 2,
            queued: vec![queued],
            leased: vec![leased],
            terminal: Vec::new(),
        };

        let plan = plan_worker_dispatch_admission(input(
            &state,
            &[],
            &[],
            WorkerConcurrencyLimits::default(),
            3,
        ))
        .expect("same-conversation leased dispatch must block admission");

        assert_eq!(
            plan,
            WorkerDispatchAdmissionPlan::NotAdmitted {
                reason:
                    WorkerDispatchAdmissionBlockedReason::AllQueuedDispatchesBlockedByConcurrency,
                blocked_candidates: vec![WorkerDispatchAdmissionBlockedCandidate {
                    dispatch_id: "dispatch-queued".to_string(),
                    reason: WorkerConcurrencyBlockReason::ConversationAlreadyActive {
                        project_id: "project-a".to_string(),
                        agent_pubkey: "agent-a".to_string(),
                        conversation_id: "conversation-a".to_string(),
                        dispatch_id: Some("dispatch-leased".to_string()),
                        worker_id: None,
                    },
                    counts: WorkerConcurrencyCounts {
                        global: 1,
                        project: 1,
                        agent: 1,
                    },
                }],
            }
        );
    }

    #[test]
    fn propagates_lease_planning_errors_for_allowed_candidate() {
        let state = DispatchQueueState {
            last_sequence: 2,
            queued: vec![dispatch_record(1, "dispatch-a", "project-a", "agent-a")],
            leased: Vec::new(),
            terminal: Vec::new(),
        };

        let error = plan_worker_dispatch_admission(input(
            &state,
            &[],
            &[],
            WorkerConcurrencyLimits::default(),
            2,
        ))
        .expect_err("stale lease sequence must fail");

        match error {
            WorkerDispatchAdmissionError::DispatchQueue { source } => {
                assert!(matches!(
                    *source,
                    DispatchQueueError::NonIncreasingSequence {
                        sequence: 2,
                        previous_sequence: 2,
                    }
                ));
            }
        }
    }

    fn input<'a>(
        dispatch_state: &'a DispatchQueueState,
        active_workers: &'a [ActiveWorkerConcurrencySnapshot],
        active_dispatches: &'a [ActiveDispatchConcurrencySnapshot],
        limits: WorkerConcurrencyLimits,
        sequence: u64,
    ) -> WorkerDispatchAdmissionInput<'a> {
        WorkerDispatchAdmissionInput {
            dispatch_state,
            active_workers,
            active_dispatches,
            limits,
            sequence,
            timestamp: 1_710_000_000_000 + sequence,
            correlation_id: "admit-correlation".to_string(),
        }
    }

    fn dispatch_record(
        sequence: u64,
        dispatch_id: &str,
        project_id: &str,
        agent_pubkey: &str,
    ) -> DispatchQueueRecord {
        dispatch_record_with_conversation(
            sequence,
            dispatch_id,
            project_id,
            agent_pubkey,
            "conversation-a",
        )
    }

    fn dispatch_record_with_conversation(
        sequence: u64,
        dispatch_id: &str,
        project_id: &str,
        agent_pubkey: &str,
        conversation_id: &str,
    ) -> DispatchQueueRecord {
        build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence,
            timestamp: 1_710_000_000_000 + sequence,
            correlation_id: format!("correlation-{sequence}"),
            dispatch_id: dispatch_id.to_string(),
            ral: DispatchRalIdentity {
                project_id: project_id.to_string(),
                agent_pubkey: agent_pubkey.to_string(),
                conversation_id: conversation_id.to_string(),
                ral_number: 7,
            },
            triggering_event_id: format!("event-{sequence}"),
            claim_token: format!("claim-{sequence}"),
            status: DispatchQueueStatus::Queued,
        })
    }

    fn active_worker(
        worker_id: &str,
        dispatch_id: Option<&str>,
        project_id: &str,
        agent_pubkey: &str,
    ) -> ActiveWorkerConcurrencySnapshot {
        active_worker_with_conversation(
            worker_id,
            dispatch_id,
            project_id,
            agent_pubkey,
            "conversation-a",
        )
    }

    fn active_worker_with_conversation(
        worker_id: &str,
        dispatch_id: Option<&str>,
        project_id: &str,
        agent_pubkey: &str,
        conversation_id: &str,
    ) -> ActiveWorkerConcurrencySnapshot {
        ActiveWorkerConcurrencySnapshot {
            worker_id: worker_id.to_string(),
            dispatch_id: dispatch_id.map(str::to_string),
            project_id: project_id.to_string(),
            agent_pubkey: agent_pubkey.to_string(),
            conversation_id: conversation_id.to_string(),
        }
    }

    trait DispatchRecordTestExt {
        fn with_status(self, status: DispatchQueueStatus) -> Self;
    }

    impl DispatchRecordTestExt for DispatchQueueRecord {
        fn with_status(mut self, status: DispatchQueueStatus) -> Self {
            self.status = status;
            self
        }
    }
}
