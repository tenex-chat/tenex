use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::backend_events::heartbeat::BackendSigner;
use crate::nostr_event::{
    NormalizedNostrEvent, NostrEventError, SignedNostrEvent, canonical_payload, event_hash_hex,
};

pub const NIP46_KIND: u64 = 24133;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Nip46Request {
    pub id: String,
    pub method: String,
    pub params: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Nip46Response {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Error)]
pub enum Nip46ProtocolError {
    #[error("nip-46 response carried neither result nor error")]
    EmptyResponse,
    #[error("nip-46 remote signer returned error: {0}")]
    Remote(String),
    #[error("nip-46 response id mismatch: expected {expected}, got {actual}")]
    IdMismatch { expected: String, actual: String },
    #[error("nip-46 json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("nip-46 event canonicalization failed: {0}")]
    Canonicalize(#[from] NostrEventError),
    #[error("nip-46 event signing failed: {0}")]
    Sign(#[from] secp256k1::Error),
}

pub fn new_request_id() -> String {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).expect("getrandom must produce entropy for nip-46 request ids");
    hex::encode(bytes)
}

pub fn build_sign_event_request(unsigned_event_json: &str) -> (String, Nip46Request) {
    let id = new_request_id();
    let request = Nip46Request {
        id: id.clone(),
        method: "sign_event".to_string(),
        params: vec![unsigned_event_json.to_string()],
    };
    (id, request)
}

pub fn build_connect_request(remote_pubkey: &str, secret: Option<&str>) -> (String, Nip46Request) {
    let id = new_request_id();
    let mut params = vec![remote_pubkey.to_string()];
    if let Some(secret) = secret {
        params.push(secret.to_string());
    }
    let request = Nip46Request {
        id: id.clone(),
        method: "connect".to_string(),
        params,
    };
    (id, request)
}

pub fn build_nip46_event(
    backend_signer: &dyn BackendSigner,
    remote_pubkey: &str,
    encrypted_content: &str,
    created_at: u64,
) -> Result<SignedNostrEvent, Nip46ProtocolError> {
    let signer_pubkey = backend_signer.xonly_pubkey_hex();
    let tags: Vec<Vec<String>> = vec![vec!["p".to_string(), remote_pubkey.to_string()]];

    let normalized = NormalizedNostrEvent {
        kind: NIP46_KIND,
        content: encrypted_content.to_string(),
        tags: tags.clone(),
        pubkey: Some(signer_pubkey.clone()),
        created_at: Some(created_at),
    };

    let canonical = canonical_payload(&normalized)?;
    let id = event_hash_hex(&canonical);
    let digest = decode_event_id(&id)?;
    let sig = backend_signer.sign_schnorr(&digest)?;

    Ok(SignedNostrEvent {
        id,
        pubkey: signer_pubkey,
        created_at,
        kind: NIP46_KIND,
        tags,
        content: encrypted_content.to_string(),
        sig,
    })
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

pub fn extract_result(
    response: &Nip46Response,
    expected_id: &str,
) -> Result<String, Nip46ProtocolError> {
    if response.id != expected_id {
        return Err(Nip46ProtocolError::IdMismatch {
            expected: expected_id.to_string(),
            actual: response.id.clone(),
        });
    }
    if let Some(error) = &response.error {
        return Err(Nip46ProtocolError::Remote(error.clone()));
    }
    match &response.result {
        Some(result) => Ok(result.clone()),
        None => Err(Nip46ProtocolError::EmptyResponse),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn new_request_id_is_32_char_lowercase_hex_and_unique() {
        let mut ids = HashSet::new();
        for _ in 0..100 {
            let id = new_request_id();
            assert_eq!(id.len(), 32, "id must be 32 hex chars (16 bytes)");
            assert!(
                id.chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
                "id must be lowercase hex, got {id}"
            );
            assert!(ids.insert(id), "new_request_id must produce unique ids");
        }
    }

    #[test]
    fn build_sign_event_request_returns_matching_id_and_params() {
        let unsigned = r#"{"kind":1,"content":"hi"}"#;
        let (id, request) = build_sign_event_request(unsigned);
        assert!(!id.is_empty());
        assert_eq!(request.id, id);
        assert_eq!(request.method, "sign_event");
        assert_eq!(request.params, vec![unsigned.to_string()]);
    }

    #[test]
    fn build_connect_request_with_secret_includes_two_params() {
        let (_id, request) = build_connect_request("pk", Some("xyz"));
        assert_eq!(request.method, "connect");
        assert_eq!(request.params, vec!["pk".to_string(), "xyz".to_string()]);
    }

    #[test]
    fn build_connect_request_without_secret_includes_one_param() {
        let (_id, request) = build_connect_request("pk", None);
        assert_eq!(request.method, "connect");
        assert_eq!(request.params, vec!["pk".to_string()]);
    }

    #[test]
    fn extract_result_returns_ok_for_matching_id_and_result() {
        let response = Nip46Response {
            id: "A".to_string(),
            result: Some("OK".to_string()),
            error: None,
        };
        let out = extract_result(&response, "A").expect("expected Ok");
        assert_eq!(out, "OK");
    }

    #[test]
    fn extract_result_reports_id_mismatch() {
        let response = Nip46Response {
            id: "A".to_string(),
            result: Some("OK".to_string()),
            error: None,
        };
        match extract_result(&response, "B") {
            Err(Nip46ProtocolError::IdMismatch { expected, actual }) => {
                assert_eq!(expected, "B");
                assert_eq!(actual, "A");
            }
            other => panic!("expected IdMismatch, got {other:?}"),
        }
    }

    #[test]
    fn extract_result_reports_remote_error() {
        let response = Nip46Response {
            id: "A".to_string(),
            result: None,
            error: Some("denied".to_string()),
        };
        match extract_result(&response, "A") {
            Err(Nip46ProtocolError::Remote(message)) => assert_eq!(message, "denied"),
            other => panic!("expected Remote, got {other:?}"),
        }
    }

    #[test]
    fn extract_result_reports_empty_response() {
        let response = Nip46Response {
            id: "A".to_string(),
            result: None,
            error: None,
        };
        match extract_result(&response, "A") {
            Err(Nip46ProtocolError::EmptyResponse) => {}
            other => panic!("expected EmptyResponse, got {other:?}"),
        }
    }

    #[test]
    fn request_round_trips_through_serde_json() {
        let request = Nip46Request {
            id: "abc123".to_string(),
            method: "sign_event".to_string(),
            params: vec!["payload".to_string()],
        };
        let encoded = serde_json::to_string(&request).expect("serialize request");
        let decoded: Nip46Request = serde_json::from_str(&encoded).expect("deserialize request");
        assert_eq!(decoded, request);
    }

    #[test]
    fn response_deserializes_with_absent_result_and_error() {
        let json = r#"{"id":"abc"}"#;
        let decoded: Nip46Response = serde_json::from_str(json).expect("deserialize response");
        assert_eq!(decoded.id, "abc");
        assert!(decoded.result.is_none());
        assert!(decoded.error.is_none());
    }

    #[test]
    fn build_nip46_event_has_correct_kind_tags_and_signature() {
        use crate::backend_signer::HexBackendSigner;
        use crate::nostr_event::verify_signed_event;

        let signer = HexBackendSigner::from_private_key_hex(
            "0101010101010101010101010101010101010101010101010101010101010101",
        )
        .unwrap();
        let remote = "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766";
        let event = build_nip46_event(&signer, remote, "ciphertext", 1_700_000_000).unwrap();

        assert_eq!(event.kind, 24133);
        assert_eq!(event.content, "ciphertext");
        assert_eq!(event.tags, vec![vec!["p".to_string(), remote.to_string()]]);
        assert_eq!(event.pubkey, signer.pubkey_hex());
        verify_signed_event(&event).unwrap();
    }

    #[test]
    fn build_nip46_event_id_matches_canonical_hash() {
        use crate::backend_signer::HexBackendSigner;

        let signer = HexBackendSigner::from_private_key_hex(
            "0101010101010101010101010101010101010101010101010101010101010101",
        )
        .unwrap();
        let remote = "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766";
        let event = build_nip46_event(&signer, remote, "ciphertext", 1_700_000_000).unwrap();

        let canonical = canonical_payload(&event.normalized()).expect("canonical payload");
        let expected_id = event_hash_hex(&canonical);
        assert_eq!(event.id, expected_id);
    }

    #[test]
    fn build_nip46_event_with_empty_content_and_different_timestamp() {
        use crate::backend_signer::HexBackendSigner;
        use crate::nostr_event::verify_signed_event;

        let signer = HexBackendSigner::from_private_key_hex(
            "0101010101010101010101010101010101010101010101010101010101010101",
        )
        .unwrap();
        let remote = "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766";

        let original = build_nip46_event(&signer, remote, "ciphertext", 1_700_000_000).unwrap();
        let event = build_nip46_event(&signer, remote, "", 1_700_000_500).unwrap();

        assert_eq!(event.content, "");
        assert_eq!(event.created_at, 1_700_000_500);
        verify_signed_event(&event).unwrap();
        assert_ne!(event.id, original.id);
    }
}
