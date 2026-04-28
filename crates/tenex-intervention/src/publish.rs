use anyhow::{Context, Result};
use nostr_sdk::prelude::*;
use tracing::info;

pub struct Publisher {
    client: Client,
    keys: Keys,
}

impl Publisher {
    pub async fn new(secret_key: &str, relays: &[String]) -> Result<Self> {
        let keys = Keys::parse(secret_key).context("parse backend secret key")?;
        let client = Client::new(keys.clone());
        for relay in relays {
            client
                .add_relay(relay.as_str())
                .await
                .with_context(|| format!("add relay {relay}"))?;
        }
        client.connect().await;
        Ok(Self { client, keys })
    }

    /// Publish a review-request kind:1 event to the intervention agent.
    ///
    /// Content: natural-language review request addressed to the agent.
    /// Tags:
    ///   ["p", interventionAgentPubkey]
    ///   ["e", conversationId, "", "root"]
    pub async fn publish_review_request(
        &self,
        intervention_agent_pubkey: &str,
        conversation_id: &str,
        user_name: Option<&str>,
        agent_name: Option<&str>,
    ) -> Result<EventId> {
        let user_label = user_name.unwrap_or("the user");
        let agent_label = agent_name.unwrap_or("an agent");

        let content = format!(
            "{agent_label} has finished working on this conversation and {user_label} has not responded. Please review the work and follow up if needed."
        );

        let agent_pk = PublicKey::from_hex(intervention_agent_pubkey)
            .context("parse intervention agent pubkey")?;

        let root_tag = Tag::parse(vec![
            "e".to_string(),
            conversation_id.to_string(),
            "".to_string(),
            "root".to_string(),
        ])
        .context("build root e-tag")?;

        let event = EventBuilder::new(Kind::TextNote, &content)
            .tags(vec![Tag::public_key(agent_pk), root_tag])
            .sign_with_keys(&self.keys)
            .context("sign review-request kind:1")?;

        let event_id = event.id;
        self.client
            .send_event(&event)
            .await
            .context("publish review-request kind:1")?;

        info!(
            conversation_id = %conversation_id,
            agent_pubkey = %intervention_agent_pubkey,
            event_id = %event_id,
            "intervention review request published"
        );
        Ok(event_id)
    }
}
