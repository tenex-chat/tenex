//! Sign and publish kind:513 metadata events.

use anyhow::{Context, Result};
use nostr::event::{EventBuilder, Tag};
use nostr::key::Keys;
use nostr::types::Kind;
use nostr_sdk::Client;

use crate::source::ProjectEvent;
use crate::summarize::Summary;

const KIND_EVENT_METADATA: u16 = 513;

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

    pub async fn publish(
        &self,
        conversation_id: &str,
        project: &ProjectEvent,
        model: &str,
        summary: &Summary,
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

        let event = EventBuilder::new(Kind::Custom(KIND_EVENT_METADATA), "")
            .tags(tags)
            .sign_with_keys(&self.keys)
            .context("sign kind:513")?;
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
