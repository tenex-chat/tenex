use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::dispatch_queue::{
    DispatchQueueError, DispatchQueueRecord, DispatchQueueStatus, append_dispatch_queue_record,
    replay_dispatch_queue,
};
use crate::inbound_envelope::{InboundEnvelope, RuntimeTransport};
use crate::ral_journal::{RalJournalError, append_ral_journal_record};
use crate::ral_scheduler::{
    RalDispatchPreparation, RalDispatchPreparationInput, RalNamespace, RalScheduler,
    RalSchedulerError,
};
use crate::worker_dispatch_input::{
    WorkerDispatchExecuteFields, WorkerDispatchInput, WorkerDispatchInputError,
    WorkerDispatchInputFromExecuteFields, WorkerDispatchInputSourceType,
    WorkerDispatchInputWriterMetadata, worker_dispatch_input_path, write_create_or_compare_equal,
};
use crate::worker_protocol::AgentWorkerExecutionFlags;

const INBOUND_DISPATCH_DIGEST_DOMAIN: &[u8] = b"tenex-inbound-dispatch-v1";
const INBOUND_WORKER_ID_PREFIX: &str = "inbound-worker";
const INBOUND_CLAIM_TOKEN_PREFIX: &str = "inbound-claim";
const INBOUND_DISPATCH_ID_PREFIX: &str = "inbound";

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
                    debug: false,
                },
            },
            source_metadata: Some(source_metadata(input.envelope)),
        });
    write_create_or_compare_equal(input.daemon_dir, &sidecar_input)?;

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
    let preparation = scheduler.plan_dispatch_preparation(RalDispatchPreparationInput {
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
    append_dispatch_preparation(input.daemon_dir, &preparation)?;

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

fn append_dispatch_preparation(
    daemon_dir: &Path,
    preparation: &RalDispatchPreparation,
) -> Result<(), InboundDispatchEnqueueError> {
    append_ral_journal_record(daemon_dir, &preparation.allocation_record)?;
    append_ral_journal_record(daemon_dir, &preparation.claim_record)?;
    append_dispatch_queue_record(daemon_dir, &preparation.dispatch_record)?;
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
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalJournalEvent, RalJournalIdentity, RalJournalRecord,
        RalReplayStatus, read_ral_journal_records, replay_ral_journal,
    };
    use crate::worker_dispatch_input::read_optional as read_worker_dispatch_input;
    use serde_json::{Value, json};
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn enqueue_inbound_nostr_dispatch_writes_worker_runtime_artifacts() {
        let daemon_dir = unique_temp_dir("inbound-dispatch-nostr");
        let envelope = nostr_envelope();

        let outcome = enqueue_inbound_dispatch(InboundDispatchEnqueueInput {
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
            1_710_000_700_000,
            "inbound-dispatch-test@0",
        );

        if daemon_dir.exists() {
            fs::remove_dir_all(daemon_dir).expect("temp dir cleanup must succeed");
        }
    }

    #[test]
    fn enqueue_inbound_telegram_dispatch_writes_worker_runtime_artifacts() {
        let daemon_dir = unique_temp_dir("inbound-dispatch-telegram");
        let envelope = telegram_envelope();

        let outcome = enqueue_inbound_dispatch(InboundDispatchEnqueueInput {
            daemon_dir: &daemon_dir,
            project: InboundDispatchProject {
                project_id: "TENEX-demo",
                project_base_path: "/repo/demo",
                metadata_path: "/repo/demo/.tenex/project.json",
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
        let envelope = nostr_envelope();
        let input = InboundDispatchEnqueueInput {
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
        assert_eq!(fields.metadata_path, "/repo/demo/.tenex/project.json");
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

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }
}
