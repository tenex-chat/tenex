use std::collections::BTreeSet;
use std::str::FromStr;

use secp256k1::XOnlyPublicKey;
use thiserror::Error;

use super::heartbeat::BackendSigner;
use crate::nostr_event::{
    NormalizedNostrEvent, NostrEventError, SignedNostrEvent, canonical_payload, event_hash_hex,
};

/// Kind 24011 is now a **per-agent** configuration event (not the old
/// "installed agent list" single event). One event per installed agent,
/// signed by the backend, listing the agent's available and active
/// models / skills / mcp servers. Ephemeral: relays don't store it; clients
/// receive fresh snapshots on each periodic tick and on every 24020 ingest.
pub const AGENT_CONFIG_KIND: u64 = 24011;

/// Back-compat alias. The legacy name is preserved because several call sites
/// and fixtures refer to the kind by its former symbolic name.
pub const INSTALLED_AGENT_LIST_KIND: u64 = AGENT_CONFIG_KIND;

/// A `(pubkey, slug)` pair describing one installed agent. Lives here for
/// historical reasons — callers across the daemon (agent inventory,
/// per-agent publish fan-out, project-status agent list) pass this shape
/// around.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledAgentListAgent {
    pub pubkey: String,
    pub slug: String,
}

pub struct AgentConfigInputs<'a> {
    pub created_at: u64,
    pub agent_pubkey: &'a str,
    pub agent_slug: &'a str,
    pub owner_pubkeys: &'a [String],
    pub available_models: &'a [String],
    pub active_models: &'a BTreeSet<String>,
    pub available_skills: &'a [String],
    pub active_skills: &'a BTreeSet<String>,
    pub available_mcps: &'a [String],
    pub active_mcps: &'a BTreeSet<String>,
}

