use anyhow::{Context, Result};
use nostr_sdk::prelude::*;
use tracing::{info, warn};

use crate::model::ScheduledTask;

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

    /// Publish a kind:1 trigger event for a scheduled task.
    ///
    /// Tag layout (per spec):
    ///   ["a", projectRef]               — project NIP-33 address
    ///   ["p", targetPubkey]             — agent to route to (when resolved)
    ///   ["scheduled-task", taskId]      — task identity
    ///   ["scheduled-task-cron", expr]   — for cron tasks
    ///   OR
    ///   ["scheduled-task-execute-at", iso] — for one-off tasks
    ///   ["e", targetChannel]            — when present
    pub async fn publish_task(
        &self,
        task: &ScheduledTask,
        target_pubkey: Option<&str>,
    ) -> Result<EventId> {
        let mut tags: Vec<Tag> = Vec::new();

        if let Some(project_ref) = &task.project_ref {
            tags.push(parse_tag(&["a", project_ref])?);
        }

        if let Some(pubkey) = target_pubkey {
            tags.push(parse_tag(&["p", pubkey])?);
        } else {
            warn!(
                task_id = %task.id,
                slug = %task.target_agent_slug,
                "agent slug not resolved; publishing without p-tag"
            );
        }

        tags.push(parse_tag(&["scheduled-task", &task.id])?);

        if task.is_oneoff() {
            // Storage validation guarantees one-off tasks carry executeAt;
            // anything else here is a programmer error in the load path.
            let iso = task.execute_at.as_deref().with_context(|| {
                format!(
                    "one-off task '{}' missing executeAt at publish time",
                    task.id
                )
            })?;
            tags.push(parse_tag(&["scheduled-task-execute-at", iso])?);
        } else {
            tags.push(parse_tag(&["scheduled-task-cron", &task.schedule])?);
        }

        if let Some(channel) = &task.target_channel {
            tags.push(parse_tag(&["e", channel])?);
        }

        let event = EventBuilder::new(Kind::TextNote, &task.prompt)
            .tags(tags)
            .sign_with_keys(&self.keys)
            .context("sign scheduled-task kind:1")?;

        let event_id = event.id;
        self.client
            .send_event(&event)
            .await
            .context("publish scheduled-task kind:1")?;

        info!(
            task_id = %task.id,
            event_id = %event_id,
            "scheduled task fired"
        );
        Ok(event_id)
    }
}

fn parse_tag(parts: &[&str]) -> Result<Tag> {
    Tag::parse(parts.iter().map(|s| s.to_string())).context("build tag")
}
