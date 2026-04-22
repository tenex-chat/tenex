use serde_json::json;
use thiserror::Error;

use crate::backend_events::heartbeat::BackendSigner;
use crate::nostr_event::{
    NormalizedNostrEvent, NostrEventError, SignedNostrEvent, canonical_payload, event_hash_hex,
};

pub const BACKEND_PROFILE_KIND: u64 = 0;
pub const DEFAULT_BACKEND_PROFILE_DESCRIPTION: &str =
    "TENEX Backend Daemon - Multi-agent orchestration system";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendProfileInputs<'a> {
    pub created_at: u64,
    pub backend_name: &'a str,
    pub whitelisted_pubkeys: &'a [String],
}

#[derive(Debug, Error)]
pub enum BackendProfileEncodeError {
    #[error("nostr event error: {0}")]
    Event(#[from] NostrEventError),
    #[error("json serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("nostr signing error: {0}")]
    Sign(#[from] secp256k1::Error),
}

pub fn encode_backend_profile<S: BackendSigner>(
    inputs: &BackendProfileInputs<'_>,
    signer: &S,
) -> Result<SignedNostrEvent, BackendProfileEncodeError> {
    let pubkey = signer.xonly_pubkey_hex();
    let mut tags = inputs
        .whitelisted_pubkeys
        .iter()
        .filter(|whitelisted| !whitelisted.is_empty() && whitelisted.as_str() != pubkey)
        .map(|whitelisted| vec!["p".to_string(), whitelisted.clone()])
        .collect::<Vec<_>>();
    tags.push(vec!["bot".to_string()]);
    tags.push(vec!["t".to_string(), "tenex".to_string()]);
    tags.push(vec!["t".to_string(), "tenex-backend".to_string()]);

    let content = serde_json::to_string(&json!({
        "name": inputs.backend_name,
        "description": DEFAULT_BACKEND_PROFILE_DESCRIPTION,
        "picture": format!("https://api.dicebear.com/7.x/bottts/svg?seed={pubkey}"),
    }))?;
    let normalized = NormalizedNostrEvent {
        kind: BACKEND_PROFILE_KIND,
        content,
        tags,
        pubkey: Some(pubkey.clone()),
        created_at: Some(inputs.created_at),
    };
    let canonical = canonical_payload(&normalized)?;
    let id = event_hash_hex(&canonical);
    let digest = hex_digest_to_array(&id)?;
    let sig = signer.sign_schnorr(&digest)?;

    Ok(SignedNostrEvent {
        id,
        pubkey,
        created_at: inputs.created_at,
        kind: BACKEND_PROFILE_KIND,
        tags: normalized.tags,
        content: normalized.content,
        sig,
    })
}

fn hex_digest_to_array(value: &str) -> Result<[u8; 32], NostrEventError> {
    let bytes = hex::decode(value)?;
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
    use crate::backend_signer::HexBackendSigner;
    use crate::nostr_event::verify_signed_event;

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    #[test]
    fn encodes_signed_backend_kind_zero_profile() {
        let signer =
            HexBackendSigner::from_private_key_hex(TEST_SECRET_KEY_HEX).expect("signer loads");
        let owners = vec!["a".repeat(64)];
        let event = encode_backend_profile(
            &BackendProfileInputs {
                created_at: 1_710_001_000,
                backend_name: "tenex backend",
                whitelisted_pubkeys: &owners,
            },
            &signer,
        )
        .expect("profile encodes");

        assert_eq!(event.kind, BACKEND_PROFILE_KIND);
        assert_eq!(event.pubkey, signer.pubkey_hex());
        assert!(event.tags.contains(&vec!["bot".to_string()]));
        assert!(
            event
                .tags
                .contains(&vec!["t".to_string(), "tenex-backend".to_string()])
        );
        verify_signed_event(&event).expect("profile signature verifies");
    }
}
