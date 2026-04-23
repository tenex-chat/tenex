use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use thiserror::Error;

use crate::backend_config::Nip46Config;
use crate::nip46::client::SignError;
use crate::nip46::registry::{NIP46Registry, RegistryError};
use crate::publish_outbox::{
    BackendPublishOutboxInput, PublishOutboxError, PublishOutboxRecord,
    accept_backend_signed_publish_event,
};
use crate::worker_dispatch_execution::WorkerDispatchSession;
use crate::worker_protocol::AGENT_WORKER_PROTOCOL_VERSION;

#[derive(Debug)]
pub struct WorkerNip46PublishFlowInput<'a> {
    pub daemon_dir: &'a Path,
    pub registry: Arc<NIP46Registry>,
    pub nip46_config: &'a Nip46Config,
    pub default_relay: &'a str,
    pub message: &'a Value,
    pub accepted_at: u64,
    pub result_sequence: u64,
    pub result_timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerNip46PublishFlowOutcome {
    pub status: WorkerNip46PublishOutcomeStatus,
    pub publish_result: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerNip46PublishOutcomeStatus {
    Accepted { record: Box<PublishOutboxRecord> },
    Rejected { reason: String },
    Failed { reason: String },
}

#[derive(Debug, Error)]
pub enum WorkerNip46PublishFlowError {
    #[error("nip46 publish field is missing or invalid: {0}")]
    InvalidField(&'static str),
    #[error("nip46 publish unsigned event missing field: {0}")]
    MissingUnsignedField(&'static str),
    #[error("nip46 publish unsigned event field invalid: {0}")]
    InvalidUnsignedField(&'static str),
    #[error("nip46 publish JSON build failed: {0}")]
    JsonBuild(serde_json::Error),
    #[error("nip46 publish outbox acceptance failed: {0}")]
    Outbox(#[from] PublishOutboxError),
    #[error("nip46 publish_result send failed: {source}")]
    SendPublishResult {
        outcome: Box<WorkerNip46PublishFlowOutcome>,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
}

pub fn handle_worker_nip46_publish_request<S>(
    session: &mut S,
    input: WorkerNip46PublishFlowInput<'_>,
) -> Result<WorkerNip46PublishFlowOutcome, WorkerNip46PublishFlowError>
where
    S: WorkerDispatchSession,
{
    let outcome = build_outcome(&input)?;

    if let Err(source) = session.send_worker_message(&outcome.publish_result) {
        return Err(WorkerNip46PublishFlowError::SendPublishResult {
            outcome: Box::new(outcome),
            source: Box::new(source),
        });
    }

    Ok(outcome)
}

fn build_outcome(
    input: &WorkerNip46PublishFlowInput<'_>,
) -> Result<WorkerNip46PublishFlowOutcome, WorkerNip46PublishFlowError> {
    let parsed = parse_request(input.message)?;

    let client = match input.registry.client_for_owner(
        &parsed.owner_pubkey,
        input.nip46_config,
        input.default_relay,
    ) {
        Ok(client) => client,
        Err(error) => {
            let reason = error.to_string();
            return Ok(failed_outcome(input, &parsed, reason, &error));
        }
    };

    let unsigned_json =
        build_unsigned_json(&parsed).map_err(WorkerNip46PublishFlowError::JsonBuild)?;

    let signed = match client.sign_event_json(&unsigned_json) {
        Ok(signed) => signed,
        Err(error) => {
            let reason = error.to_string();
            return Ok(failed_outcome_for_sign(input, &parsed, reason, error));
        }
    };

    let outbox_input = BackendPublishOutboxInput {
        request_id: parsed.request_id.clone(),
        request_sequence: parsed.sequence,
        request_timestamp: parsed.timestamp,
        correlation_id: parsed.correlation_id.clone(),
        project_id: parsed.project_id.clone(),
        conversation_id: parsed.conversation_id.clone(),
        publisher_pubkey: parsed.owner_pubkey.clone(),
        ral_number: parsed.ral_number,
        wait_for_relay_ok: parsed.wait_for_relay_ok,
        timeout_ms: parsed.timeout_ms,
        event: signed,
    };

    let record =
        accept_backend_signed_publish_event(input.daemon_dir, outbox_input, input.accepted_at)?;

    let publish_result = build_accepted_result(input, &parsed, &record.event.id);
    Ok(WorkerNip46PublishFlowOutcome {
        status: WorkerNip46PublishOutcomeStatus::Accepted {
            record: Box::new(record),
        },
        publish_result,
    })
}

fn failed_outcome(
    input: &WorkerNip46PublishFlowInput<'_>,
    parsed: &Nip46PublishRequest,
    reason: String,
    error: &RegistryError,
) -> WorkerNip46PublishFlowOutcome {
    tracing::warn!(
        request_id = %parsed.request_id,
        owner = %parsed.owner_pubkey,
        error = %error,
        "nip46_publish_request rejected at registry resolution"
    );
    let publish_result = build_failure_result(input, parsed, "failed", &reason);
    WorkerNip46PublishFlowOutcome {
        status: WorkerNip46PublishOutcomeStatus::Failed { reason },
        publish_result,
    }
}

fn failed_outcome_for_sign(
    input: &WorkerNip46PublishFlowInput<'_>,
    parsed: &Nip46PublishRequest,
    reason: String,
    error: SignError,
) -> WorkerNip46PublishFlowOutcome {
    let status = sign_error_to_status(&error);
    tracing::warn!(
        request_id = %parsed.request_id,
        owner = %parsed.owner_pubkey,
        status,
        error = %error,
        "nip46_publish_request signing did not succeed"
    );
    let publish_result = build_failure_result(input, parsed, status, &reason);
    let status_value = match status {
        "rejected" => WorkerNip46PublishOutcomeStatus::Rejected {
            reason: reason.clone(),
        },
        _ => WorkerNip46PublishOutcomeStatus::Failed {
            reason: reason.clone(),
        },
    };
    WorkerNip46PublishFlowOutcome {
        status: status_value,
        publish_result,
    }
}

fn sign_error_to_status(error: &SignError) -> &'static str {
    match error {
        SignError::Rejected(_) => "rejected",
        SignError::Timeout
        | SignError::InvalidSignedEvent(_)
        | SignError::Crypto(_)
        | SignError::Protocol(_)
        | SignError::Outbox(_)
        | SignError::InvalidOwnerPubkey(_) => "failed",
    }
}

fn build_accepted_result(
    input: &WorkerNip46PublishFlowInput<'_>,
    parsed: &Nip46PublishRequest,
    event_id: &str,
) -> Value {
    json!({
        "version": AGENT_WORKER_PROTOCOL_VERSION,
        "type": "nip46_publish_result",
        "correlationId": parsed.correlation_id,
        "sequence": input.result_sequence,
        "timestamp": input.result_timestamp,
        "projectId": parsed.project_id,
        "agentPubkey": parsed.agent_pubkey,
        "conversationId": parsed.conversation_id,
        "ralNumber": parsed.ral_number,
        "requestId": parsed.request_id,
        "status": "accepted",
        "eventId": event_id,
    })
}

fn build_failure_result(
    input: &WorkerNip46PublishFlowInput<'_>,
    parsed: &Nip46PublishRequest,
    status: &str,
    reason: &str,
) -> Value {
    json!({
        "version": AGENT_WORKER_PROTOCOL_VERSION,
        "type": "nip46_publish_result",
        "correlationId": parsed.correlation_id,
        "sequence": input.result_sequence,
        "timestamp": input.result_timestamp,
        "projectId": parsed.project_id,
        "agentPubkey": parsed.agent_pubkey,
        "conversationId": parsed.conversation_id,
        "ralNumber": parsed.ral_number,
        "requestId": parsed.request_id,
        "status": status,
        "reason": reason,
    })
}

fn build_unsigned_json(parsed: &Nip46PublishRequest) -> Result<String, serde_json::Error> {
    let created_at = parsed.created_at.unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_secs()
    });

    let mut object = serde_json::Map::new();
    object.insert("kind".to_string(), Value::from(parsed.kind));
    object.insert("content".to_string(), Value::from(parsed.content.clone()));
    object.insert("tags".to_string(), Value::from(parsed.tags.clone()));
    object.insert(
        "pubkey".to_string(),
        Value::from(parsed.owner_pubkey.clone()),
    );
    object.insert("created_at".to_string(), Value::from(created_at));
    if let Some(explanation) = &parsed.tenex_explanation {
        object.insert(
            "tenex_explanation".to_string(),
            Value::from(explanation.clone()),
        );
    }

    serde_json::to_string(&Value::Object(object))
}

fn parse_request(message: &Value) -> Result<Nip46PublishRequest, WorkerNip46PublishFlowError> {
    let object = message
        .as_object()
        .ok_or(WorkerNip46PublishFlowError::InvalidField("message"))?;

    let unsigned = object
        .get("unsignedEvent")
        .and_then(Value::as_object)
        .ok_or(WorkerNip46PublishFlowError::InvalidField("unsignedEvent"))?;

    let kind = unsigned
        .get("kind")
        .and_then(Value::as_u64)
        .ok_or(WorkerNip46PublishFlowError::MissingUnsignedField("kind"))?;
    let content = unsigned
        .get("content")
        .and_then(Value::as_str)
        .ok_or(WorkerNip46PublishFlowError::InvalidUnsignedField("content"))?
        .to_string();

    let tags_value = unsigned
        .get("tags")
        .and_then(Value::as_array)
        .ok_or(WorkerNip46PublishFlowError::InvalidUnsignedField("tags"))?;
    let mut tags: Vec<Vec<String>> = Vec::with_capacity(tags_value.len());
    for tag in tags_value {
        let tag_array = tag
            .as_array()
            .ok_or(WorkerNip46PublishFlowError::InvalidUnsignedField("tags"))?;
        let mut row: Vec<String> = Vec::with_capacity(tag_array.len());
        for value in tag_array {
            row.push(
                value
                    .as_str()
                    .ok_or(WorkerNip46PublishFlowError::InvalidUnsignedField("tags"))?
                    .to_string(),
            );
        }
        tags.push(row);
    }

    let created_at = match unsigned.get("created_at") {
        None => None,
        Some(value) => Some(value.as_u64().ok_or(
            WorkerNip46PublishFlowError::InvalidUnsignedField("created_at"),
        )?),
    };

    let tenex_explanation = match object.get("tenexExplanation") {
        None => None,
        Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .ok_or(WorkerNip46PublishFlowError::InvalidField(
                    "tenexExplanation",
                ))?
                .to_string(),
        ),
    };

    Ok(Nip46PublishRequest {
        correlation_id: required_string(object, "correlationId")?,
        sequence: required_u64(object, "sequence")?,
        timestamp: required_u64(object, "timestamp")?,
        project_id: required_string(object, "projectId")?,
        agent_pubkey: required_string(object, "agentPubkey")?,
        conversation_id: required_string(object, "conversationId")?,
        ral_number: required_u64(object, "ralNumber")?,
        request_id: required_string(object, "requestId")?,
        owner_pubkey: required_string(object, "ownerPubkey")?,
        wait_for_relay_ok: object
            .get("waitForRelayOk")
            .and_then(Value::as_bool)
            .ok_or(WorkerNip46PublishFlowError::InvalidField("waitForRelayOk"))?,
        timeout_ms: object
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .ok_or(WorkerNip46PublishFlowError::InvalidField("timeoutMs"))?,
        kind,
        content,
        tags,
        created_at,
        tenex_explanation,
    })
}

fn required_string(
    object: &serde_json::Map<String, Value>,
    field: &'static str,
) -> Result<String, WorkerNip46PublishFlowError> {
    Ok(object
        .get(field)
        .and_then(Value::as_str)
        .ok_or(WorkerNip46PublishFlowError::InvalidField(field))?
        .to_string())
}

fn required_u64(
    object: &serde_json::Map<String, Value>,
    field: &'static str,
) -> Result<u64, WorkerNip46PublishFlowError> {
    object
        .get(field)
        .and_then(Value::as_u64)
        .ok_or(WorkerNip46PublishFlowError::InvalidField(field))
}

#[derive(Debug, Clone)]
struct Nip46PublishRequest {
    correlation_id: String,
    sequence: u64,
    timestamp: u64,
    project_id: String,
    agent_pubkey: String,
    conversation_id: String,
    ral_number: u64,
    request_id: String,
    owner_pubkey: String,
    wait_for_relay_ok: bool,
    timeout_ms: u64,
    kind: u64,
    content: String,
    tags: Vec<Vec<String>>,
    created_at: Option<u64>,
    tenex_explanation: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::OwnerNip46Config;
    use crate::backend_signer::HexBackendSigner;
    use crate::nip44;
    use crate::nip46::client::PublishOutboxHandle;
    use crate::nip46::pending::PendingNip46Requests;
    use crate::nip46::protocol::{Nip46Request, Nip46Response};
    use crate::nostr_event::{
        NormalizedNostrEvent, SignedNostrEvent, canonical_payload, event_hash_hex,
    };
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use secp256k1::{Keypair, PublicKey, Secp256k1, SecretKey};
    use std::collections::HashMap;
    use std::error::Error;
    use std::fmt;
    use std::str::FromStr;
    use std::sync::Mutex;
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    const BACKEND_SECRET_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const OWNER_SECRET_HEX: &str =
        "0202020202020202020202020202020202020202020202020202020202020202";

    #[derive(Debug, Default)]
    struct RecordingSession {
        sent_messages: Vec<Value>,
        send_error: Option<FakeSendError>,
    }

    impl WorkerDispatchSession for RecordingSession {
        type Error = FakeSendError;

        fn send_worker_message(&mut self, message: &Value) -> Result<(), Self::Error> {
            self.sent_messages.push(message.clone());
            if let Some(error) = self.send_error.clone() {
                return Err(error);
            }
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

    struct CaptureOutbox {
        captured: Mutex<Vec<(SignedNostrEvent, Vec<String>)>>,
    }

    impl CaptureOutbox {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                captured: Mutex::new(Vec::new()),
            })
        }

        fn captured(&self) -> Vec<(SignedNostrEvent, Vec<String>)> {
            self.captured.lock().unwrap().clone()
        }
    }

    impl PublishOutboxHandle for CaptureOutbox {
        fn enqueue(&self, event: SignedNostrEvent, relay_urls: Vec<String>) -> Result<(), String> {
            self.captured.lock().unwrap().push((event, relay_urls));
            Ok(())
        }
    }

    struct OwnerKeys {
        secret: SecretKey,
        keypair: Keypair,
        xonly_hex: String,
        secp: Secp256k1<secp256k1::All>,
    }

    impl OwnerKeys {
        fn from_secret_hex(hex_str: &str) -> Self {
            let secret = SecretKey::from_str(hex_str).expect("valid secret key");
            let secp = Secp256k1::new();
            let keypair = Keypair::from_secret_key(&secp, &secret);
            let (xonly, _) = keypair.x_only_public_key();
            Self {
                secret,
                keypair,
                xonly_hex: hex::encode(xonly.serialize()),
                secp,
            }
        }

        fn sign_unsigned_payload(&self, json_payload: &str) -> SignedNostrEvent {
            let raw: serde_json::Map<String, Value> =
                serde_json::from_str(json_payload).expect("payload json");
            let kind = raw["kind"].as_u64().expect("kind");
            let content = raw["content"].as_str().unwrap_or_default().to_string();
            let tags_value = raw["tags"].as_array().expect("tags");
            let tags: Vec<Vec<String>> = tags_value
                .iter()
                .map(|tag| {
                    tag.as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap().to_string())
                        .collect()
                })
                .collect();
            let created_at = raw["created_at"].as_u64().unwrap_or(1_700_000_000);
            let normalized = NormalizedNostrEvent {
                kind,
                content: content.clone(),
                tags: tags.clone(),
                pubkey: Some(self.xonly_hex.clone()),
                created_at: Some(created_at),
            };
            let canonical = canonical_payload(&normalized).expect("canonical");
            let id = event_hash_hex(&canonical);
            let digest: [u8; 32] = hex::decode(&id).unwrap().try_into().unwrap();
            let sig = self
                .secp
                .sign_schnorr_no_aux_rand(digest.as_slice(), &self.keypair);
            SignedNostrEvent {
                id,
                pubkey: self.xonly_hex.clone(),
                created_at,
                kind,
                tags,
                content,
                sig: hex::encode(sig.to_byte_array()),
            }
        }
    }

    fn backend_signer() -> Arc<HexBackendSigner> {
        Arc::new(
            HexBackendSigner::from_private_key_hex(BACKEND_SECRET_HEX)
                .expect("backend signer must load"),
        )
    }

    fn registry_with_outbox() -> (Arc<NIP46Registry>, Arc<CaptureOutbox>) {
        let outbox = CaptureOutbox::new();
        let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::clone(&outbox) as _;
        let registry = Arc::new(NIP46Registry::new(
            backend_signer(),
            PendingNip46Requests::default(),
            outbox_handle,
        ));
        (registry, outbox)
    }

    fn config_for(owner: &str) -> Nip46Config {
        let mut owners = HashMap::new();
        owners.insert(
            owner.to_string(),
            OwnerNip46Config {
                bunker_uri: Some(format!("bunker://{owner}?relay=wss://relay.test/")),
            },
        );
        Nip46Config {
            signing_timeout_ms: 2_000,
            max_retries: 0,
            owners,
        }
    }

    fn unique_temp_daemon_dir() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tenex-worker-nip46-{}-{nanos}", std::process::id()))
    }

    fn build_request_message(
        owner_pubkey: &str,
        agent_pubkey: &str,
        request_id: &str,
        explanation: Option<&str>,
    ) -> Value {
        let mut message = json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "nip46_publish_request",
            "correlationId": "nostr_publish_as_user:c-alpha",
            "sequence": 11_u64,
            "timestamp": 1_710_002_000_000_u64,
            "projectId": "project-alpha",
            "agentPubkey": agent_pubkey,
            "conversationId": "c-alpha",
            "ralNumber": 3_u64,
            "requestId": request_id,
            "ownerPubkey": owner_pubkey,
            "waitForRelayOk": true,
            "timeoutMs": 30_000_u64,
            "unsignedEvent": {
                "kind": 1_u64,
                "content": "hello world",
                "tags": [["t".to_string(), "tenex".to_string()]],
            },
        });
        if let Some(text) = explanation {
            message["tenexExplanation"] = Value::String(text.to_string());
        }
        message
    }

    fn decrypt_request(
        owner: &OwnerKeys,
        backend_pubkey: &str,
        captured: &SignedNostrEvent,
    ) -> Nip46Request {
        let backend_pk =
            PublicKey::from_str(&format!("02{backend_pubkey}")).expect("valid backend pk");
        let conversation_key =
            nip44::conversation_key(&owner.secret, &backend_pk).expect("conversation key");
        let plaintext =
            nip44::decrypt(&conversation_key, &captured.content).expect("decrypt ciphertext");
        serde_json::from_slice(&plaintext).expect("parse request")
    }

    fn encrypt_response(
        owner: &OwnerKeys,
        backend_pubkey: &str,
        response: &Nip46Response,
    ) -> String {
        let backend_pk =
            PublicKey::from_str(&format!("02{backend_pubkey}")).expect("valid backend pk");
        let conversation_key =
            nip44::conversation_key(&owner.secret, &backend_pk).expect("conversation key");
        let plaintext = serde_json::to_string(response).expect("serialize response");
        nip44::encrypt(&conversation_key, plaintext.as_bytes()).expect("encrypt response")
    }

    fn wait_for_captured(outbox: &CaptureOutbox, index: usize) -> SignedNostrEvent {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let captured = outbox.captured();
            if let Some(entry) = captured.get(index) {
                return entry.0.clone();
            }
            if Instant::now() >= deadline {
                panic!("timed out waiting for captured event at index {index}");
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn spawn_mock_bunker(
        registry: Arc<NIP46Registry>,
        owner_pubkey: String,
        config: Nip46Config,
        default_relay: String,
        backend_pubkey: String,
        outbox: Arc<CaptureOutbox>,
        verdict: BunkerVerdict,
    ) -> JoinHandle<()> {
        thread::spawn(move || {
            let owner_keys = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
            let client = registry
                .client_for_owner(&owner_pubkey, &config, &default_relay)
                .expect("client must build");

            // Connect.
            let connect_event = wait_for_captured(&outbox, 0);
            let connect_request = decrypt_request(&owner_keys, &backend_pubkey, &connect_event);
            assert_eq!(connect_request.method, "connect");
            let connect_response = Nip46Response {
                id: connect_request.id,
                result: Some("ack".to_string()),
                error: None,
            };
            let encrypted_connect =
                encrypt_response(&owner_keys, &backend_pubkey, &connect_response);
            client.dispatch_incoming(&encrypted_connect).unwrap();

            // Sign.
            let sign_event = wait_for_captured(&outbox, 1);
            let sign_request = decrypt_request(&owner_keys, &backend_pubkey, &sign_event);
            assert_eq!(sign_request.method, "sign_event");
            match verdict {
                BunkerVerdict::Approve { capture_payload } => {
                    if let Some(slot) = capture_payload {
                        *slot.lock().unwrap() = Some(sign_request.params[0].clone());
                    }
                    let signed = owner_keys.sign_unsigned_payload(&sign_request.params[0]);
                    let response = Nip46Response {
                        id: sign_request.id,
                        result: Some(serde_json::to_string(&signed).unwrap()),
                        error: None,
                    };
                    let encrypted = encrypt_response(&owner_keys, &backend_pubkey, &response);
                    client.dispatch_incoming(&encrypted).unwrap();
                }
                BunkerVerdict::Deny(reason) => {
                    let response = Nip46Response {
                        id: sign_request.id,
                        result: None,
                        error: Some(reason.to_string()),
                    };
                    let encrypted = encrypt_response(&owner_keys, &backend_pubkey, &response);
                    client.dispatch_incoming(&encrypted).unwrap();
                }
            }
        })
    }

    enum BunkerVerdict {
        Approve {
            capture_payload: Option<Arc<Mutex<Option<String>>>>,
        },
        Deny(&'static str),
    }

    #[test]
    fn accepted_outcome_persists_outbox_record_and_carries_explanation_to_bunker() {
        let daemon_dir = unique_temp_daemon_dir();
        std::fs::create_dir_all(&daemon_dir).expect("daemon dir create");

        let (registry, outbox) = registry_with_outbox();
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let backend_pubkey = backend_signer().pubkey_hex().to_string();
        let config = config_for(&owner.xonly_hex);
        let captured_payload: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let bunker = spawn_mock_bunker(
            Arc::clone(&registry),
            owner.xonly_hex.clone(),
            config.clone(),
            "wss://relay.test/".to_string(),
            backend_pubkey,
            Arc::clone(&outbox),
            BunkerVerdict::Approve {
                capture_payload: Some(Arc::clone(&captured_payload)),
            },
        );

        let agent_pubkey = "a".repeat(64);
        let message = build_request_message(
            &owner.xonly_hex,
            &agent_pubkey,
            "publish-1",
            Some("Please publish this comment"),
        );
        let mut session = RecordingSession::default();

        let outcome = handle_worker_nip46_publish_request(
            &mut session,
            WorkerNip46PublishFlowInput {
                daemon_dir: &daemon_dir,
                registry: Arc::clone(&registry),
                nip46_config: &config,
                default_relay: "wss://relay.test/",
                message: &message,
                accepted_at: 1_710_002_000_100,
                result_sequence: 901,
                result_timestamp: 1_710_002_000_200,
            },
        )
        .expect("flow must succeed");
        bunker.join().expect("bunker thread");

        let record = match outcome.status {
            WorkerNip46PublishOutcomeStatus::Accepted { record } => *record,
            other => panic!("expected Accepted, got {other:?}"),
        };
        assert_eq!(record.event.pubkey, owner.xonly_hex);
        assert_eq!(record.request.agent_pubkey, owner.xonly_hex);

        assert_eq!(session.sent_messages.len(), 1);
        let result_msg = &session.sent_messages[0];
        assert_eq!(result_msg["status"], "accepted");
        assert_eq!(result_msg["eventId"], record.event.id);
        assert_eq!(result_msg["requestId"], "publish-1");

        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &record.event.id)
                .expect("read pending must succeed")
                .is_some()
        );

        let payload = captured_payload
            .lock()
            .unwrap()
            .clone()
            .expect("bunker must have observed unsigned payload");
        let parsed: serde_json::Value = serde_json::from_str(&payload).expect("payload json");
        assert_eq!(
            parsed["tenex_explanation"].as_str(),
            Some("Please publish this comment")
        );
        assert_eq!(parsed["pubkey"], owner.xonly_hex);

        std::fs::remove_dir_all(&daemon_dir).ok();
    }

    #[test]
    fn registry_resolution_failure_returns_failed_status_without_outbox_record() {
        let daemon_dir = unique_temp_daemon_dir();
        std::fs::create_dir_all(&daemon_dir).expect("daemon dir create");

        let outbox = CaptureOutbox::new();
        let outbox_handle: Arc<dyn PublishOutboxHandle + Send + Sync> = Arc::clone(&outbox) as _;
        let registry = Arc::new(NIP46Registry::new(
            backend_signer(),
            PendingNip46Requests::default(),
            outbox_handle,
        ));
        let owner_pubkey = "b".repeat(64);
        let config = Nip46Config::default();

        let agent_pubkey = "a".repeat(64);
        let message = build_request_message(&owner_pubkey, &agent_pubkey, "publish-2", None);
        let mut session = RecordingSession::default();

        let outcome = handle_worker_nip46_publish_request(
            &mut session,
            WorkerNip46PublishFlowInput {
                daemon_dir: &daemon_dir,
                registry: Arc::clone(&registry),
                nip46_config: &config,
                default_relay: "",
                message: &message,
                accepted_at: 1_710_002_000_100,
                result_sequence: 901,
                result_timestamp: 1_710_002_000_200,
            },
        )
        .expect("flow must succeed in producing failure result");

        match outcome.status {
            WorkerNip46PublishOutcomeStatus::Failed { reason } => {
                assert!(reason.contains("no bunker uri"));
            }
            other => panic!("expected Failed, got {other:?}"),
        }
        assert_eq!(session.sent_messages.len(), 1);
        assert_eq!(session.sent_messages[0]["status"], "failed");
        assert!(outbox.captured().is_empty());

        std::fs::remove_dir_all(&daemon_dir).ok();
    }

    #[test]
    fn timeout_returns_failed_status_when_bunker_silent() {
        let daemon_dir = unique_temp_daemon_dir();
        std::fs::create_dir_all(&daemon_dir).expect("daemon dir create");

        let (registry, _outbox) = registry_with_outbox();
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let mut config = config_for(&owner.xonly_hex);
        config.signing_timeout_ms = 50;
        config.max_retries = 0;

        let agent_pubkey = "a".repeat(64);
        let message = build_request_message(&owner.xonly_hex, &agent_pubkey, "publish-3", None);
        let mut session = RecordingSession::default();

        let outcome = handle_worker_nip46_publish_request(
            &mut session,
            WorkerNip46PublishFlowInput {
                daemon_dir: &daemon_dir,
                registry: Arc::clone(&registry),
                nip46_config: &config,
                default_relay: "wss://relay.test/",
                message: &message,
                accepted_at: 1_710_002_000_100,
                result_sequence: 901,
                result_timestamp: 1_710_002_000_200,
            },
        )
        .expect("flow must produce failure result on timeout");

        match outcome.status {
            WorkerNip46PublishOutcomeStatus::Failed { reason } => {
                assert!(reason.contains("timed out"));
            }
            other => panic!("expected Failed timeout, got {other:?}"),
        }
        assert_eq!(session.sent_messages[0]["status"], "failed");

        std::fs::remove_dir_all(&daemon_dir).ok();
    }

    #[test]
    fn user_rejection_returns_rejected_status() {
        let daemon_dir = unique_temp_daemon_dir();
        std::fs::create_dir_all(&daemon_dir).expect("daemon dir create");

        let (registry, outbox) = registry_with_outbox();
        let owner = OwnerKeys::from_secret_hex(OWNER_SECRET_HEX);
        let backend_pubkey = backend_signer().pubkey_hex().to_string();
        let config = config_for(&owner.xonly_hex);

        let bunker = spawn_mock_bunker(
            Arc::clone(&registry),
            owner.xonly_hex.clone(),
            config.clone(),
            "wss://relay.test/".to_string(),
            backend_pubkey,
            Arc::clone(&outbox),
            BunkerVerdict::Deny("user rejected"),
        );

        let agent_pubkey = "a".repeat(64);
        let message = build_request_message(&owner.xonly_hex, &agent_pubkey, "publish-4", None);
        let mut session = RecordingSession::default();

        let outcome = handle_worker_nip46_publish_request(
            &mut session,
            WorkerNip46PublishFlowInput {
                daemon_dir: &daemon_dir,
                registry: Arc::clone(&registry),
                nip46_config: &config,
                default_relay: "wss://relay.test/",
                message: &message,
                accepted_at: 1_710_002_000_100,
                result_sequence: 901,
                result_timestamp: 1_710_002_000_200,
            },
        )
        .expect("flow must produce rejected result");
        bunker.join().expect("bunker thread");

        match outcome.status {
            WorkerNip46PublishOutcomeStatus::Rejected { reason } => {
                assert!(reason.contains("user rejected"));
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
        assert_eq!(session.sent_messages[0]["status"], "rejected");

        std::fs::remove_dir_all(&daemon_dir).ok();
    }
}
