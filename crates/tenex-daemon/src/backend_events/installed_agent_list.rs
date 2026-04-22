use std::cmp::Ordering;
use std::str::FromStr;

use secp256k1::XOnlyPublicKey;
use thiserror::Error;

use super::heartbeat::BackendSigner;
use crate::nostr_event::{
    NormalizedNostrEvent, NostrEventError, SignedNostrEvent, canonical_payload, event_hash_hex,
};

pub const INSTALLED_AGENT_LIST_KIND: u64 = 24011;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledAgentListAgent {
    pub pubkey: String,
    pub slug: String,
}

pub struct InstalledAgentListInputs<'a> {
    pub created_at: u64,
    pub owner_pubkeys: &'a [String],
    pub agents: &'a [InstalledAgentListAgent],
}

#[derive(Debug, Error)]
pub enum InstalledAgentListEncodeError {
    #[error("installed-agent-list owner pubkey at index {index} is invalid: {reason}")]
    InvalidOwnerPubkey { index: usize, reason: String },
    #[error("installed-agent-list agent pubkey at index {index} is invalid: {reason}")]
    InvalidAgentPubkey { index: usize, reason: String },
    #[error("installed-agent-list agent slug at index {index} is empty")]
    EmptyAgentSlug { index: usize },
    #[error("installed-agent-list canonicalization failed: {0}")]
    Canonicalize(#[from] NostrEventError),
    #[error("installed-agent-list signing failed: {0}")]
    Sign(#[from] secp256k1::Error),
}

pub fn encode_installed_agent_list<S: BackendSigner>(
    inputs: &InstalledAgentListInputs<'_>,
    signer: &S,
) -> Result<SignedNostrEvent, InstalledAgentListEncodeError> {
    for (index, pubkey) in inputs.owner_pubkeys.iter().enumerate() {
        validate_xonly_pubkey_hex(pubkey).map_err(|err| {
            InstalledAgentListEncodeError::InvalidOwnerPubkey {
                index,
                reason: err.to_string(),
            }
        })?;
    }

    for (index, agent) in inputs.agents.iter().enumerate() {
        if agent.slug.is_empty() {
            return Err(InstalledAgentListEncodeError::EmptyAgentSlug { index });
        }
        validate_xonly_pubkey_hex(&agent.pubkey).map_err(|err| {
            InstalledAgentListEncodeError::InvalidAgentPubkey {
                index,
                reason: err.to_string(),
            }
        })?;
    }

    let signer_pubkey = signer.xonly_pubkey_hex();
    let tags = installed_agent_list_tags(inputs);
    let normalized = NormalizedNostrEvent {
        kind: INSTALLED_AGENT_LIST_KIND,
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
        kind: INSTALLED_AGENT_LIST_KIND,
        tags,
        content: String::new(),
        sig,
    })
}

fn installed_agent_list_tags(inputs: &InstalledAgentListInputs<'_>) -> Vec<Vec<String>> {
    let mut tags = Vec::with_capacity(inputs.owner_pubkeys.len() + inputs.agents.len());
    for pubkey in inputs.owner_pubkeys {
        tags.push(vec!["p".to_string(), pubkey.clone()]);
    }

    let mut agents: Vec<&InstalledAgentListAgent> = inputs.agents.iter().collect();
    agents.sort_by(|left, right| match left.slug.cmp(&right.slug) {
        Ordering::Equal => left.pubkey.cmp(&right.pubkey),
        order => order,
    });

    for agent in agents {
        tags.push(vec![
            "agent".to_string(),
            agent.pubkey.clone(),
            agent.slug.clone(),
        ]);
    }
    tags
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

    fn agent(fill_byte: u8, slug: &str) -> InstalledAgentListAgent {
        InstalledAgentListAgent {
            pubkey: pubkey_hex(fill_byte),
            slug: slug.to_string(),
        }
    }

    #[test]
    fn encodes_installed_agent_list_with_canonical_id_and_valid_signature() {
        let signer = test_signer();
        let owners = vec![pubkey_hex(0x02), pubkey_hex(0x03)];
        let alpha_later_pubkey = agent(0x08, "alpha");
        let alpha_earlier_pubkey = agent(0x07, "alpha");
        let beta = agent(0x06, "beta");
        let agents = vec![
            beta.clone(),
            alpha_later_pubkey.clone(),
            alpha_earlier_pubkey.clone(),
        ];
        let inputs = InstalledAgentListInputs {
            created_at: 1_700_000_000,
            owner_pubkeys: &owners,
            agents: &agents,
        };

        let event =
            encode_installed_agent_list(&inputs, &signer).expect("encode installed agent list");

        let mut expected_agents = agents.clone();
        expected_agents.sort_by(|left, right| match left.slug.cmp(&right.slug) {
            Ordering::Equal => left.pubkey.cmp(&right.pubkey),
            order => order,
        });
        let mut expected_tags = vec![
            vec!["p".to_string(), owners[0].clone()],
            vec!["p".to_string(), owners[1].clone()],
        ];
        expected_tags.extend(expected_agents.iter().map(|agent| {
            vec![
                "agent".to_string(),
                agent.pubkey.clone(),
                agent.slug.clone(),
            ]
        }));

        assert_eq!(event.kind, 24011);
        assert_eq!(event.content, "");
        assert_eq!(event.tags, expected_tags);
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
    fn preserves_owner_pubkey_order_and_duplicates_for_typescript_compatibility() {
        let signer = test_signer();
        let owner_a = pubkey_hex(0x02);
        let owner_b = pubkey_hex(0x03);
        let owners = vec![owner_b.clone(), owner_a.clone(), owner_b.clone()];
        let agents: Vec<InstalledAgentListAgent> = Vec::new();
        let inputs = InstalledAgentListInputs {
            created_at: 1_700_000_001,
            owner_pubkeys: &owners,
            agents: &agents,
        };

        let event =
            encode_installed_agent_list(&inputs, &signer).expect("encode installed agent list");

        assert_eq!(
            event.tags,
            vec![
                vec!["p".to_string(), owner_b.clone()],
                vec!["p".to_string(), owner_a],
                vec!["p".to_string(), owner_b],
            ],
        );
        verify_signed_event(&event).expect("signature must verify");
    }

    #[test]
    fn allows_empty_inventory() {
        let signer = test_signer();
        let owners: Vec<String> = Vec::new();
        let agents: Vec<InstalledAgentListAgent> = Vec::new();
        let inputs = InstalledAgentListInputs {
            created_at: 1_700_000_002,
            owner_pubkeys: &owners,
            agents: &agents,
        };

        let event =
            encode_installed_agent_list(&inputs, &signer).expect("encode installed agent list");

        assert_eq!(event.kind, INSTALLED_AGENT_LIST_KIND);
        assert_eq!(event.tags, Vec::<Vec<String>>::new());
        assert_eq!(event.content, "");
        verify_signed_event(&event).expect("signature must verify");
    }

    #[test]
    fn canonical_payload_is_deterministic_for_fixed_inputs() {
        let signer = test_signer();
        let owners = vec![pubkey_hex(0x02), pubkey_hex(0x03)];
        let agents = vec![agent(0x05, "beta"), agent(0x04, "alpha")];
        let inputs = InstalledAgentListInputs {
            created_at: 1_700_000_003,
            owner_pubkeys: &owners,
            agents: &agents,
        };

        let first =
            encode_installed_agent_list(&inputs, &signer).expect("first installed list encode");
        let second =
            encode_installed_agent_list(&inputs, &signer).expect("second installed list encode");

        assert_eq!(
            canonical_payload(&first.normalized()).expect("first canonical payload"),
            canonical_payload(&second.normalized()).expect("second canonical payload"),
        );
        assert_eq!(first.id, second.id);
    }

    #[test]
    fn rejects_malformed_owner_pubkey_hex() {
        let signer = test_signer();
        let owners = vec!["not-a-valid-pubkey".to_string()];
        let agents: Vec<InstalledAgentListAgent> = Vec::new();
        let inputs = InstalledAgentListInputs {
            created_at: 1_700_000_004,
            owner_pubkeys: &owners,
            agents: &agents,
        };

        let err =
            encode_installed_agent_list(&inputs, &signer).expect_err("must reject owner pubkey");
        match err {
            InstalledAgentListEncodeError::InvalidOwnerPubkey { index, .. } => {
                assert_eq!(index, 0);
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn rejects_malformed_agent_pubkey_hex() {
        let signer = test_signer();
        let owners: Vec<String> = Vec::new();
        let agents = vec![InstalledAgentListAgent {
            pubkey: "not-a-valid-pubkey".to_string(),
            slug: "alpha".to_string(),
        }];
        let inputs = InstalledAgentListInputs {
            created_at: 1_700_000_005,
            owner_pubkeys: &owners,
            agents: &agents,
        };

        let err =
            encode_installed_agent_list(&inputs, &signer).expect_err("must reject agent pubkey");
        match err {
            InstalledAgentListEncodeError::InvalidAgentPubkey { index, .. } => {
                assert_eq!(index, 0);
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn rejects_empty_agent_slug() {
        let signer = test_signer();
        let owners: Vec<String> = Vec::new();
        let agents = vec![InstalledAgentListAgent {
            pubkey: pubkey_hex(0x04),
            slug: String::new(),
        }];
        let inputs = InstalledAgentListInputs {
            created_at: 1_700_000_006,
            owner_pubkeys: &owners,
            agents: &agents,
        };

        let err =
            encode_installed_agent_list(&inputs, &signer).expect_err("must reject empty slug");
        match err {
            InstalledAgentListEncodeError::EmptyAgentSlug { index } => assert_eq!(index, 0),
            other => panic!("unexpected error: {other:?}"),
        }
    }
}
