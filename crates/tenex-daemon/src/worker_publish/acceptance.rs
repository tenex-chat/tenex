use std::path::Path;

use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

use crate::nostr_event::SignedNostrEvent;
use crate::publish_outbox::{
    PublishOutboxError, PublishOutboxRecord, accept_worker_publish_request,
    build_accepted_publish_result,
};
use crate::telegram_outbox::TelegramOutboxRecord;
use crate::worker_protocol::{
    AgentWorkerPublishResultMessageInput, AgentWorkerPublishResultStatus,
    build_agent_worker_publish_result_message,
};
use crate::worker_telegram_egress::{
    WorkerEgressRoute, WorkerEgressRouteError, WorkerTelegramEgressContext,
    WorkerTelegramEgressError, WorkerTelegramEgressInput, accept_worker_telegram_egress,
    classify_worker_egress_route,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerPublishAcceptanceInput<'a> {
    pub daemon_dir: &'a Path,
    pub message: &'a Value,
    pub accepted_at: u64,
    pub result_sequence: u64,
    pub result_timestamp: u64,
    pub telegram_egress: Option<WorkerTelegramEgressContext<'a>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerPublishAcceptance {
    pub egress: WorkerPublishAcceptedEgress,
    pub publish_result: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerPublishAcceptedEgress {
    Nostr(PublishOutboxRecord),
    Telegram(Box<TelegramOutboxRecord>),
}

impl WorkerPublishAcceptedEgress {
    pub fn as_nostr(&self) -> Option<&PublishOutboxRecord> {
        match self {
            Self::Nostr(record) => Some(record),
            Self::Telegram(_) => None,
        }
    }

    pub fn event_id(&self) -> &str {
        match self {
            Self::Nostr(record) => &record.event.id,
            Self::Telegram(record) => &record.nostr_event_id,
        }
    }
}

#[derive(Debug, Error)]
pub enum WorkerPublishError {
    #[error("worker publish field is missing or invalid: {0}")]
    InvalidField(&'static str),
    #[error("publish outbox acceptance failed: {0}")]
    Outbox(#[from] PublishOutboxError),
    #[error("worker egress routing failed: {0}")]
    Route(#[from] WorkerEgressRouteError),
    #[error("telegram egress context is required for telegram-targeted publish_request")]
    MissingTelegramEgressContext,
    #[error("telegram egress acceptance failed: {0}")]
    TelegramEgress(#[from] WorkerTelegramEgressError),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerPublishRoutingRequest {
    correlation_id: String,
    sequence: u64,
    request_id: String,
    event: SignedNostrEvent,
}

pub fn accept_worker_publish_and_build_result(
    input: WorkerPublishAcceptanceInput<'_>,
) -> Result<WorkerPublishAcceptance, WorkerPublishError> {
    let request: WorkerPublishRoutingRequest = serde_json::from_value(input.message.clone())
        .map_err(|_| WorkerPublishError::InvalidField("publish_request"))?;
    let request_sequence = request.sequence;

    let (egress, publish_result) = match classify_worker_egress_route(&request.event)? {
        WorkerEgressRoute::Nostr => {
            let record =
                accept_worker_publish_request(input.daemon_dir, input.message, input.accepted_at)?;
            let publish_result = build_accepted_publish_result(
                &record,
                input.result_sequence,
                input.result_timestamp,
            );
            (WorkerPublishAcceptedEgress::Nostr(record), publish_result)
        }
        WorkerEgressRoute::Telegram => {
            let context = input
                .telegram_egress
                .ok_or(WorkerPublishError::MissingTelegramEgressContext)?;
            let record = accept_worker_telegram_egress(WorkerTelegramEgressInput {
                daemon_dir: input.daemon_dir,
                message: input.message,
                context,
                accepted_at: input.accepted_at,
            })?;
            let publish_result =
                build_agent_worker_publish_result_message(AgentWorkerPublishResultMessageInput {
                    correlation_id: request.correlation_id,
                    sequence: input.result_sequence,
                    timestamp: input.result_timestamp,
                    request_id: request.request_id,
                    request_sequence,
                    status: AgentWorkerPublishResultStatus::Accepted,
                    event_ids: vec![request.event.id],
                    error: None,
                })
                .expect("accepted telegram egress publish_result must satisfy worker protocol");
            (
                WorkerPublishAcceptedEgress::Telegram(Box::new(record)),
                publish_result,
            )
        }
    };

    Ok(WorkerPublishAcceptance {
        egress,
        publish_result,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr_event::{
        Nip01EventFixture, NormalizedNostrEvent, canonical_payload, event_hash_hex,
    };
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use crate::telegram::bindings::{RuntimeTransport, write_transport_binding};
    use crate::telegram_outbox::{TelegramDeliveryPayload, read_pending_telegram_outbox_record};
    use crate::worker_protocol::{
        AGENT_WORKER_PROTOCOL_VERSION, WorkerProtocolDirection,
        validate_agent_worker_protocol_message,
    };
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const STREAM_TEXT_DELTA_FIXTURE: &str =
        include_str!("../../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json");
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn accepts_worker_publish_request_and_builds_correlated_result() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let message = publish_request_message(&fixture, 41, 1710001000000);

        let accepted = accept_worker_publish_and_build_result(WorkerPublishAcceptanceInput {
            daemon_dir: &daemon_dir,
            message: &message,
            accepted_at: 1710001000100,
            result_sequence: 900,
            result_timestamp: 1710001000200,
            telegram_egress: None,
        })
        .expect("publish request must accept");
        let record = accepted
            .egress
            .as_nostr()
            .expect("default worker publish must route to Nostr");

        assert_eq!(record.request.request_sequence, 41);
        assert_eq!(record.request.correlation_id, "rust_worker_publish");
        assert_eq!(record.event.id, fixture.signed.id);
        assert_eq!(accepted.publish_result["type"], "publish_result");
        assert_eq!(
            accepted.publish_result["correlationId"],
            "rust_worker_publish"
        );
        assert_eq!(accepted.publish_result["sequence"], 900);
        assert_eq!(accepted.publish_result["timestamp"], 1710001000200_u64);
        assert_eq!(accepted.publish_result["requestId"], "publish-fixture-01");
        assert_eq!(accepted.publish_result["requestSequence"], 41);
        assert_eq!(accepted.publish_result["status"], "accepted");
        assert_eq!(
            accepted.publish_result["eventIds"],
            json!([fixture.signed.id])
        );
        assert_eq!(
            validate_agent_worker_protocol_message(&accepted.publish_result)
                .expect("publish_result must validate"),
            WorkerProtocolDirection::DaemonToWorker
        );

        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &record.event.id)
                .expect("pending record read must succeed")
                .is_some()
        );
        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn duplicate_publish_request_returns_existing_pending_record_and_result() {
        let daemon_dir = unique_temp_daemon_dir();
        let fixture = signed_event_fixture();
        let message = publish_request_message(&fixture, 41, 1710001000000);

        let first = accept_worker_publish_and_build_result(WorkerPublishAcceptanceInput {
            daemon_dir: &daemon_dir,
            message: &message,
            accepted_at: 1710001000100,
            result_sequence: 900,
            result_timestamp: 1710001000200,
            telegram_egress: None,
        })
        .expect("first publish request must accept");
        let duplicate = accept_worker_publish_and_build_result(WorkerPublishAcceptanceInput {
            daemon_dir: &daemon_dir,
            message: &message,
            accepted_at: 1710001000300,
            result_sequence: 901,
            result_timestamp: 1710001000400,
            telegram_egress: None,
        })
        .expect("duplicate publish request must accept idempotently");

        assert_eq!(duplicate.egress, first.egress);
        assert_eq!(duplicate.publish_result["sequence"], 901);
        assert_eq!(
            duplicate.publish_result["eventIds"],
            first.publish_result["eventIds"]
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
    }

    #[test]
    fn accepts_telegram_egress_without_persisting_relay_publish_outbox() {
        let daemon_dir = unique_temp_daemon_dir();
        let data_dir = daemon_dir.join("data");
        let fixture = signed_event_fixture();
        let owner_pubkey = "b".repeat(64);
        let channel_id = "telegram:group:-1001:topic:77";
        let event = signed_event_from_fixture_secret(
            &fixture,
            vec![
                vec![
                    "e".to_string(),
                    "root-event-id".to_string(),
                    "".to_string(),
                    "root".to_string(),
                ],
                vec![
                    "a".to_string(),
                    format!("31933:{owner_pubkey}:project-alpha"),
                ],
                vec!["tenex:egress".to_string(), "telegram".to_string()],
                vec!["tenex:channel".to_string(), channel_id.to_string()],
            ],
            "proactive update from the agent",
            1_710_001_001,
        );
        write_transport_binding(
            &data_dir,
            RuntimeTransport::Telegram,
            &event.pubkey,
            channel_id,
            "project-alpha",
            1_710_001_000_000,
        )
        .expect("transport binding must write");

        let mut message = publish_request_message(&fixture, 41, 1_710_001_000_000);
        message["agentPubkey"] = json!(event.pubkey);
        message["event"] = json!(event);

        let accepted = accept_worker_publish_and_build_result(WorkerPublishAcceptanceInput {
            daemon_dir: &daemon_dir,
            message: &message,
            accepted_at: 1_710_001_000_100,
            result_sequence: 900,
            result_timestamp: 1_710_001_000_200,
            telegram_egress: Some(WorkerTelegramEgressContext {
                data_dir: &data_dir,
                backend_pubkey: &owner_pubkey,
                writer_version: "test-version",
            }),
        })
        .expect("telegram egress publish request must accept");

        let record = match &accepted.egress {
            WorkerPublishAcceptedEgress::Telegram(record) => record,
            other => panic!("expected telegram egress, got {other:?}"),
        };
        assert_eq!(
            record.nostr_event_id,
            message["event"]["id"]
                .as_str()
                .expect("event id must be present")
        );
        assert_eq!(record.channel_binding.chat_id, -1001);
        assert_eq!(record.channel_binding.message_thread_id, Some(77));
        assert_eq!(record.project_binding.project_d_tag, "project-alpha");
        match &record.payload {
            TelegramDeliveryPayload::HtmlText { html } => {
                assert!(html.contains("proactive update from the agent"));
            }
            other => panic!("expected html telegram payload, got {other:?}"),
        }
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, record.nostr_event_id.as_str())
                .expect("pending relay publish read must succeed")
                .is_none()
        );
        assert!(
            read_pending_telegram_outbox_record(&daemon_dir, &record.record_id)
                .expect("pending telegram outbox read must succeed")
                .is_some()
        );
        assert_eq!(accepted.publish_result["status"], "accepted");
        assert_eq!(
            accepted.publish_result["eventIds"],
            json!([record.nostr_event_id])
        );

        fs::remove_dir_all(daemon_dir).expect("temp daemon dir cleanup must succeed");
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
            "ralNumber": 7,
            "requestId": "publish-fixture-01",
            "waitForRelayOk": true,
            "timeoutMs": 30000,
            "runtimeEventClass": "complete",
            "event": fixture.signed,
        })
    }

    fn signed_event_fixture() -> Nip01EventFixture {
        serde_json::from_str(STREAM_TEXT_DELTA_FIXTURE).expect("fixture must parse")
    }

    fn signed_event_from_fixture_secret(
        fixture: &Nip01EventFixture,
        tags: Vec<Vec<String>>,
        content: &str,
        created_at: u64,
    ) -> SignedNostrEvent {
        let secret_bytes: [u8; 32] = hex::decode(&fixture.secret_key_hex)
            .expect("fixture secret must decode")
            .try_into()
            .expect("fixture secret must be 32 bytes");
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid fixture secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let normalized = NormalizedNostrEvent {
            kind: 1,
            content: content.to_string(),
            tags,
            pubkey: Some(fixture.pubkey.clone()),
            created_at: Some(created_at),
        };
        let canonical = canonical_payload(&normalized).expect("canonical payload must serialize");
        let id = event_hash_hex(&canonical);
        let digest: [u8; 32] = hex::decode(&id)
            .expect("event id must decode")
            .try_into()
            .expect("event id must be 32 bytes");
        let sig = secp.sign_schnorr_no_aux_rand(&digest, &keypair);

        SignedNostrEvent {
            id,
            pubkey: fixture.pubkey.clone(),
            created_at,
            kind: normalized.kind,
            tags: normalized.tags,
            content: normalized.content,
            sig: hex::encode(sig.to_byte_array()),
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tenex-worker-publish-test-{nanos}-{counter}"))
    }
}
