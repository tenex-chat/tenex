use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use thiserror::Error;
use tokio::sync::mpsc::UnboundedSender;

use crate::backend_config::Nip46Config;
use crate::daemon_signals::PublishEnqueued;
use crate::dispatch_queue::DispatchQueueState;
use crate::nip46::registry::NIP46Registry;
use crate::ral_journal::{
    RAL_JOURNAL_WRITER_RUST_DAEMON, RalDelegationType, RalJournalError, RalJournalEvent,
    RalJournalIdentity, RalJournalRecord, RalPendingDelegation,
    append_ral_journal_record_with_resequence,
};
use crate::ral_scheduler::RalScheduler;
use crate::worker_completion::flow::{
    AppliedWorkerTerminalFlow, WorkerTerminalFlowError, WorkerTerminalFlowInput,
    handle_worker_terminal_result,
};
use crate::worker_completion::plan::WorkerCompletionDispatchInput;
use crate::worker_completion::result::WorkerResultTransitionContext;
use crate::worker_dispatch::execution::WorkerDispatchSession;
use crate::worker_heartbeat::{
    WorkerHeartbeatContext, WorkerHeartbeatError, WorkerHeartbeatSnapshot,
    plan_worker_heartbeat_snapshot,
};
use crate::worker_lifecycle::launch_lock::WorkerLaunchLocks;
use crate::worker_message::{
    WorkerControlTelemetryKind, WorkerMessageAction, WorkerMessageError, WorkerMessagePlan,
    WorkerPublishedMode, WorkerStreamTelemetryKind, plan_worker_message_handling,
};
use crate::worker_publish::flow::{
    WorkerPublishFlowError, WorkerPublishFlowInput, WorkerPublishFlowOutcome,
    handle_worker_publish_request,
};
use crate::worker_publish::nip46_flow::{
    WorkerNip46PublishFlowError, WorkerNip46PublishFlowInput, WorkerNip46PublishFlowOutcome,
    handle_worker_nip46_publish_request,
};
use crate::worker_runtime_state::{
    ActiveWorkerRuntimeSnapshot, SharedWorkerRuntimeState, WorkerRuntimeStateError,
};
use crate::worker_telegram_egress::WorkerTelegramEgressContext;

#[derive(Debug)]
pub struct WorkerMessageFlowInput<'a> {
    pub daemon_dir: &'a Path,
    pub worker_id: &'a str,
    pub message: &'a Value,
    pub observed_at: u64,
    pub publish: Option<WorkerMessagePublishContext<'a>>,
    pub nip46_publish: Option<WorkerMessageNip46PublishContext<'a>>,
    pub terminal: Option<WorkerMessageTerminalContext<'a>>,
}

#[derive(Debug, Clone)]
pub struct WorkerMessageNip46PublishContext<'a> {
    pub registry: Arc<NIP46Registry>,
    pub nip46_config: &'a Nip46Config,
    pub default_relay: &'a str,
    pub accepted_at: u64,
    pub result_sequence: u64,
    pub result_timestamp: u64,
}

#[derive(Debug, Clone)]
pub struct WorkerMessagePublishContext<'a> {
    pub accepted_at: u64,
    pub result_sequence_source: Arc<AtomicU64>,
    pub result_timestamp: u64,
    pub telegram_egress: Option<WorkerTelegramEgressContext<'a>>,
    pub publish_enqueued_tx: Option<UnboundedSender<PublishEnqueued>>,
}

