use std::error::Error;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::worker_dispatch::execution::WorkerDispatchSession;
use crate::worker_injection_queue::{
    WorkerInjectionMarkSentInput, WorkerInjectionQueueError, WorkerInjectionQueueRecord,
    WorkerInjectionRole, mark_worker_injection_sent, pending_worker_injections_for,
};
use crate::worker_lifecycle::abort::DEFAULT_WORKER_GRACEFUL_ABORT_TIMEOUT_MS;
use crate::worker_lifecycle::stop_request::take_worker_stop_request;
use crate::worker_message_flow::{
    WorkerMessageFlowError, WorkerMessageFlowInput, WorkerMessageFlowOutcome,
    WorkerMessageNip46PublishContext, WorkerMessagePublishContext, WorkerMessageTerminalContext,
    handle_worker_message_flow,
};
use crate::worker_protocol::{
    AGENT_WORKER_PROTOCOL_VERSION, WorkerProtocolError, decode_agent_worker_protocol_frame,
    validate_agent_worker_protocol_message,
};
use crate::ral_journal::{
    RAL_JOURNAL_WRITER_RUST_DAEMON, RalDelegationType, RalJournalEvent, RalJournalIdentity,
    RalJournalRecord, RalPendingDelegation, append_ral_journal_record_with_resequence,
};
use crate::ral_scheduler::RalScheduler;
use crate::worker_publish::flow::{WorkerPublishFlowOutcome, WorkerPublishResultDelivery};
use crate::worker_runtime_state::SharedWorkerRuntimeState;
use crate::worker_session::frame_pump::WorkerFrameReceiver;

pub struct WorkerSessionLoopInput<'a> {
    pub daemon_dir: &'a Path,
    pub runtime_state: &'a SharedWorkerRuntimeState,
    pub worker_id: &'a str,
    pub observed_at: u64,
    pub publish: Option<WorkerMessagePublishContext<'a>>,
    pub nip46_publish: Option<WorkerMessageNip46PublishContext<'a>>,
    pub live_publish_maintenance: Option<&'a mut dyn FnMut(&Path, u64) -> Result<(), String>>,
    pub terminal: Option<WorkerMessageTerminalContext<'a>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerSessionLoopFinalReason {
    TerminalResultHandled,
    BootFailureCandidate,
    PublishAcceptedWorkerPipeClosed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSessionLoopOutcome {
    pub frame_count: u64,
    pub final_reason: WorkerSessionLoopFinalReason,
}

#[derive(Debug, Error)]
pub enum WorkerSessionLoopError<E>
where
    E: Error + Send + Sync + 'static,
{
    #[error("worker frame receive failed: {source}")]
    Receive {
        #[source]
        source: E,
    },
    #[error("worker frame decode failed: {source}")]
    Decode {
        #[source]
        source: WorkerProtocolError,
    },
    #[error("worker message flow failed: {source}")]
    MessageFlow {
        #[source]
        source: WorkerMessageFlowError,
    },
    #[error("worker session publish maintenance failed: {message}")]
    PublishMaintenance { message: String },
    #[error("worker session injection queue failed: {source}")]
    InjectionQueue {
        #[source]
        source: WorkerInjectionQueueError,
    },
    #[error("worker session injection protocol failed: {source}")]
    InjectionProtocol {
        #[source]
        source: WorkerProtocolError,
    },
    #[error("worker session injection send failed: {source}")]
    SendInjection {
        #[source]
        source: E,
    },
    #[error("worker session stop request filesystem failed: {0}")]
    StopRequest(std::io::Error),
    #[error("worker session stop request abort protocol failed: {source}")]
    StopRequestProtocol {
        #[source]
        source: WorkerProtocolError,
    },
    #[error("worker session stop request abort send failed: {source}")]
    SendAbort {
        #[source]
        source: E,
    },
    #[error(
        "worker pipe closed after accepted non-terminal publish_request with runtimeEventClass {runtime_event_class}: {error}"
    )]
    PublishResultPipeClosedAfterNonTerminalAcceptance {
        runtime_event_class: String,
        error: String,
    },
}

pub fn run_worker_session_loop<S>(
    worker: &mut S,
    mut input: WorkerSessionLoopInput<'_>,
) -> Result<WorkerSessionLoopOutcome, WorkerSessionLoopError<<S as WorkerFrameReceiver>::Error>>
where
    S: WorkerFrameReceiver + WorkerDispatchSession<Error = <S as WorkerFrameReceiver>::Error>,
{
    let mut frame_count = 0_u64;

    loop {
        send_pending_worker_injections(worker, &input)?;
        send_pending_stop_request(worker, &input)?;

        let frame = worker
            .receive_worker_frame()
            .map_err(|source| WorkerSessionLoopError::Receive { source })?;
        let decoded_message = decode_agent_worker_protocol_frame(&frame)
            .map_err(|source| WorkerSessionLoopError::Decode { source })?;
        let terminal = if is_terminal_message(&decoded_message) {
            input.terminal.take()
        } else {
            None
        };

        let outcome = handle_worker_message_flow(
            worker,
            input.runtime_state,
            WorkerMessageFlowInput {
                daemon_dir: input.daemon_dir,
                worker_id: input.worker_id,
                message: &decoded_message,
                observed_at: input.observed_at,
                publish: input.publish.clone(),
                nip46_publish: input.nip46_publish.clone(),
                terminal,
            },
        )
        .map_err(|source| WorkerSessionLoopError::MessageFlow { source })?;

        frame_count += 1;

        match outcome {
            WorkerMessageFlowOutcome::TerminalResultHandled { .. } => {
                return Ok(WorkerSessionLoopOutcome {
                    frame_count,
                    final_reason: WorkerSessionLoopFinalReason::TerminalResultHandled,
                });
            }
            WorkerMessageFlowOutcome::BootFailureCandidate { .. } => {
                return Ok(WorkerSessionLoopOutcome {
                    frame_count,
                    final_reason: WorkerSessionLoopFinalReason::BootFailureCandidate,
                });
            }
            WorkerMessageFlowOutcome::PublishRequestHandled { outcome } => {
                run_live_publish_maintenance(&mut input)?;
                let runtime_event_class = outcome
                    .message_plan
                    .message
                    .get("runtimeEventClass")
                    .and_then(Value::as_str)
                    .unwrap_or("<missing>")
                    .to_string();
                if let WorkerPublishResultDelivery::WorkerPipeClosedAfterAcceptance { error } =
                    &outcome.result_delivery
                {
                    if runtime_event_class == "complete" {
                        return finish_terminal_publish_after_closed_worker_pipe(
                            worker,
                            &mut input,
                            frame_count,
                            &outcome,
                            error,
                        );
                    }
                    if runtime_event_class == "delegation" {
                        return finish_waiting_for_delegation_after_closed_worker_pipe(
                            worker,
                            &mut input,
                            frame_count,
                            &outcome,
                            error,
                        );
                    }
                    // Worker is fire-and-forget for non-terminal classes (per
                    // commit 22ee6bcc): the worker may publish a stream_text_delta,
                    // a conversation update, an error event, etc. and exit before
                    // the daemon sends back publish_result. That's not a session
                    // failure — the daemon already accepted the event and routed
                    // it to the relay. Skip the unsendable send-back and continue
                    // reading any frames the worker queued before exit; the loop
                    // exits cleanly when receive_worker_frame returns EOF or the
                    // terminal frame arrives.
                    tracing::debug!(
                        worker_id = %input.worker_id,
                        runtime_event_class = %runtime_event_class,
                        error = %error,
                        "worker pipe closed after fire-and-forget publish acceptance; continuing to drain remaining frames"
                    );
                    continue;
                }
                // publish_result was delivered successfully; now send any
                // injections that arrived while the publish was in-flight.
                // If the worker closed its stdin between receiving
                // publish_result and this injection send (which happens when
                // the worker published a "delegation" event and exited before
                // the nostr handler queued the completion injection), treat it
                // as a synthetic pipe-closed-after-acceptance and run the
                // appropriate terminal synthesis path.
                if let Some(error) = pending_injection_pipe_closed_error(worker, &input)? {
                    if runtime_event_class == "complete" {
                        return finish_terminal_publish_after_closed_worker_pipe(
                            worker,
                            &mut input,
                            frame_count,
                            &outcome,
                            &error,
                        );
                    }
                    if runtime_event_class == "delegation" {
                        return finish_waiting_for_delegation_after_closed_worker_pipe(
                            worker,
                            &mut input,
                            frame_count,
                            &outcome,
                            &error,
                        );
                    }
                    return Err(WorkerSessionLoopError::PublishResultPipeClosedAfterNonTerminalAcceptance {
                        runtime_event_class,
                        error,
                    });
                }
                send_pending_stop_request(worker, &input)?;
            }
            WorkerMessageFlowOutcome::Nip46PublishRequestHandled { .. } => {
                run_live_publish_maintenance(&mut input)?;
                if let Some(nip46) = input.nip46_publish.as_mut() {
                    nip46.result_sequence = nip46.result_sequence.saturating_add(1);
                }
                send_pending_worker_injections(worker, &input)?;
                send_pending_stop_request(worker, &input)?;
            }
            WorkerMessageFlowOutcome::HeartbeatUpdated { .. }
            | WorkerMessageFlowOutcome::ControlTelemetry { .. }
            | WorkerMessageFlowOutcome::StreamTelemetry { .. }
            | WorkerMessageFlowOutcome::PublishedNotification { .. } => {
                send_pending_worker_injections(worker, &input)?;
                send_pending_stop_request(worker, &input)?;
            }
        }
    }
}

