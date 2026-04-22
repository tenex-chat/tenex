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

    fn owner_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    #[test]
    fn encodes_single_owner_heartbeat_with_canonical_id_and_valid_signature() {
        let signer = test_signer();
        let owner = owner_hex(0x02);
        let owners = vec![owner.clone()];
        let inputs = HeartbeatInputs {
            created_at: 1_700_000_000,
            owner_pubkeys: &owners,
        };

        let event = encode_heartbeat(&inputs, &signer).expect("encode heartbeat");

        assert_eq!(event.kind, 24012);
        assert_eq!(event.content, "");
        assert_eq!(event.tags, vec![vec!["p".to_string(), owner]]);
        assert_eq!(event.pubkey, signer.xonly_pubkey_hex());
        assert_eq!(event.created_at, 1_700_000_000);

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
    fn encodes_multiple_owners_preserving_input_order_without_self_p_tag() {
        let signer = test_signer();
        let owner_a = owner_hex(0x02);
        let owner_b = owner_hex(0x03);
        let owner_c = owner_hex(0x04);
        let owners = vec![owner_a.clone(), owner_b.clone(), owner_c.clone()];
        let inputs = HeartbeatInputs {
            created_at: 1_700_000_100,
            owner_pubkeys: &owners,
        };

        let event = encode_heartbeat(&inputs, &signer).expect("encode heartbeat");

        assert_eq!(
            event.tags,
            vec![
                vec!["p".to_string(), owner_a],
                vec!["p".to_string(), owner_b],
                vec!["p".to_string(), owner_c],
            ],
        );
        let self_pubkey = signer.xonly_pubkey_hex();
        assert!(
            event.tags.iter().all(|tag| tag[1] != self_pubkey),
            "self p-tag must not appear",
        );
        verify_signed_event(&event).expect("signature must verify");
    }

    #[test]
    fn rejects_empty_owner_list() {
        let signer = test_signer();
        let owners: Vec<String> = Vec::new();
        let inputs = HeartbeatInputs {
            created_at: 1_700_000_000,
            owner_pubkeys: &owners,
        };

        let err = encode_heartbeat(&inputs, &signer).expect_err("must reject empty owners");
        assert!(matches!(err, HeartbeatEncodeError::NoOwnerPubkeys));
    }

    #[test]
    fn rejects_malformed_owner_pubkey_hex() {
        let signer = test_signer();
        let owners = vec!["not-a-valid-pubkey".to_string()];
        let inputs = HeartbeatInputs {
            created_at: 1_700_000_000,
            owner_pubkeys: &owners,
        };

        let err = encode_heartbeat(&inputs, &signer).expect_err("must reject invalid hex");
        match err {
            HeartbeatEncodeError::InvalidOwnerPubkey { index, .. } => assert_eq!(index, 0),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn rejects_duplicate_owner_pubkeys() {
        let signer = test_signer();
        let owner = owner_hex(0x02);
        let owners = vec![owner.clone(), owner.clone()];
        let inputs = HeartbeatInputs {
            created_at: 1_700_000_000,
            owner_pubkeys: &owners,
        };

        let err = encode_heartbeat(&inputs, &signer).expect_err("must reject duplicates");
        match err {
            HeartbeatEncodeError::DuplicateOwnerPubkey { pubkey } => assert_eq!(pubkey, owner),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn preserves_created_at_in_canonical_payload() {
        let signer = test_signer();
        let owner = owner_hex(0x02);
        let owners = vec![owner];
        let inputs = HeartbeatInputs {
            created_at: 42,
            owner_pubkeys: &owners,
        };

        let event = encode_heartbeat(&inputs, &signer).expect("encode heartbeat");
        let canonical = canonical_payload(&event.normalized()).expect("canonical payload");
        assert!(
            canonical.contains(",42,"),
            "canonical payload must contain exact created_at: {canonical}",
        );
        assert_eq!(event.created_at, 42);
    }

    #[test]
    fn canonical_payload_is_deterministic_for_fixed_inputs() {
        let signer = test_signer();
        let owners = vec![owner_hex(0x02), owner_hex(0x03)];
        let inputs = HeartbeatInputs {
            created_at: 1_700_000_000,
            owner_pubkeys: &owners,
        };

        let first = encode_heartbeat(&inputs, &signer).expect("first encode");
        let second = encode_heartbeat(&inputs, &signer).expect("second encode");

        let canonical_first = canonical_payload(&first.normalized()).expect("canonical first");
        let canonical_second = canonical_payload(&second.normalized()).expect("canonical second");
        assert_eq!(canonical_first, canonical_second);
        assert_eq!(first.id, second.id);
    }

    #[test]
    fn signature_round_trips_through_verify_signed_event() {
        let signer = test_signer();
        let owners = vec![owner_hex(0x02), owner_hex(0x03)];
        let inputs = HeartbeatInputs {
            created_at: 1_700_000_500,
            owner_pubkeys: &owners,
        };

        let event = encode_heartbeat(&inputs, &signer).expect("encode heartbeat");
        verify_signed_event(&event).expect("round-trip verification must succeed");
    }

    #[test]
    fn event_pubkey_matches_signer_xonly_pubkey() {
        let signer = test_signer();
        let owners = vec![owner_hex(0x02)];
        let inputs = HeartbeatInputs {
            created_at: 1_700_000_000,
            owner_pubkeys: &owners,
        };

        let event = encode_heartbeat(&inputs, &signer).expect("encode heartbeat");
        assert_eq!(event.pubkey, signer.xonly_pubkey_hex());
    }
}