#[derive(Debug)]
pub struct WorkerMessageTerminalContext<'a> {
    pub scheduler: &'a RalScheduler,
    pub dispatch_state: &'a DispatchQueueState,
    pub result_context: WorkerResultTransitionContext,
    pub dispatch: Option<WorkerCompletionDispatchInput>,
    pub locks: WorkerLaunchLocks,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerMessageFlowOutcome {
    HeartbeatUpdated {
        message: WorkerMessagePlan,
        snapshot: WorkerHeartbeatSnapshot,
    },
    PublishRequestHandled {
        outcome: Box<WorkerPublishFlowOutcome>,
    },
    Nip46PublishRequestHandled {
        message: WorkerMessagePlan,
        outcome: Box<WorkerNip46PublishFlowOutcome>,
    },
    TerminalResultHandled {
        outcome: Box<AppliedWorkerTerminalFlow>,
        removed_worker: Box<ActiveWorkerRuntimeSnapshot>,
    },
    ControlTelemetry {
        message: WorkerMessagePlan,
        kind: WorkerControlTelemetryKind,
    },
    StreamTelemetry {
        message: WorkerMessagePlan,
        kind: WorkerStreamTelemetryKind,
    },
    PublishedNotification {
        message: WorkerMessagePlan,
        mode: WorkerPublishedMode,
    },
    BootFailureCandidate {
        message: WorkerMessagePlan,
        candidate: WorkerBootFailureCandidate,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerBootFailureCandidate {
    pub worker_id: String,
    pub correlation_id: String,
    pub sequence: u64,
    pub timestamp: u64,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Error)]
pub enum WorkerMessageFlowError {
    #[error("worker message classification failed: {source}")]
    Message {
        #[source]
        source: Box<WorkerMessageError>,
    },
    #[error("worker heartbeat planning failed: {source}")]
    Heartbeat {
        #[source]
        source: Box<WorkerHeartbeatError>,
    },
    #[error("worker runtime state rejected message handling: {source}")]
    Runtime {
        #[source]
        source: Box<WorkerRuntimeStateError>,
    },
    #[error("worker message field is missing or invalid: {0}")]
    InvalidField(&'static str),
    #[error("worker {worker_id} message identity does not match active runtime worker")]
    RuntimeIdentityMismatch {
        worker_id: String,
        expected: Box<RalJournalIdentity>,
        actual: Box<RalJournalIdentity>,
    },
    #[error(
        "terminal context worker {actual_worker_id} does not match active worker {expected_worker_id}"
    )]
    TerminalContextWorkerMismatch {
        expected_worker_id: String,
        actual_worker_id: String,
    },
    #[error("terminal context claim token does not match active worker {worker_id}")]
    TerminalContextClaimTokenMismatch {
        worker_id: String,
        expected: String,
        actual: String,
    },
    #[error("worker message type {message_type} needs publish context")]
    MissingPublishContext { message_type: String },
    #[error("worker message type {message_type} needs nip46 publish context")]
    MissingNip46PublishContext { message_type: String },
    #[error("worker message type {message_type} needs terminal context")]
    MissingTerminalContext { message_type: String },
    #[error("worker publish flow failed: {source}")]
    Publish {
        #[source]
        source: Box<WorkerPublishFlowError>,
    },
    #[error("worker nip46 publish flow failed: {source}")]
    Nip46Publish {
        #[source]
        source: Box<WorkerNip46PublishFlowError>,
    },
    #[error("worker terminal flow failed: {source}")]
    Terminal {
        #[source]
        source: Box<WorkerTerminalFlowError>,
    },
    #[error("worker delegation registration journal failed: {source}")]
    RalJournal {
        #[source]
        source: Box<RalJournalError>,
    },
    #[error("worker delegation registration journal sequence exhausted after {last_sequence}")]
    RalJournalSequenceExhausted { last_sequence: u64 },
}

