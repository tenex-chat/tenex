//! Sign and publish kind:513 metadata events.
//!
//! Events are signed by the project's PM agent (the first agent listed
//! in the kind:31933 event) — passed in per-publish as a `Signer` — so
//! that ingesting backends can authenticate the event author against
//! public project state. The relay-level NIP-42 authentication still
//! uses the backend's own key, configured at construction.

use anyhow::{Context, Result};
use nostr::event::{EventBuilder, Tag};
use nostr::key::Keys;
use nostr::Kind;
use nostr_sdk::{Client, ClientOptions};
use tenex_project::Signer;

use crate::source::ProjectEvent;
use crate::summarize::Summary;

const KIND_EVENT_METADATA: u16 = 513;

pub struct Publisher {
    client: Client,
}

impl Publisher {
    pub async fn new(backend_secret_key: &str, relays: &[String]) -> Result<Self> {
        let keys = Keys::parse(backend_secret_key).context("parse backend secret key")?;
        let client = Client::builder()
            .signer(keys)
            .opts(ClientOptions::new().automatic_authentication(true))
            .build();
        for relay in relays {
            client
                .add_relay(relay.as_str())
                .await
                .with_context(|| format!("add relay {relay}"))?;
        }
        client.connect().await;
        Ok(Self { client })
    }

    /// Sign with the PM agent's signer and broadcast.
    pub async fn publish(
        &self,
        conversation_id: &str,
        project: &ProjectEvent,
        model: &str,
        summary: &Summary,
        signer: &dyn Signer,
    ) -> Result<()> {
        let mut tags: Vec<Tag> = Vec::new();
        tags.push(parse_tag(&["e", conversation_id])?);
        if !summary.title.is_empty() {
            tags.push(parse_tag(&["title", &summary.title])?);
        }
        if !summary.summary.is_empty() {
            tags.push(parse_tag(&["summary", &summary.summary])?);
        }
        if !summary.status_label.is_empty() {
            tags.push(parse_tag(&["status-label", &summary.status_label])?);
        }
        if !summary.status_current_activity.is_empty() {
            tags.push(parse_tag(&[
                "status-current-activity",
                &summary.status_current_activity,
            ])?);
        }
        for c in &summary.categories {
            if !c.is_empty() {
                tags.push(parse_tag(&["t", c])?);
            }
        }
        tags.push(parse_tag(&["a", &project.tag_id()])?);
        tags.push(parse_tag(&["model", model])?);

        let builder = EventBuilder::new(Kind::Custom(KIND_EVENT_METADATA), "").tags(tags);
        let event = signer
            .sign(builder)
            .await
            .with_context(|| format!("sign kind:513 for conversation {conversation_id}"))?;
        self.client
            .send_event(&event)
            .await
            .context("publish kind:513")?;
        Ok(())
    }
}

fn parse_tag(parts: &[&str]) -> Result<Tag> {
    Tag::parse(parts.iter().map(|s| s.to_string())).context("build tag")
}
