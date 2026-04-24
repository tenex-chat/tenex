use thiserror::Error;

use crate::dispatch_queue::{
    DispatchQueueError, DispatchQueueLifecycleInput, DispatchQueueRecord, DispatchQueueState,
    DispatchQueueStatus, DispatchRalIdentity, plan_dispatch_queue_terminal,
};
use crate::ral_journal::{RalJournalIdentity, RalJournalRecord};
use crate::ral_scheduler::{RalScheduler, RalSchedulerError, RalWorkerTransitionInput};
use crate::worker_completion::result::WorkerResultTransitionPlan;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerCompletionDispatchInput {
    pub dispatch_id: String,
    pub sequence: u64,
    pub timestamp: u64,
    pub correlation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerCompletionInput {
    pub result: WorkerResultTransitionPlan,
    pub dispatch: Option<WorkerCompletionDispatchInput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerCompletionPlan {
    pub worker_sequence: u64,
    pub worker_timestamp: u64,
    pub ral_journal_record: RalJournalRecord,
    pub dispatch_queue_record: Option<DispatchQueueRecord>,
}

#[derive(Debug, Error)]
pub enum WorkerCompletionError {
    #[error("RAL worker transition rejected: {source}")]
    Ral {
        #[source]
        source: Box<RalSchedulerError>,
    },
    #[error("dispatch queue completion rejected: {source}")]
    Dispatch {
        #[source]
        source: Box<DispatchQueueError>,
    },
    #[error("dispatch {dispatch_id} RAL identity does not match worker result")]
    DispatchRalMismatch {
        dispatch_id: String,
        expected: Box<DispatchRalIdentity>,
        actual: Box<DispatchRalIdentity>,
    },
    #[error("dispatch {dispatch_id} claim token does not match worker result")]
    DispatchClaimTokenMismatch {
        dispatch_id: String,
        expected: String,
        actual: String,
    },
}

pub fn plan_worker_completion(
    scheduler: &RalScheduler,
    dispatch_state: &DispatchQueueState,
    input: WorkerCompletionInput,
) -> Result<WorkerCompletionPlan, WorkerCompletionError> {
    let WorkerResultTransitionPlan {
        worker_sequence,
        worker_timestamp,
        ral_transition_input,
    } = input.result;

    let ral_journal_record = scheduler
        .plan_worker_transition(ral_transition_input.clone())
        .map_err(WorkerCompletionError::from)?
        .record;

    let dispatch_queue_record = input
        .dispatch
        .map(|dispatch| plan_dispatch_completion(dispatch_state, dispatch, &ral_transition_input))
        .transpose()?;

    Ok(WorkerCompletionPlan {
        worker_sequence,
        worker_timestamp,
        ral_journal_record,
        dispatch_queue_record,
    })
}

fn plan_dispatch_completion(
    dispatch_state: &DispatchQueueState,
    dispatch: WorkerCompletionDispatchInput,
    transition_input: &RalWorkerTransitionInput,
) -> Result<DispatchQueueRecord, WorkerCompletionError> {
    let dispatch_id = dispatch.dispatch_id.clone();
    let record = plan_dispatch_queue_terminal(
        dispatch_state,
        DispatchQueueLifecycleInput {
            dispatch_id: dispatch.dispatch_id,
            sequence: dispatch.sequence,
            timestamp: dispatch.timestamp,
            correlation_id: dispatch.correlation_id,
        },
        DispatchQueueStatus::Completed,
    )
    .map_err(WorkerCompletionError::from)?;

    let expected_ral = dispatch_identity_from_ral(&transition_input.identity);
    if record.ral != expected_ral {
        return Err(WorkerCompletionError::DispatchRalMismatch {
            dispatch_id,
            expected: Box::new(expected_ral),
            actual: Box::new(record.ral),
        });
    }

    if record.claim_token != transition_input.claim_token {
        return Err(WorkerCompletionError::DispatchClaimTokenMismatch {
            dispatch_id,
            expected: transition_input.claim_token.clone(),
            actual: record.claim_token,
        });
    }

    Ok(record)
}

impl From<RalSchedulerError> for WorkerCompletionError {
    fn from(source: RalSchedulerError) -> Self {
        Self::Ral {
            source: Box::new(source),
        }
    }
}

impl From<DispatchQueueError> for WorkerCompletionError {
    fn from(source: DispatchQueueError) -> Self {
        Self::Dispatch {
            source: Box::new(source),
        }
    }
}

fn dispatch_identity_from_ral(identity: &RalJournalIdentity) -> DispatchRalIdentity {
    DispatchRalIdentity {
        project_id: identity.project_id.clone(),
        agent_pubkey: identity.agent_pubkey.clone(),
        conversation_id: identity.conversation_id.clone(),
        ral_number: identity.ral_number,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecordParams, build_dispatch_queue_record, replay_dispatch_queue_records,
    };
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalDelegationType, RalJournalEvent, RalJournalReplay,
        RalPendingDelegation, RalTerminalSummary, RalWorkerError, replay_ral_journal_records,
    };
    use crate::ral_scheduler::{RalWorkerTransition, RalWorkerTransitionInput};

    #[test]
    fn plans_completed_worker_result_and_dispatch_completion() {
        let plan = plan_completion(worker_transition(RalWorkerTransition::Completed {
            terminal: terminal(vec!["event-complete"]),
        }))
        .expect("completed result must plan");

        assert_eq!(plan.worker_sequence, 15);
        assert_eq!(plan.worker_timestamp, 1710000402400);
        assert_eq!(plan.ral_journal_record.sequence, 12);
        assert_eq!(
            plan.ral_journal_record.event,
            RalJournalEvent::Completed {
                identity: identity(),
                worker_id: "worker-a".to_string(),
                claim_token: "claim-a".to_string(),
                terminal: terminal(vec!["event-complete"]),
            }
        );

        let dispatch_record = plan
            .dispatch_queue_record
            .expect("dispatch completion must be planned");
        assert_eq!(dispatch_record.sequence, 102);
        assert_eq!(dispatch_record.timestamp, 1710000500102);
        assert_eq!(dispatch_record.status, DispatchQueueStatus::Completed);
        assert_eq!(dispatch_record.dispatch_id, "dispatch-a");
        assert_eq!(dispatch_record.claim_token, "claim-a");
    }

    #[test]
    fn plans_waiting_for_delegation_worker_result_and_dispatch_completion() {
        let pending = pending_delegation("delegation-a");
        let plan = plan_completion(worker_transition(
            RalWorkerTransition::WaitingForDelegation {
                pending_delegations: vec![pending.clone()],
                terminal: terminal(Vec::new()),
            },
        ))
        .expect("waiting result must plan");

        assert_eq!(
            plan.ral_journal_record.event,
            RalJournalEvent::WaitingForDelegation {
                identity: identity(),
                worker_id: "worker-a".to_string(),
                claim_token: "claim-a".to_string(),
                pending_delegations: vec![pending],
                terminal: terminal(Vec::new()),
            }
        );
        assert_eq!(
            plan.dispatch_queue_record
                .expect("dispatch completion must be planned")
                .status,
            DispatchQueueStatus::Completed
        );
    }

    #[test]
    fn plans_no_response_error_and_aborted_worker_results() {
        let cases = vec![
            (
                RalWorkerTransition::NoResponse {
                    terminal: terminal(Vec::new()),
                },
                "no_response",
            ),
            (
                RalWorkerTransition::Error {
                    error: RalWorkerError {
                        code: "provider_error".to_string(),
                        message: "provider failed".to_string(),
                        retryable: true,
                    },
                    terminal: terminal(vec!["event-error"]),
                },
                "error",
            ),
            (
                RalWorkerTransition::Aborted {
                    abort_reason: "operator_requested".to_string(),
                    terminal: terminal(Vec::new()),
                },
                "aborted",
            ),
        ];

        for (transition, expected_event) in cases {
            let plan = plan_completion(worker_transition(transition))
                .unwrap_or_else(|error| panic!("{expected_event} result must plan: {error:?}"));

            assert_eq!(plan.ral_journal_record.event.event_name(), expected_event);
            assert_eq!(
                plan.dispatch_queue_record
                    .expect("dispatch completion must be planned")
                    .status,
                DispatchQueueStatus::Completed
            );
        }
    }

    #[test]
    fn rejects_stale_claim_token_using_scheduler_validation() {
        let mut result = worker_transition(RalWorkerTransition::Completed {
            terminal: terminal(Vec::new()),
        });
        result.ral_transition_input.claim_token = "claim-stale".to_string();

        let error = plan_completion(result).expect_err("stale claim must be rejected");

        match error {
            WorkerCompletionError::Ral { source } => {
                assert!(matches!(
                    source.as_ref(),
                    RalSchedulerError::InvalidClaimToken { .. }
                ));
            }
            other => panic!("expected RAL invalid claim rejection, got {other:?}"),
        }
    }

    #[test]
    fn rejects_wrong_worker_using_scheduler_validation() {
        let mut result = worker_transition(RalWorkerTransition::Completed {
            terminal: terminal(Vec::new()),
        });
        result.ral_transition_input.worker_id = "worker-b".to_string();

        let error = plan_completion(result).expect_err("wrong worker must be rejected");

        match error {
            WorkerCompletionError::Ral { source } => match source.as_ref() {
                RalSchedulerError::WorkerClaimMismatch {
                    expected_worker_id,
                    actual_worker_id,
                    ..
                } => {
                    assert_eq!(expected_worker_id.as_deref(), Some("worker-a"));
                    assert_eq!(actual_worker_id, "worker-b");
                }
                other => panic!("expected worker claim mismatch, got {other:?}"),
            },
            other => panic!("expected RAL worker mismatch rejection, got {other:?}"),
        }
    }

    #[test]
    fn rejects_dispatch_claim_token_mismatch() {
        let mut dispatch_state = dispatch_state();
        dispatch_state.leased[0].claim_token = "claim-other".to_string();

        let result = worker_transition(RalWorkerTransition::Completed {
            terminal: terminal(Vec::new()),
        });
        let error = plan_worker_completion(
            &scheduler(),
            &dispatch_state,
            completion_input(result, Some(dispatch_input())),
        )
        .expect_err("dispatch claim mismatch must be rejected");

        match error {
            WorkerCompletionError::DispatchClaimTokenMismatch {
                dispatch_id,
                expected,
                actual,
            } => {
                assert_eq!(dispatch_id, "dispatch-a");
                assert_eq!(expected, "claim-a");
                assert_eq!(actual, "claim-other");
            }
            other => panic!("expected dispatch claim mismatch, got {other:?}"),
        }
    }

    fn plan_completion(
        result: WorkerResultTransitionPlan,
    ) -> Result<WorkerCompletionPlan, WorkerCompletionError> {
        plan_worker_completion(
            &scheduler(),
            &dispatch_state(),
            completion_input(result, Some(dispatch_input())),
        )
    }

    fn completion_input(
        result: WorkerResultTransitionPlan,
        dispatch: Option<WorkerCompletionDispatchInput>,
    ) -> WorkerCompletionInput {
        WorkerCompletionInput { result, dispatch }
    }

    fn scheduler() -> RalScheduler {
        let replay = replay_ral_journal_records(vec![
            journal_record(
                10,
                RalJournalEvent::Allocated {
                    identity: identity(),
                    triggering_event_id: Some("trigger-a".to_string()),
                },
            ),
            journal_record(
                11,
                RalJournalEvent::Claimed {
                    identity: identity(),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                },
            ),
        ])
        .expect("journal replay must succeed");
        RalScheduler::new(&RalJournalReplay {
            last_sequence: replay.last_sequence,
            states: replay.states,
        })
    }

    fn dispatch_state() -> DispatchQueueState {
        replay_dispatch_queue_records(vec![
            dispatch_record(100, DispatchQueueStatus::Queued, "claim-a"),
            dispatch_record(101, DispatchQueueStatus::Leased, "claim-a"),
        ])
        .expect("dispatch replay must succeed")
    }

    fn worker_transition(transition: RalWorkerTransition) -> WorkerResultTransitionPlan {
        WorkerResultTransitionPlan {
            worker_sequence: 15,
            worker_timestamp: 1710000402400,
            ral_transition_input: RalWorkerTransitionInput {
                identity: identity(),
                worker_id: "worker-a".to_string(),
                claim_token: "claim-a".to_string(),
                sequence: 12,
                timestamp: 1710000500012,
                correlation_id: "correlation-worker-result".to_string(),
                writer_version: "test-version".to_string(),
                transition,
            },
        }
    }

    fn dispatch_input() -> WorkerCompletionDispatchInput {
        WorkerCompletionDispatchInput {
            dispatch_id: "dispatch-a".to_string(),
            sequence: 102,
            timestamp: 1710000500102,
            correlation_id: "correlation-dispatch-complete".to_string(),
        }
    }

    fn journal_record(sequence: u64, event: RalJournalEvent) -> RalJournalRecord {
        RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            "test-version",
            sequence,
            1710000400000 + sequence,
            format!("correlation-{sequence}"),
            event,
        )
    }

    fn dispatch_record(
        sequence: u64,
        status: DispatchQueueStatus,
        claim_token: &str,
    ) -> DispatchQueueRecord {
        build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence,
            timestamp: 1710000400000 + sequence,
            correlation_id: format!("correlation-dispatch-{sequence}"),
            dispatch_id: "dispatch-a".to_string(),
            ral: dispatch_identity_from_ral(&identity()),
            triggering_event_id: "trigger-a".to_string(),
            claim_token: claim_token.to_string(),
            status,
        })
    }

    fn identity() -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: "project-a".to_string(),
            agent_pubkey: "a".repeat(64),
            conversation_id: "conversation-a".to_string(),
            ral_number: 1,
        }
    }

    fn terminal(final_event_ids: Vec<&str>) -> RalTerminalSummary {
        RalTerminalSummary {
            published_user_visible_event: !final_event_ids.is_empty(),
            pending_delegations_remain: false,
            accumulated_runtime_ms: 2250,
            final_event_ids: final_event_ids
                .into_iter()
                .map(ToString::to_string)
                .collect(),
            keep_worker_warm: false,
        }
    }

    fn pending_delegation(delegation_conversation_id: &str) -> RalPendingDelegation {
        RalPendingDelegation {
            delegation_conversation_id: delegation_conversation_id.to_string(),
            recipient_pubkey: "recipient-a".to_string(),
            sender_pubkey: "sender-a".to_string(),
            prompt: "Please handle this delegated work.".to_string(),
            delegation_type: RalDelegationType::Standard,
            ral_number: 2,
            parent_delegation_conversation_id: None,
            pending_sub_delegations: None,
            deferred_completion: None,
            followup_event_id: None,
            project_id: Some("project-a".to_string()),
            suggestions: None,
            killed: None,
            killed_at: None,
        }
    }

    trait RalJournalEventName {
        fn event_name(&self) -> &'static str;
    }

    impl RalJournalEventName for RalJournalEvent {
        fn event_name(&self) -> &'static str {
            match self {
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
    }
}