pub fn handle_worker_message_flow<S>(
    session: &mut S,
    runtime_state: &SharedWorkerRuntimeState,
    input: WorkerMessageFlowInput<'_>,
) -> Result<WorkerMessageFlowOutcome, WorkerMessageFlowError>
where
    S: WorkerDispatchSession,
{
    let message_plan =
        plan_worker_message_handling(input.message).map_err(WorkerMessageFlowError::from)?;

    match message_plan.action.clone() {
        WorkerMessageAction::HeartbeatSnapshotCandidate => handle_heartbeat(
            runtime_state,
            input.worker_id,
            input.observed_at,
            message_plan,
        ),
        WorkerMessageAction::PublishRequestCandidate => {
            let publish =
                input
                    .publish
                    .ok_or_else(|| WorkerMessageFlowError::MissingPublishContext {
                        message_type: message_plan.metadata.message_type.clone(),
                    })?;
            let _ =
                ensure_active_worker_matches_message(runtime_state, input.worker_id, &message_plan)?;
            let result_sequence = publish
                .result_sequence_source
                .fetch_add(1, Ordering::Relaxed);
            let publish_enqueued_tx = publish.publish_enqueued_tx.clone();
            let outcome = handle_worker_publish_request(
                session,
                WorkerPublishFlowInput {
                    daemon_dir: input.daemon_dir,
                    message: &message_plan.message,
                    accepted_at: publish.accepted_at,
                    result_sequence,
                    result_timestamp: publish.result_timestamp,
                    telegram_egress: publish.telegram_egress,
                },
            )
            .map_err(WorkerMessageFlowError::from)?;

            if outcome.acceptance.egress.as_nostr().is_some() {
                if let Some(ref tx) = publish_enqueued_tx {
                    let _ = tx.send(PublishEnqueued);
                }
            }

            Ok(WorkerMessageFlowOutcome::PublishRequestHandled {
                outcome: Box::new(outcome),
            })
        }
        WorkerMessageAction::Nip46PublishRequestCandidate => {
            let nip46 = input.nip46_publish.ok_or_else(|| {
                WorkerMessageFlowError::MissingNip46PublishContext {
                    message_type: message_plan.metadata.message_type.clone(),
                }
            })?;
            let _ =
                ensure_active_worker_matches_message(runtime_state, input.worker_id, &message_plan)?;
            let outcome = handle_worker_nip46_publish_request(
                session,
                WorkerNip46PublishFlowInput {
                    daemon_dir: input.daemon_dir,
                    registry: nip46.registry,
                    nip46_config: nip46.nip46_config,
                    default_relay: nip46.default_relay,
                    message: &message_plan.message,
                    accepted_at: nip46.accepted_at,
                    result_sequence: nip46.result_sequence,
                    result_timestamp: nip46.result_timestamp,
                },
            )
            .map_err(WorkerMessageFlowError::from)?;

            Ok(WorkerMessageFlowOutcome::Nip46PublishRequestHandled {
                message: message_plan,
                outcome: Box::new(outcome),
            })
        }
        WorkerMessageAction::TerminalResultCandidate { .. } => {
            let terminal =
                input
                    .terminal
                    .ok_or_else(|| WorkerMessageFlowError::MissingTerminalContext {
                        message_type: message_plan.metadata.message_type.clone(),
                    })?;
            let (active_worker, active_slot) = ensure_active_worker_matches_message(
                runtime_state,
                input.worker_id,
                &message_plan,
            )?;
            ensure_terminal_context_matches_worker(
                &active_worker,
                &active_slot,
                &terminal.result_context,
            )?;
            let terminal_scheduler =
                RalScheduler::from_daemon_dir(input.daemon_dir).map_err(|source| {
                    WorkerMessageFlowError::RalJournal {
                        source: Box::new(source),
                    }
                })?;
            let mut result_context = terminal.result_context;
            result_context.journal_sequence = terminal_scheduler
                .state()
                .last_sequence
                .checked_add(1)
                .ok_or(WorkerMessageFlowError::RalJournalSequenceExhausted {
                    last_sequence: terminal_scheduler.state().last_sequence,
                })?;
            // Stamp the terminal record with the actual wall-clock time at the
            // moment of writing, not the dispatch-admission time captured
            // earlier.  This ensures the journal reflects when the session
            // actually finished so RAL-based concurrency checks (e.g. the
            // temporal-overlap proof in scenario 04) see accurate windows.
            result_context.journal_timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
                .unwrap_or(result_context.journal_timestamp);
            if let Some(entry) = terminal_scheduler.entry(&active_slot.identity) {
                result_context.resolved_pending_delegations = entry.pending_delegations.clone();
                result_context.already_completed_delegation_ids = entry
                    .completed_delegations
                    .iter()
                    .map(|c| c.delegation_conversation_id.clone())
                    .collect::<HashSet<_>>();
            }

            let outcome = handle_worker_terminal_result(
                &terminal_scheduler,
                terminal.dispatch_state,
                WorkerTerminalFlowInput {
                    daemon_dir: input.daemon_dir,
                    message: &message_plan.message,
                    result_context,
                    dispatch: terminal.dispatch,
                    locks: terminal.locks,
                },
            )
            .map_err(WorkerMessageFlowError::from)?;

            // Remove just the terminating execution slot. If it was the worker's
            // only slot, the worker is removed too — same observable outcome as
            // the pre-warm-worker behavior.
            let removed_worker = runtime_state
                .lock()
                .expect("runtime state mutex poisoned")
                .remove_terminal_dispatch(&active_slot.dispatch_id)
                .map_err(WorkerMessageFlowError::from)?;

            Ok(WorkerMessageFlowOutcome::TerminalResultHandled {
                outcome: Box::new(outcome),
                removed_worker: Box::new(removed_worker),
            })
        }
        WorkerMessageAction::ControlTelemetry { kind } => {
            if kind == WorkerControlTelemetryKind::DelegationRegistered {
                handle_delegation_registered(runtime_state, &input, &message_plan)?;
            } else if kind == WorkerControlTelemetryKind::DelegationKilled {
                handle_delegation_killed(runtime_state, &input, &message_plan)?;
            }
            Ok(WorkerMessageFlowOutcome::ControlTelemetry {
                message: message_plan,
                kind,
            })
        }
        WorkerMessageAction::StreamTelemetry { kind } => {
            Ok(WorkerMessageFlowOutcome::StreamTelemetry {
                message: message_plan,
                kind,
            })
        }
        WorkerMessageAction::PublishedNotification { mode } => {
            Ok(WorkerMessageFlowOutcome::PublishedNotification {
                message: message_plan,
                mode,
            })
        }
        WorkerMessageAction::BootError => {
            let candidate = boot_failure_candidate(input.worker_id, &message_plan)?;
            Ok(WorkerMessageFlowOutcome::BootFailureCandidate {
                message: message_plan,
                candidate,
            })
        }
    }
}

fn handle_heartbeat(
    runtime_state: &SharedWorkerRuntimeState,
    worker_id: &str,
    observed_at: u64,
    message_plan: WorkerMessagePlan,
) -> Result<WorkerMessageFlowOutcome, WorkerMessageFlowError> {
    let snapshot = plan_worker_heartbeat_snapshot(
        &message_plan.message,
        WorkerHeartbeatContext {
            worker_id: worker_id.to_string(),
            observed_at,
        },
    )
    .map_err(WorkerMessageFlowError::from)?;

    runtime_state
        .lock()
        .expect("runtime state mutex poisoned")
        .update_worker_heartbeat(worker_id, snapshot.clone())
        .map_err(WorkerMessageFlowError::from)?;

    Ok(WorkerMessageFlowOutcome::HeartbeatUpdated {
        message: message_plan,
        snapshot,
    })
}

fn ensure_active_worker_matches_message(
    runtime_state: &SharedWorkerRuntimeState,
    worker_id: &str,
    message_plan: &WorkerMessagePlan,
) -> Result<
    (
        ActiveWorkerRuntimeSnapshot,
        crate::worker_runtime_state::ActiveExecutionSlot,
    ),
    WorkerMessageFlowError,
