use std::sync::Arc;

use anyhow::{Context, Result};
use nostr_sdk::prelude::*;
use tracing::warn;

use super::agent_subprocess::DispatchJob;
use super::dispatch_pipeline::{accept_dispatch, persist_user_message};
use super::event_routing::mark_seen;
use super::mcp_subscriptions::McpSubscription;
use super::runtime_state_store::first_conversation_author;
use super::RuntimeShared;

pub(super) async fn dispatch_notification(
    shared: Arc<RuntimeShared>,
    subscription: &McpSubscription,
    content: &str,
) -> Result<()> {
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
        .sign_with_keys(&shared.backend_keys)
        .context("sign MCP subscription notification")?;

    mark_seen(&shared.seen, event.id);
    if let Err(error) = shared.client.send_event(&event).await {
        warn!(event_id = %tenex_ids::shorten_full_event_id(&event.id.to_hex()), error = %error, "failed to publish MCP subscription notification");
    }

    let completion_recipient_pubkey =
        first_conversation_author(&shared.store, &subscription.conversation_id)
            .ok()
            .flatten();
    let agent_json = shared
        .base_dir
        .join("agents")
        .join(format!("{}.json", agent.pubkey));
    persist_user_message(&shared.store, &event, &subscription.conversation_id)?;
    accept_dispatch(
        shared,
        DispatchJob {
            event,
            agent,
            conv_id: subscription.conversation_id.clone(),
            agent_json,
            allow_driver_preempt: false,
            completion_recipient_pubkey,
            // MCP-driven dispatches synthesize an event from a server
            // notification, not from an external Nostr author.
            is_external: false,
            is_remote_agent: false,
            response_tee: None,
            // Server-initiated push: there is no upstream daemon span
            // to parent against, so the resulting `tenex.runtime.dispatch`
            // becomes a fresh root.
            trace_carrier: tenex_telemetry::inject_current(),
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
