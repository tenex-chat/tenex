use std::collections::{BTreeMap, BTreeSet};

use crate::dispatch_queue::DispatchQueueRecord;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerConcurrencyTarget {
    pub dispatch_id: String,
    pub project_id: String,
    pub agent_pubkey: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveWorkerConcurrencySnapshot {
    pub worker_id: String,
    pub dispatch_id: Option<String>,
    pub project_id: String,
    pub agent_pubkey: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveDispatchConcurrencySnapshot {
    pub dispatch_id: String,
    pub project_id: String,
    pub agent_pubkey: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WorkerConcurrencyCounts {
    pub global: u64,
    pub project: u64,
    pub agent: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerConcurrencyBlockReason {
    CandidateAlreadyActive {
        dispatch_id: String,
        worker_id: String,
    },
    ConversationAlreadyActive {
        project_id: String,
        agent_pubkey: String,
        conversation_id: String,
        dispatch_id: Option<String>,
        worker_id: Option<String>,
    },
}

impl WorkerConcurrencyTarget {
    pub fn from_dispatch(dispatch: &DispatchQueueRecord) -> Self {
        Self {
            dispatch_id: dispatch.dispatch_id.clone(),
            project_id: dispatch.ral.project_id.clone(),
            agent_pubkey: dispatch.ral.agent_pubkey.clone(),
            conversation_id: dispatch.ral.conversation_id.clone(),
        }
    }
}

impl ActiveDispatchConcurrencySnapshot {
    pub fn from_dispatch(dispatch: &DispatchQueueRecord) -> Self {
        Self {
            dispatch_id: dispatch.dispatch_id.clone(),
            project_id: dispatch.ral.project_id.clone(),
            agent_pubkey: dispatch.ral.agent_pubkey.clone(),
            conversation_id: dispatch.ral.conversation_id.clone(),
        }
    }
}

/// Check whether a candidate dispatch is blocked by deduplication rules:
/// the same dispatch is already active, or the same conversation is already
/// running on a different dispatch or worker.
///
/// Returns `Ok(counts)` if the candidate may start, or `Err(reason)` if it
/// is blocked.
pub fn check_worker_dispatch_dedup(
    target: &WorkerConcurrencyTarget,
    active_workers: &[ActiveWorkerConcurrencySnapshot],
    active_dispatches: &[ActiveDispatchConcurrencySnapshot],
) -> Result<WorkerConcurrencyCounts, WorkerConcurrencyBlockReason> {
    let counts = count_active_executions(target, active_workers, active_dispatches);

    if let Some(worker) = active_workers
        .iter()
        .find(|worker| worker.dispatch_id.as_deref() == Some(target.dispatch_id.as_str()))
    {
        return Err(WorkerConcurrencyBlockReason::CandidateAlreadyActive {
            dispatch_id: target.dispatch_id.clone(),
            worker_id: worker.worker_id.clone(),
        });
    }

    if let Some(worker) = active_workers.iter().find(|worker| {
        worker.dispatch_id.as_deref() != Some(target.dispatch_id.as_str())
            && worker.project_id == target.project_id
            && worker.agent_pubkey == target.agent_pubkey
            && worker.conversation_id == target.conversation_id
    }) {
        return Err(WorkerConcurrencyBlockReason::ConversationAlreadyActive {
            project_id: target.project_id.clone(),
            agent_pubkey: target.agent_pubkey.clone(),
            conversation_id: target.conversation_id.clone(),
            dispatch_id: worker.dispatch_id.clone(),
            worker_id: Some(worker.worker_id.clone()),
        });
    }

    if let Some(dispatch) = active_dispatches.iter().find(|dispatch| {
        dispatch.dispatch_id != target.dispatch_id
            && dispatch.project_id == target.project_id
            && dispatch.agent_pubkey == target.agent_pubkey
            && dispatch.conversation_id == target.conversation_id
    }) {
        return Err(WorkerConcurrencyBlockReason::ConversationAlreadyActive {
            project_id: target.project_id.clone(),
            agent_pubkey: target.agent_pubkey.clone(),
            conversation_id: target.conversation_id.clone(),
            dispatch_id: Some(dispatch.dispatch_id.clone()),
            worker_id: None,
        });
    }

    Ok(counts)
}

pub fn count_active_executions(
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
    fn allows_start_when_no_conflicts() {
        let target = target("dispatch-target", "project-a", "agent-a");
        let result = check_worker_dispatch_dedup(
            &target,
            &[worker(
                "worker-a",
                Some("dispatch-a"),
                "project-a",
                "agent-a",
            )],
            &[],
        );

        assert_eq!(
            result,
            Ok(WorkerConcurrencyCounts {
                global: 1,
                project: 1,
                agent: 1,
            })
        );
    }

    #[test]
    fn blocks_duplicate_start_when_candidate_worker_is_already_active() {
        let target = target("dispatch-target", "project-a", "agent-a");
        let result = check_worker_dispatch_dedup(
            &target,
            &[worker(
                "worker-target",
                Some("dispatch-target"),
                "project-a",
                "agent-a",
            )],
            &[active_dispatch("dispatch-target", "project-a", "agent-a")],
        );

        assert_eq!(
            result,
            Err(WorkerConcurrencyBlockReason::CandidateAlreadyActive {
                dispatch_id: "dispatch-target".to_string(),
                worker_id: "worker-target".to_string(),
            })
        );
    }

    #[test]
    fn blocks_when_conversation_namespace_is_already_active_on_worker() {
        let target =
            target_with_conversation("dispatch-target", "project-a", "agent-a", "conversation-a");
        let result = check_worker_dispatch_dedup(
            &target,
            &[worker_with_conversation(
                "worker-a",
                Some("dispatch-a"),
                "project-a",
                "agent-a",
                "conversation-a",
            )],
            &[],
        );

        assert_eq!(
            result,
            Err(WorkerConcurrencyBlockReason::ConversationAlreadyActive {
                project_id: "project-a".to_string(),
                agent_pubkey: "agent-a".to_string(),
                conversation_id: "conversation-a".to_string(),
                dispatch_id: Some("dispatch-a".to_string()),
                worker_id: Some("worker-a".to_string()),
            })
        );
    }

    #[test]
    fn blocks_when_conversation_namespace_is_already_leased() {
        let target =
            target_with_conversation("dispatch-target", "project-a", "agent-a", "conversation-a");
        let result = check_worker_dispatch_dedup(
            &target,
            &[],
            &[active_dispatch_with_conversation(
                "dispatch-a",
                "project-a",
                "agent-a",
                "conversation-a",
            )],
        );

        assert_eq!(
            result,
            Err(WorkerConcurrencyBlockReason::ConversationAlreadyActive {
                project_id: "project-a".to_string(),
                agent_pubkey: "agent-a".to_string(),
                conversation_id: "conversation-a".to_string(),
                dispatch_id: Some("dispatch-a".to_string()),
                worker_id: None,
            })
        );
    }

    #[test]
    fn counts_project_agent_namespace_and_deduplicates_dispatch_snapshots() {
        let target = target("dispatch-target", "project-a", "agent-a");
        let result = check_worker_dispatch_dedup(
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
        );

        assert_eq!(
            result,
            Ok(WorkerConcurrencyCounts {
                global: 5,
                project: 4,
                agent: 3,
            })
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
            target_with_conversation("dispatch-a", "project-a", "agent-a", "conversation-a")
        );
        assert_eq!(
            ActiveDispatchConcurrencySnapshot::from_dispatch(&dispatch),
            active_dispatch("dispatch-a", "project-a", "agent-a")
        );
    }

    fn target(dispatch_id: &str, project_id: &str, agent_pubkey: &str) -> WorkerConcurrencyTarget {
        target_with_conversation(dispatch_id, project_id, agent_pubkey, "conversation-target")
    }

    fn target_with_conversation(
        dispatch_id: &str,
        project_id: &str,
        agent_pubkey: &str,
        conversation_id: &str,
    ) -> WorkerConcurrencyTarget {
        WorkerConcurrencyTarget {
            dispatch_id: dispatch_id.to_string(),
            project_id: project_id.to_string(),
            agent_pubkey: agent_pubkey.to_string(),
            conversation_id: conversation_id.to_string(),
        }
    }

    fn worker(
        worker_id: &str,
        dispatch_id: Option<&str>,
        project_id: &str,
        agent_pubkey: &str,
    ) -> ActiveWorkerConcurrencySnapshot {
        worker_with_conversation(
            worker_id,
            dispatch_id,
            project_id,
            agent_pubkey,
            "conversation-a",
        )
    }

    fn worker_with_conversation(
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

    fn active_dispatch(
        dispatch_id: &str,
        project_id: &str,
        agent_pubkey: &str,
    ) -> ActiveDispatchConcurrencySnapshot {
        active_dispatch_with_conversation(dispatch_id, project_id, agent_pubkey, "conversation-a")
    }

    fn active_dispatch_with_conversation(
        dispatch_id: &str,
        project_id: &str,
        agent_pubkey: &str,
        conversation_id: &str,
    ) -> ActiveDispatchConcurrencySnapshot {
        ActiveDispatchConcurrencySnapshot {
            dispatch_id: dispatch_id.to_string(),
            project_id: project_id.to_string(),
            agent_pubkey: agent_pubkey.to_string(),
            conversation_id: conversation_id.to_string(),
        }
    }
}