> {
    let worker = runtime_state
        .lock()
        .expect("runtime state mutex poisoned")
        .get_worker(worker_id)
        .cloned()
        .ok_or_else(|| WorkerRuntimeStateError::UnknownWorker {
            worker_id: worker_id.to_string(),
        })
        .map_err(WorkerMessageFlowError::from)?;
    let actual_identity = ral_identity_from_message(&message_plan.message)?;

    let slot = worker
        .execution_by_identity(&actual_identity)
        .cloned()
        .ok_or_else(|| WorkerMessageFlowError::RuntimeIdentityMismatch {
            worker_id: worker.worker_id.clone(),
            expected: Box::new(
                worker
                    .primary_execution()
                    .map(|s| s.identity.clone())
                    .unwrap_or_else(|| actual_identity.clone()),
            ),
            actual: Box::new(actual_identity),
        })?;

    Ok((worker, slot))
}

fn ensure_terminal_context_matches_worker(
    worker: &ActiveWorkerRuntimeSnapshot,
    slot: &crate::worker_runtime_state::ActiveExecutionSlot,
    context: &WorkerResultTransitionContext,
) -> Result<(), WorkerMessageFlowError> {
    if context.worker_id != worker.worker_id {
        return Err(WorkerMessageFlowError::TerminalContextWorkerMismatch {
            expected_worker_id: worker.worker_id.clone(),
            actual_worker_id: context.worker_id.clone(),
        });
    }

    if context.claim_token != slot.claim_token {
        return Err(WorkerMessageFlowError::TerminalContextClaimTokenMismatch {
            worker_id: worker.worker_id.clone(),
            expected: slot.claim_token.clone(),
            actual: context.claim_token.clone(),
        });
    }

    Ok(())
}

fn handle_delegation_registered(
    runtime_state: &SharedWorkerRuntimeState,
    input: &WorkerMessageFlowInput<'_>,
    message_plan: &WorkerMessagePlan,
) -> Result<(), WorkerMessageFlowError> {
    let (active_worker, active_slot) =
        ensure_active_worker_matches_message(runtime_state, input.worker_id, message_plan)?;
    let pending_delegation =
        pending_delegation_from_message(&message_plan.message, &active_slot.identity)?;
    let scheduler = RalScheduler::from_daemon_dir(input.daemon_dir).map_err(|source| {
        WorkerMessageFlowError::RalJournal {
            source: Box::new(source),
        }
    })?;
    let sequence = scheduler.state().last_sequence.checked_add(1).ok_or(
        WorkerMessageFlowError::RalJournalSequenceExhausted {
            last_sequence: scheduler.state().last_sequence,
        },
    )?;
    let mut record = RalJournalRecord::new(
        RAL_JOURNAL_WRITER_RUST_DAEMON,
        env!("CARGO_PKG_VERSION"),
        sequence,
        input.observed_at,
        format!(
            "{}:delegation_registered",
            message_plan.metadata.correlation_id
        ),
        RalJournalEvent::DelegationRegistered {
            identity: active_slot.identity,
            worker_id: active_worker.worker_id,
            claim_token: active_slot.claim_token,
            pending_delegation,
        },
    );
    append_ral_journal_record_with_resequence(input.daemon_dir, &mut record).map_err(|source| {
        WorkerMessageFlowError::RalJournal {
            source: Box::new(source),
        }
    })?;

    Ok(())
}

fn handle_delegation_killed(
    runtime_state: &SharedWorkerRuntimeState,
    input: &WorkerMessageFlowInput<'_>,
    message_plan: &WorkerMessagePlan,
) -> Result<(), WorkerMessageFlowError> {
    let (_active_worker, active_slot) =
        ensure_active_worker_matches_message(runtime_state, input.worker_id, message_plan)?;
    let delegation_conversation_id =
        required_string(&message_plan.message, "delegationConversationId")?.to_string();
    let reason = required_string(&message_plan.message, "reason")?.to_string();
    let scheduler = RalScheduler::from_daemon_dir(input.daemon_dir).map_err(|source| {
        WorkerMessageFlowError::RalJournal {
            source: Box::new(source),
        }
    })?;
    let sequence = scheduler.state().last_sequence.checked_add(1).ok_or(
        WorkerMessageFlowError::RalJournalSequenceExhausted {
            last_sequence: scheduler.state().last_sequence,
        },
    )?;
    let mut record = RalJournalRecord::new(
        RAL_JOURNAL_WRITER_RUST_DAEMON,
        env!("CARGO_PKG_VERSION"),
        sequence,
        input.observed_at,
        format!("{}:delegation_killed", message_plan.metadata.correlation_id),
        RalJournalEvent::DelegationKilled {
            identity: active_slot.identity,
            delegation_conversation_id,
            killed_at: input.observed_at,
            reason,
        },
    );
    append_ral_journal_record_with_resequence(input.daemon_dir, &mut record).map_err(|source| {
        WorkerMessageFlowError::RalJournal {
            source: Box::new(source),
        }
    })?;

    Ok(())
}

fn pending_delegation_from_message(
    message: &Value,
    identity: &RalJournalIdentity,
) -> Result<RalPendingDelegation, WorkerMessageFlowError> {
    Ok(RalPendingDelegation {
        delegation_conversation_id: required_string(message, "delegationConversationId")?
            .to_string(),
        recipient_pubkey: required_string(message, "recipientPubkey")?.to_string(),
        sender_pubkey: optional_string(message, "senderPubkey")
            .unwrap_or(identity.agent_pubkey.as_str())
            .to_string(),
        prompt: optional_string(message, "prompt")
            .unwrap_or_default()
            .to_string(),
        delegation_type: delegation_type_from_message(message)?,
        ral_number: identity.ral_number,
        parent_delegation_conversation_id: optional_string(
            message,
            "parentDelegationConversationId",
        )
        .map(str::to_string),
        pending_sub_delegations: None,
        deferred_completion: None,
        followup_event_id: optional_string(message, "followupEventId").map(str::to_string),
        project_id: optional_string(message, "delegationProjectId").map(str::to_string),
        suggestions: optional_string_array(message, "suggestions"),
        killed: None,
        killed_at: None,
    })
}