fn finish_terminal_publish_after_closed_worker_pipe<S>(
    worker: &mut S,
    input: &mut WorkerSessionLoopInput<'_>,
    frame_count: u64,
    publish_outcome: &WorkerPublishFlowOutcome,
    pipe_error: &str,
) -> Result<WorkerSessionLoopOutcome, WorkerSessionLoopError<<S as WorkerFrameReceiver>::Error>>
where
    S: WorkerFrameReceiver + WorkerDispatchSession<Error = <S as WorkerFrameReceiver>::Error>,
{
    let runtime_event_class = publish_outcome
        .message_plan
        .message
        .get("runtimeEventClass")
        .and_then(Value::as_str)
        .unwrap_or("<missing>")
        .to_string();
    if runtime_event_class != "complete" {
        return Err(
            WorkerSessionLoopError::PublishResultPipeClosedAfterNonTerminalAcceptance {
                runtime_event_class,
                error: pipe_error.to_string(),
            },
        );
    }

    let Some(terminal) = input.terminal.take() else {
        return Err(WorkerSessionLoopError::MessageFlow {
            source: WorkerMessageFlowError::MissingTerminalContext {
                message_type: "complete".to_string(),
            },
        });
    };
    let terminal_message = terminal_complete_message_from_publish(publish_outcome);
    let event_ids = terminal_message
        .get("finalEventIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();

    tracing::warn!(
        worker_id = %input.worker_id,
        event_ids = %event_ids,
        error = %pipe_error,
        "completing worker session from accepted publish because worker pipe closed before publish_result delivery"
    );

    let outcome = handle_worker_message_flow(
        worker,
        input.runtime_state,
        WorkerMessageFlowInput {
            daemon_dir: input.daemon_dir,
            worker_id: input.worker_id,
            message: &terminal_message,
            observed_at: input.observed_at,
            publish: input.publish.clone(),
            nip46_publish: input.nip46_publish.clone(),
            terminal: Some(terminal),
        },
    )
    .map_err(|source| WorkerSessionLoopError::MessageFlow { source })?;

    match outcome {
        WorkerMessageFlowOutcome::TerminalResultHandled { .. } => Ok(WorkerSessionLoopOutcome {
            frame_count,
            final_reason: WorkerSessionLoopFinalReason::PublishAcceptedWorkerPipeClosed,
        }),
        other => Err(WorkerSessionLoopError::MessageFlow {
            source: WorkerMessageFlowError::MissingTerminalContext {
                message_type: format!("synthetic complete produced {other:?}"),
            },
        }),
    }
}

fn terminal_complete_message_from_publish(publish_outcome: &WorkerPublishFlowOutcome) -> Value {
    let publish_request = &publish_outcome.message_plan.message;
    serde_json::json!({
        "version": publish_request["version"].clone(),
        "type": "complete",
        "correlationId": publish_request["correlationId"].clone(),
        "sequence": publish_request["sequence"].clone(),
        "timestamp": publish_request["timestamp"].clone(),
        "projectId": publish_request["projectId"].clone(),
        "agentPubkey": publish_request["agentPubkey"].clone(),
        "conversationId": publish_request["conversationId"].clone(),
        "ralNumber": publish_request["ralNumber"].clone(),
        "finalRalState": "completed",
        "publishedUserVisibleEvent": true,
        "pendingDelegationsRemain": false,
        "accumulatedRuntimeMs": 0_u64,
        "finalEventIds": publish_outcome.acceptance.publish_result["eventIds"].clone(),
        "keepWorkerWarm": false,
    })
}

fn finish_waiting_for_delegation_after_closed_worker_pipe<S>(
    worker: &mut S,
    input: &mut WorkerSessionLoopInput<'_>,
    frame_count: u64,
    publish_outcome: &WorkerPublishFlowOutcome,
    pipe_error: &str,
) -> Result<WorkerSessionLoopOutcome, WorkerSessionLoopError<<S as WorkerFrameReceiver>::Error>>
where
    S: WorkerFrameReceiver + WorkerDispatchSession<Error = <S as WorkerFrameReceiver>::Error>,
{
    let Some(terminal) = input.terminal.take() else {
        return Err(WorkerSessionLoopError::MessageFlow {
            source: WorkerMessageFlowError::MissingTerminalContext {
                message_type: "waiting_for_delegation".to_string(),
            },
        });
    };

    // The bun worker publishes the delegation Nostr event via `publish_request`
    // and then exits before sending `delegation_registered`. Extract the
    // pending delegation directly from the accepted event so we can write the
    // `DelegationRegistered` journal entry ourselves before synthesizing the
    // `waiting_for_delegation` terminal.
    let publish_request = &publish_outcome.message_plan.message;
    let event = &publish_request["event"];

    let delegation_conversation_id = event
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let sender_pubkey = event
        .get("pubkey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let prompt = event
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let recipient_pubkey = event
        .get("tags")
        .and_then(Value::as_array)
        .and_then(|tags| {
            tags.iter().find(|tag| {
                tag.as_array()
                    .and_then(|t| t.first())
                    .and_then(Value::as_str)
                    == Some("p")
            })
        })
        .and_then(Value::as_array)
        .and_then(|t| t.get(1))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let identity = RalJournalIdentity {
        project_id: publish_request
            .get("projectId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        agent_pubkey: publish_request
            .get("agentPubkey")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        conversation_id: publish_request
            .get("conversationId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        ral_number: publish_request
            .get("ralNumber")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
    };

    let (worker_id_str, claim_token) = {
        let guard = input.runtime_state.lock().expect("runtime state mutex poisoned");
        let worker_snapshot = guard.get_worker(input.worker_id).cloned();
        match worker_snapshot.and_then(|w| {
            let slot = w.primary_execution().cloned()?;
            Some((w.worker_id.clone(), slot.claim_token.clone()))
        }) {
            Some(pair) => pair,
            None => (input.worker_id.to_string(), String::new()),
        }
    };

    let pending_delegation = RalPendingDelegation {
        delegation_conversation_id: delegation_conversation_id.clone(),
        recipient_pubkey,
        sender_pubkey,
        prompt,
        delegation_type: RalDelegationType::Standard,
        ral_number: identity.ral_number,
        parent_delegation_conversation_id: None,
        pending_sub_delegations: None,
        deferred_completion: None,
        followup_event_id: None,
        project_id: None,
        suggestions: None,
        killed: None,
        killed_at: None,
    };

    let correlation_id = publish_request
        .get("correlationId")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let mut delegation_record = RalJournalRecord::new(
        RAL_JOURNAL_WRITER_RUST_DAEMON,
        env!("CARGO_PKG_VERSION"),
        0, // resequenced under lock
        input.observed_at,
        format!("{correlation_id}:delegation_registered:synthetic"),
        RalJournalEvent::DelegationRegistered {
            identity: identity.clone(),
            worker_id: worker_id_str,
            claim_token,
            pending_delegation,
        },
    );
    append_ral_journal_record_with_resequence(input.daemon_dir, &mut delegation_record).map_err(
        |source| WorkerSessionLoopError::MessageFlow {
            source: WorkerMessageFlowError::RalJournal {
                source: Box::new(source),
            },
        },
    )?;

    let pending_delegation_ids: Vec<String> =
        RalScheduler::from_daemon_dir(input.daemon_dir)
            .ok()
            .and_then(|scheduler| {
                let entry = scheduler.entry(&identity)?;
                Some(
                    entry
                        .pending_delegations
                        .iter()
                        .map(|d| d.delegation_conversation_id.clone())
                        .collect(),
                )
            })
            .unwrap_or_else(|| vec![delegation_conversation_id.clone()]);

    let terminal_message = terminal_waiting_for_delegation_message_from_publish(
        publish_outcome,
        &pending_delegation_ids,
    );

    tracing::warn!(
        worker_id = %input.worker_id,
        pending_delegations = ?pending_delegation_ids,
        error = %pipe_error,
        "synthesizing waiting_for_delegation terminal because worker pipe closed after delegation publish acceptance"
    );

    let outcome = handle_worker_message_flow(
        worker,
        input.runtime_state,
        WorkerMessageFlowInput {
            daemon_dir: input.daemon_dir,
            worker_id: input.worker_id,
            message: &terminal_message,
            observed_at: input.observed_at,
            publish: input.publish.clone(),
            nip46_publish: input.nip46_publish.clone(),
            terminal: Some(terminal),
        },
    )
    .map_err(|source| WorkerSessionLoopError::MessageFlow { source })?;

    match outcome {
        WorkerMessageFlowOutcome::TerminalResultHandled { .. } => Ok(WorkerSessionLoopOutcome {
            frame_count,
            final_reason: WorkerSessionLoopFinalReason::PublishAcceptedWorkerPipeClosed,
        }),
        other => Err(WorkerSessionLoopError::MessageFlow {
            source: WorkerMessageFlowError::MissingTerminalContext {
                message_type: format!("synthetic waiting_for_delegation produced {other:?}"),
            },
        }),
    }
}

fn terminal_waiting_for_delegation_message_from_publish(
    publish_outcome: &WorkerPublishFlowOutcome,
    pending_delegation_ids: &[String],
) -> Value {
    let publish_request = &publish_outcome.message_plan.message;
    let pending_delegations: Vec<Value> = pending_delegation_ids
        .iter()
        .map(|id| Value::String(id.clone()))
        .collect();
    serde_json::json!({
        "version": publish_request["version"].clone(),
        "type": "waiting_for_delegation",
        "correlationId": publish_request["correlationId"].clone(),
        "sequence": publish_request["sequence"].clone(),
        "timestamp": publish_request["timestamp"].clone(),
        "projectId": publish_request["projectId"].clone(),
        "agentPubkey": publish_request["agentPubkey"].clone(),
        "conversationId": publish_request["conversationId"].clone(),
        "ralNumber": publish_request["ralNumber"].clone(),
        "finalRalState": "waiting_for_delegation",
        "publishedUserVisibleEvent": true,
        "pendingDelegationsRemain": !pending_delegation_ids.is_empty(),
        "pendingDelegations": pending_delegations,
        "accumulatedRuntimeMs": 0_u64,
        "finalEventIds": publish_outcome.acceptance.publish_result["eventIds"].clone(),
        "keepWorkerWarm": false,
    })
}

fn run_live_publish_maintenance<E>(
    input: &mut WorkerSessionLoopInput<'_>,
) -> Result<(), WorkerSessionLoopError<E>>
where
    E: Error + Send + Sync + 'static,
{
    if let Some(maintenance) = input.live_publish_maintenance.as_deref_mut() {
        maintenance(input.daemon_dir, input.observed_at)
            .map_err(|message| WorkerSessionLoopError::PublishMaintenance { message })?;
    }
    Ok(())
}

fn is_terminal_message(message: &Value) -> bool {
    matches!(
        message.get("type").and_then(Value::as_str),
        Some("waiting_for_delegation" | "complete" | "no_response" | "aborted" | "error")
    )
}

fn send_pending_worker_injections<S>(
    worker: &mut S,
    input: &WorkerSessionLoopInput<'_>,
) -> Result<(), WorkerSessionLoopError<<S as WorkerFrameReceiver>::Error>>
where
    S: WorkerFrameReceiver + WorkerDispatchSession<Error = <S as WorkerFrameReceiver>::Error>,
{
    let Some(active_worker) = input
        .runtime_state
        .lock()
        .expect("runtime state mutex poisoned")
        .get_worker(input.worker_id)
        .cloned()
    else {
        return Ok(());
    };

    for slot in &active_worker.executions {
        let pending =
            pending_worker_injections_for(input.daemon_dir, input.worker_id, &slot.identity)
                .map_err(|source| WorkerSessionLoopError::InjectionQueue { source })?;

        for record in pending {
            if record.lease_token != slot.claim_token {
                tracing::warn!(
                    worker_id = %record.worker_id,
                    injection_id = %record.injection_id,
                    "skipping worker injection with stale lease token"
                );
                crate::stdout_status::print_stale_injection_skipped(
                    &record.worker_id,
                    &record.injection_id,
                );
                continue;
            }

            let message = worker_injection_protocol_message(&record, input.observed_at);
            validate_agent_worker_protocol_message(&message)
                .map_err(|source| WorkerSessionLoopError::InjectionProtocol { source })?;
            if let Err(source) = worker.send_worker_message(&message) {
                if S::is_worker_pipe_closed_error(&source) {
                    // Worker stdin is closed; skip this injection and return.
                    // The worker is expected to send a terminal frame next
                    // (waiting_for_delegation, complete, etc.) which the
                    // session loop will read on the next receive_worker_frame
                    // call. The injection remains queued and will be handled
                    // when the session completes or a new worker is dispatched.
                    tracing::warn!(
                        worker_id = %input.worker_id,
                        injection_id = %record.injection_id,
                        error = %source,
                        "worker pipe closed before injection delivery at loop top; skipping to read terminal frame"
                    );
                    return Ok(());
                }
                return Err(WorkerSessionLoopError::SendInjection { source });
            }
            mark_worker_injection_sent(WorkerInjectionMarkSentInput {
                daemon_dir: input.daemon_dir.to_path_buf(),
                timestamp: input.observed_at,
                correlation_id: format!("{}:sent", record.correlation_id),
                worker_id: record.worker_id,
                injection_id: record.injection_id,
            })
            .map_err(|source| WorkerSessionLoopError::InjectionQueue { source })?;
        }
    }

    Ok(())
}

/// Sends all pending injections, but if the worker's stdin pipe is closed,
/// returns `Ok(Some(error_string))` instead of propagating the error.
///
/// Used after a `publish_result` was delivered successfully for a terminal
/// event class ("delegation" or "complete"): the worker may have closed its
/// stdin immediately after receiving `publish_result`, and a concurrent nostr
/// handler may have queued an injection in the window between the publish and
/// this call.  When that happens the session must synthesize the terminal
/// rather than failing with "broken pipe".
fn pending_injection_pipe_closed_error<S>(
    worker: &mut S,
    input: &WorkerSessionLoopInput<'_>,
) -> Result<Option<String>, WorkerSessionLoopError<<S as WorkerFrameReceiver>::Error>>
where
    S: WorkerFrameReceiver + WorkerDispatchSession<Error = <S as WorkerFrameReceiver>::Error>,
{
    let Some(active_worker) = input
        .runtime_state
        .lock()
        .expect("runtime state mutex poisoned")
        .get_worker(input.worker_id)
        .cloned()
    else {
        return Ok(None);
    };

    for slot in &active_worker.executions {
        let pending =
            pending_worker_injections_for(input.daemon_dir, input.worker_id, &slot.identity)
                .map_err(|source| WorkerSessionLoopError::InjectionQueue { source })?;

        for record in pending {
            if record.lease_token != slot.claim_token {
                tracing::warn!(
                    worker_id = %record.worker_id,
                    injection_id = %record.injection_id,
                    "skipping worker injection with stale lease token"
                );
                crate::stdout_status::print_stale_injection_skipped(
                    &record.worker_id,
                    &record.injection_id,
                );
                continue;
            }

            let message = worker_injection_protocol_message(&record, input.observed_at);
            validate_agent_worker_protocol_message(&message)
                .map_err(|source| WorkerSessionLoopError::InjectionProtocol { source })?;
            if let Err(source) = worker.send_worker_message(&message) {
                if S::is_worker_pipe_closed_error(&source) {
                    tracing::warn!(
                        worker_id = %input.worker_id,
                        injection_id = %record.injection_id,
                        error = %source,
                        "worker pipe closed before injection delivery after accepted publish; synthesizing terminal"
                    );
                    return Ok(Some(source.to_string()));
                }
                return Err(WorkerSessionLoopError::SendInjection { source });
            }
            mark_worker_injection_sent(WorkerInjectionMarkSentInput {
                daemon_dir: input.daemon_dir.to_path_buf(),
                timestamp: input.observed_at,
                correlation_id: format!("{}:sent", record.correlation_id),
                worker_id: record.worker_id,
                injection_id: record.injection_id,
            })
            .map_err(|source| WorkerSessionLoopError::InjectionQueue { source })?;
        }
    }

    Ok(None)
}

fn send_pending_stop_request<S>(
    worker: &mut S,
    input: &WorkerSessionLoopInput<'_>,
) -> Result<(), WorkerSessionLoopError<<S as WorkerFrameReceiver>::Error>>
where
    S: WorkerFrameReceiver + WorkerDispatchSession<Error = <S as WorkerFrameReceiver>::Error>,
{
    let Some(active_worker) = input
        .runtime_state
        .lock()
        .expect("runtime state mutex poisoned")
        .get_worker(input.worker_id)
        .cloned()
    else {
        return Ok(());
    };

    let mut next_sequence = active_worker
        .latest_heartbeat()
        .map(|hb| hb.sequence + 1)
        .unwrap_or(1);

    for slot in &active_worker.executions {
        let stop_request = take_worker_stop_request(
            input.daemon_dir,
            &slot.identity.agent_pubkey,
            &slot.identity.conversation_id,
        )
        .map_err(WorkerSessionLoopError::StopRequest)?;

        let Some(stop_request) = stop_request else {
            continue;
        };

        let sequence = next_sequence;
        next_sequence += 1;

        let message = serde_json::json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "abort",
            "correlationId": format!("stop-command:{}", stop_request.stop_event_id),
            "sequence": sequence,
            "timestamp": input.observed_at,
            "projectId": slot.identity.project_id,
            "agentPubkey": slot.identity.agent_pubkey,
            "conversationId": slot.identity.conversation_id,
            "ralNumber": slot.identity.ral_number,
            "reason": "user_requested_stop",
            "gracefulTimeoutMs": DEFAULT_WORKER_GRACEFUL_ABORT_TIMEOUT_MS,
        });

        validate_agent_worker_protocol_message(&message)
            .map_err(|source| WorkerSessionLoopError::StopRequestProtocol { source })?;

        worker
            .send_worker_message(&message)
            .map_err(|source| WorkerSessionLoopError::SendAbort { source })?;

        tracing::info!(
            worker_id = %input.worker_id,
            stop_event_id = %stop_request.stop_event_id,
            agent_pubkey = %slot.identity.agent_pubkey,
            conversation_id = %slot.identity.conversation_id,
            "sent abort to worker from user stop command"
        );
    }

    Ok(())
}

fn worker_injection_protocol_message(record: &WorkerInjectionQueueRecord, timestamp: u64) -> Value {
    let role = match record.role {
        WorkerInjectionRole::User => "user",
        WorkerInjectionRole::System => "system",
    };
    let mut message = serde_json::json!({
        "version": AGENT_WORKER_PROTOCOL_VERSION,
        "type": "inject",
        "correlationId": record.correlation_id,
        "sequence": record.sequence,
        "timestamp": timestamp,
        "projectId": record.identity.project_id,
        "agentPubkey": record.identity.agent_pubkey,
        "conversationId": record.identity.conversation_id,
        "ralNumber": record.identity.ral_number,
        "injectionId": record.injection_id,
        "leaseToken": record.lease_token,
        "role": role,
        "content": record.content,
    });
    if let Some(delegation_completion) = &record.delegation_completion {
        message["delegationCompletion"] = serde_json::json!({
            "delegationConversationId": delegation_completion.delegation_conversation_id,
            "recipientPubkey": delegation_completion.recipient_pubkey,
            "completedAt": delegation_completion.completed_at,
            "completionEventId": delegation_completion.completion_event_id,
        });
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{
        DispatchQueueRecord, DispatchQueueRecordParams, DispatchQueueState, DispatchQueueStatus,
        DispatchRalIdentity, append_dispatch_queue_record, build_dispatch_queue_record,
        replay_dispatch_queue, replay_dispatch_queue_records,
    };
    use crate::nostr_event::Nip01EventFixture;
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
        RalJournalReplay, RalReplayStatus, append_ral_journal_record, replay_ral_journal,
        replay_ral_journal_records,
    };
    use crate::ral_lock::{build_ral_lock_info, read_ral_lock_info};
    use crate::ral_scheduler::RalScheduler;
    use crate::worker_completion::plan::WorkerCompletionDispatchInput;
    use crate::worker_injection_queue::{
        WorkerDelegationCompletionInjection, WorkerInjectionEnqueueInput, WorkerInjectionRole,
        enqueue_worker_injection, replay_worker_injection_queue,
    };
    use crate::worker_lifecycle::launch::{
        RalAllocationLockScope, RalStateLockScope, WorkerLaunchPlan,
    };
    use crate::worker_lifecycle::launch_lock::acquire_worker_launch_locks;
    use crate::worker_process::{
        AgentWorkerProcess, AgentWorkerProcessConfig, bun_agent_worker_command,
    };
    use crate::worker_protocol::{WorkerProtocolFixture, encode_agent_worker_protocol_frame};
    use crate::worker_runtime_state::{
        SharedWorkerRuntimeState, WorkerRuntimeStartedDispatch, new_shared_worker_runtime_state,
    };
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::error::Error;
    use std::fmt;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const WORKER_PROTOCOL_FIXTURE: &str = include_str!(
        "../../../../src/test-utils/fixtures/worker-protocol/agent-execution.compat.json"
    );
    const STREAM_TEXT_DELTA_FIXTURE: &str =
        include_str!("../../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json");

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("crate must live under repo_root/crates/tenex-daemon")
            .to_path_buf()
    }

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug, Default)]
    struct RecordingWorker {
        incoming_frames: VecDeque<Vec<u8>>,
        sent_messages: Vec<Value>,
        receive_error: Option<FakeWorkerError>,
        send_error: Option<FakeWorkerError>,
    }

    impl WorkerFrameReceiver for RecordingWorker {
        type Error = FakeWorkerError;

        fn receive_worker_frame(&mut self) -> Result<Vec<u8>, Self::Error> {
            if let Some(error) = self.receive_error.clone() {
                return Err(error);
            }

            self.incoming_frames
                .pop_front()
                .ok_or(FakeWorkerError("missing frame"))
        }
    }

    impl WorkerDispatchSession for RecordingWorker {
        type Error = FakeWorkerError;

        fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error> {
            self.sent_messages.push(message.clone());

            if let Some(error) = self.send_error.clone() {
                return Err(error);
            }

            Ok(())
        }

        fn is_worker_pipe_closed_error(error: &Self::Error) -> bool {
            error.0 == "broken pipe"
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

    #[test]
    fn heartbeat_then_terminal_result_stops_the_session_loop() {
        let daemon_dir = unique_temp_daemon_dir();
        append_initial_ral_records_for(&daemon_dir, "worker-alpha", identity());
        append_initial_dispatch_records_for(&daemon_dir, identity());
        let scheduler = scheduler_from_records();
        let dispatch_state = dispatch_state_from_records();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");

        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([
                frame_for(&fixture_valid_message("heartbeat")),
                frame_for(&fixture_valid_message("complete")),
            ]),
            ..Default::default()
        };
        let runtime_state = runtime_state_for("worker-alpha", identity());

        let outcome = run_worker_session_loop(
            &mut worker,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &runtime_state,
                worker_id: "worker-alpha",
                observed_at: 1_710_000_403_000,
                publish: None,
                nip46_publish: None,
                live_publish_maintenance: None,
                terminal: Some(WorkerMessageTerminalContext {
                    scheduler: &scheduler,
                    dispatch_state: &dispatch_state,
                    result_context: result_context(),
                    dispatch: Some(dispatch_input()),
                    locks,
                }),
            },
        )
        .expect("session loop must stop on terminal frame");

        assert_eq!(outcome.frame_count, 2);
        assert_eq!(
            outcome.final_reason,
            WorkerSessionLoopFinalReason::TerminalResultHandled
        );
        assert!(
            runtime_state
                .lock()
                .unwrap()
                .get_worker("worker-alpha")
                .is_none()
        );
        assert!(worker.sent_messages.is_empty());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn publish_request_then_continuation_keeps_running_until_boot_failure_candidate() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let publish_request = publish_request_message(&fixture, 41, 1_710_001_000_000);

        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([
                frame_for(&publish_request),
                frame_for(&fixture_valid_message("boot-error")),
            ]),
            ..Default::default()
        };
        let runtime_state = runtime_state_for("worker-alpha", identity_with_agent(&fixture.pubkey));
        let maintenance_calls = std::cell::Cell::new(0_u64);
        let mut live_publish_maintenance = |daemon_dir_seen: &Path, now_seen: u64| {
            assert_eq!(daemon_dir_seen, daemon_dir.as_path());
            assert_eq!(now_seen, 1_710_000_403_000);
            maintenance_calls.set(maintenance_calls.get() + 1);
            Ok(())
        };

        let outcome = run_worker_session_loop(
            &mut worker,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &runtime_state,
                worker_id: "worker-alpha",
                observed_at: 1_710_000_403_000,
                publish: Some(WorkerMessagePublishContext {
                    accepted_at: 1_710_001_000_100,
                    result_sequence_source: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(
                        900,
                    )),
                    result_timestamp: 1_710_001_000_200,
                    telegram_egress: None,
                    publish_enqueued_tx: None,
                }),
                nip46_publish: None,
                live_publish_maintenance: Some(&mut live_publish_maintenance),
                terminal: None,
            },
        )
        .expect("publish request must continue into the next frame");

        assert_eq!(outcome.frame_count, 2);
        assert_eq!(
            outcome.final_reason,
            WorkerSessionLoopFinalReason::BootFailureCandidate
        );
        assert_eq!(worker.sent_messages.len(), 1);
        assert_eq!(worker.sent_messages[0]["type"], "publish_result");
        assert_eq!(worker.sent_messages[0]["status"], "accepted");
        assert_eq!(maintenance_calls.get(), 1);
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
    fn accepted_terminal_publish_with_closed_worker_pipe_completes_session() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let identity = identity_with_agent(&fixture.pubkey);
        append_initial_ral_records_for(&daemon_dir, "worker-alpha", identity.clone());
        append_initial_dispatch_records_for(&daemon_dir, identity.clone());
        let scheduler = scheduler_from_records_for_identity("worker-alpha", identity.clone());
        let dispatch_state = dispatch_state_from_records_for_identity(identity.clone());
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan_for(&identity), &owner)
            .expect("launch locks must acquire");
        let allocation_lock_path = locks.allocation.path.clone();
        let state_lock_path = locks.state.path.clone();
        let publish_request = publish_request_message(&fixture, 41, 1_710_001_000_000);
        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([frame_for(&publish_request)]),
            send_error: Some(FakeWorkerError("broken pipe")),
            ..Default::default()
        };
        let runtime_state = runtime_state_for("worker-alpha", identity.clone());

        let outcome = run_worker_session_loop(
            &mut worker,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &runtime_state,
                worker_id: "worker-alpha",
                observed_at: 1_710_000_403_000,
                publish: Some(WorkerMessagePublishContext {
                    accepted_at: 1_710_001_000_100,
                    result_sequence_source: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(
                        900,
                    )),
                    result_timestamp: 1_710_001_000_200,
                    telegram_egress: None,
                    publish_enqueued_tx: None,
                }),
                nip46_publish: None,
                live_publish_maintenance: None,
                terminal: Some(WorkerMessageTerminalContext {
                    scheduler: &scheduler,
                    dispatch_state: &dispatch_state,
                    result_context: result_context(),
                    dispatch: Some(dispatch_input()),
                    locks,
                }),
            },
        )
        .expect("closed worker pipe after accepted terminal publish must complete");

        assert_eq!(outcome.frame_count, 1);
        assert_eq!(
            outcome.final_reason,
            WorkerSessionLoopFinalReason::PublishAcceptedWorkerPipeClosed
        );
        assert_eq!(worker.sent_messages.len(), 1);
        assert_eq!(worker.sent_messages[0]["type"], "publish_result");
        assert_eq!(worker.sent_messages[0]["status"], "accepted");
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &fixture.signed.id)
                .expect("pending outbox must read")
                .is_some()
        );
        assert!(
            runtime_state
                .lock()
                .unwrap()
                .get_worker("worker-alpha")
                .is_none()
        );

        let ral = replay_ral_journal(&daemon_dir).expect("RAL journal must replay");
        let entry = ral
            .states
            .get(&identity)
            .expect("completed RAL must replay");
        assert_eq!(entry.status, RalReplayStatus::Completed);
        assert_eq!(entry.final_event_ids, vec![fixture.signed.id.clone()]);
        let dispatch = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert!(dispatch.leased.is_empty());
        assert_eq!(dispatch.terminal.len(), 1);
        assert_eq!(dispatch.terminal[0].status, DispatchQueueStatus::Completed);
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
    fn delegation_publish_with_injection_arriving_after_publish_result_completes_session() {
        // Regression: when a delegation event is published and the worker closes its
        // stdin pipe right after receiving publish_result, but a concurrent nostr
        // handler queued an injection in that window, the session must synthesize the
        // waiting_for_delegation terminal rather than failing with "broken pipe".
        //
        // The race: no injection is queued when the loop starts (position #1 sends
        // nothing). During publish handling the injection arrives. At position #2
        // the injection is found but the pipe is already closed.
        //
        // Simulated by an InjectingOnPublishResultWorker that enqueues an injection
        // into the filesystem when it delivers publish_result, then fails all
        // subsequent sends with broken pipe.
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let identity = identity_with_agent(&fixture.pubkey);
        append_initial_ral_records_for(&daemon_dir, "worker-alpha", identity.clone());
        append_initial_dispatch_records_for(&daemon_dir, identity.clone());
        let scheduler = scheduler_from_records_for_identity("worker-alpha", identity.clone());
        let dispatch_state = dispatch_state_from_records_for_identity(identity.clone());
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan_for(&identity), &owner)
            .expect("launch locks must acquire");

        // Use the signed fixture event with runtimeEventClass = "delegation".
        let delegation_publish_request = json!({
            "version": crate::worker_protocol::AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_request",
            "correlationId": "delegation-publish-corr-1",
            "sequence": 42_u64,
            "timestamp": 1_710_001_000_000_u64,
            "projectId": "project-alpha",
            "agentPubkey": fixture.pubkey,
            "conversationId": "conversation-alpha",
            "ralNumber": 3_u64,
            "requestId": "publish-delegation-01",
            "waitForRelayOk": true,
            "timeoutMs": 30_000_u64,
            "runtimeEventClass": "delegation",
            "event": fixture.signed,
        });

        // A worker that, upon successfully sending publish_result, enqueues a
        // delegation-completion injection into the filesystem (simulating the
        // concurrent nostr handler), then returns broken-pipe on all further sends.
        struct InjectingOnPublishResultWorker {
            frames: VecDeque<Vec<u8>>,
            sent: Vec<Value>,
            daemon_dir: PathBuf,
            identity: RalJournalIdentity,
            pipe_closed: bool,
        }

        impl WorkerFrameReceiver for InjectingOnPublishResultWorker {
            type Error = FakeWorkerError;

            fn receive_worker_frame(&mut self) -> Result<Vec<u8>, Self::Error> {
                self.frames
                    .pop_front()
                    .ok_or(FakeWorkerError("missing frame"))
            }
        }

        impl WorkerDispatchSession for InjectingOnPublishResultWorker {
            type Error = FakeWorkerError;

            fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error> {
                self.sent.push(message.clone());
                if self.pipe_closed {
                    return Err(FakeWorkerError("broken pipe"));
                }
                if message.get("type").and_then(Value::as_str) == Some("publish_result") {
                    // Simulate concurrent nostr handler queuing an injection
                    enqueue_worker_injection(WorkerInjectionEnqueueInput {
                        daemon_dir: self.daemon_dir.clone(),
                        timestamp: 1_710_000_403_001,
                        correlation_id: "delegation-completion-inject:event-b".to_string(),
                        worker_id: "worker-alpha".to_string(),
                        identity: self.identity.clone(),
                        injection_id: "delegation-completion:event-b".to_string(),
                        lease_token: "claim-alpha".to_string(),
                        role: WorkerInjectionRole::System,
                        content: "agent2 responded".to_string(),
                        delegation_completion: Some(WorkerDelegationCompletionInjection {
                            delegation_conversation_id: "delegation-conv-1".to_string(),
                            recipient_pubkey: self.identity.agent_pubkey.clone(),
                            completed_at: 1_710_000_402,
                            completion_event_id: "event-b".to_string(),
                        }),
                    })
                    .expect("injection must queue");
                    self.pipe_closed = true;
                }
                Ok(())
            }

            fn is_worker_pipe_closed_error(error: &Self::Error) -> bool {
                error.0 == "broken pipe"
            }
        }

        let mut worker = InjectingOnPublishResultWorker {
            frames: VecDeque::from([frame_for(&delegation_publish_request)]),
            sent: Vec::new(),
            daemon_dir: daemon_dir.clone(),
            identity: identity.clone(),
            pipe_closed: false,
        };
        let runtime_state = runtime_state_for("worker-alpha", identity.clone());

        let outcome = run_worker_session_loop(
            &mut worker,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &runtime_state,
                worker_id: "worker-alpha",
                observed_at: 1_710_000_403_000,
                publish: Some(WorkerMessagePublishContext {
                    accepted_at: 1_710_001_000_100,
                    result_sequence_source: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(
                        900,
                    )),
                    result_timestamp: 1_710_001_000_200,
                    telegram_egress: None,
                    publish_enqueued_tx: None,
                }),
                nip46_publish: None,
                live_publish_maintenance: None,
                terminal: Some(WorkerMessageTerminalContext {
                    scheduler: &scheduler,
                    dispatch_state: &dispatch_state,
                    result_context: result_context(),
                    dispatch: Some(dispatch_input()),
                    locks,
                }),
            },
        )
        .expect("injection pipe-closed after delegation publish must synthesize terminal");

        assert_eq!(outcome.frame_count, 1);
        assert_eq!(
            outcome.final_reason,
            WorkerSessionLoopFinalReason::PublishAcceptedWorkerPipeClosed
        );
        // publish_result was sent (1st), then inject was attempted and found the pipe
        // closed (2nd, recorded before broken-pipe error).
        assert_eq!(worker.sent[0]["type"], "publish_result");
        assert_eq!(worker.sent[1]["type"], "inject");
        assert!(
            runtime_state
                .lock()
                .unwrap()
                .get_worker("worker-alpha")
                .is_none()
        );

        let ral = replay_ral_journal(&daemon_dir).expect("RAL journal must replay");
        let entry = ral
            .states
            .get(&identity)
            .expect("delegation RAL must replay");
        assert_eq!(entry.status, RalReplayStatus::WaitingForDelegation);
        let dispatch = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert!(dispatch.leased.is_empty());
        assert_eq!(dispatch.terminal.len(), 1);

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn boot_failure_candidate_stops_the_session_loop() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([frame_for(&fixture_valid_message("boot-error"))]),
            ..Default::default()
        };
        let runtime_state = runtime_state_for("worker-alpha", identity());

        let outcome = run_worker_session_loop(
            &mut worker,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &runtime_state,
                worker_id: "worker-alpha",
                observed_at: 1_710_000_403_000,
                publish: None,
                nip46_publish: None,
                live_publish_maintenance: None,
                terminal: None,
            },
        )
        .expect("boot error must stop the loop");

        assert_eq!(outcome.frame_count, 1);
        assert_eq!(
            outcome.final_reason,
            WorkerSessionLoopFinalReason::BootFailureCandidate
        );
        assert!(worker.sent_messages.is_empty());

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn malformed_frame_returns_decode_error() {
        let daemon_dir = unique_temp_daemon_dir();
        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([vec![0, 1, 2]]),
            ..Default::default()
        };
        let runtime_state = runtime_state_for("worker-alpha", identity());

        let error = run_worker_session_loop(
            &mut worker,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &runtime_state,
                worker_id: "worker-alpha",
                observed_at: 1_710_000_403_000,
                publish: None,
                nip46_publish: None,
                live_publish_maintenance: None,
                terminal: None,
            },
        )
        .expect_err("malformed frame must be rejected");

        assert!(matches!(error, WorkerSessionLoopError::Decode { .. }));

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn pending_worker_injection_is_sent_and_marked_sent() {
        let daemon_dir = unique_temp_daemon_dir();
        enqueue_worker_injection(WorkerInjectionEnqueueInput {
            daemon_dir: daemon_dir.clone(),
            timestamp: 1_710_000_402_000,
            correlation_id: "delegation-completion-inject:event-a".to_string(),
            worker_id: "worker-alpha".to_string(),
            identity: identity(),
            injection_id: "delegation-completion:event-a".to_string(),
            lease_token: "claim-alpha".to_string(),
            role: WorkerInjectionRole::System,
            content: "delegation done".to_string(),
            delegation_completion: Some(WorkerDelegationCompletionInjection {
                delegation_conversation_id: "delegation-a".to_string(),
                recipient_pubkey: "b".repeat(64),
                completed_at: 1_710_000_002,
                completion_event_id: "event-a".to_string(),
            }),
        })
        .expect("injection must queue");
        let mut worker = RecordingWorker {
            incoming_frames: VecDeque::from([
                frame_for(&fixture_valid_message("heartbeat")),
                frame_for(&fixture_valid_message("boot-error")),
            ]),
            ..Default::default()
        };
        let runtime_state = runtime_state_for("worker-alpha", identity());

        let outcome = run_worker_session_loop(
            &mut worker,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &runtime_state,
                worker_id: "worker-alpha",
                observed_at: 1_710_000_403_000,
                publish: None,
                nip46_publish: None,
                live_publish_maintenance: None,
                terminal: None,
            },
        )
        .expect("session loop must continue through injected message");

        assert_eq!(
            outcome.final_reason,
            WorkerSessionLoopFinalReason::BootFailureCandidate
        );
        assert_eq!(worker.sent_messages.len(), 1);
        assert_eq!(worker.sent_messages[0]["type"], "inject");
        assert_eq!(
            worker.sent_messages[0]["injectionId"],
            "delegation-completion:event-a"
        );
        assert_eq!(
            worker.sent_messages[0]["delegationCompletion"]["delegationConversationId"],
            "delegation-a"
        );

        let replayed =
            replay_worker_injection_queue(&daemon_dir).expect("injection queue must replay");
        assert!(replayed.queued.is_empty());
        assert_eq!(replayed.sent.len(), 1);

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    #[ignore = "requires Bun and repo TypeScript dependencies"]
    fn bun_agent_worker_session_loop_handles_real_process_to_completion() {
        let daemon_dir = unique_temp_daemon_dir();
        let owner = build_ral_lock_info(100, "host-a", 1_000);
        let locks = acquire_worker_launch_locks(&daemon_dir, &launch_plan(), &owner)
            .expect("launch locks must acquire");
        let execute_message = fixture_valid_message("execute");
        let identity = identity_from_message(&execute_message);

        let bun = std::env::var("BUN_BIN").unwrap_or_else(|_| "bun".to_string());
        let command = bun_agent_worker_command(&repo_root(), bun)
            .env("TENEX_AGENT_WORKER_ENGINE", "mock")
            .env("LOG_LEVEL", "silent");
        let mut worker = AgentWorkerProcess::spawn(
            &command,
            &AgentWorkerProcessConfig {
                boot_timeout: Duration::from_secs(5),
            },
        )
        .expect("agent worker must boot");
        let worker_id = worker.ready.worker_id.clone();
        let scheduler = scheduler_from_records_for(&worker_id);
        let dispatch_state = dispatch_state_from_records();
        let runtime_state = runtime_state_for(&worker_id, identity);

        worker
            .process
            .send_message(&execute_message)
            .expect("execute must send");

        let outcome = run_worker_session_loop(
            &mut worker.process,
            WorkerSessionLoopInput {
                daemon_dir: &daemon_dir,
                runtime_state: &runtime_state,
                worker_id: &worker_id,
                observed_at: 1_710_000_403_000,
                publish: None,
                nip46_publish: None,
                live_publish_maintenance: None,
                terminal: Some(WorkerMessageTerminalContext {
                    scheduler: &scheduler,
                    dispatch_state: &dispatch_state,
                    result_context: result_context_for(&worker_id),
                    dispatch: Some(dispatch_input()),
                    locks,
                }),
            },
        )
        .expect("session loop must stop on terminal frame");

        assert_eq!(outcome.frame_count, 3);
        assert_eq!(
            outcome.final_reason,
            WorkerSessionLoopFinalReason::TerminalResultHandled
        );
        assert!(
            runtime_state
                .lock()
                .unwrap()
                .get_worker(&worker_id)
                .is_none()
        );

        let status = worker
            .process
            .wait_for_exit(Duration::from_secs(5))
            .expect("worker must exit");
        assert!(status.success(), "worker exited with {status}");

        cleanup_temp_dir(daemon_dir);
    }

    fn frame_for(message: &Value) -> Vec<u8> {
        encode_agent_worker_protocol_frame(message).expect("frame must encode")
    }

    fn identity_from_message(message: &Value) -> RalJournalIdentity {
        RalJournalIdentity {
            project_id: message
                .get("projectId")
                .and_then(Value::as_str)
                .expect("message must include projectId")
                .to_string(),
            agent_pubkey: message
                .get("agentPubkey")
                .and_then(Value::as_str)
                .expect("message must include agentPubkey")
                .to_string(),
            conversation_id: message
                .get("conversationId")
                .and_then(Value::as_str)
                .expect("message must include conversationId")
                .to_string(),
            ral_number: message
                .get("ralNumber")
                .and_then(Value::as_u64)
                .expect("message must include ralNumber"),
        }
    }

    fn runtime_state_for(
        worker_id: &str,
        identity: RalJournalIdentity,
    ) -> SharedWorkerRuntimeState {
        let state = new_shared_worker_runtime_state();
        state
            .lock()
            .expect("runtime state mutex poisoned")
            .register_started_dispatch(WorkerRuntimeStartedDispatch {
                worker_id: worker_id.to_string(),
                pid: 4242,
                dispatch_id: "dispatch-alpha".to_string(),
                identity,
                claim_token: "claim-alpha".to_string(),
                started_at: 1_710_000_400_500,
            })
            .expect("worker runtime must register");
        state
    }

    fn scheduler_from_records() -> RalScheduler {
        scheduler_from_records_for("worker-alpha")
    }

    fn scheduler_from_records_for(worker_id: &str) -> RalScheduler {
        scheduler_from_records_for_identity(worker_id, identity())
    }

    fn scheduler_from_records_for_identity(
        worker_id: &str,
        identity: RalJournalIdentity,
    ) -> RalScheduler {
        let replay =
            replay_ral_journal_records(initial_ral_records_for_identity(worker_id, identity))
                .expect("journal replay must succeed");
        RalScheduler::new(&RalJournalReplay {
            last_sequence: replay.last_sequence,
            states: replay.states,
        })
    }

    fn dispatch_state_from_records() -> DispatchQueueState {
        dispatch_state_from_records_for_identity(identity())
    }

    fn dispatch_state_from_records_for_identity(
        identity: RalJournalIdentity,
    ) -> DispatchQueueState {
        replay_dispatch_queue_records(initial_dispatch_records_for_identity(identity))
            .expect("dispatch replay must succeed")
    }

    fn initial_ral_records_for_identity(
        worker_id: &str,
        identity: RalJournalIdentity,
    ) -> Vec<RalJournalRecord> {
        vec![
            journal_record(
                198,
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some("trigger-alpha".to_string()),
                },
            ),
            journal_record(
                199,
                RalJournalEvent::Claimed {
                    identity,
                    worker_id: worker_id.to_string(),
                    claim_token: "claim-alpha".to_string(),
                },
            ),
        ]
    }

    fn initial_dispatch_records_for_identity(
        identity: RalJournalIdentity,
    ) -> Vec<DispatchQueueRecord> {
        vec![
            dispatch_record_for_identity(300, DispatchQueueStatus::Queued, identity.clone()),
            dispatch_record_for_identity(301, DispatchQueueStatus::Leased, identity),
        ]
    }

    fn append_initial_ral_records_for(
        daemon_dir: &Path,
        worker_id: &str,
        identity: RalJournalIdentity,
    ) {
        for record in initial_ral_records_for_identity(worker_id, identity) {
            append_ral_journal_record(daemon_dir, &record).expect("RAL record must append");
        }
    }

    fn append_initial_dispatch_records_for(daemon_dir: &Path, identity: RalJournalIdentity) {
        for record in initial_dispatch_records_for_identity(identity) {
            append_dispatch_queue_record(daemon_dir, &record).expect("dispatch record must append");
        }
    }

    fn result_context() -> crate::worker_completion::result::WorkerResultTransitionContext {
        result_context_for("worker-alpha")
    }

    fn result_context_for(
        worker_id: &str,
    ) -> crate::worker_completion::result::WorkerResultTransitionContext {
        crate::worker_completion::result::WorkerResultTransitionContext {
            worker_id: worker_id.to_string(),
            claim_token: "claim-alpha".to_string(),
            journal_sequence: 200,
            journal_timestamp: 1_710_000_500_000,
            writer_version: "test-version".to_string(),
            resolved_pending_delegations: Vec::new(),
            already_completed_delegation_ids: std::collections::HashSet::new(),
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
        launch_plan_for(&identity())
    }

    fn launch_plan_for(identity: &RalJournalIdentity) -> WorkerLaunchPlan {
        WorkerLaunchPlan {
            allocation_lock_scope: RalAllocationLockScope {
                project_id: identity.project_id.clone(),
                agent_pubkey: identity.agent_pubkey.clone(),
                conversation_id: identity.conversation_id.clone(),
            },
            state_lock_scope: RalStateLockScope {
                project_id: identity.project_id.clone(),
                agent_pubkey: identity.agent_pubkey.clone(),
                conversation_id: identity.conversation_id.clone(),
                ral_number: identity.ral_number,
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

    fn dispatch_record_for_identity(
        sequence: u64,
        status: DispatchQueueStatus,
        identity: RalJournalIdentity,
    ) -> DispatchQueueRecord {
        build_dispatch_queue_record(DispatchQueueRecordParams {
            sequence,
            timestamp: 1_710_000_450_000 + sequence,
            correlation_id: format!("correlation-dispatch-{sequence}"),
            dispatch_id: "dispatch-alpha".to_string(),
            ral: DispatchRalIdentity {
                project_id: identity.project_id,
                agent_pubkey: identity.agent_pubkey,
                conversation_id: identity.conversation_id,
                ral_number: identity.ral_number,
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
            "version": crate::worker_protocol::AGENT_WORKER_PROTOCOL_VERSION,
            "type": "publish_request",
            "correlationId": "rust_worker_session_loop",
            "sequence": sequence,
            "timestamp": timestamp,
            "projectId": "project-alpha",
            "agentPubkey": fixture.pubkey,
            "conversationId": "conversation-alpha",
            "ralNumber": 3,
            "requestId": "publish-fixture-01",
            "waitForRelayOk": true,
            "timeoutMs": 30_000,
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
        let fixture: WorkerProtocolFixture =
            serde_json::from_str(WORKER_PROTOCOL_FIXTURE).expect("fixture must parse");
        fixture
            .valid_messages
            .iter()
            .find(|message| message.name == name)
            .unwrap_or_else(|| panic!("fixture message {name} must exist"))
            .message
            .clone()
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tenex-worker-session-loop-test-{nanos}-{counter}"))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if let Err(error) = fs::remove_dir_all(path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            panic!("temp daemon dir cleanup must succeed: {error}");
        }
    }
}
