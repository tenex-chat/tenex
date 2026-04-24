use std::path::{Path, PathBuf};

use tracing;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::conversation_store_files::{ConversationStoreFilesError, append_envelope_message};
use crate::dispatch_queue::{
    DispatchQueueError, DispatchQueueRecord, DispatchQueueStatus, acquire_dispatch_queue_lock,
    append_dispatch_queue_record, replay_dispatch_queue,
};
use crate::inbound_envelope::{InboundEnvelope, RuntimeTransport};
use crate::ral_journal::{
    RalCompletedDelegation, RalJournalError, RalJournalIdentity, RalJournalRecord, RalReplayStatus,
    append_ral_journal_record_with_resequence,
};
use crate::ral_scheduler::{
    RalDelegationCompletionPlanInput, RalDispatchPreparation, RalDispatchPreparationInput,
    RalNamespace, RalResumeDispatchPreparation, RalResumeDispatchPreparationInput, RalScheduler,
    RalSchedulerError,
};
use crate::worker_dispatch::input::{
    WorkerDispatchExecuteFields, WorkerDispatchInput, WorkerDispatchInputError,
    WorkerDispatchInputFromExecuteFields, WorkerDispatchInputSourceType,
    WorkerDispatchInputWriterMetadata, worker_dispatch_input_path, write_create_or_compare_equal,
};
use crate::worker_protocol::AgentWorkerExecutionFlags;