#[derive(Debug, Error)]
pub enum AgentConfigEncodeError {
    #[error("agent-config agent pubkey is invalid: {reason}")]
    InvalidAgentPubkey { reason: String },
    #[error("agent-config agent slug is empty")]
    EmptyAgentSlug,
    #[error("agent-config owner pubkey at index {index} is invalid: {reason}")]
    InvalidOwnerPubkey { index: usize, reason: String },
    #[error("agent-config {block} entry at index {index} is empty")]
    EmptySlug { block: &'static str, index: usize },
    #[error("agent-config canonicalization failed: {0}")]
    Canonicalize(#[from] NostrEventError),
    #[error("agent-config signing failed: {0}")]
    Sign(#[from] secp256k1::Error),
}

/// Back-compat alias so callers migrating from the old module still compile
/// while the TS side is being updated. Delete once every caller has moved to
/// `AgentConfigEncodeError`.
pub type InstalledAgentListEncodeError = AgentConfigEncodeError;

pub fn encode_agent_config<S: BackendSigner>(
    inputs: &AgentConfigInputs<'_>,
    signer: &S,
) -> Result<SignedNostrEvent, AgentConfigEncodeError> {
    validate_xonly_pubkey_hex(inputs.agent_pubkey).map_err(|err| {
        AgentConfigEncodeError::InvalidAgentPubkey {
            reason: err.to_string(),
        }
    })?;
    if inputs.agent_slug.is_empty() {
        return Err(AgentConfigEncodeError::EmptyAgentSlug);
    }
    for (index, pubkey) in inputs.owner_pubkeys.iter().enumerate() {
        validate_xonly_pubkey_hex(pubkey).map_err(|err| {
            AgentConfigEncodeError::InvalidOwnerPubkey {
                index,
                reason: err.to_string(),
            }
        })?;
    }
    validate_non_empty("model", inputs.available_models)?;
    validate_non_empty("skill", inputs.available_skills)?;
    validate_non_empty("mcp", inputs.available_mcps)?;

    let signer_pubkey = signer.xonly_pubkey_hex();
    let tags = agent_config_tags(inputs);
    let normalized = NormalizedNostrEvent {
        kind: AGENT_CONFIG_KIND,
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
        kind: AGENT_CONFIG_KIND,
        tags,
        content: String::new(),
        sig,
    })
}

fn validate_non_empty(block: &'static str, values: &[String]) -> Result<(), AgentConfigEncodeError> {
    for (index, value) in values.iter().enumerate() {
        if value.is_empty() {
            return Err(AgentConfigEncodeError::EmptySlug { block, index });
        }
    }
    Ok(())
}

fn agent_config_tags(inputs: &AgentConfigInputs<'_>) -> Vec<Vec<String>> {
    let mut tags = Vec::new();
    tags.push(vec![
        "agent".to_string(),
        inputs.agent_pubkey.to_string(),
        inputs.agent_slug.to_string(),
    ]);
    for pubkey in inputs.owner_pubkeys {
        tags.push(vec!["p".to_string(), pubkey.clone()]);
    }
    emit_slug_block(
        &mut tags,
        "model",
        inputs.available_models,
        inputs.active_models,
    );
    emit_slug_block(
        &mut tags,
        "skill",
        inputs.available_skills,
        inputs.active_skills,
    );
    emit_slug_block(
        &mut tags,
        "mcp",
        inputs.available_mcps,
        inputs.active_mcps,
    );
    tags
}

fn emit_slug_block(
    tags: &mut Vec<Vec<String>>,
    name: &str,
    available: &[String],
    active: &BTreeSet<String>,
) {
    // Emit entries alphabetically by slug, preserving the user-specified
    // "active" marker. Active and inactive entries are interleaved by slug;
    // the marker is what distinguishes them.
    let mut sorted: Vec<&String> = available.iter().collect();
    sorted.sort();
    sorted.dedup();
    for slug in sorted {
        let mut tag = vec![name.to_string(), slug.clone()];
        if active.contains(slug) {
            tag.push("active".to_string());
        }
        tags.push(tag);
    }
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

    #[test]
    fn encodes_per_agent_event_with_active_markers_and_sorted_blocks() {
        let signer = test_signer();
        let agent_pubkey = pubkey_hex(0x04);
        let owner_a = pubkey_hex(0x02);
        let owner_b = pubkey_hex(0x03);
        let owners = vec![owner_a.clone(), owner_b.clone()];
        let available_models = vec!["opus".to_string(), "sonnet".to_string()];
        let active_models: BTreeSet<String> = BTreeSet::from(["opus".to_string()]);
        let available_skills = vec![
            "read-access".to_string(),
            "shell".to_string(),
            "write-access".to_string(),
        ];
        let active_skills: BTreeSet<String> =
            BTreeSet::from(["read-access".to_string(), "shell".to_string()]);
        let available_mcps = vec!["github".to_string(), "jira".to_string()];
        let active_mcps: BTreeSet<String> = BTreeSet::from(["github".to_string()]);

        let inputs = AgentConfigInputs {
            created_at: 1_700_000_000,
            agent_pubkey: &agent_pubkey,
            agent_slug: "worker",
            owner_pubkeys: &owners,
            available_models: &available_models,
            active_models: &active_models,
            available_skills: &available_skills,
            active_skills: &active_skills,
            available_mcps: &available_mcps,
            active_mcps: &active_mcps,
        };

        let event = encode_agent_config(&inputs, &signer).expect("encode");

        assert_eq!(event.kind, AGENT_CONFIG_KIND);
        assert_eq!(
            event.tags,
            vec![
                vec![
                    "agent".to_string(),
                    agent_pubkey.clone(),
                    "worker".to_string()
                ],
                vec!["p".to_string(), owner_a.clone()],
                vec!["p".to_string(), owner_b.clone()],
                vec!["model".to_string(), "opus".to_string(), "active".to_string()],
                vec!["model".to_string(), "sonnet".to_string()],
                vec![
                    "skill".to_string(),
                    "read-access".to_string(),
                    "active".to_string()
                ],
                vec!["skill".to_string(), "shell".to_string(), "active".to_string()],
                vec!["skill".to_string(), "write-access".to_string()],
                vec!["mcp".to_string(), "github".to_string(), "active".to_string()],
                vec!["mcp".to_string(), "jira".to_string()],
            ]
        );
        verify_signed_event(&event).expect("signature must verify");
    }

    #[test]
    fn encodes_minimal_event_with_no_available_entries() {
        let signer = test_signer();
        let agent_pubkey = pubkey_hex(0x04);
        let inputs = AgentConfigInputs {
            created_at: 1_700_000_000,
            agent_pubkey: &agent_pubkey,
            agent_slug: "worker",
            owner_pubkeys: &[],
            available_models: &[],
            active_models: &BTreeSet::new(),
            available_skills: &[],
            active_skills: &BTreeSet::new(),
            available_mcps: &[],
            active_mcps: &BTreeSet::new(),
        };

        let event = encode_agent_config(&inputs, &signer).expect("encode");
        assert_eq!(
            event.tags,
            vec![vec![
                "agent".to_string(),
                agent_pubkey,
                "worker".to_string()
            ]]
        );
        verify_signed_event(&event).expect("signature must verify");
    }

    #[test]
    fn active_marker_only_at_index_2() {
        let signer = test_signer();
        let agent_pubkey = pubkey_hex(0x04);
        let available = vec!["opus".to_string()];
        let active: BTreeSet<String> = BTreeSet::from(["opus".to_string()]);
        let inputs = AgentConfigInputs {
            created_at: 1_700_000_000,
            agent_pubkey: &agent_pubkey,
            agent_slug: "worker",
            owner_pubkeys: &[],
            available_models: &available,
            active_models: &active,
            available_skills: &[],
            active_skills: &BTreeSet::new(),
            available_mcps: &[],
            active_mcps: &BTreeSet::new(),
        };

        let event = encode_agent_config(&inputs, &signer).expect("encode");
        let model_tag = event.tags.iter().find(|t| t.first().map(String::as_str) == Some("model")).expect("model tag");
        assert_eq!(model_tag, &vec!["model".to_string(), "opus".to_string(), "active".to_string()]);
        assert_eq!(model_tag.len(), 3);
        assert!(model_tag.get(3).is_none());
    }

    #[test]
    fn inactive_entry_has_no_third_element() {
        let signer = test_signer();
        let agent_pubkey = pubkey_hex(0x04);
        let available = vec!["opus".to_string(), "sonnet".to_string()];
        let active: BTreeSet<String> = BTreeSet::from(["opus".to_string()]);
        let inputs = AgentConfigInputs {
            created_at: 1_700_000_000,
            agent_pubkey: &agent_pubkey,
            agent_slug: "worker",
            owner_pubkeys: &[],
            available_models: &available,
            active_models: &active,
            available_skills: &[],
            active_skills: &BTreeSet::new(),
            available_mcps: &[],
            active_mcps: &BTreeSet::new(),
        };

        let event = encode_agent_config(&inputs, &signer).expect("encode");
        let sonnet_tag = event
            .tags
            .iter()
            .find(|t| t.get(1).map(String::as_str) == Some("sonnet"))
            .expect("sonnet tag");
        assert_eq!(sonnet_tag.len(), 2);
    }

    #[test]
    fn rejects_invalid_agent_pubkey() {
        let signer = test_signer();
        let inputs = AgentConfigInputs {
            created_at: 1_700_000_000,
            agent_pubkey: "not-a-pubkey",
            agent_slug: "worker",
            owner_pubkeys: &[],
            available_models: &[],
            active_models: &BTreeSet::new(),
            available_skills: &[],
            active_skills: &BTreeSet::new(),
            available_mcps: &[],
            active_mcps: &BTreeSet::new(),
        };
        assert!(matches!(
            encode_agent_config(&inputs, &signer),
            Err(AgentConfigEncodeError::InvalidAgentPubkey { .. })
        ));
    }

    #[test]
    fn rejects_empty_agent_slug() {
        let signer = test_signer();
        let agent_pubkey = pubkey_hex(0x04);
        let inputs = AgentConfigInputs {
            created_at: 1_700_000_000,
            agent_pubkey: &agent_pubkey,
            agent_slug: "",
            owner_pubkeys: &[],
            available_models: &[],
            active_models: &BTreeSet::new(),
            available_skills: &[],
            active_skills: &BTreeSet::new(),
            available_mcps: &[],
            active_mcps: &BTreeSet::new(),
        };
        assert!(matches!(
            encode_agent_config(&inputs, &signer),
            Err(AgentConfigEncodeError::EmptyAgentSlug)
        ));
    }
}
