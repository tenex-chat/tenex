//! kind:24012 `TenexBackendHeartbeat` — periodic liveness signal from the
//! daemon's backend signer.
//!
//! Event shape:
//!
//! ```text
//! kind     = 24012
//! content  = ""
//! tags     = ["p", <whitelisted_pubkey>] for each whitelisted_pubkey
//! ```
//!
//! Signed with the backend signer (see [`tenex_backend_keys::ensure`]).

use anyhow::{anyhow, Context, Result};
use nostr_sdk::{Client, ClientOptions, Event, EventBuilder, Keys, Kind, Tag};
use tenex_protocol::nostr::kinds::BACKEND_HEARTBEAT;

use crate::store::tenex_config::TenexConfigDoc;

pub fn build_heartbeat_event(keys: &Keys, whitelisted_pubkeys: &[String]) -> Result<Event> {
    let mut tags: Vec<Tag> = Vec::with_capacity(whitelisted_pubkeys.len());
    for pk in whitelisted_pubkeys {
        tags.push(
            Tag::parse(["p", pk.as_str()]).map_err(|e| anyhow!("build p tag for {pk}: {e}"))?,
        );
    }

    let event = EventBuilder::new(Kind::Custom(BACKEND_HEARTBEAT), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| anyhow!("sign heartbeat event: {e}"))?;
    Ok(event)
}

fn resolve_relays(doc: &TenexConfigDoc) -> Vec<String> {
    let configured = doc.relays();
    if configured.is_empty() {
        vec!["wss://relay.tenex.chat".to_string()]
    } else {
        configured
    }
}

pub async fn publish_backend_heartbeat(base_dir: &std::path::Path) -> Result<()> {
    let doc = TenexConfigDoc::load(base_dir)?;
    let whitelisted = doc.whitelisted_pubkeys();
    let relays = resolve_relays(&doc);

    let keys = tenex_backend_keys::ensure(base_dir)?;
    let event = build_heartbeat_event(&keys, &whitelisted)?;

    let client = Client::builder()
        .signer(keys)
        .opts(ClientOptions::new().automatic_authentication(true))
        .build();
    for relay in &relays {
        client
            .add_relay(relay.as_str())
            .await
            .with_context(|| format!("add_relay {relay}"))?;
    }
    client.connect().await;
    client
        .send_event(&event)
        .await
        .map_err(|e| anyhow!("send_event: {e}"))?;
    client.disconnect().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_keys() -> Keys {
        Keys::generate()
    }

    #[test]
    fn build_event_has_correct_kind_and_empty_content() {
        let keys = make_keys();
        let event = build_heartbeat_event(&keys, &[]).unwrap();
        assert_eq!(u16::from(event.kind), BACKEND_HEARTBEAT);
        assert_eq!(event.content, "");
    }

    #[test]
    fn build_event_emits_one_p_tag_per_whitelisted_pubkey() {
        let keys = make_keys();
        let whitelisted: Vec<String> = vec!["a".repeat(64), "b".repeat(64), "c".repeat(64)];
        let event = build_heartbeat_event(&keys, &whitelisted).unwrap();
        let p_tags: Vec<Vec<&str>> = event
            .tags
            .iter()
            .filter_map(|t| {
                let s = t.as_slice();
                if s.first().map(String::as_str) == Some("p") {
                    Some(s.iter().map(String::as_str).collect())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(p_tags.len(), 3);
        for (i, pk) in whitelisted.iter().enumerate() {
            assert_eq!(p_tags[i], vec!["p", pk.as_str()]);
        }
    }

    #[test]
    fn build_event_signature_verifies() {
        let keys = make_keys();
        let event = build_heartbeat_event(&keys, &[]).unwrap();
        event
            .verify()
            .expect("backend-signed heartbeat event must verify");
    }

    #[test]
    fn build_event_signed_by_backend_pubkey() {
        let keys = make_keys();
        let event = build_heartbeat_event(&keys, &[]).unwrap();
        assert_eq!(event.pubkey, keys.public_key());
    }
}
