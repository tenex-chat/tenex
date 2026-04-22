use std::collections::{BTreeMap, BTreeSet};

use crate::dispatch_queue::DispatchQueueRecord;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerConcurrencyTarget {
    pub dispatch_id: String,
    pub project_id: String,
    pub agent_pubkey: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveWorkerConcurrencySnapshot {
    pub worker_id: String,
    pub dispatch_id: Option<String>,
    pub project_id: String,
    pub agent_pubkey: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveDispatchConcurrencySnapshot {
    pub dispatch_id: String,
    pub project_id: String,
    pub agent_pubkey: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WorkerConcurrencyLimits {
    pub global: Option<u64>,
    pub per_project: Option<u64>,
    pub per_agent: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerConcurrencyPlanInput<'a> {
    pub target: &'a WorkerConcurrencyTarget,
    pub active_workers: &'a [ActiveWorkerConcurrencySnapshot],
    pub active_dispatches: &'a [ActiveDispatchConcurrencySnapshot],
    pub limits: WorkerConcurrencyLimits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WorkerConcurrencyCounts {
    pub global: u64,
    pub project: u64,
    pub agent: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerConcurrencyDecision {
    StartAllowed {
        counts: WorkerConcurrencyCounts,
    },
    Blocked {
        reason: WorkerConcurrencyBlockReason,
        counts: WorkerConcurrencyCounts,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerConcurrencyBlockReason {
    CandidateAlreadyActive {
        dispatch_id: String,
        worker_id: String,
    },
    GlobalLimitReached {
        limit: u64,
    },
    ProjectLimitReached {
        project_id: String,
        limit: u64,
    },
    AgentLimitReached {
        project_id: String,
        agent_pubkey: String,
        limit: u64,
    },
}

impl WorkerConcurrencyTarget {
    pub fn from_dispatch(dispatch: &DispatchQueueRecord) -> Self {
        Self {
            dispatch_id: dispatch.dispatch_id.clone(),
            project_id: dispatch.ral.project_id.clone(),
            agent_pubkey: dispatch.ral.agent_pubkey.clone(),
        }
    }
}

impl ActiveDispatchConcurrencySnapshot {
    pub fn from_dispatch(dispatch: &DispatchQueueRecord) -> Self {
        Self {
            dispatch_id: dispatch.dispatch_id.clone(),
            project_id: dispatch.ral.project_id.clone(),
            agent_pubkey: dispatch.ral.agent_pubkey.clone(),
        }
    }
}

pub fn plan_worker_concurrency(input: WorkerConcurrencyPlanInput<'_>) -> WorkerConcurrencyDecision {
    let counts =
        count_active_executions(input.target, input.active_workers, input.active_dispatches);

    if let Some(worker) = input
        .active_workers
        .iter()
        .find(|worker| worker.dispatch_id.as_deref() == Some(input.target.dispatch_id.as_str()))
    {
        return WorkerConcurrencyDecision::Blocked {
            reason: WorkerConcurrencyBlockReason::CandidateAlreadyActive {
                dispatch_id: input.target.dispatch_id.clone(),
                worker_id: worker.worker_id.clone(),
            },
            counts,
        };
    }

    if let Some(limit) = input.limits.global
        && counts.global >= limit
    {
        return WorkerConcurrencyDecision::Blocked {
            reason: WorkerConcurrencyBlockReason::GlobalLimitReached { limit },
            counts,
        };
    }

    if let Some(limit) = input.limits.per_project
        && counts.project >= limit
    {
        return WorkerConcurrencyDecision::Blocked {
            reason: WorkerConcurrencyBlockReason::ProjectLimitReached {
                project_id: input.target.project_id.clone(),
                limit,
            },
            counts,
        };
    }

    if let Some(limit) = input.limits.per_agent
        && counts.agent >= limit
    {
        return WorkerConcurrencyDecision::Blocked {
            reason: WorkerConcurrencyBlockReason::AgentLimitReached {
                project_id: input.target.project_id.clone(),
                agent_pubkey: input.target.agent_pubkey.clone(),
                limit,
            },
            counts,
        };
    }

    WorkerConcurrencyDecision::StartAllowed { counts }
}

fn count_active_executions(
    target: &WorkerConcurrencyTarget,
    active_workers: &[ActiveWorkerConcurrencySnapshot],
    active_dispatches: &[ActiveDispatchConcurrencySnapshot],
) -> WorkerConcurrencyCounts {
    let mut executions = BTreeMap::<ActiveExecutionKey, ActiveExecutionScope>::new();

    for dispatch in active_dispatches {
        if dispatch.dispatch_id == target.dispatch_id {
            continue;
        }

        executions.insert(
            ActiveExecutionKey::Dispatch(dispatch.dispatch_id.clone()),
            ActiveExecutionScope {
                project_id: dispatch.project_id.clone(),
                agent_pubkey: dispatch.agent_pubkey.clone(),
            },
        );
    }

    let mut worker_ids = BTreeSet::<String>::new();
    for worker in active_workers {
        if worker.dispatch_id.as_deref() == Some(target.dispatch_id.as_str()) {
            continue;
        }

        let key = match &worker.dispatch_id {
            Some(dispatch_id) => ActiveExecutionKey::Dispatch(dispatch_id.clone()),
            None => {
                if !worker_ids.insert(worker.worker_id.clone()) {
                    continue;
                }
                ActiveExecutionKey::Worker(worker.worker_id.clone())
            }
        };

        executions
            .entry(key)
            .or_insert_with(|| ActiveExecutionScope {
                project_id: worker.project_id.clone(),
                agent_pubkey: worker.agent_pubkey.clone(),
            });
    }

    let mut counts = WorkerConcurrencyCounts {
        global: executions.len() as u64,
        ..WorkerConcurrencyCounts::default()
    };

    for execution in executions.values() {
        if execution.project_id == target.project_id {
            counts.project += 1;
        }

        if execution.project_id == target.project_id
            && execution.agent_pubkey == target.agent_pubkey
        {
            counts.agent += 1;
        }
    }

    counts
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ActiveExecutionKey {
    Dispatch(String),
    Worker(String),
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
        DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        build_dispatch_queue_record,
    };

    #[test]
    fn allows_start_when_counts_are_below_limits() {
        let target = target("dispatch-target", "project-a", "agent-a");
        let decision = plan_worker_concurrency(input(
            &target,
            &[worker(
                "worker-a",
                Some("dispatch-a"),
                "project-a",
                "agent-a",
            )],
            &[],
            WorkerConcurrencyLimits {
                global: Some(2),
                per_project: Some(2),
                per_agent: Some(2),
            },
        ));

        assert_eq!(
            decision,
            WorkerConcurrencyDecision::StartAllowed {
                counts: WorkerConcurrencyCounts {
                    global: 1,
                    project: 1,
                    agent: 1,
                },
            }
        );
    }

    #[test]
    fn blocks_when_global_limit_is_saturated() {
        let target = target("dispatch-target", "project-a", "agent-a");
        let decision = plan_worker_concurrency(input(
            &target,
            &[
                worker("worker-a", Some("dispatch-a"), "project-a", "agent-a"),
                worker("worker-b", Some("dispatch-b"), "project-b", "agent-b"),
            ],
            &[],
            WorkerConcurrencyLimits {
                global: Some(2),
                per_project: None,
                per_agent: None,
            },
        ));

        assert_eq!(
            decision,
            WorkerConcurrencyDecision::Blocked {
                reason: WorkerConcurrencyBlockReason::GlobalLimitReached { limit: 2 },
                counts: WorkerConcurrencyCounts {
                    global: 2,
                    project: 1,
                    agent: 1,
                },
            }
        );
    }

    #[test]
    fn blocks_when_project_limit_is_saturated() {
        let target = target("dispatch-target", "project-a", "agent-c");
        let decision = plan_worker_concurrency(input(
            &target,
            &[
                worker("worker-a", Some("dispatch-a"), "project-a", "agent-a"),
                worker("worker-b", Some("dispatch-b"), "project-a", "agent-b"),
                worker("worker-c", Some("dispatch-c"), "project-b", "agent-c"),
            ],
            &[],
            WorkerConcurrencyLimits {
                global: Some(10),
                per_project: Some(2),
                per_agent: None,
            },
        ));

        assert_eq!(
            decision,
            WorkerConcurrencyDecision::Blocked {
                reason: WorkerConcurrencyBlockReason::ProjectLimitReached {
                    project_id: "project-a".to_string(),
                    limit: 2,
                },
                counts: WorkerConcurrencyCounts {
                    global: 3,
                    project: 2,
                    agent: 0,
                },
            }
        );
    }

    #[test]
    fn blocks_when_agent_limit_is_saturated() {
        let target = target("dispatch-target", "project-a", "agent-a");
        let decision = plan_worker_concurrency(input(
            &target,
            &[
                worker("worker-a", Some("dispatch-a"), "project-a", "agent-a"),
                worker("worker-b", Some("dispatch-b"), "project-a", "agent-a"),
                worker("worker-c", Some("dispatch-c"), "project-a", "agent-b"),
            ],
            &[],
            WorkerConcurrencyLimits {
                global: Some(10),
                per_project: Some(10),
                per_agent: Some(2),
            },
        ));

        assert_eq!(
            decision,
            WorkerConcurrencyDecision::Blocked {
                reason: WorkerConcurrencyBlockReason::AgentLimitReached {
                    project_id: "project-a".to_string(),
                    agent_pubkey: "agent-a".to_string(),
                    limit: 2,
                },
                counts: WorkerConcurrencyCounts {
                    global: 3,
                    project: 3,
                    agent: 2,
                },
            }
        );
    }

    #[test]
    fn treats_none_limits_as_unlimited_and_zero_as_block_all() {
        let target = target("dispatch-target", "project-a", "agent-a");
        let unlimited_decision = plan_worker_concurrency(input(
            &target,
            &[
                worker("worker-a", Some("dispatch-a"), "project-a", "agent-a"),
                worker("worker-b", Some("dispatch-b"), "project-a", "agent-a"),
                worker("worker-c", Some("dispatch-c"), "project-b", "agent-a"),
            ],
            &[],
            WorkerConcurrencyLimits::default(),
        ));

        assert_eq!(
            unlimited_decision,
            WorkerConcurrencyDecision::StartAllowed {
                counts: WorkerConcurrencyCounts {
                    global: 3,
                    project: 2,
                    agent: 2,
                },
            }
        );

        let zero_decision = plan_worker_concurrency(input(
            &target,
            &[],
            &[],
            WorkerConcurrencyLimits {
                global: Some(0),
                per_project: None,
                per_agent: None,
            },
        ));

        assert_eq!(
            zero_decision,
            WorkerConcurrencyDecision::Blocked {
                reason: WorkerConcurrencyBlockReason::GlobalLimitReached { limit: 0 },
                counts: WorkerConcurrencyCounts::default(),
            }
        );
    }

    #[test]
    fn counts_project_agent_namespace_and_deduplicates_dispatch_snapshots() {
        let target = target("dispatch-target", "project-a", "agent-a");
        let decision = plan_worker_concurrency(input(
            &target,
            &[
                worker("worker-a", Some("dispatch-a"), "project-a", "agent-a"),
                worker("worker-b", Some("dispatch-b"), "project-a", "agent-a"),
                worker("worker-c", Some("dispatch-c"), "project-a", "agent-b"),
                worker("worker-d", Some("dispatch-d"), "project-b", "agent-a"),
                worker("worker-e", None, "project-a", "agent-a"),
            ],
            &[
                active_dispatch("dispatch-a", "project-a", "agent-a"),
                active_dispatch("dispatch-target", "project-a", "agent-a"),
            ],
            WorkerConcurrencyLimits {
                global: Some(10),
                per_project: Some(10),
                per_agent: Some(10),
            },
        ));

        assert_eq!(
            decision,
            WorkerConcurrencyDecision::StartAllowed {
                counts: WorkerConcurrencyCounts {
                    global: 5,
                    project: 4,
                    agent: 3,
                },
            }
        );
    }

    #[test]
    fn blocks_duplicate_start_when_candidate_worker_is_already_active() {
        let target = target("dispatch-target", "project-a", "agent-a");
        let decision = plan_worker_concurrency(input(
            &target,
            &[worker(
                "worker-target",
                Some("dispatch-target"),
                "project-a",
                "agent-a",
            )],
            &[active_dispatch("dispatch-target", "project-a", "agent-a")],
            WorkerConcurrencyLimits {
                global: Some(10),
                per_project: Some(10),
                per_agent: Some(10),
            },
        ));

        assert_eq!(
            decision,
            WorkerConcurrencyDecision::Blocked {
                reason: WorkerConcurrencyBlockReason::CandidateAlreadyActive {
                    dispatch_id: "dispatch-target".to_string(),
                    worker_id: "worker-target".to_string(),
                },
                counts: WorkerConcurrencyCounts::default(),
            }
        );
    }

    #[test]
    fn builds_target_and_active_dispatch_snapshot_from_dispatch_record() {
        let dispatch = build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence: 1,
            timestamp: 1_710_000_000_000,
            correlation_id: "correlation-a".to_string(),
            dispatch_id: "dispatch-a".to_string(),
            ral: DispatchRalIdentity {
                project_id: "project-a".to_string(),
                agent_pubkey: "agent-a".to_string(),
                conversation_id: "conversation-a".to_string(),
                ral_number: 7,
            },
            triggering_event_id: "event-a".to_string(),
            claim_token: "claim-a".to_string(),
            status: DispatchQueueStatus::Leased,
        });

        assert_eq!(
            WorkerConcurrencyTarget::from_dispatch(&dispatch),
            target("dispatch-a", "project-a", "agent-a")
        );
        assert_eq!(
            ActiveDispatchConcurrencySnapshot::from_dispatch(&dispatch),
            active_dispatch("dispatch-a", "project-a", "agent-a")
        );
    }

    fn input<'a>(
        target: &'a WorkerConcurrencyTarget,
        active_workers: &'a [ActiveWorkerConcurrencySnapshot],
        active_dispatches: &'a [ActiveDispatchConcurrencySnapshot],
        limits: WorkerConcurrencyLimits,
    ) -> WorkerConcurrencyPlanInput<'a> {
        WorkerConcurrencyPlanInput {
            target,
            active_workers,
            active_dispatches,
            limits,
        }
    }

    fn target(dispatch_id: &str, project_id: &str, agent_pubkey: &str) -> WorkerConcurrencyTarget {
        WorkerConcurrencyTarget {
            dispatch_id: dispatch_id.to_string(),
            project_id: project_id.to_string(),
            agent_pubkey: agent_pubkey.to_string(),
        }
    }

    fn worker(
        worker_id: &str,
        dispatch_id: Option<&str>,
        project_id: &str,
        agent_pubkey: &str,
    ) -> ActiveWorkerConcurrencySnapshot {
        ActiveWorkerConcurrencySnapshot {
            worker_id: worker_id.to_string(),
            dispatch_id: dispatch_id.map(str::to_string),
            project_id: project_id.to_string(),
            agent_pubkey: agent_pubkey.to_string(),
        }
    }

    fn active_dispatch(
        dispatch_id: &str,
        project_id: &str,
        agent_pubkey: &str,
    ) -> ActiveDispatchConcurrencySnapshot {
        ActiveDispatchConcurrencySnapshot {
            dispatch_id: dispatch_id.to_string(),
            project_id: project_id.to_string(),
            agent_pubkey: agent_pubkey.to_string(),
        }
    }
}