const INBOUND_DISPATCH_DIGEST_DOMAIN: &[u8] = b"tenex-inbound-dispatch-v1";
const INBOUND_WORKER_ID_PREFIX: &str = "inbound-worker";
const INBOUND_CLAIM_TOKEN_PREFIX: &str = "inbound-claim";
const INBOUND_DISPATCH_ID_PREFIX: &str = "inbound";
const DELEGATION_RESUME_WORKER_ID_PREFIX: &str = "delegation-resume-worker";
const DELEGATION_RESUME_CLAIM_TOKEN_PREFIX: &str = "delegation-resume-claim";
const DELEGATION_RESUME_DISPATCH_ID_PREFIX: &str = "delegation-resume";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InboundDispatchProject<'a> {
    pub project_id: &'a str,
    pub project_base_path: &'a str,
    pub metadata_path: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InboundDispatchRoute<'a> {
    pub agent_pubkey: &'a str,
    pub conversation_id: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InboundDispatchEnqueueInput<'a> {
    pub daemon_dir: &'a Path,
    pub project: InboundDispatchProject<'a>,
    pub route: InboundDispatchRoute<'a>,
    pub envelope: &'a InboundEnvelope,
    pub timestamp: u64,
    pub writer_version: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DelegationCompletionDispatchInput<'a> {
    pub daemon_dir: &'a Path,
    pub project: InboundDispatchProject<'a>,
    pub identity: &'a RalJournalIdentity,
    pub parent_status: RalReplayStatus,
    pub completion: &'a RalCompletedDelegation,
    pub triggering_envelope: &'a InboundEnvelope,
    pub remaining_pending_delegation_ids: &'a [String],
    pub resume_if_waiting: bool,
    pub timestamp: u64,
    pub writer_version: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundDispatchEnqueueOutcome {
    pub dispatch_id: String,
    pub triggering_event_id: String,
    pub worker_id: String,
    pub claim_token: String,
    pub project_id: String,
    pub agent_pubkey: String,
    pub conversation_id: String,
    pub sidecar_path: PathBuf,
    pub queued: bool,
    pub already_existed: bool,
    pub dispatch_record: DispatchQueueRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DelegationCompletionDispatchOutcome {
    Recorded {
        completion_record: RalJournalRecord,
    },
    Resumed {
        dispatch_id: String,
        triggering_event_id: String,
        worker_id: String,
        claim_token: String,
        project_id: String,
        agent_pubkey: String,
        conversation_id: String,
        ral_number: u64,
        sidecar_path: PathBuf,
        queued: bool,
        already_existed: bool,
        completion_record: Option<RalJournalRecord>,
        dispatch_record: DispatchQueueRecord,
    },
}

#[derive(Debug, Error)]
pub enum InboundDispatchEnqueueError {
    #[error("inbound transport {transport:?} cannot be dispatched by the worker queue")]
    UnsupportedTransport { transport: RuntimeTransport },
    #[error("inbound dispatch sequence exhausted: {0}")]
    SequenceExhausted(&'static str),
    #[error("inbound dispatch envelope serialization failed: {0}")]
    EnvelopeJson(#[from] serde_json::Error),
    #[error("inbound dispatch worker sidecar failed: {0}")]
    DispatchInput(#[from] WorkerDispatchInputError),
    #[error("inbound dispatch RAL scheduler failed: {0}")]
    RalScheduler(#[from] RalSchedulerError),
    #[error("inbound dispatch RAL journal failed: {0}")]
    RalJournal(#[from] RalJournalError),
    #[error("inbound dispatch queue failed: {0}")]
    DispatchQueue(#[from] DispatchQueueError),
    #[error("inbound dispatch conversation store write failed: {0}")]
    ConversationStore(#[from] ConversationStoreFilesError),
}

pub fn enqueue_inbound_dispatch(
    input: InboundDispatchEnqueueInput<'_>,
) -> Result<InboundDispatchEnqueueOutcome, InboundDispatchEnqueueError> {
    let source_type = source_type_for_transport(input.envelope.transport)?;
    let triggering_event_id = input.envelope.message.native_id.clone();
    let ids = inbound_dispatch_ids(
        input.project.project_id,
        input.route.agent_pubkey,
        input.route.conversation_id,
        &triggering_event_id,
    );

    let sidecar_input =
        WorkerDispatchInput::from_execute_fields(WorkerDispatchInputFromExecuteFields {
            dispatch_id: ids.dispatch_id.clone(),
            source_type,
            writer: WorkerDispatchInputWriterMetadata {
                writer: "inbound_dispatch".to_string(),
                writer_version: input.writer_version.to_string(),
                timestamp: input.timestamp,
            },
            execute_fields: WorkerDispatchExecuteFields {
                worker_id: Some(ids.worker_id.clone()),
                triggering_event_id: triggering_event_id.clone(),
                project_base_path: input.project.project_base_path.to_string(),
                metadata_path: input.project.metadata_path.to_string(),
                triggering_envelope: serde_json::to_value(input.envelope)?,
                execution_flags: AgentWorkerExecutionFlags {
                    is_delegation_completion: false,
                    has_pending_delegations: false,
                    pending_delegation_ids: Vec::new(),
                    debug: false,
                },
            },
            source_metadata: Some(source_metadata(input.envelope)),
        });
    write_create_or_compare_equal(input.daemon_dir, &sidecar_input)?;

    let metadata_path = std::path::Path::new(input.project.metadata_path);
    append_envelope_message(metadata_path, input.route.conversation_id, input.envelope)?;

    let _dispatch_lock = acquire_dispatch_queue_lock(input.daemon_dir)?;
    let dispatch_state = replay_dispatch_queue(input.daemon_dir)?;
    if let Some(existing) = dispatch_state.latest_record(&ids.dispatch_id) {
        return Ok(InboundDispatchEnqueueOutcome {
            dispatch_id: ids.dispatch_id,
            triggering_event_id,
            worker_id: ids.worker_id,
            claim_token: existing.claim_token.clone(),
            project_id: input.project.project_id.to_string(),
            agent_pubkey: input.route.agent_pubkey.to_string(),
            conversation_id: input.route.conversation_id.to_string(),
            sidecar_path: worker_dispatch_input_path(
                input.daemon_dir,
                existing.dispatch_id.as_str(),
            ),
            queued: existing.status == DispatchQueueStatus::Queued,
            already_existed: true,
            dispatch_record: existing.clone(),
        });
    }

    let scheduler = RalScheduler::from_daemon_dir(input.daemon_dir)?;
    let mut preparation = scheduler.plan_dispatch_preparation(RalDispatchPreparationInput {
        namespace: RalNamespace::new(
            input.project.project_id.to_string(),
            input.route.agent_pubkey.to_string(),
            input.route.conversation_id.to_string(),
        ),
        triggering_event_id: triggering_event_id.clone(),
        worker_id: ids.worker_id.clone(),
        claim_token: ids.claim_token.clone(),
        journal_sequence: next_sequence(scheduler.state().last_sequence, "RAL journal")?,
        dispatch_sequence: next_sequence(dispatch_state.last_sequence, "dispatch queue")?,
        last_dispatch_sequence: dispatch_state.last_sequence,
        timestamp: input.timestamp,
        correlation_id: ids.correlation_id.clone(),
        dispatch_id: ids.dispatch_id.clone(),
        writer_version: input.writer_version.to_string(),
    })?;
    append_dispatch_preparation(input.daemon_dir, &mut preparation)?;

    tracing::info!(
        dispatch_id = %ids.dispatch_id,
        agent_pubkey = %input.route.agent_pubkey,
        project_id = %input.project.project_id,
        conversation_id = %input.route.conversation_id,
        triggering_event_id = %triggering_event_id,
        "inbound dispatch queued"
    );

    Ok(InboundDispatchEnqueueOutcome {
        dispatch_id: ids.dispatch_id,
        triggering_event_id,
        worker_id: ids.worker_id,
        claim_token: preparation.claim.claim_token.clone(),
        project_id: input.project.project_id.to_string(),
        agent_pubkey: input.route.agent_pubkey.to_string(),
        conversation_id: input.route.conversation_id.to_string(),
        sidecar_path: worker_dispatch_input_path(
            input.daemon_dir,
            preparation.dispatch_record.dispatch_id.as_str(),
        ),
        queued: true,
        already_existed: false,
        dispatch_record: preparation.dispatch_record,
    })
}

pub fn enqueue_delegation_completion_dispatch(
    input: DelegationCompletionDispatchInput<'_>,
) -> Result<DelegationCompletionDispatchOutcome, InboundDispatchEnqueueError> {
    let source_type = source_type_for_transport(input.triggering_envelope.transport)?;
    let triggering_event_id = input.triggering_envelope.message.native_id.clone();
    let ids = delegation_resume_dispatch_ids(
        &input.identity.project_id,
        &input.identity.agent_pubkey,
        &input.identity.conversation_id,
        input.identity.ral_number,
        &input.completion.completion_event_id,
    );
    let should_resume =
        input.resume_if_waiting && input.parent_status == RalReplayStatus::WaitingForDelegation;

    if should_resume {
        let sidecar_input =
            WorkerDispatchInput::from_execute_fields(WorkerDispatchInputFromExecuteFields {
                dispatch_id: ids.dispatch_id.clone(),
                source_type,
                writer: WorkerDispatchInputWriterMetadata {
                    writer: "inbound_dispatch".to_string(),
                    writer_version: input.writer_version.to_string(),
                    timestamp: input.timestamp,
                },
                execute_fields: WorkerDispatchExecuteFields {
                    worker_id: Some(ids.worker_id.clone()),
                    triggering_event_id: triggering_event_id.clone(),
                    project_base_path: input.project.project_base_path.to_string(),
                    metadata_path: input.project.metadata_path.to_string(),
                    triggering_envelope: serde_json::to_value(input.triggering_envelope)?,
                    execution_flags: AgentWorkerExecutionFlags {
                        is_delegation_completion: true,
                        has_pending_delegations: !input.remaining_pending_delegation_ids.is_empty(),
                        pending_delegation_ids: input.remaining_pending_delegation_ids.to_vec(),
                        debug: false,
                    },
                },
                source_metadata: Some(source_metadata(input.triggering_envelope)),
            });
        write_create_or_compare_equal(input.daemon_dir, &sidecar_input)?;
    }

    let _dispatch_lock = acquire_dispatch_queue_lock(input.daemon_dir)?;
    let dispatch_state = replay_dispatch_queue(input.daemon_dir)?;
    if should_resume && let Some(existing) = dispatch_state.latest_record(&ids.dispatch_id) {
        return Ok(DelegationCompletionDispatchOutcome::Resumed {
            dispatch_id: ids.dispatch_id,
            triggering_event_id,
            worker_id: ids.worker_id,
            claim_token: existing.claim_token.clone(),
            project_id: input.identity.project_id.clone(),
            agent_pubkey: input.identity.agent_pubkey.clone(),
            conversation_id: input.identity.conversation_id.clone(),
            ral_number: input.identity.ral_number,
            sidecar_path: worker_dispatch_input_path(
                input.daemon_dir,
                existing.dispatch_id.as_str(),
            ),
            queued: existing.status == DispatchQueueStatus::Queued,
            already_existed: true,
            completion_record: None,
            dispatch_record: existing.clone(),
        });
    }

    let scheduler = RalScheduler::from_daemon_dir(input.daemon_dir)?;
    let mut completion_plan =
        scheduler.plan_delegation_completion(RalDelegationCompletionPlanInput {
            identity: input.identity.clone(),
            completion: input.completion.clone(),
            sequence: next_sequence(scheduler.state().last_sequence, "RAL journal")?,
            timestamp: input.timestamp,
            correlation_id: ids.correlation_id.clone(),
            writer_version: input.writer_version.to_string(),
        })?;

    if !should_resume {
        append_ral_journal_record_with_resequence(input.daemon_dir, &mut completion_plan.record)?;
        return Ok(DelegationCompletionDispatchOutcome::Recorded {
            completion_record: completion_plan.record,
        });
    }

    let mut resume_preparation =
        scheduler.plan_resume_dispatch_preparation(RalResumeDispatchPreparationInput {
            identity: input.identity.clone(),
            worker_id: ids.worker_id.clone(),
            claim_token: ids.claim_token.clone(),
            journal_sequence: next_sequence(completion_plan.record.sequence, "RAL journal")?,
            dispatch_sequence: next_sequence(dispatch_state.last_sequence, "dispatch queue")?,
            last_dispatch_sequence: dispatch_state.last_sequence,
            timestamp: input.timestamp,
            correlation_id: ids.correlation_id.clone(),
            dispatch_id: ids.dispatch_id.clone(),
            triggering_event_id: triggering_event_id.clone(),
            writer_version: input.writer_version.to_string(),
        })?;
    append_delegation_resume_preparation(
        input.daemon_dir,
        &mut completion_plan.record,
        &mut resume_preparation,
    )?;

    tracing::info!(
        dispatch_id = %ids.dispatch_id,
        agent_pubkey = %input.identity.agent_pubkey,
        project_id = %input.identity.project_id,
        conversation_id = %input.identity.conversation_id,
        ral_number = input.identity.ral_number,
        completion_event_id = %input.completion.completion_event_id,
        "delegation completion resume dispatch queued"
    );

    Ok(DelegationCompletionDispatchOutcome::Resumed {
        dispatch_id: ids.dispatch_id,
        triggering_event_id,
        worker_id: ids.worker_id,
        claim_token: resume_preparation.claim.claim_token.clone(),
        project_id: input.identity.project_id.clone(),
        agent_pubkey: input.identity.agent_pubkey.clone(),
        conversation_id: input.identity.conversation_id.clone(),
        ral_number: input.identity.ral_number,
        sidecar_path: worker_dispatch_input_path(
            input.daemon_dir,
            resume_preparation.dispatch_record.dispatch_id.as_str(),
        ),
        queued: true,
        already_existed: false,
        completion_record: Some(completion_plan.record),
        dispatch_record: resume_preparation.dispatch_record,
    })
}

fn append_dispatch_preparation(
    daemon_dir: &Path,
    preparation: &mut RalDispatchPreparation,
) -> Result<(), InboundDispatchEnqueueError> {
    append_ral_journal_record_with_resequence(daemon_dir, &mut preparation.allocation_record)?;
    append_ral_journal_record_with_resequence(daemon_dir, &mut preparation.claim_record)?;
    append_dispatch_queue_record(daemon_dir, &preparation.dispatch_record)?;
    Ok(())
}

fn append_delegation_resume_preparation(
    daemon_dir: &Path,
    completion_record: &mut RalJournalRecord,
    resume_preparation: &mut RalResumeDispatchPreparation,
) -> Result<(), InboundDispatchEnqueueError> {
    append_ral_journal_record_with_resequence(daemon_dir, completion_record)?;
    append_ral_journal_record_with_resequence(daemon_dir, &mut resume_preparation.claim_record)?;
    append_dispatch_queue_record(daemon_dir, &resume_preparation.dispatch_record)?;
    Ok(())
}

fn source_type_for_transport(
    transport: RuntimeTransport,
) -> Result<WorkerDispatchInputSourceType, InboundDispatchEnqueueError> {
    match transport {
        RuntimeTransport::Nostr => Ok(WorkerDispatchInputSourceType::Nostr),
        RuntimeTransport::Telegram => Ok(WorkerDispatchInputSourceType::Telegram),
        RuntimeTransport::Local | RuntimeTransport::Mcp => {
            Err(InboundDispatchEnqueueError::UnsupportedTransport { transport })
        }
    }
}

fn source_metadata(envelope: &InboundEnvelope) -> Value {
    serde_json::json!({
        "transport": envelope.transport,
        "messageId": envelope.message.id,
        "nativeId": envelope.message.native_id,
        "channelId": envelope.channel.id,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InboundDispatchIds {
    dispatch_id: String,
    worker_id: String,
    claim_token: String,
    correlation_id: String,
}

fn inbound_dispatch_ids(
    project_id: &str,
    agent_pubkey: &str,
    conversation_id: &str,
    triggering_event_id: &str,
) -> InboundDispatchIds {
    let digest = stable_digest(&[
        project_id,
        agent_pubkey,
        conversation_id,
        triggering_event_id,
    ]);
    InboundDispatchIds {
        dispatch_id: format!("{INBOUND_DISPATCH_ID_PREFIX}-{digest}"),
        worker_id: format!("{INBOUND_WORKER_ID_PREFIX}-{digest}"),
        claim_token: format!("{INBOUND_CLAIM_TOKEN_PREFIX}-{digest}"),
        correlation_id: format!("inbound-dispatch-{digest}"),
    }
}

fn delegation_resume_dispatch_ids(
    project_id: &str,
    agent_pubkey: &str,
    conversation_id: &str,
    ral_number: u64,
    completion_event_id: &str,
) -> InboundDispatchIds {
    let ral_number = ral_number.to_string();
    let digest = stable_digest(&[
        "delegation-resume",
        project_id,
        agent_pubkey,
        conversation_id,
        ral_number.as_str(),
        completion_event_id,
    ]);
    InboundDispatchIds {
        dispatch_id: format!("{DELEGATION_RESUME_DISPATCH_ID_PREFIX}-{digest}"),
        worker_id: format!("{DELEGATION_RESUME_WORKER_ID_PREFIX}-{digest}"),
        claim_token: format!("{DELEGATION_RESUME_CLAIM_TOKEN_PREFIX}-{digest}"),
        correlation_id: format!("delegation-resume-{digest}"),
    }
}

fn stable_digest(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(INBOUND_DISPATCH_DIGEST_DOMAIN);
    for part in parts {
        hasher.update([0]);
        hasher.update(part.as_bytes());
    }
    let digest = hasher.finalize();
    hex::encode(&digest[..12])
}

fn next_sequence(
    last_sequence: u64,
    sequence_space: &'static str,
) -> Result<u64, InboundDispatchEnqueueError> {
    last_sequence
        .checked_add(1)
        .ok_or(InboundDispatchEnqueueError::SequenceExhausted(
            sequence_space,
        ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{read_dispatch_queue_records, replay_dispatch_queue};
    use crate::inbound_envelope::{
        ChannelKind, ChannelRef, ExternalMessageRef, InboundMetadata, PrincipalKind, PrincipalRef,
        TelegramChatType, TelegramTransportMetadata, TransportMetadataBag,
    };
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalCompletedDelegation, RalDelegationType, RalJournalEvent,
        RalJournalIdentity, RalJournalRecord, RalPendingDelegation, RalReplayStatus,
        RalTerminalSummary, append_ral_journal_record, read_ral_journal_records,
        replay_ral_journal,
    };
    use crate::worker_dispatch::input::read_optional as read_worker_dispatch_input;
    use serde_json::{Value, json};
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn enqueue_inbound_nostr_dispatch_writes_worker_runtime_artifacts() {
        let daemon_dir = unique_temp_dir("inbound-dispatch-nostr");
        let metadata_path = daemon_dir.join("project");
        fs::create_dir_all(&metadata_path).expect("metadata path must create");
        let envelope = nostr_envelope();

        let outcome = enqueue_inbound_dispatch(InboundDispatchEnqueueInput {
            daemon_dir: &daemon_dir,
            project: InboundDispatchProject {
                project_id: "TENEX-demo",
                project_base_path: "/repo/demo",
                metadata_path: metadata_path.to_str().expect("metadata path must be utf8"),
            },
            route: InboundDispatchRoute {
                agent_pubkey: "agent-pubkey",
                conversation_id: "conversation-alpha",
            },
            envelope: &envelope,
            timestamp: 1_710_000_700_000,
            writer_version: "inbound-dispatch-test@0",
        })
        .expect("inbound dispatch must enqueue");

        assert!(outcome.queued);
        assert!(!outcome.already_existed);
        assert_eq!(outcome.triggering_event_id, "event-alpha");
        assert_inbound_dispatch_artifacts(
            &daemon_dir,
            &envelope,
            &outcome,
            WorkerDispatchInputSourceType::Nostr,
            json!({
                "transport": "nostr",
                "messageId": "nostr:event-alpha",
                "nativeId": "event-alpha",
                "channelId": "nostr:conversation:event-alpha",
            }),
            json!({
                "transport": "nostr",
                "principal": {
                    "id": "nostr:sender",
                    "transport": "nostr",
                    "linkedPubkey": "sender"
                },
                "channel": {
                    "id": "nostr:conversation:event-alpha",
                    "transport": "nostr",
                    "kind": "conversation"
                },
                "message": {
                    "id": "nostr:event-alpha",
                    "transport": "nostr",
                    "nativeId": "event-alpha"
                },
                "recipients": [],
                "content": "hello",
                "occurredAt": 1_710_000_700,
                "capabilities": [],
                "metadata": {}
            }),
            "TENEX-demo",
            "agent-pubkey",
            "conversation-alpha",
            metadata_path.to_str().expect("metadata path must be utf8"),
            1_710_000_700_000,
            "inbound-dispatch-test@0",
        );

        let conversation_file = metadata_path.join("conversations").join("conversation-alpha.json");
        let conversation: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&conversation_file).expect("conversation file must exist"),
        )
        .expect("conversation file must parse");
        let messages = conversation["messages"].as_array().expect("messages must be array");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["eventId"], "event-alpha");
        assert_eq!(messages[0]["content"], "hello");
        assert_eq!(messages[0]["messageType"], "text");

        if daemon_dir.exists() {
            fs::remove_dir_all(daemon_dir).expect("temp dir cleanup must succeed");
        }
    }

    #[test]
    fn enqueue_inbound_telegram_dispatch_writes_worker_runtime_artifacts() {
        let daemon_dir = unique_temp_dir("inbound-dispatch-telegram");
        let metadata_path = daemon_dir.join("project");
        fs::create_dir_all(&metadata_path).expect("metadata path must create");
        let envelope = telegram_envelope();

        let outcome = enqueue_inbound_dispatch(InboundDispatchEnqueueInput {
            daemon_dir: &daemon_dir,
            project: InboundDispatchProject {
                project_id: "TENEX-demo",
                project_base_path: "/repo/demo",
                metadata_path: metadata_path.to_str().expect("metadata path must be utf8"),
            },
            route: InboundDispatchRoute {
                agent_pubkey: "agent-pubkey",
                conversation_id: "conversation-bravo",
            },
            envelope: &envelope,
            timestamp: 1_710_000_800_000,
            writer_version: "inbound-dispatch-test@0",
        })
        .expect("inbound dispatch must enqueue");

        assert!(outcome.queued);
        assert!(!outcome.already_existed);
        assert_eq!(outcome.triggering_event_id, "tg-event-88");
        assert_inbound_dispatch_artifacts(
            &daemon_dir,
            &envelope,
            &outcome,
            WorkerDispatchInputSourceType::Telegram,
            json!({
                "transport": "telegram",
                "messageId": "telegram:msg-88",
                "nativeId": "tg-event-88",
                "channelId": "telegram:group:-100200300",
            }),
            json!({
                "transport": "telegram",
                "principal": {
                    "id": "telegram:user-42",
                    "transport": "telegram",
                    "displayName": "Ada",
                    "username": "ada",
                    "kind": "human"
                },
                "channel": {
                    "id": "telegram:group:-100200300",
                    "transport": "telegram",
                    "kind": "group",
                    "projectBinding": "TENEX-demo"
                },
                "message": {
                    "id": "telegram:msg-88",
                    "transport": "telegram",
                    "nativeId": "tg-event-88",
                    "replyToId": "telegram:msg-87"
                },
                "recipients": [],
                "content": "hello from telegram",
                "occurredAt": 1_710_000_800,
                "capabilities": ["reply"],
                "metadata": {
                    "transport": {
                        "telegram": {
                            "updateId": 88,
                            "chatId": "telegram:group:-100200300",
                            "messageId": "telegram:msg-88",
                            "threadId": "telegram:thread-3",
                            "chatType": "group",
                            "isEditedMessage": false,
                            "senderUserId": "telegram:user-42",
                            "chatTitle": "TENEX group",
                            "chatUsername": "tenex-group",
                            "memberCount": 12,
                            "botId": "telegram:bot-1",
                            "botUsername": "tenex_bot"
                        }
                    }
                }
            }),
            "TENEX-demo",
            "agent-pubkey",
            "conversation-bravo",
            metadata_path.to_str().expect("metadata path must be utf8"),
            1_710_000_800_000,
            "inbound-dispatch-test@0",
        );

        if daemon_dir.exists() {
            fs::remove_dir_all(daemon_dir).expect("temp dir cleanup must succeed");
        }
    }

    #[test]
    fn enqueue_inbound_dispatch_is_idempotent_for_same_route_and_event() {
        let daemon_dir = unique_temp_dir("inbound-dispatch-idempotent");
        let metadata_path = daemon_dir.join("project");
        fs::create_dir_all(&metadata_path).expect("metadata path must create");
        let envelope = nostr_envelope();
        let metadata_path_str = metadata_path.to_str().expect("metadata path must be utf8");
        let input = InboundDispatchEnqueueInput {
            daemon_dir: &daemon_dir,
            project: InboundDispatchProject {
                project_id: "TENEX-demo",
                project_base_path: "/repo/demo",
                metadata_path: metadata_path_str,
            },
            route: InboundDispatchRoute {
                agent_pubkey: "agent-pubkey",
                conversation_id: "conversation-alpha",
            },
            envelope: &envelope,
            timestamp: 1_710_000_700_000,
            writer_version: "inbound-dispatch-test@0",
        };

        let first = enqueue_inbound_dispatch(input).expect("first enqueue must succeed");
        let second = enqueue_inbound_dispatch(input).expect("second enqueue must be idempotent");

        assert_eq!(second.dispatch_id, first.dispatch_id);
        assert!(second.already_existed);
        let dispatch = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(dispatch.queued.len(), 1);
        assert_eq!(dispatch.last_sequence, 1);

        if daemon_dir.exists() {
            fs::remove_dir_all(daemon_dir).expect("temp dir cleanup must succeed");
        }
    }

    #[test]
    fn delegation_completion_resume_reclaims_waiting_ral_without_allocating_new_one() {
        let daemon_dir = unique_temp_dir("delegation-completion-resume");
        let identity = RalJournalIdentity {
            project_id: "TENEX-demo".to_string(),
            agent_pubkey: "agent-pubkey".to_string(),
            conversation_id: "conversation-alpha".to_string(),
            ral_number: 1,
        };
        for record in [
            RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "inbound-dispatch-test@0",
                1,
                1_710_000_700_000,
                "seed",
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some("event-alpha".to_string()),
                },
            ),
            RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "inbound-dispatch-test@0",
                2,
                1_710_000_700_001,
                "seed",
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                },
            ),
            RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "inbound-dispatch-test@0",
                3,
                1_710_000_700_002,
                "seed",
                RalJournalEvent::WaitingForDelegation {
                    identity: identity.clone(),
                    worker_id: "worker-a".to_string(),
                    claim_token: "claim-a".to_string(),
                    pending_delegations: vec![
                        pending_delegation("delegation-a"),
                        pending_delegation("delegation-b"),
                    ],
                    terminal: terminal_summary(),
                },
            ),
        ] {
            append_ral_journal_record(&daemon_dir, &record).expect("seed journal must append");
        }
        let parent_trigger = nostr_envelope();
        let completion = RalCompletedDelegation {
            delegation_conversation_id: "delegation-a".to_string(),
            sender_pubkey: "recipient-a".to_string(),
            recipient_pubkey: "agent-pubkey".to_string(),
            response: "done".to_string(),
            completed_at: 1_710_000_900,
            completion_event_id: "completion-a".to_string(),
            full_transcript: None,
        };

        let outcome = enqueue_delegation_completion_dispatch(DelegationCompletionDispatchInput {
            daemon_dir: &daemon_dir,
            project: InboundDispatchProject {
                project_id: "TENEX-demo",
                project_base_path: "/repo/demo",
                metadata_path: "/repo/demo/.tenex/project.json",
            },
            identity: &identity,
            parent_status: RalReplayStatus::WaitingForDelegation,
            completion: &completion,
            triggering_envelope: &parent_trigger,
            remaining_pending_delegation_ids: &["delegation-b".to_string()],
            resume_if_waiting: true,
            timestamp: 1_710_000_900_000,
            writer_version: "inbound-dispatch-test@0",
        })
        .expect("delegation completion must enqueue resume");

        let DelegationCompletionDispatchOutcome::Resumed {
            dispatch_id,
            dispatch_record,
            ..
        } = outcome
        else {
            panic!("expected resumed dispatch");
        };
        let sidecar = read_worker_dispatch_input(&daemon_dir, &dispatch_id)
            .expect("sidecar must read")
            .expect("sidecar must exist");
        let fields = sidecar
            .resolved_execute_fields()
            .expect("sidecar execute fields must resolve");
        assert!(fields.execution_flags.is_delegation_completion);
        assert!(fields.execution_flags.has_pending_delegations);
        assert_eq!(
            fields.execution_flags.pending_delegation_ids,
            vec!["delegation-b".to_string()]
        );

        let journal = read_ral_journal_records(&daemon_dir).expect("journal must read");
        assert_eq!(journal.len(), 5);
        assert!(matches!(
            journal[3].event,
            RalJournalEvent::DelegationCompleted { .. }
        ));
        assert!(matches!(journal[4].event, RalJournalEvent::Claimed { .. }));
        let replay = replay_ral_journal(&daemon_dir).expect("journal must replay");
        let entry = replay.states.get(&identity).expect("identity must exist");
        assert_eq!(entry.status, RalReplayStatus::Claimed);
        assert_eq!(
            entry
                .pending_delegations
                .iter()
                .map(|pending| pending.delegation_conversation_id.as_str())
                .collect::<Vec<_>>(),
            vec!["delegation-b"]
        );
        assert_eq!(entry.completed_delegations, vec![completion]);
        let dispatch = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(dispatch.queued, vec![dispatch_record]);

        if daemon_dir.exists() {
            fs::remove_dir_all(daemon_dir).expect("temp dir cleanup must succeed");
        }
    }

    #[test]
    fn unsupported_transport_is_rejected() {
        let daemon_dir = unique_temp_dir("inbound-dispatch-unsupported");
        let mut envelope = nostr_envelope();
        envelope.transport = RuntimeTransport::Local;

        let error = enqueue_inbound_dispatch(InboundDispatchEnqueueInput {
            daemon_dir: &daemon_dir,
            project: InboundDispatchProject {
                project_id: "TENEX-demo",
                project_base_path: "/repo/demo",
                metadata_path: "/repo/demo/.tenex/project.json",
            },
            route: InboundDispatchRoute {
                agent_pubkey: "agent-pubkey",
                conversation_id: "conversation-alpha",
            },
            envelope: &envelope,
            timestamp: 1_710_000_700_000,
            writer_version: "inbound-dispatch-test@0",
        })
        .expect_err("local transport cannot map to worker dispatch sidecar source");

        assert!(matches!(
            error,
            InboundDispatchEnqueueError::UnsupportedTransport {
                transport: RuntimeTransport::Local
            }
        ));
        if daemon_dir.exists() {
            fs::remove_dir_all(daemon_dir).expect("temp dir cleanup must succeed");
        }
    }

    fn nostr_envelope() -> InboundEnvelope {
        InboundEnvelope {
            transport: RuntimeTransport::Nostr,
            principal: PrincipalRef {
                id: "nostr:sender".to_string(),
                transport: RuntimeTransport::Nostr,
                linked_pubkey: Some("sender".to_string()),
                display_name: None,
                username: None,
                kind: None,
            },
            channel: ChannelRef {
                id: "nostr:conversation:event-alpha".to_string(),
                transport: RuntimeTransport::Nostr,
                kind: ChannelKind::Conversation,
                project_binding: None,
            },
            message: ExternalMessageRef {
                id: "nostr:event-alpha".to_string(),
                transport: RuntimeTransport::Nostr,
                native_id: "event-alpha".to_string(),
                reply_to_id: None,
            },
            recipients: Vec::new(),
            content: "hello".to_string(),
            occurred_at: 1_710_000_700,
            capabilities: Vec::new(),
            metadata: InboundMetadata::default(),
        }
    }

    fn telegram_envelope() -> InboundEnvelope {
        InboundEnvelope {
            transport: RuntimeTransport::Telegram,
            principal: PrincipalRef {
                id: "telegram:user-42".to_string(),
                transport: RuntimeTransport::Telegram,
                linked_pubkey: None,
                display_name: Some("Ada".to_string()),
                username: Some("ada".to_string()),
                kind: Some(PrincipalKind::Human),
            },
            channel: ChannelRef {
                id: "telegram:group:-100200300".to_string(),
                transport: RuntimeTransport::Telegram,
                kind: ChannelKind::Group,
                project_binding: Some("TENEX-demo".to_string()),
            },
            message: ExternalMessageRef {
                id: "telegram:msg-88".to_string(),
                transport: RuntimeTransport::Telegram,
                native_id: "tg-event-88".to_string(),
                reply_to_id: Some("telegram:msg-87".to_string()),
            },
            recipients: Vec::new(),
            content: "hello from telegram".to_string(),
            occurred_at: 1_710_000_800,
            capabilities: vec!["reply".to_string()],
            metadata: InboundMetadata {
                transport: Some(TransportMetadataBag {
                    telegram: Some(TelegramTransportMetadata {
                        update_id: 88,
                        chat_id: "telegram:group:-100200300".to_string(),
                        message_id: "telegram:msg-88".to_string(),
                        thread_id: Some("telegram:thread-3".to_string()),
                        chat_type: TelegramChatType::Group,
                        is_edited_message: false,
                        sender_user_id: "telegram:user-42".to_string(),
                        chat_title: Some("TENEX group".to_string()),
                        topic_title: None,
                        chat_username: Some("tenex-group".to_string()),
                        member_count: Some(12),
                        administrators: None,
                        seen_participants: None,
                        bot_id: Some("telegram:bot-1".to_string()),
                        bot_username: Some("tenex_bot".to_string()),
                    }),
                }),
                ..InboundMetadata::default()
            },
        }
    }

    fn pending_delegation(delegation_conversation_id: &str) -> RalPendingDelegation {
        RalPendingDelegation {
            delegation_conversation_id: delegation_conversation_id.to_string(),
            recipient_pubkey: "recipient-a".to_string(),
            sender_pubkey: "agent-pubkey".to_string(),
            prompt: "delegated prompt".to_string(),
            delegation_type: RalDelegationType::Standard,
            ral_number: 1,
            parent_delegation_conversation_id: None,
            pending_sub_delegations: None,
            deferred_completion: None,
            followup_event_id: None,
            project_id: None,
            suggestions: None,
            killed: None,
            killed_at: None,
        }
    }

    fn terminal_summary() -> RalTerminalSummary {
        RalTerminalSummary {
            published_user_visible_event: false,
            pending_delegations_remain: true,
            accumulated_runtime_ms: 0,
            final_event_ids: Vec::new(),
            keep_worker_warm: false,
        }
    }

    fn assert_inbound_dispatch_artifacts(
        daemon_dir: &Path,
        envelope: &InboundEnvelope,
        outcome: &InboundDispatchEnqueueOutcome,
        expected_source_type: WorkerDispatchInputSourceType,
        expected_source_metadata: Value,
        expected_triggering_envelope: Value,
        project_id: &str,
        agent_pubkey: &str,
        conversation_id: &str,
        metadata_path: &str,
        timestamp: u64,
        writer_version: &str,
    ) {
        let sidecar = read_worker_dispatch_input(daemon_dir, &outcome.dispatch_id)
            .expect("sidecar must read")
            .expect("sidecar must exist");
        assert_eq!(sidecar.source_type, expected_source_type);
        assert_eq!(
            sidecar.source_metadata,
            Some(expected_source_metadata.clone())
        );
        let fields = sidecar
            .resolved_execute_fields()
            .expect("sidecar fields must resolve");
        assert_eq!(
            fields.worker_id.as_deref(),
            Some(outcome.worker_id.as_str())
        );
        assert_eq!(fields.project_base_path, "/repo/demo");
        assert_eq!(fields.metadata_path, metadata_path);
        assert_eq!(fields.triggering_envelope, expected_triggering_envelope);
        assert_eq!(
            serde_json::to_value(envelope).expect("triggering envelope must serialize"),
            fields.triggering_envelope
        );

        let dispatch_records =
            read_dispatch_queue_records(daemon_dir).expect("dispatch queue must read");
        assert_eq!(dispatch_records, vec![outcome.dispatch_record.clone()]);
        assert_eq!(dispatch_records[0].status, DispatchQueueStatus::Queued);

        let digest = outcome
            .dispatch_id
            .strip_prefix("inbound-")
            .expect("dispatch id must carry the inbound prefix");
        let identity = RalJournalIdentity {
            project_id: project_id.to_string(),
            agent_pubkey: agent_pubkey.to_string(),
            conversation_id: conversation_id.to_string(),
            ral_number: 1,
        };
        let expected_allocation_record = RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            writer_version,
            1,
            timestamp,
            format!("inbound-dispatch-{digest}"),
            RalJournalEvent::Allocated {
                identity: identity.clone(),
                triggering_event_id: Some(outcome.triggering_event_id.clone()),
            },
        );
        let expected_claim_record = RalJournalRecord::new(
            RAL_JOURNAL_WRITER_RUST_DAEMON,
            writer_version,
            2,
            timestamp,
            format!("inbound-dispatch-{digest}"),
            RalJournalEvent::Claimed {
                identity,
                worker_id: outcome.worker_id.clone(),
                claim_token: outcome.claim_token.clone(),
            },
        );
        let journal_records = read_ral_journal_records(daemon_dir).expect("RAL journal must read");
        assert_eq!(
            journal_records,
            vec![expected_allocation_record, expected_claim_record]
        );

        let dispatch = replay_dispatch_queue(daemon_dir).expect("dispatch queue must replay");
        assert_eq!(dispatch.queued.len(), 1);
        assert_eq!(dispatch.queued[0].dispatch_id, outcome.dispatch_id);
        assert_eq!(dispatch.queued[0].status, DispatchQueueStatus::Queued);

        let ral = replay_ral_journal(daemon_dir).expect("RAL journal must replay");
        let entry = ral
            .states
            .values()
            .next()
            .expect("RAL entry must be present");
        assert_eq!(entry.status, RalReplayStatus::Claimed);
        assert_eq!(
            entry.triggering_event_id.as_deref(),
            Some(outcome.triggering_event_id.as_str())
        );
        assert_eq!(entry.worker_id.as_deref(), Some(outcome.worker_id.as_str()));
        assert_eq!(
            entry.active_claim_token.as_deref(),
            Some(outcome.claim_token.as_str())
        );
    }

    #[test]
    fn concurrent_ingress_and_completion_appends_produce_unique_sequences() {
        use crate::ral_journal::append_ral_journal_record_with_resequence;
        use std::collections::HashSet;
        use std::sync::Arc;
        use std::thread;

        let daemon_dir = Arc::new(unique_temp_dir("inbound-dispatch-concurrency"));
        fs::create_dir_all(daemon_dir.as_path()).expect("daemon dir must be created");

        const INGRESS_ITERATIONS: usize = 20;
        const COMPLETION_ITERATIONS: usize = 20;

        let metadata_path = Arc::new(daemon_dir.join("project"));
        fs::create_dir_all(metadata_path.as_path()).expect("metadata path must create");
        let ingress_daemon_dir = Arc::clone(&daemon_dir);
        let ingress_metadata_path = Arc::clone(&metadata_path);
        let ingress = thread::spawn(move || {
            for iteration in 0..INGRESS_ITERATIONS {
                let mut envelope = nostr_envelope();
                let event_id = format!("event-ingress-{iteration}");
                envelope.message.id = format!("nostr:{event_id}");
                envelope.message.native_id = event_id.clone();
                envelope.channel.id = format!("nostr:conversation:{event_id}");
                let conversation_id = format!("conversation-ingress-{iteration}");
                enqueue_inbound_dispatch(InboundDispatchEnqueueInput {
                    daemon_dir: ingress_daemon_dir.as_path(),
                    project: InboundDispatchProject {
                        project_id: "TENEX-concurrency",
                        project_base_path: "/repo/concurrency",
                        metadata_path: ingress_metadata_path
                            .to_str()
                            .expect("metadata path must be utf8"),
                    },
                    route: InboundDispatchRoute {
                        agent_pubkey: "agent-pubkey",
                        conversation_id: &conversation_id,
                    },
                    envelope: &envelope,
                    timestamp: 1_710_000_000_000 + iteration as u64,
                    writer_version: "inbound-dispatch-concurrency@0",
                })
                .expect("ingress enqueue must succeed");
            }
        });

        let completion_daemon_dir = Arc::clone(&daemon_dir);
        let completion = thread::spawn(move || {
            for iteration in 0..COMPLETION_ITERATIONS {
                let identity = RalJournalIdentity {
                    project_id: "TENEX-concurrency".to_string(),
                    agent_pubkey: "agent-pubkey".to_string(),
                    conversation_id: format!("conversation-completion-{iteration}"),
                    ral_number: 1,
                };
                let mut record = RalJournalRecord::new(
                    RAL_JOURNAL_WRITER_RUST_DAEMON,
                    "inbound-dispatch-concurrency@0",
                    1,
                    1_710_000_500_000 + iteration as u64,
                    format!("completion-{iteration}"),
                    RalJournalEvent::Completed {
                        identity,
                        worker_id: format!("worker-completion-{iteration}"),
                        claim_token: format!("claim-completion-{iteration}"),
                        terminal: terminal_summary(),
                    },
                );
                append_ral_journal_record_with_resequence(
                    completion_daemon_dir.as_path(),
                    &mut record,
                )
                .expect("completion append must succeed");
            }
        });

        ingress.join().expect("ingress thread must join");
        completion.join().expect("completion thread must join");

        let journal = read_ral_journal_records(daemon_dir.as_path())
            .expect("journal must read after concurrent writes");
        let expected_len = INGRESS_ITERATIONS * 2 + COMPLETION_ITERATIONS;
        assert_eq!(
            journal.len(),
            expected_len,
            "journal should contain every concurrent write"
        );
        let mut sequences: HashSet<u64> = HashSet::with_capacity(expected_len);
        for record in &journal {
            assert!(
                sequences.insert(record.sequence),
                "duplicate journal sequence {}",
                record.sequence
            );
        }
        let max_sequence = *sequences.iter().max().expect("sequences must not be empty");
        assert_eq!(max_sequence, expected_len as u64);

        if daemon_dir.exists() {
            fs::remove_dir_all(daemon_dir.as_path()).expect("temp dir cleanup must succeed");
        }
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }
}
