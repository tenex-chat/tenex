use std::str::FromStr;

use secp256k1::XOnlyPublicKey;
use thiserror::Error;

use super::heartbeat::BackendSigner;
use crate::nostr_event::{
    NormalizedNostrEvent, NostrEventError, SignedNostrEvent, canonical_payload, event_hash_hex,
};

pub const OPERATIONS_STATUS_KIND: u64 = 24133;
pub const OPERATIONS_STATUS_MAX_WHITELISTED_PUBKEYS: usize = 1024;
pub const OPERATIONS_STATUS_MAX_AGENT_PUBKEYS: usize = 4096;

const PROJECT_REFERENCE_KIND: &str = "31933";

pub struct OperationsStatusInputs<'a> {
    pub created_at: u64,
    pub conversation_id: &'a str,
    pub whitelisted_pubkeys: &'a [String],
    pub agent_pubkeys: &'a [String],
    pub project_tag: &'a [String],
}

#[derive(Debug, Error)]
pub enum OperationsStatusEncodeError {
    #[error("operations-status conversation id is invalid: {reason}")]
    InvalidConversationId { reason: String },
    #[error("operations-status project tag must be an a-tag with a non-empty project reference")]
    InvalidProjectTag,
    #[error("operations-status project reference is invalid: {reason}")]
    InvalidProjectReference { reason: String },
    #[error("operations-status whitelisted pubkey at index {index} is invalid: {reason}")]
    InvalidWhitelistedPubkey { index: usize, reason: String },
    #[error("operations-status agent pubkey at index {index} is invalid: {reason}")]
    InvalidAgentPubkey { index: usize, reason: String },
    #[error("operations-status whitelisted pubkey count {count} exceeds maximum {max}")]
    TooManyWhitelistedPubkeys { count: usize, max: usize },
    #[error("operations-status agent pubkey count {count} exceeds maximum {max}")]
    TooManyAgentPubkeys { count: usize, max: usize },
    #[error("operations-status canonicalization failed: {0}")]
    Canonicalize(#[from] NostrEventError),
    #[error("operations-status signing failed: {0}")]
    Sign(#[from] secp256k1::Error),
}

pub fn encode_operations_status<S: BackendSigner>(
    inputs: &OperationsStatusInputs<'_>,
    signer: &S,
) -> Result<SignedNostrEvent, OperationsStatusEncodeError> {
    validate_inputs(inputs)?;

    let signer_pubkey = signer.xonly_pubkey_hex();
    let tags = operations_status_tags(inputs);
    let normalized = NormalizedNostrEvent {
        kind: OPERATIONS_STATUS_KIND,
        content: String::new(),
        tags: tags.clone(),
        pubkey: Some(signer_pubkey.clone()),
        created_at: Some(inputs.created_at),
    };

    let canonical = canonical_payload(&normalized)?;
    let id = event_hash_hex(&canonical);
    let digest = decode_event_id(&id)?;
    let sig = signer.sign_schnorr(&digest)?;

    Ok(SignedNostrEvent {
        id,
        pubkey: signer_pubkey,
        created_at: inputs.created_at,
        kind: OPERATIONS_STATUS_KIND,
        tags,
        content: String::new(),
        sig,
    })
}

fn validate_inputs(inputs: &OperationsStatusInputs<'_>) -> Result<(), OperationsStatusEncodeError> {
    validate_event_id_hex(inputs.conversation_id)?;
    validate_project_tag(inputs.project_tag)?;

    if inputs.whitelisted_pubkeys.len() > OPERATIONS_STATUS_MAX_WHITELISTED_PUBKEYS {
        return Err(OperationsStatusEncodeError::TooManyWhitelistedPubkeys {
            count: inputs.whitelisted_pubkeys.len(),
            max: OPERATIONS_STATUS_MAX_WHITELISTED_PUBKEYS,
        });
    }
    if inputs.agent_pubkeys.len() > OPERATIONS_STATUS_MAX_AGENT_PUBKEYS {
        return Err(OperationsStatusEncodeError::TooManyAgentPubkeys {
            count: inputs.agent_pubkeys.len(),
            max: OPERATIONS_STATUS_MAX_AGENT_PUBKEYS,
        });
    }

    for (index, pubkey) in inputs.whitelisted_pubkeys.iter().enumerate() {
        validate_xonly_pubkey_hex(pubkey).map_err(|err| {
            OperationsStatusEncodeError::InvalidWhitelistedPubkey {
                index,
                reason: err.to_string(),
            }
        })?;
    }

    for (index, pubkey) in inputs.agent_pubkeys.iter().enumerate() {
        validate_xonly_pubkey_hex(pubkey).map_err(|err| {
            OperationsStatusEncodeError::InvalidAgentPubkey {
                index,
                reason: err.to_string(),
            }
        })?;
    }

    Ok(())
}

fn operations_status_tags(inputs: &OperationsStatusInputs<'_>) -> Vec<Vec<String>> {
    let mut tags =
        Vec::with_capacity(2 + inputs.whitelisted_pubkeys.len() + inputs.agent_pubkeys.len());
    tags.push(vec!["e".to_string(), inputs.conversation_id.to_string()]);

    for pubkey in inputs.whitelisted_pubkeys {
        tags.push(vec!["P".to_string(), pubkey.clone()]);
    }

    for pubkey in inputs.agent_pubkeys {
        tags.push(vec!["p".to_string(), pubkey.clone()]);
    }

    tags.push(inputs.project_tag.to_vec());
    tags
}

fn validate_project_tag(project_tag: &[String]) -> Result<(), OperationsStatusEncodeError> {
    if project_tag.len() < 2
        || project_tag.first().map(String::as_str) != Some("a")
        || project_tag
            .get(1)
            .is_none_or(|reference| reference.is_empty())
    {
        return Err(OperationsStatusEncodeError::InvalidProjectTag);
    }

    validate_project_reference(&project_tag[1])
}

fn validate_project_reference(reference: &str) -> Result<(), OperationsStatusEncodeError> {
    let mut parts = reference.splitn(3, ':');
    let kind = parts.next().unwrap_or_default();
    let pubkey = parts.next().unwrap_or_default();
    let d_tag = parts.next().unwrap_or_default();

    if kind != PROJECT_REFERENCE_KIND || pubkey.is_empty() || d_tag.is_empty() {
        return Err(OperationsStatusEncodeError::InvalidProjectReference {
            reason: format!("expected {PROJECT_REFERENCE_KIND}:<pubkey>:<d-tag>"),
        });
    }

    validate_xonly_pubkey_hex(pubkey).map_err(|err| {
        OperationsStatusEncodeError::InvalidProjectReference {
            reason: err.to_string(),
        }
    })?;

    Ok(())
}

fn validate_event_id_hex(value: &str) -> Result<(), OperationsStatusEncodeError> {
    let bytes =
        hex::decode(value).map_err(|err| OperationsStatusEncodeError::InvalidConversationId {
            reason: err.to_string(),
        })?;
    if bytes.len() != 32 {
        return Err(OperationsStatusEncodeError::InvalidConversationId {
            reason: format!("expected 32 bytes, got {}", bytes.len()),
        });
    }
    Ok(())
}

fn validate_xonly_pubkey_hex(value: &str) -> Result<(), secp256k1::Error> {
    XOnlyPublicKey::from_str(value)?;
    Ok(())
}

fn decode_event_id(id_hex: &str) -> Result<[u8; 32], NostrEventError> {
    let bytes = hex::decode(id_hex)?;
    bytes
        .try_into()
        .map_err(|bytes: Vec<u8>| NostrEventError::InvalidDigestLength {
            field: "event id",
            actual: bytes.len(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr_event::verify_signed_event;
    use secp256k1::{Keypair, Secp256k1, SecretKey, Signing};

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    struct Secp256k1Signer<C: Signing> {
        secp: Secp256k1<C>,
        keypair: Keypair,
        xonly_hex: String,
    }

    impl<C: Signing> Secp256k1Signer<C> {
        fn new(secp: Secp256k1<C>, secret_hex: &str) -> Self {
            let secret = SecretKey::from_str(secret_hex).expect("valid secret key hex");
            let keypair = Keypair::from_secret_key(&secp, &secret);
            let (xonly, _) = keypair.x_only_public_key();
            let xonly_hex = hex::encode(xonly.serialize());
            Self {
                secp,
                keypair,
                xonly_hex,
            }
        }
    }

    impl<C: Signing> BackendSigner for Secp256k1Signer<C> {
        fn xonly_pubkey_hex(&self) -> String {
            self.xonly_hex.clone()
        }

        fn sign_schnorr(&self, digest: &[u8; 32]) -> Result<String, secp256k1::Error> {
            let sig = self
                .secp
                .sign_schnorr_no_aux_rand(digest.as_slice(), &self.keypair);
            Ok(hex::encode(sig.to_byte_array()))
        }
    }

    fn test_signer() -> Secp256k1Signer<secp256k1::All> {
        Secp256k1Signer::new(Secp256k1::new(), TEST_SECRET_KEY_HEX)
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn event_id_hex(fill_byte: u8) -> String {
        hex::encode([fill_byte; 32])
    }

    fn project_tag(owner_pubkey: &str) -> Vec<String> {
        vec![
            "a".to_string(),
            format!("{PROJECT_REFERENCE_KIND}:{owner_pubkey}:demo-project"),
        ]
    }

    #[test]
    fn encodes_operations_status_with_typescript_tag_order_and_valid_signature() {
        let signer = test_signer();
        let conversation_id = event_id_hex(0x09);
        let project_owner = pubkey_hex(0x02);
        let whitelisted = vec![pubkey_hex(0x03), pubkey_hex(0x04)];
        let agents = vec![pubkey_hex(0x05), pubkey_hex(0x06)];
        let project_tag = project_tag(&project_owner);
        let inputs = OperationsStatusInputs {
            created_at: 1_700_000_000,
            conversation_id: &conversation_id,
            whitelisted_pubkeys: &whitelisted,
            agent_pubkeys: &agents,
            project_tag: &project_tag,
        };

        let event =
            encode_operations_status(&inputs, &signer).expect("encode operations status event");

        assert_eq!(event.kind, OPERATIONS_STATUS_KIND);
        assert_eq!(event.content, "");
        assert_eq!(event.pubkey, signer.xonly_pubkey_hex());
        assert_eq!(event.created_at, 1_700_000_000);
        assert_eq!(
            event.tags,
            vec![
                vec!["e".to_string(), conversation_id.clone()],
                vec!["P".to_string(), whitelisted[0].clone()],
                vec!["P".to_string(), whitelisted[1].clone()],
                vec!["p".to_string(), agents[0].clone()],
                vec!["p".to_string(), agents[1].clone()],
                project_tag.clone(),
            ],
        );

        let expected_canonical = canonical_payload(&NormalizedNostrEvent {
            kind: event.kind,
            content: event.content.clone(),
            tags: event.tags.clone(),
            pubkey: Some(event.pubkey.clone()),
            created_at: Some(event.created_at),
        })
        .expect("canonical payload");
        assert_eq!(event.id, event_hash_hex(&expected_canonical));
        verify_signed_event(&event).expect("signature must verify");
    }

    #[test]
    fn encodes_cleanup_status_with_no_agent_p_tags() {
        let signer = test_signer();
        let conversation_id = event_id_hex(0x0a);
        let project_owner = pubkey_hex(0x02);
        let whitelisted = vec![pubkey_hex(0x03)];
        let agents: Vec<String> = Vec::new();
        let project_tag = project_tag(&project_owner);
        let inputs = OperationsStatusInputs {
            created_at: 1_700_000_001,
            conversation_id: &conversation_id,
            whitelisted_pubkeys: &whitelisted,
            agent_pubkeys: &agents,
            project_tag: &project_tag,
        };

        let event =
            encode_operations_status(&inputs, &signer).expect("encode cleanup status event");

        assert_eq!(
            event.tags,
            vec![
                vec!["e".to_string(), conversation_id.clone()],
                vec!["P".to_string(), whitelisted[0].clone()],
                project_tag.clone(),
            ],
        );
        assert!(event.tags.iter().all(|tag| tag[0] != "p"));
        assert_eq!(event.content, "");
        verify_signed_event(&event).expect("signature must verify");
    }

    #[test]
    fn canonical_payload_is_deterministic_for_fixed_inputs() {
        let signer = test_signer();
        let conversation_id = event_id_hex(0x0b);
        let project_owner = pubkey_hex(0x02);
        let whitelisted = vec![pubkey_hex(0x03), pubkey_hex(0x04)];
        let agents = vec![pubkey_hex(0x05), pubkey_hex(0x06)];
        let project_tag = project_tag(&project_owner);
        let inputs = OperationsStatusInputs {
            created_at: 1_700_000_002,
            conversation_id: &conversation_id,
            whitelisted_pubkeys: &whitelisted,
            agent_pubkeys: &agents,
            project_tag: &project_tag,
        };

        let first = encode_operations_status(&inputs, &signer).expect("first encode");
        let second = encode_operations_status(&inputs, &signer).expect("second encode");

        assert_eq!(first, second);
        assert_eq!(
            canonical_payload(&first.normalized()).expect("first canonical payload"),
            canonical_payload(&second.normalized()).expect("second canonical payload"),
        );
    }

    #[test]
    fn rejects_malformed_conversation_event_id() {
        let signer = test_signer();
        let project_owner = pubkey_hex(0x02);
        let whitelisted: Vec<String> = Vec::new();
        let agents: Vec<String> = Vec::new();
        let project_tag = project_tag(&project_owner);
        let inputs = OperationsStatusInputs {
            created_at: 1_700_000_003,
            conversation_id: "not-a-valid-event-id",
            whitelisted_pubkeys: &whitelisted,
            agent_pubkeys: &agents,
            project_tag: &project_tag,
        };

        let err = encode_operations_status(&inputs, &signer).expect_err("must reject event id hex");
        assert!(matches!(
            err,
            OperationsStatusEncodeError::InvalidConversationId { .. }
        ));
    }

    #[test]
    fn rejects_invalid_project_reference_pubkey() {
        let signer = test_signer();
        let conversation_id = event_id_hex(0x0c);
        let whitelisted: Vec<String> = Vec::new();
        let agents: Vec<String> = Vec::new();
        let project_tag = vec![
            "a".to_string(),
            format!("{PROJECT_REFERENCE_KIND}:not-a-pubkey:demo-project"),
        ];
        let inputs = OperationsStatusInputs {
            created_at: 1_700_000_004,
            conversation_id: &conversation_id,
            whitelisted_pubkeys: &whitelisted,
            agent_pubkeys: &agents,
            project_tag: &project_tag,
        };

        let err = encode_operations_status(&inputs, &signer)
            .expect_err("must reject invalid project reference pubkey");
        assert!(matches!(
            err,
            OperationsStatusEncodeError::InvalidProjectReference { .. }
        ));
    }

    #[test]
    fn rejects_invalid_project_tag_shape() {
        let signer = test_signer();
        let conversation_id = event_id_hex(0x0d);
        let whitelisted: Vec<String> = Vec::new();
        let agents: Vec<String> = Vec::new();
        let project_tag = vec!["p".to_string(), pubkey_hex(0x02)];
        let inputs = OperationsStatusInputs {
            created_at: 1_700_000_005,
            conversation_id: &conversation_id,
            whitelisted_pubkeys: &whitelisted,
            agent_pubkeys: &agents,
            project_tag: &project_tag,
        };

        let err =
            encode_operations_status(&inputs, &signer).expect_err("must reject project tag shape");
        assert!(matches!(
            err,
            OperationsStatusEncodeError::InvalidProjectTag
        ));
    }

    #[test]
    fn rejects_malformed_whitelisted_pubkey_hex() {
        let signer = test_signer();
        let conversation_id = event_id_hex(0x0e);
        let project_owner = pubkey_hex(0x02);
        let whitelisted = vec!["not-a-pubkey".to_string()];
        let agents: Vec<String> = Vec::new();
        let project_tag = project_tag(&project_owner);
        let inputs = OperationsStatusInputs {
            created_at: 1_700_000_006,
            conversation_id: &conversation_id,
            whitelisted_pubkeys: &whitelisted,
            agent_pubkeys: &agents,
            project_tag: &project_tag,
        };

        let err =
            encode_operations_status(&inputs, &signer).expect_err("must reject whitelist pubkey");
        match err {
            OperationsStatusEncodeError::InvalidWhitelistedPubkey { index, .. } => {
                assert_eq!(index, 0);
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn rejects_malformed_agent_pubkey_hex() {
        let signer = test_signer();
        let conversation_id = event_id_hex(0x0f);
        let project_owner = pubkey_hex(0x02);
        let whitelisted: Vec<String> = Vec::new();
        let agents = vec!["not-a-pubkey".to_string()];
        let project_tag = project_tag(&project_owner);
        let inputs = OperationsStatusInputs {
            created_at: 1_700_000_007,
            conversation_id: &conversation_id,
            whitelisted_pubkeys: &whitelisted,
            agent_pubkeys: &agents,
            project_tag: &project_tag,
        };

        let err = encode_operations_status(&inputs, &signer).expect_err("must reject agent pubkey");
        match err {
            OperationsStatusEncodeError::InvalidAgentPubkey { index, .. } => {
                assert_eq!(index, 0);
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn rejects_pubkey_counts_above_bounds() {
        let signer = test_signer();
        let conversation_id = event_id_hex(0x10);
        let project_owner = pubkey_hex(0x02);
        let valid_agent = pubkey_hex(0x03);
        let whitelisted: Vec<String> = Vec::new();
        let agents = vec![valid_agent; OPERATIONS_STATUS_MAX_AGENT_PUBKEYS + 1];
        let project_tag = project_tag(&project_owner);
        let inputs = OperationsStatusInputs {
            created_at: 1_700_000_008,
            conversation_id: &conversation_id,
            whitelisted_pubkeys: &whitelisted,
            agent_pubkeys: &agents,
            project_tag: &project_tag,
        };

        let err =
            encode_operations_status(&inputs, &signer).expect_err("must reject oversized agents");
        match err {
            OperationsStatusEncodeError::TooManyAgentPubkeys { count, max } => {
                assert_eq!(count, OPERATIONS_STATUS_MAX_AGENT_PUBKEYS + 1);
                assert_eq!(max, OPERATIONS_STATUS_MAX_AGENT_PUBKEYS);
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn backend_operations_status_fixture_matches_canonical_signature_and_tag_order() {
        let fixture: crate::nostr_event::Nip01EventFixture = serde_json::from_str(include_str!(
            "../../../../src/test-utils/fixtures/backend-events/operations-status.compat.json"
        ))
        .expect("fixture must parse");
        let signer = test_signer();
        let conversation_id = event_id_hex(0x09);
        let project_owner = pubkey_hex(0x02);
        let whitelisted = vec![pubkey_hex(0x03)];
        let agents = vec![pubkey_hex(0x04), pubkey_hex(0x05)];
        let project_tag = project_tag(&project_owner);
        let inputs = OperationsStatusInputs {
            created_at: fixture.created_at,
            conversation_id: &conversation_id,
            whitelisted_pubkeys: &whitelisted,
            agent_pubkeys: &agents,
            project_tag: &project_tag,
        };

        assert_eq!(fixture.name, "backend-operations-status-basic");
        assert_eq!(
            fixture.description,
            "Canonical backend operations-status fixture for kind 24133."
        );
        assert_eq!(fixture.secret_key_hex, TEST_SECRET_KEY_HEX);
        assert_eq!(fixture.pubkey, signer.xonly_pubkey_hex());
        assert_eq!(fixture.normalized, fixture.signed.normalized());
        assert_eq!(fixture.signed.tags, fixture.normalized.tags);
        assert_eq!(
            fixture.signed.tags,
            vec![
                vec!["e".to_string(), conversation_id.clone()],
                vec!["P".to_string(), whitelisted[0].clone()],
                vec!["p".to_string(), agents[0].clone()],
                vec!["p".to_string(), agents[1].clone()],
                project_tag.clone(),
            ]
        );

        let event = encode_operations_status(&inputs, &signer).expect("encode operations status");
        assert_eq!(event, fixture.signed);
        assert_eq!(
            canonical_payload(&fixture.normalized).expect("canonical payload"),
            fixture.canonical_payload
        );
        assert_eq!(event.id, fixture.event_hash);
        assert_eq!(event.id, fixture.signed.id);

        verify_signed_event(&fixture.signed).expect("fixture signature must verify");
    }
}