fn delegation_type_from_message(
    message: &Value,
) -> Result<RalDelegationType, WorkerMessageFlowError> {
    match required_string(message, "delegationType")? {
        "standard" => Ok(RalDelegationType::Standard),
        "followup" => Ok(RalDelegationType::Followup),
        "external" => Ok(RalDelegationType::External),
        "ask" => Ok(RalDelegationType::Ask),
        _ => Err(WorkerMessageFlowError::InvalidField("delegationType")),
    }
}

fn ral_identity_from_message(
    message: &Value,
) -> Result<RalJournalIdentity, WorkerMessageFlowError> {
    Ok(RalJournalIdentity {
        project_id: required_string(message, "projectId")?.to_string(),
        agent_pubkey: required_string(message, "agentPubkey")?.to_string(),
        conversation_id: required_string(message, "conversationId")?.to_string(),
        ral_number: required_u64(message, "ralNumber")?,
    })
}

fn boot_failure_candidate(
    worker_id: &str,
    message_plan: &WorkerMessagePlan,
) -> Result<WorkerBootFailureCandidate, WorkerMessageFlowError> {
    let error = message_plan
        .message
        .get("error")
        .ok_or(WorkerMessageFlowError::InvalidField("error"))?;

    Ok(WorkerBootFailureCandidate {
        worker_id: worker_id.to_string(),
        correlation_id: message_plan.metadata.correlation_id.clone(),
        sequence: message_plan.metadata.sequence,
        timestamp: message_plan.metadata.timestamp,
        code: required_string(error, "code")?.to_string(),
        message: required_string(error, "message")?.to_string(),
        retryable: required_bool(error, "retryable")?,
    })
}

fn required_string<'a>(
    value: &'a Value,
    field: &'static str,
) -> Result<&'a str, WorkerMessageFlowError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or(WorkerMessageFlowError::InvalidField(field))
}

fn required_u64(value: &Value, field: &'static str) -> Result<u64, WorkerMessageFlowError> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or(WorkerMessageFlowError::InvalidField(field))
}

fn required_bool(value: &Value, field: &'static str) -> Result<bool, WorkerMessageFlowError> {
    value
        .get(field)
        .and_then(Value::as_bool)
        .ok_or(WorkerMessageFlowError::InvalidField(field))
}

fn optional_string<'a>(value: &'a Value, field: &'static str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn optional_string_array(value: &Value, field: &'static str) -> Option<Vec<String>> {
    let array = value.get(field)?.as_array()?;
    let mut strings = Vec::with_capacity(array.len());
    for item in array {
        strings.push(item.as_str()?.to_string());
    }
    Some(strings)
}

impl From<WorkerMessageError> for WorkerMessageFlowError {
    fn from(source: WorkerMessageError) -> Self {
        Self::Message {
            source: Box::new(source),
        }
    }
}

impl From<WorkerHeartbeatError> for WorkerMessageFlowError {
    fn from(source: WorkerHeartbeatError) -> Self {
        Self::Heartbeat {
            source: Box::new(source),
        }
    }
}

impl From<WorkerRuntimeStateError> for WorkerMessageFlowError {
    fn from(source: WorkerRuntimeStateError) -> Self {
        Self::Runtime {
            source: Box::new(source),
        }
    }
}

impl From<WorkerPublishFlowError> for WorkerMessageFlowError {
    fn from(source: WorkerPublishFlowError) -> Self {
        Self::Publish {
            source: Box::new(source),
        }
    }
}

impl From<WorkerNip46PublishFlowError> for WorkerMessageFlowError {
    fn from(source: WorkerNip46PublishFlowError) -> Self {
        Self::Nip46Publish {
            source: Box::new(source),
        }
    }
}

