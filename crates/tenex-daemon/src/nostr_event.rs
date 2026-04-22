use secp256k1::{Secp256k1, XOnlyPublicKey, schnorr::Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::str::FromStr;

#[derive(Debug, thiserror::Error)]
pub enum NostrEventError {
    #[error("normalized event is missing pubkey")]
    MissingPubkey,
    #[error("normalized event is missing created_at")]
    MissingCreatedAt,
    #[error("invalid hex: {0}")]
    InvalidHex(#[from] hex::FromHexError),
    #[error("expected 32 bytes for {field}, got {actual}")]
    InvalidDigestLength { field: &'static str, actual: usize },
    #[error("event id mismatch: expected {expected}, got {actual}")]
    EventIdMismatch { expected: String, actual: String },
    #[error("secp256k1 verification error: {0}")]
    Secp256k1(#[from] secp256k1::Error),
    #[error("json serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Nip01EventFixture {
    pub name: String,
    pub description: String,
    #[serde(rename = "secretKeyHex")]
    pub secret_key_hex: String,
    pub pubkey: String,
    pub created_at: u64,
    pub normalized: NormalizedNostrEvent,
    #[serde(rename = "canonicalPayload")]
    pub canonical_payload: String,
    #[serde(rename = "eventHash")]
    pub event_hash: String,
    pub signed: SignedNostrEvent,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct NormalizedNostrEvent {
    pub kind: u64,
    pub content: String,
    pub tags: Vec<Vec<String>>,
    pub pubkey: Option<String>,
    pub created_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct SignedNostrEvent {
    pub id: String,
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u64,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}

impl SignedNostrEvent {
    pub fn normalized(&self) -> NormalizedNostrEvent {
        NormalizedNostrEvent {
            kind: self.kind,
            content: self.content.clone(),
            tags: self.tags.clone(),
            pubkey: Some(self.pubkey.clone()),
            created_at: Some(self.created_at),
        }
    }
}

pub fn canonical_payload(event: &NormalizedNostrEvent) -> Result<String, NostrEventError> {
    let pubkey = event
        .pubkey
        .as_ref()
        .ok_or(NostrEventError::MissingPubkey)?;
    let created_at = event.created_at.ok_or(NostrEventError::MissingCreatedAt)?;
    let payload = serde_json::json!([0, pubkey, created_at, event.kind, event.tags, event.content]);

    Ok(serde_json::to_string(&payload)?)
}

pub fn event_hash_hex(canonical_payload: &str) -> String {
    let digest = Sha256::digest(canonical_payload.as_bytes());
    hex::encode(digest)
}

pub fn verify_signed_event(event: &SignedNostrEvent) -> Result<(), NostrEventError> {
    let canonical = canonical_payload(&event.normalized())?;
    let actual_id = event_hash_hex(&canonical);
    if actual_id != event.id {
        return Err(NostrEventError::EventIdMismatch {
            expected: actual_id,
            actual: event.id.clone(),
        });
    }

    let digest = decode_32_bytes("event id", &event.id)?;
    let pubkey = XOnlyPublicKey::from_str(&event.pubkey)?;
    let signature = Signature::from_str(&event.sig)?;
    let secp = Secp256k1::verification_only();

    secp.verify_schnorr(&signature, &digest, &pubkey)?;
    Ok(())
}

fn decode_32_bytes(field: &'static str, value: &str) -> Result<[u8; 32], NostrEventError> {
    let bytes = hex::decode(value)?;
    bytes
        .try_into()
        .map_err(|bytes: Vec<u8>| NostrEventError::InvalidDigestLength {
            field,
            actual: bytes.len(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const STREAM_TEXT_DELTA_FIXTURE: &str =
        include_str!("../../../src/test-utils/fixtures/nostr/stream-text-delta.compat.json");

    #[test]
    fn stream_text_delta_fixture_matches_nip01_hash_and_signature() {
        let fixture: Nip01EventFixture =
            serde_json::from_str(STREAM_TEXT_DELTA_FIXTURE).expect("fixture must parse");

        let canonical = canonical_payload(&fixture.normalized).expect("canonical payload");
        assert_eq!(canonical, fixture.canonical_payload);
        assert_eq!(event_hash_hex(&canonical), fixture.event_hash);
        assert_eq!(fixture.signed.id, fixture.event_hash);
        assert_eq!(
            canonical_payload(&fixture.signed.normalized()).expect("signed canonical payload"),
            fixture.canonical_payload
        );

        verify_signed_event(&fixture.signed).expect("fixture signature must verify");
    }
}
