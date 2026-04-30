use std::sync::Arc;

use anyhow::{bail, Context, Result};
use nostr_sdk::prelude::*;
use tracing::warn;

use super::mcp_subscriptions::McpSubscription;
use super::{accept_dispatch, first_conversation_author, mark_seen, DispatchJob, RuntimeShared};

pub(super) async fn dispatch_notification(
    shared: Arc<RuntimeShared>,
    subscription: &McpSubscription,
    content: &str,
) -> Result<()> {
    let Some(keys) = shared.backend_keys.as_ref() else {
        bail!("backend keys unavailable for MCP subscription notification");
    };
    let agent = shared
        .agent_snapshot()
        .agents
        .into_iter()
        .find(|agent| agent.pubkey == subscription.agent_pubkey)
        .with_context(|| {
            format!(
                "subscription agent '{}' is not in this runtime",
                subscription.agent_pubkey
            )
        })?;
    let agent_pubkey =
        PublicKey::from_hex(&subscription.agent_pubkey).context("parse agent pubkey")?;
    let root_id = EventId::from_hex(&subscription.root_event_id).context("parse root event id")?;
    let body = format!(
        "<system-reminder type=\"mcp-resource-updated\" subscription-id=\"{}\">\nMCP resource updated.\nServer: {}\nResource: {}\nDescription: {}\n\n{}\n</system-reminder>",
        escape_xml(&subscription.id),
        escape_xml(&subscription.server_name),
        escape_xml(&subscription.resource_uri),
        escape_xml(&subscription.description),
        escape_xml(content),
    );
    let tags = vec![
        Tag::public_key(agent_pubkey),
        Tag::from_standardized_without_cell(TagStandard::Event {
            event_id: root_id,
            relay_url: None,
            marker: Some(Marker::Root),
            public_key: None,
            uppercase: false,
        }),
        Tag::parse(["a", shared.project_addr.as_str()]).context("build project a tag")?,
        Tag::parse(["mcp-subscription", subscription.id.as_str()])
            .context("build mcp-subscription tag")?,
    ];
    let event = EventBuilder::new(Kind::TextNote, body)
        .tags(tags)
        .sign_with_keys(keys)
        .context("sign MCP subscription notification")?;

    mark_seen(&shared.seen, event.id);
    if let Err(error) = shared.client.send_event(&event).await {
        warn!(event_id = %event.id.to_hex()[..8], error = %error, "failed to publish MCP subscription notification");
    }

    let completion_recipient_pubkey =
        first_conversation_author(&shared.store, &subscription.conversation_id)
            .ok()
            .flatten();
    let agent_json = shared
        .base_dir
        .join("agents")
        .join(format!("{}.json", agent.pubkey));
    accept_dispatch(
        shared,
        DispatchJob {
            event,
            agent,
            conv_id: subscription.conversation_id.clone(),
            agent_json,
            allow_driver_preempt: false,
            completion_recipient_pubkey,
            response_tee: None,
        },
    )
    .await
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