impl From<WorkerTerminalFlowError> for WorkerMessageFlowError {
    fn from(source: WorkerTerminalFlowError) -> Self {
        Self::Terminal {
            source: Box::new(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecord, DispatchQueueRecordParams, DispatchQueueStatus, DispatchRalIdentity,
        append_dispatch_queue_record, build_dispatch_queue_record, replay_dispatch_queue,
    };
    use crate::nostr_event::Nip01EventFixture;
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
        append_ral_journal_record,
    };
    use crate::ral_lock::{build_ral_lock_info, read_ral_lock_info};
    use crate::ral_scheduler::RalScheduler;
    use crate::worker_lifecycle::launch::{
        RalAllocationLockScope, RalStateLockScope, WorkerLaunchPlan,
    };
    use crate::worker_lifecycle::launch_lock::acquire_worker_launch_locks;
    use crate::worker_protocol::AGENT_WORKER_PROTOCOL_VERSION;
    use crate::worker_publish::flow::WorkerPublishResultDelivery;
    use crate::worker_runtime_state::{SharedWorkerRuntimeState, WorkerRuntimeStartedDispatch};
    use serde_json::json;
    use std::error::Error;
    use std::fmt;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const STREAM_TEXT_DELTA_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json");
    const WORKER_PROTOCOL_FIXTURE: &str = include_str!(
        "../../../src/test-utils/fixtures/worker-protocol/agent-execution.compat.json"
    );

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug, Default)]
    struct RecordingSession {
        sent_messages: Vec<Value>,
    }

    impl WorkerDispatchSession for RecordingSession {
        type Error = FakeSendError;

        fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error> {
            self.sent_messages.push(message.clone());
            Ok(())
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct FakeSendError(&'static str);

    impl fmt::Display for FakeSendError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    impl Error for FakeSendError {}

    #[test]
    fn handles_heartbeat_by_updating_runtime_state() {
        let daemon_dir = unique_temp_daemon_dir();
        let runtime_state = runtime_state_for(identity());
        let mut session = RecordingSession::default();

        let outcome = handle_worker_message_flow(
            &mut session,
            &runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-alpha",
                message: &fixture_valid_message("heartbeat"),
                observed_at: 1_710_000_403_000,
                publish: None,
                nip46_publish: None,
                terminal: None,
            },
        )
        .expect("heartbeat message flow must succeed");

        match outcome {
            WorkerMessageFlowOutcome::HeartbeatUpdated { message, snapshot } => {
                assert_eq!(message.metadata.message_type, "heartbeat");
                assert_eq!(snapshot.worker_id, "worker-alpha");
                assert_eq!(snapshot.observed_at, 1_710_000_403_000);
                assert_eq!(
                    runtime_state
                        .lock()
                        .unwrap()
                        .get_worker("worker-alpha")
                        .expect("worker must remain active")
                        .latest_heartbeat()
                        .cloned(),
                    Some(snapshot)
                );
            }
            other => panic!("expected heartbeat outcome, got {other:?}"),
        }
        assert!(session.sent_messages.is_empty());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn delegation_registered_records_pending_delegation_for_claimed_ral() {
        let daemon_dir = unique_temp_daemon_dir();
        append_initial_ral_records(&daemon_dir);
        let runtime_state = runtime_state_for(identity());
        let mut session = RecordingSession::default();
        let message = json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "delegation_registered",
            "correlationId": "worker-message-flow-test",
            "sequence": 42,
            "timestamp": 1_710_000_404_000_u64,
            "projectId": "project-alpha",
            "agentPubkey": "a".repeat(64),
            "conversationId": "conversation-alpha",
            "ralNumber": 3,
            "delegationConversationId": "delegation-a",
            "recipientPubkey": "b".repeat(64),
            "senderPubkey": "a".repeat(64),
            "prompt": "please handle this",
            "delegationType": "standard",
        });

        let outcome = handle_worker_message_flow(
            &mut session,
            &runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-alpha",
                message: &message,
                observed_at: 1_710_000_404_050,
                publish: None,
                nip46_publish: None,
                terminal: None,
            },
        )
        .expect("delegation registration must be recorded");

        match outcome {
            WorkerMessageFlowOutcome::ControlTelemetry { message, kind } => {
                assert_eq!(message.metadata.message_type, "delegation_registered");
                assert_eq!(kind, WorkerControlTelemetryKind::DelegationRegistered);
            }
            other => panic!("expected control telemetry outcome, got {other:?}"),
        }

        let scheduler = RalScheduler::from_daemon_dir(&daemon_dir).expect("journal must replay");
        let entry = scheduler
            .entry(&identity())
            .expect("claimed RAL entry must remain present");
        assert_eq!(entry.status, crate::ral_journal::RalReplayStatus::Claimed);
        assert_eq!(entry.pending_delegations.len(), 1);
        assert_eq!(
            entry.pending_delegations[0].delegation_conversation_id,
            "delegation-a"
        );
        assert_eq!(entry.pending_delegations[0].prompt, "please handle this");
        assert!(session.sent_messages.is_empty());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn handles_publish_request_through_publish_flow() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let runtime_state = runtime_state_for(identity_with_agent(&fixture.pubkey));
        let mut session = RecordingSession::default();
        let message = publish_request_message(&fixture, 41, 1_710_001_000_000);

        let outcome = handle_worker_message_flow(
            &mut session,
            &runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-alpha",
                message: &message,
                observed_at: 1_710_001_000_050,
                publish: Some(WorkerMessagePublishContext {
                    accepted_at: 1_710_001_000_100,
                    result_sequence_source: Arc::new(AtomicU64::new(900)),
                    result_timestamp: 1_710_001_000_200,
                    telegram_egress: None,
                    publish_enqueued_tx: None,
                }),
                nip46_publish: None,
                terminal: None,
            },
        )
        .expect("publish request message flow must succeed");

        match outcome {
            WorkerMessageFlowOutcome::PublishRequestHandled { outcome } => {
                assert_eq!(
                    outcome
                        .acceptance
                        .egress
                        .as_nostr()
                        .expect("default worker publish must route to Nostr")
                        .event
                        .id,
                    fixture.signed.id
                );
                assert_eq!(
                    session.sent_messages,
                    vec![outcome.acceptance.publish_result]
                );
                assert_eq!(outcome.result_delivery, WorkerPublishResultDelivery::Sent);
            }
            other => panic!("expected publish outcome, got {other:?}"),
        }
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending publish record must read")
                .is_some()
        );
        assert!(
            runtime_state
                .lock()
                .unwrap()
                .get_worker("worker-alpha")
                .is_some()
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn handles_terminal_result_through_terminal_flow_and_removes_runtime_worker() {
        let daemon_dir = unique_temp_daemon_dir();
        append_initial_ral_records(&daemon_dir);
        append_initial_dispatch_records(&daemon_dir);
        let scheduler = RalScheduler::from_daemon_dir(&daemon_dir).expect("scheduler must replay");
        let dispatch_state = replay_dispatch_queue(&daemon_dir).expect("queue must replay");
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");
        let allocation_lock_path = locks.allocation.path.clone();
        let state_lock_path = locks.state.path.clone();
        let runtime_state = runtime_state_for(identity());
        let mut session = RecordingSession::default();

        let outcome = handle_worker_message_flow(
            &mut session,
            &runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-alpha",
                message: &fixture_valid_message("complete"),
                observed_at: 1_710_000_500_050,
                publish: None,
                nip46_publish: None,
                terminal: Some(WorkerMessageTerminalContext {
                    scheduler: &scheduler,
                    dispatch_state: &dispatch_state,
                    result_context: result_context(),
                    dispatch: Some(dispatch_input()),
                    locks,
                }),
            },
        )
        .expect("terminal message flow must succeed");

        match outcome {
            WorkerMessageFlowOutcome::TerminalResultHandled {
                outcome,
                removed_worker,
            } => {
                assert_eq!(outcome.message.metadata.message_type, "complete");
                assert_eq!(removed_worker.worker_id, "worker-alpha");
            }
            other => panic!("expected terminal outcome, got {other:?}"),
        }
        assert!(runtime_state.lock().unwrap().is_empty());
        assert!(session.sent_messages.is_empty());
        assert_eq!(
            read_ral_lock_info(&allocation_lock_path).expect("allocation lock must read"),
            None
        );
        assert_eq!(
            read_ral_lock_info(&state_lock_path).expect("state lock must read"),
            None
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn returns_telemetry_without_runtime_or_filesystem_side_effects() {
        let daemon_dir = unique_temp_daemon_dir();
        let runtime_state = crate::worker_runtime_state::new_shared_worker_runtime_state();
        let mut session = RecordingSession::default();

        let outcome = handle_worker_message_flow(
            &mut session,
            &runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-alpha",
                message: &fixture_valid_message("stream-delta"),
                observed_at: 1_710_000_401_500,
                publish: None,
                nip46_publish: None,
                terminal: None,
            },
        )
        .expect("stream telemetry message flow must succeed");

        match outcome {
            WorkerMessageFlowOutcome::StreamTelemetry { message, kind } => {
                assert_eq!(message.metadata.message_type, "stream_delta");
                assert_eq!(kind, WorkerStreamTelemetryKind::StreamDelta);
            }
            other => panic!("expected telemetry outcome, got {other:?}"),
        }
        assert!(runtime_state.lock().unwrap().is_empty());
        assert!(session.sent_messages.is_empty());
        assert!(!daemon_dir.exists());
    }

    #[test]
    fn returns_boot_error_as_reconciliation_candidate() {
        let daemon_dir = unique_temp_daemon_dir();
        let runtime_state = crate::worker_runtime_state::new_shared_worker_runtime_state();
        let mut session = RecordingSession::default();

        let outcome = handle_worker_message_flow(
            &mut session,
            &runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-boot",
                message: &fixture_valid_message("boot-error"),
                observed_at: 1_710_000_401_150,
                publish: None,
                nip46_publish: None,
                terminal: None,
            },
        )
        .expect("boot error message flow must classify");

        match outcome {
            WorkerMessageFlowOutcome::BootFailureCandidate { message, candidate } => {
                assert_eq!(message.metadata.message_type, "boot_error");
                assert_eq!(candidate.worker_id, "worker-boot");
                assert_eq!(candidate.code, "missing_agent");
                assert_eq!(
                    candidate.message,
                    "agent was not found in shared filesystem state"
                );
                assert!(!candidate.retryable);
            }
            other => panic!("expected boot failure candidate, got {other:?}"),
        }
        assert!(runtime_state.lock().unwrap().is_empty());
        assert!(session.sent_messages.is_empty());
        assert!(!daemon_dir.exists());
    }

    #[test]
    fn rejects_terminal_message_without_terminal_context_before_side_effects() {
        let daemon_dir = unique_temp_daemon_dir();
        let runtime_state = runtime_state_for(identity());
        let mut session = RecordingSession::default();

        let error = handle_worker_message_flow(
            &mut session,
            &runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: &daemon_dir,
                worker_id: "worker-alpha",
                message: &fixture_valid_message("complete"),
                observed_at: 1_710_000_500_050,
                publish: None,
                nip46_publish: None,
                terminal: None,
            },
        )
        .expect_err("terminal message needs terminal context");

        assert!(matches!(
            error,
            WorkerMessageFlowError::MissingTerminalContext { .. }
        ));
        assert!(
            runtime_state
                .lock()
                .unwrap()
                .get_worker("worker-alpha")
                .is_some()
        );
        assert!(session.sent_messages.is_empty());
        assert!(!daemon_dir.exists());
    }

    fn runtime_state_for(identity: RalJournalIdentity) -> SharedWorkerRuntimeState {
        let state = crate::worker_runtime_state::new_shared_worker_runtime_state();
        state
            .lock()
            .unwrap()
            .register_started_dispatch(WorkerRuntimeStartedDispatch {
                worker_id: "worker-alpha".to_string(),
                pid: 4242,
                dispatch_id: "dispatch-alpha".to_string(),
                identity,
                claim_token: "claim-alpha".to_string(),
                started_at: 1_710_000_400_500,
            })
            .expect("runtime worker must register");
        state
    }

    fn append_initial_ral_records(daemon_dir: &PathBuf) {
        for record in initial_ral_records() {
            append_ral_journal_record(daemon_dir, &record).expect("journal record must append");
        }
    }

    fn append_initial_dispatch_records(daemon_dir: &PathBuf) {
        for record in initial_dispatch_records() {
            append_dispatch_queue_record(daemon_dir, &record).expect("dispatch record must append");
        }
    }

    fn initial_ral_records() -> Vec<RalJournalRecord> {
        vec![
            journal_record(
                198,
                RalJournalEvent::Allocated {
                    identity: identity(),
                    triggering_event_id: Some("trigger-alpha".to_string()),
                },
            ),
            journal_record(
                199,
                RalJournalEvent::Claimed {
                    identity: identity(),
                    worker_id: "worker-alpha".to_string(),
                    claim_token: "claim-alpha".to_string(),
                },
            ),
        ]
    }

    fn initial_dispatch_records() -> Vec<DispatchQueueRecord> {
        vec![
            dispatch_record(300, DispatchQueueStatus::Queued),
            dispatch_record(301, DispatchQueueStatus::Leased),
        ]
    }

    fn result_context() -> WorkerResultTransitionContext {
        WorkerResultTransitionContext {
            worker_id: "worker-alpha".to_string(),
            claim_token: "claim-alpha".to_string(),
            journal_sequence: 200,
            journal_timestamp: 1_710_000_500_000,
            writer_version: "test-version".to_string(),
            resolved_pending_delegations: Vec::new(),
            already_completed_delegation_ids: HashSet::new(),
        }
    }

    fn dispatch_input() -> WorkerCompletionDispatchInput {
        WorkerCompletionDispatchInput {
            dispatch_id: "dispatch-alpha".to_string(),
            sequence: 302,
            timestamp: 1_710_000_500_302,
            correlation_id: "correlation-dispatch-complete".to_string(),
        }
    }

    fn launch_plan() -> WorkerLaunchPlan {
        WorkerLaunchPlan {
            allocation_lock_scope: RalAllocationLockScope {
                project_id: "project-alpha".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-alpha".to_string(),
            },
            state_lock_scope: RalStateLockScope {
                project_id: "project-alpha".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-alpha".to_string(),
                ral_number: 3,
            },
            execute_message: json!({ "type": "execute" }),
        }
    }

    fn journal_record(sequence: u64, event: RalJournalEvent) -> RalJournalRecord {
        RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            "test-version",
            sequence,
            1_710_000_400_000 + sequence,
            format!("correlation-journal-{sequence}"),
            event,
        )
    }

    fn dispatch_record(sequence: u64, status: DispatchQueueStatus) -> DispatchQueueRecord {
        build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence,
            timestamp: 1_710_000_450_000 + sequence,
            correlation_id: format!("correlation-dispatch-{sequence}"),
            dispatch_id: "dispatch-alpha".to_string(),
            ral: DispatchRalIdentity {
                project_id: "project-alpha".to_string(),
                agent_pubkey: "a".repeat(64),
                conversation_id: "conversation-alpha".to_string(),
                ral_number: 3,
            },
            triggering_event_id: "trigger-alpha".to_string(),
            claim_token: "claim-alpha".to_string(),
            status,
        })
    }

    fn publish_request_message(
        fixture: &Nip01EventFixture,
        sequence: u64,
        timestamp: u64,
    ) -> Value {
        json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_request",
            "correlationId": "rust_worker_publish",
            "sequence": sequence,
            "timestamp": timestamp,
            "projectId": "project-alpha",
            "agentPubkey": fixture.pubkey,
            "conversationId": "conversation-alpha",
            "ralNumber": 3,
            "requestId": "publish-fixture-01",
            "waitForRelayOk": true,
            "timeoutMs": 30000,
            "runtimeEventClass": "complete",
            "event": fixture.signed,
        })
    }

    fn identity() -> RalJournalIdentity {
        identity_with_agent(&"a".repeat(64))
    }

    fn identity_with_agent(agent_pubkey: &str) -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: "project-alpha".to_string(),
            agent_pubkey: agent_pubkey.to_string(),
            conversation_id: "conversation-alpha".to_string(),
            ral_number: 3,
        }
    }

    fn signed_event_fixture() -> Nip01EventFixture {
        serde_json::from_str(STREAM_TEXT_DELTA_FIXTURE).expect("fixture must parse")
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

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tenex-worker-message-flow-test-{nanos}-{counter}"))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if let Err(error) = fs::remove_dir_all(path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            panic!("temp daemon dir cleanup must succeed: {error}");
        }
    }
}
