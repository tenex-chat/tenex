use anyhow::{Context, Result};
use nostr_sdk::prelude::*;
use tenex_project::Project;
use tenex_protocol::{
    nostr::NostrChannel, sink::RelaySink, Channel, ConversationRef, EncodingContext, Intent,
    InterventionReviewIntent, MessageRef, PrincipalKind, PrincipalRef, ProjectRef,
};
use tracing::info;

pub struct Publisher {
    channel: NostrChannel<RelaySink>,
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
        let channel = NostrChannel::from_keys(keys, RelaySink::new(client));
        Ok(Self { channel })
    }

    /// Publish a kind:1 intervention-review event to the intervention agent.
    ///
    /// Tags produced (per `tenex-protocol`'s canonical encoder):
    ///   ["p", interventionAgentPubkey]
    ///   ["context", "intervention-review"]
    ///   ["a", "31933:<owner-pubkey>:<d-tag>"]
    ///
    /// No e-tag — intervention reviews are standalone, not threaded replies.
    pub async fn publish_review_request(
        &self,
        intervention_agent_pubkey: &str,
        project_id: &str,
        conversation_id: &str,
        user_name: Option<&str>,
        agent_name: Option<&str>,
    ) -> Result<EventId> {
        let project_ref = resolve_project_ref(project_id)?;

        let target_pk =
            PublicKey::from_hex(intervention_agent_pubkey).context("parse agent pubkey")?;
        let target = PrincipalRef::Nostr {
            pubkey: target_pk,
            kind: PrincipalKind::Agent,
            display_name: None,
        };

        let conversation_event_id =
            EventId::from_hex(conversation_id).context("parse conversation id")?;
        let conversation = ConversationRef::Nostr {
            root_event_id: conversation_event_id,
        };

        let intent = InterventionReviewIntent {
            target: target.clone(),
            conversation,
            user_name: user_name.unwrap_or("the user").to_string(),
            agent_name: agent_name.unwrap_or("an agent").to_string(),
        };

        let ctx = EncodingContext {
            project: project_ref,
            conversation_root: None,
            triggering_message: None,
            completion_recipient: None,
            triggering_principal: target,
            ral: 0,
            model: None,
            cost_usd: None,
            execution_time_ms: None,
            llm_runtime_ms: None,
            llm_runtime_total_ms: None,
            branch: None,
            team: None,
        };

        let refs = self
            .channel
            .send(Intent::InterventionReview(intent), &ctx)
            .await
            .context("publish review-request kind:1")?;
        let event_id = match refs.into_iter().next() {
            Some(MessageRef::Nostr { event_id }) => event_id,
            None => anyhow::bail!("intervention review produced no event"),
        };

        info!(
            conversation_id = %conversation_id,
            agent_pubkey = %intervention_agent_pubkey,
            event_id = %event_id,
            "intervention review request published"
        );
        Ok(event_id)
    }
}

fn resolve_project_ref(project_id: &str) -> Result<ProjectRef> {
    let project = Project::open_default(project_id)
        .with_context(|| format!("open project DB for '{project_id}'"))?;
    let meta = project
        .metadata()
        .context("read project metadata")?
        .with_context(|| format!("project '{project_id}' has no metadata row"))?;
    let owner = meta
        .owner_pubkey
        .as_ref()
        .with_context(|| format!("project '{project_id}' has no owner_pubkey"))?;
    Ok(ProjectRef {
        author: PublicKey::from_hex(owner).context("parse project owner pubkey")?,
        d_tag: meta.d_tag,
    })
}
