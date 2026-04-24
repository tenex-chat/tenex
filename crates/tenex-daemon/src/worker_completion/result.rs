use std::collections::{HashMap, HashSet};

use serde_json::Value;
use thiserror::Error;

use crate::ral_journal::{
    RalJournalIdentity, RalPendingDelegation, RalTerminalSummary, RalWorkerError,
};
use crate::ral_scheduler::{RalWorkerTransition, RalWorkerTransitionInput};
use crate::worker_protocol::{
    WorkerProtocolDirection, WorkerProtocolError, validate_agent_worker_protocol_message,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerResultTransitionContext {
    pub worker_id: String,
    pub claim_token: String,
    pub journal_sequence: u64,
    pub journal_timestamp: u64,
    pub writer_version: String,
    pub resolved_pending_delegations: Vec<RalPendingDelegation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerResultTransitionPlan {
    pub worker_sequence: u64,
    pub worker_timestamp: u64,
    pub ral_transition_input: RalWorkerTransitionInput,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkerResultError {
    #[error("worker protocol error: {0}")]
    Protocol(#[from] WorkerProtocolError),
    #[error("worker result had invalid direction {0:?}")]
    InvalidDirection(WorkerProtocolDirection),
    #[error("worker message type {message_type} is not a terminal result")]
    NonTerminalMessage { message_type: String },
    #[error("worker result field is missing or invalid: {0}")]
    InvalidField(&'static str),
    #[error("resolved pending delegation {delegation_conversation_id} was duplicated")]
    DuplicateResolvedPendingDelegation { delegation_conversation_id: String },
    #[error("worker pending delegation {delegation_conversation_id} was not resolved")]
    UnresolvedPendingDelegation { delegation_conversation_id: String },
    #[error("resolved pending delegation {delegation_conversation_id} was not reported by worker")]
    UnreportedResolvedPendingDelegation { delegation_conversation_id: String },
}

pub fn plan_worker_result_transition(
    message: &Value,
    context: WorkerResultTransitionContext,
) -> Result<WorkerResultTransitionPlan, WorkerResultError> {
    let direction = validate_agent_worker_protocol_message(message)?;
    if direction != WorkerProtocolDirection::WorkerToDaemon {
        return Err(WorkerResultError::InvalidDirection(direction));
    }

    let message_type = required_string(message, "type")?;
    let transition = match message_type {
        "waiting_for_delegation" => RalWorkerTransition::WaitingForDelegation {
            pending_delegations: resolved_pending_delegations(
                required_string_array(message, "pendingDelegations")?,
                context.resolved_pending_delegations,
            )?,
            terminal: terminal_summary(message)?,
        },
        "complete" => RalWorkerTransition::Completed {
            terminal: terminal_summary(message)?,
        },
        "no_response" => RalWorkerTransition::NoResponse {
            terminal: terminal_summary(message)?,
        },
        "error" => {
            if !required_bool(message, "terminal")? {
                return Err(WorkerResultError::InvalidField("terminal"));
            }
            RalWorkerTransition::Error {
                error: worker_error(message)?,
                terminal: terminal_summary(message)?,
            }
        }
        "aborted" => RalWorkerTransition::Aborted {
            abort_reason: required_string(message, "abortReason")?.to_string(),
            terminal: terminal_summary(message)?,
        },
        other => {
            return Err(WorkerResultError::NonTerminalMessage {
                message_type: other.to_string(),
            });
        }
    };

    Ok(WorkerResultTransitionPlan {
        worker_sequence: required_u64(message, "sequence")?,
        worker_timestamp: required_u64(message, "timestamp")?,
        ral_transition_input: RalWorkerTransitionInput {
            identity: RalJournalIdentity {
                project_id: required_string(message, "projectId")?.to_string(),
                agent_pubkey: required_string(message, "agentPubkey")?.to_string(),
                conversation_id: required_string(message, "conversationId")?.to_string(),
                ral_number: required_u64(message, "ralNumber")?,
            },
            worker_id: context.worker_id,
            claim_token: context.claim_token,
            sequence: context.journal_sequence,
            timestamp: context.journal_timestamp,
            correlation_id: required_string(message, "correlationId")?.to_string(),
            writer_version: context.writer_version,
            transition,
        },
    })
}

fn terminal_summary(message: &Value) -> Result<RalTerminalSummary, WorkerResultError> {
    Ok(RalTerminalSummary {
        published_user_visible_event: required_bool(message, "publishedUserVisibleEvent")?,
        pending_delegations_remain: required_bool(message, "pendingDelegationsRemain")?,
        accumulated_runtime_ms: required_u64(message, "accumulatedRuntimeMs")?,
        final_event_ids: required_string_array(message, "finalEventIds")?
            .into_iter()
            .map(ToString::to_string)
            .collect(),
        keep_worker_warm: required_bool(message, "keepWorkerWarm")?,
    })
}

fn worker_error(message: &Value) -> Result<RalWorkerError, WorkerResultError> {
    let error = message
        .get("error")
        .ok_or(WorkerResultError::InvalidField("error"))?;
    Ok(RalWorkerError {
        code: required_string(error, "code")?.to_string(),
        message: required_string(error, "message")?.to_string(),
        retryable: required_bool(error, "retryable")?,
    })
}

fn resolved_pending_delegations(
    worker_delegation_ids: Vec<&str>,
    resolved_pending_delegations: Vec<RalPendingDelegation>,
) -> Result<Vec<RalPendingDelegation>, WorkerResultError> {
    let mut resolved_by_id = HashMap::with_capacity(resolved_pending_delegations.len());
    for delegation in resolved_pending_delegations {
        let id = delegation.delegation_conversation_id.clone();
        if resolved_by_id.insert(id.clone(), delegation).is_some() {
            return Err(WorkerResultError::DuplicateResolvedPendingDelegation {
                delegation_conversation_id: id,
            });
        }
    }

    let mut reported_ids = HashSet::with_capacity(worker_delegation_ids.len());
    let mut pending_delegations = Vec::with_capacity(worker_delegation_ids.len());
    for id in worker_delegation_ids {
        reported_ids.insert(id.to_string());
        let delegation = resolved_by_id.remove(id).ok_or_else(|| {
            WorkerResultError::UnresolvedPendingDelegation {
                delegation_conversation_id: id.to_string(),
            }
        })?;
        pending_delegations.push(delegation);
    }

    if let Some(unreported_id) = resolved_by_id
        .keys()
        .filter(|id| !reported_ids.contains(*id))
        .min()
        .cloned()
    {
        return Err(WorkerResultError::UnreportedResolvedPendingDelegation {
            delegation_conversation_id: unreported_id,
        });
    }

    Ok(pending_delegations)
}

fn required_string<'a>(
    message: &'a Value,
    field: &'static str,
) -> Result<&'a str, WorkerResultError> {
    message
        .get(field)
        .and_then(Value::as_str)
        .ok_or(WorkerResultError::InvalidField(field))
}

fn required_u64(message: &Value, field: &'static str) -> Result<u64, WorkerResultError> {
    message
        .get(field)
        .and_then(Value::as_u64)
        .ok_or(WorkerResultError::InvalidField(field))
}

fn required_bool(message: &Value, field: &'static str) -> Result<bool, WorkerResultError> {
    message
        .get(field)
        .and_then(Value::as_bool)
        .ok_or(WorkerResultError::InvalidField(field))
}

fn required_string_array<'a>(
    message: &'a Value,
    field: &'static str,
) -> Result<Vec<&'a str>, WorkerResultError> {
    message
        .get(field)
        .and_then(Value::as_array)
        .ok_or(WorkerResultError::InvalidField(field))?
        .iter()
        .map(|value| value.as_str().ok_or(WorkerResultError::InvalidField(field)))
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::ral_journal::{RalDelegationType, RalPendingDelegation};

    const WORKER_PROTOCOL_FIXTURE: &str = include_str!(
        "../../../../src/test-utils/fixtures/worker-protocol/agent-execution.compat.json"
    );

    #[test]
    fn plans_complete_result_transition_from_shared_fixture() {
        let message = fixture_valid_message("complete");

        let plan = plan_worker_result_transition(&message, context(Vec::new()))
            .expect("complete worker result must plan");

        assert_eq!(plan.worker_sequence, 15);
        assert_eq!(plan.worker_timestamp, 1710000402400);
        assert_eq!(plan.ral_transition_input.sequence, 200);
        assert_eq!(plan.ral_transition_input.timestamp, 1710000500000);
        assert_eq!(
            plan.ral_transition_input.correlation_id,
            "exec_01hzzzzzzzzzzzzzzzzzzzzzzz"
        );
        assert_eq!(plan.ral_transition_input.worker_id, "worker-alpha");
        assert_eq!(plan.ral_transition_input.claim_token, "claim-alpha");
        assert_eq!(
            plan.ral_transition_input.identity,
            RalJournalIdentity {
                project_id: "project-alpha".to_string(),
                agent_pubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
                conversation_id: "conversation-alpha".to_string(),
                ral_number: 3,
            }
        );

        match plan.ral_transition_input.transition {
            RalWorkerTransition::Completed { terminal } => {
                assert!(terminal.published_user_visible_event);
                assert!(!terminal.pending_delegations_remain);
                assert_eq!(terminal.accumulated_runtime_ms, 2250);
                assert_eq!(terminal.final_event_ids, vec!["published-event-id"]);
                assert!(!terminal.keep_worker_warm);
            }
            other => panic!("expected completed transition, got {other:?}"),
        }
    }

    #[test]
    fn plans_waiting_result_with_resolved_pending_delegations() {
        let message = fixture_valid_message("waiting-for-delegation");
        let delegation = pending_delegation("delegation-conversation-1");

        let plan = plan_worker_result_transition(&message, context(vec![delegation.clone()]))
            .expect("waiting worker result must plan");

        match plan.ral_transition_input.transition {
            RalWorkerTransition::WaitingForDelegation {
                pending_delegations,
                terminal,
            } => {
                assert_eq!(pending_delegations, vec![delegation]);
                assert!(!terminal.published_user_visible_event);
                assert!(terminal.pending_delegations_remain);
                assert_eq!(terminal.accumulated_runtime_ms, 1200);
                assert!(terminal.keep_worker_warm);
            }
            other => panic!("expected waiting transition, got {other:?}"),
        }
    }

    #[test]
    fn rejects_unresolved_pending_delegation_ids() {
        let message = fixture_valid_message("waiting-for-delegation");

        assert_eq!(
            plan_worker_result_transition(&message, context(Vec::new())),
            Err(WorkerResultError::UnresolvedPendingDelegation {
                delegation_conversation_id: "delegation-conversation-1".to_string()
            })
        );
    }

    #[test]
    fn rejects_unreported_resolved_pending_delegations() {
        let message = fixture_valid_message("waiting-for-delegation");

        assert_eq!(
            plan_worker_result_transition(
                &message,
                context(vec![
                    pending_delegation("delegation-conversation-1"),
                    pending_delegation("delegation-conversation-2"),
                ]),
            ),
            Err(WorkerResultError::UnreportedResolvedPendingDelegation {
                delegation_conversation_id: "delegation-conversation-2".to_string()
            })
        );
    }

    #[test]
    fn rejects_non_terminal_worker_messages() {
        let message = fixture_valid_message("published");

        assert_eq!(
            plan_worker_result_transition(&message, context(Vec::new())),
            Err(WorkerResultError::NonTerminalMessage {
                message_type: "published".to_string()
            })
        );
    }

    #[test]
    fn rejects_daemon_to_worker_messages() {
        let message = fixture_valid_message("publish-result");

        assert_eq!(
            plan_worker_result_transition(&message, context(Vec::new())),
            Err(WorkerResultError::InvalidDirection(
                WorkerProtocolDirection::DaemonToWorker
            ))
        );
    }

    #[test]
    fn plans_error_result_and_requires_terminal_error_flag() {
        let message = fixture_valid_message("error");

        let plan = plan_worker_result_transition(&message, context(Vec::new()))
            .expect("terminal error worker result must plan");
        match plan.ral_transition_input.transition {
            RalWorkerTransition::Error { error, terminal } => {
                assert_eq!(error.code, "llm_provider_error");
                assert_eq!(error.message, "provider returned retryable error");
                assert!(error.retryable);
                assert_eq!(terminal.final_event_ids, vec!["error-event-id"]);
            }
            other => panic!("expected error transition, got {other:?}"),
        }

        let mut non_terminal = message;
        non_terminal["terminal"] = json!(false);
        assert_eq!(
            plan_worker_result_transition(&non_terminal, context(Vec::new())),
            Err(WorkerResultError::InvalidField("terminal"))
        );
    }

    #[test]
    fn plans_no_response_and_aborted_result_transitions() {
        let no_response = plan_worker_result_transition(
            &fixture_valid_message("no-response"),
            context(Vec::new()),
        )
        .expect("no_response worker result must plan");
        assert!(matches!(
            no_response.ral_transition_input.transition,
            RalWorkerTransition::NoResponse { .. }
        ));

        let aborted =
            plan_worker_result_transition(&fixture_valid_message("aborted"), context(Vec::new()))
                .expect("aborted worker result must plan");
        assert!(matches!(
            aborted.ral_transition_input.transition,
            RalWorkerTransition::Aborted {
                ref abort_reason,
                ..
            } if abort_reason == "operator_requested"
        ));
    }

    fn fixture_valid_message(name: &str) -> Value {
        let fixture: Value =
            serde_json::from_str(WORKER_PROTOCOL_FIXTURE).expect("fixture must parse");
        fixture["validMessages"]
            .as_array()
            .expect("validMessages must be an array")
            .iter()
            .find(|message| message["name"] == name)
            .unwrap_or_else(|| panic!("fixture message {name} must exist"))["message"]
            .clone()
    }

    fn context(
        resolved_pending_delegations: Vec<RalPendingDelegation>,
    ) -> WorkerResultTransitionContext {
        WorkerResultTransitionContext {
            worker_id: "worker-alpha".to_string(),
            claim_token: "claim-alpha".to_string(),
            journal_sequence: 200,
            journal_timestamp: 1710000500000,
            writer_version: "test-version".to_string(),
            resolved_pending_delegations,
        }
    }

    fn pending_delegation(delegation_conversation_id: &str) -> RalPendingDelegation {
        RalPendingDelegation {
            delegation_conversation_id: delegation_conversation_id.to_string(),
            recipient_pubkey: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                .to_string(),
            sender_pubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
            prompt: "Please handle this delegated work.".to_string(),
            delegation_type: RalDelegationType::Standard,
            ral_number: 4,
            parent_delegation_conversation_id: None,
            pending_sub_delegations: None,
            deferred_completion: None,
            followup_event_id: None,
            project_id: Some("project-alpha".to_string()),
            suggestions: None,
            killed: None,
            killed_at: None,
        }
    }
}
