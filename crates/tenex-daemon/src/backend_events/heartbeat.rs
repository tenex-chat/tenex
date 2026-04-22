use std::collections::HashSet;
use std::str::FromStr;

use secp256k1::XOnlyPublicKey;
use thiserror::Error;

use crate::nostr_event::{
    NormalizedNostrEvent, NostrEventError, SignedNostrEvent, canonical_payload, event_hash_hex,
};

pub const BACKEND_HEARTBEAT_KIND: u64 = 24012;

pub struct HeartbeatInputs<'a> {
    pub created_at: u64,
    pub owner_pubkeys: &'a [String],
}

#[derive(Debug, Error)]
pub enum HeartbeatEncodeError {
    #[error("heartbeat requires at least one owner pubkey")]
    NoOwnerPubkeys,
    #[error("heartbeat owner pubkey at index {index} is invalid: {reason}")]
    InvalidOwnerPubkey { index: usize, reason: String },
    #[error("heartbeat owner pubkey is duplicated: {pubkey}")]
    DuplicateOwnerPubkey { pubkey: String },
    #[error("heartbeat canonicalization failed: {0}")]
    Canonicalize(#[from] NostrEventError),
    #[error("heartbeat signing failed: {0}")]
    Sign(#[from] secp256k1::Error),
}

pub trait BackendSigner {
    fn xonly_pubkey_hex(&self) -> String;
    fn sign_schnorr(&self, digest: &[u8; 32]) -> Result<String, secp256k1::Error>;
}

pub fn encode_heartbeat<S: BackendSigner>(
    inputs: &HeartbeatInputs<'_>,
    signer: &S,
) -> Result<SignedNostrEvent, HeartbeatEncodeError> {
    if inputs.owner_pubkeys.is_empty() {
        return Err(HeartbeatEncodeError::NoOwnerPubkeys);
    }

    let mut seen = HashSet::with_capacity(inputs.owner_pubkeys.len());
    for (index, pubkey) in inputs.owner_pubkeys.iter().enumerate() {
        validate_xonly_pubkey_hex(index, pubkey)?;
        if !seen.insert(pubkey.as_str()) {
            return Err(HeartbeatEncodeError::DuplicateOwnerPubkey {
                pubkey: pubkey.clone(),
            });
        }
    }

    let signer_pubkey = signer.xonly_pubkey_hex();
    let tags: Vec<Vec<String>> = inputs
        .owner_pubkeys
        .iter()
        .map(|pk| vec!["p".to_string(), pk.clone()])
        .collect();

    let normalized = NormalizedNostrEvent {
        kind: BACKEND_HEARTBEAT_KIND,
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
        kind: BACKEND_HEARTBEAT_KIND,
        tags,
        content: String::new(),
        sig,
    })
}

fn validate_xonly_pubkey_hex(index: usize, value: &str) -> Result<(), HeartbeatEncodeError> {
    XOnlyPublicKey::from_str(value).map_err(|err| HeartbeatEncodeError::InvalidOwnerPubkey {
        index,
        reason: err.to_string(),
    })?;
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
