use std::path::Path;

use thiserror::Error;

use crate::backend_events::heartbeat::BackendSigner;
use crate::nostr_event::{
    NormalizedNostrEvent, NostrEventError, SignedNostrEvent, canonical_payload, event_hash_hex,
};
use crate::publish_outbox::PublishOutboxError;
use crate::publish_runtime::{
    BackendPublishRuntimeInput, BackendPublishRuntimeOutcome, enqueue_backend_event_for_publish,
};

pub const INTERVENTION_REVIEW_EVENT_KIND: u64 = 1;
pub const INTERVENTION_REVIEW_CONTEXT_TAG_VALUE: &str = "intervention-review";
const INTERVENTION_REVIEW_CORRELATION_ID: &str = "intervention-review-request";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRequestInputs<'a> {
    pub project_d_tag: &'a str,
    pub project_owner_pubkey: &'a str,
    pub project_manager_pubkey: Option<&'a str>,
    pub conversation_id: &'a str,
    pub completing_agent_pubkey: &'a str,
    pub user_pubkey: &'a str,
    pub intervention_agent_pubkey: &'a str,
    pub created_at: u64,
}

#[derive(Debug, Error)]
pub enum InterventionPublishError {
    #[error("intervention review canonicalization failed: {0}")]
    Canonicalize(#[from] NostrEventError),
    #[error("intervention review signing failed: {0}")]
    Sign(#[from] secp256k1::Error),
    #[error("intervention review outbox failed: {0}")]
    Outbox(#[from] PublishOutboxError),
}

pub type InterventionPublishResult<T> = Result<T, InterventionPublishError>;

fn project_coordinate(inputs: &ReviewRequestInputs<'_>) -> String {
    format!("31933:{}:{}", inputs.project_owner_pubkey, inputs.project_d_tag)
}

fn review_content(inputs: &ReviewRequestInputs<'_>) -> String {
    let conv_short = short_prefix(inputs.conversation_id);
    let user_short = short_prefix(inputs.user_pubkey);
    let agent_short = short_prefix(inputs.completing_agent_pubkey);
    format!(
        "Conversation {conv_short} has completed and {user_short} hasn't responded. \
         {agent_short} finished their work. Please review and decide if action is needed."
    )
}

fn short_prefix(hex_id: &str) -> String {
    if hex_id.len() <= 8 {
        hex_id.to_string()
    } else {
        format!("{}…", &hex_id[..8])
    }
}

pub fn build_review_event<S: BackendSigner>(
    inputs: &ReviewRequestInputs<'_>,
    signer: &S,
) -> InterventionPublishResult<SignedNostrEvent> {
    let signer_pubkey = signer.xonly_pubkey_hex();
    let tags = review_tags(inputs);
    let content = review_content(inputs);

    let normalized = NormalizedNostrEvent {
        kind: INTERVENTION_REVIEW_EVENT_KIND,
        content: content.clone(),
        tags: tags.clone(),
        pubkey: Some(signer_pubkey.clone()),
        created_at: Some(inputs.created_at),
    };
    let canonical = canonical_payload(&normalized)?;
    let id_hex = event_hash_hex(&canonical);
    let digest = decode_event_id(&id_hex)?;
    let sig = signer.sign_schnorr(&digest)?;

    Ok(SignedNostrEvent {
        id: id_hex,
        pubkey: signer_pubkey,
        created_at: inputs.created_at,
        kind: INTERVENTION_REVIEW_EVENT_KIND,
        tags,
        content,
        sig,
    })
}

fn review_tags(inputs: &ReviewRequestInputs<'_>) -> Vec<Vec<String>> {
    let mut tags: Vec<Vec<String>> = Vec::new();
    tags.push(vec![
        "p".to_string(),
        inputs.intervention_agent_pubkey.to_string(),
    ]);
    tags.push(vec![
        "context".to_string(),
        INTERVENTION_REVIEW_CONTEXT_TAG_VALUE.to_string(),
    ]);
    tags.push(vec!["a".to_string(), project_coordinate(inputs)]);
    tags.push(vec!["e".to_string(), inputs.conversation_id.to_string()]);
    if let Some(manager) = inputs.project_manager_pubkey {
        if !manager.is_empty() && manager != inputs.intervention_agent_pubkey {
            tags.push(vec!["p".to_string(), manager.to_string()]);
        }
    }
    tags
}

pub fn enqueue_review<S: BackendSigner>(
    daemon_dir: &Path,
    inputs: &ReviewRequestInputs<'_>,
    signer: &S,
    accepted_at_ms: u64,
    request_sequence: u64,
    writer_version: &str,
) -> InterventionPublishResult<BackendPublishRuntimeOutcome> {
    let event = build_review_event(inputs, signer)?;
    let request_id = format!(
        "intervention-review:{}:{}",
        inputs.project_d_tag, inputs.conversation_id
    );
    let signer_pubkey = signer.xonly_pubkey_hex();
    let outcome = enqueue_backend_event_for_publish(BackendPublishRuntimeInput {
        daemon_dir,
        event,
        accepted_at: accepted_at_ms,
        request_id: &request_id,
        request_sequence,
        request_timestamp: accepted_at_ms,
        correlation_id: INTERVENTION_REVIEW_CORRELATION_ID,
        project_id: inputs.project_d_tag,
        conversation_id: inputs.conversation_id,
        expected_publisher_pubkey: &signer_pubkey,
        ral_number: 0,
        wait_for_relay_ok: false,
        timeout_ms: 0,
    })?;
    let _ = writer_version;
    Ok(outcome)
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

    use std::str::FromStr;

    fn test_signer() -> Secp256k1Signer<secp256k1::All> {
        Secp256k1Signer::new(Secp256k1::new(), TEST_SECRET_KEY_HEX)
    }

    fn sample_inputs<'a>(
        owner: &'a str,
        intervention_agent: &'a str,
    ) -> ReviewRequestInputs<'a> {
        ReviewRequestInputs {
            project_d_tag: "proj-alpha",
            project_owner_pubkey: owner,
            project_manager_pubkey: None,
            conversation_id: "11112222333344445555666677778888aaaabbbbccccddddeeeeffff00001111",
            completing_agent_pubkey:
                "9999999999999999999999999999999999999999999999999999999999999999",
            user_pubkey: "1111111111111111111111111111111111111111111111111111111111111111",
            intervention_agent_pubkey: intervention_agent,
            created_at: 1_710_000_000,
        }
    }

    #[test]
    fn event_is_kind_1_with_context_and_review_tags() {
        let signer = test_signer();
        let owner_pubkey = "2222222222222222222222222222222222222222222222222222222222222222";
        let intervention_pubkey = "3333333333333333333333333333333333333333333333333333333333333333";
        let inputs = sample_inputs(owner_pubkey, intervention_pubkey);
        let event = build_review_event(&inputs, &signer).expect("build");
        assert_eq!(event.kind, INTERVENTION_REVIEW_EVENT_KIND);
        assert_eq!(event.pubkey, signer.xonly_pubkey_hex());
        let expected_coordinate = format!("31933:{}:{}", owner_pubkey, inputs.project_d_tag);
        assert!(event.tags.contains(&vec!["p".to_string(), intervention_pubkey.to_string()]));
        assert!(event.tags.contains(&vec![
            "context".to_string(),
            INTERVENTION_REVIEW_CONTEXT_TAG_VALUE.to_string(),
        ]));
        assert!(event
            .tags
            .contains(&vec!["a".to_string(), expected_coordinate]));
        assert!(event
            .tags
            .contains(&vec!["e".to_string(), inputs.conversation_id.to_string()]));
        verify_signed_event(&event).expect("signature must verify");
    }

    #[test]
    fn content_mentions_conversation_user_and_agent_prefixes() {
        let signer = test_signer();
        let inputs = sample_inputs(
            "2222222222222222222222222222222222222222222222222222222222222222",
            "3333333333333333333333333333333333333333333333333333333333333333",
        );
        let event = build_review_event(&inputs, &signer).expect("build");
        assert!(event.content.contains("11112222"));
        assert!(event.content.contains("11111111"));
        assert!(event.content.contains("99999999"));
    }

    #[test]
    fn manager_tag_added_when_distinct_from_intervention_agent() {
        let signer = test_signer();
        let manager = "4444444444444444444444444444444444444444444444444444444444444444".to_string();
        let mut inputs = sample_inputs(
            "2222222222222222222222222222222222222222222222222222222222222222",
            "3333333333333333333333333333333333333333333333333333333333333333",
        );
        inputs.project_manager_pubkey = Some(&manager);
        let event = build_review_event(&inputs, &signer).expect("build");
        assert!(event.tags.iter().any(|tag| tag[0] == "p" && tag[1] == manager));
    }

    #[test]
    fn manager_tag_omitted_when_same_as_intervention_agent() {
        let signer = test_signer();
        let intervention = "3333333333333333333333333333333333333333333333333333333333333333";
        let mut inputs = sample_inputs(
            "2222222222222222222222222222222222222222222222222222222222222222",
            intervention,
        );
        inputs.project_manager_pubkey = Some(intervention);
        let event = build_review_event(&inputs, &signer).expect("build");
        let intervention_owned = intervention.to_string();
        let p_tags: Vec<&Vec<String>> = event
            .tags
            .iter()
            .filter(|tag| tag[0] == "p")
            .collect();
        assert_eq!(p_tags.len(), 1);
        assert_eq!(p_tags[0][1], intervention_owned);
    }
}
