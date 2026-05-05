//! kind:0 backend profile — identity announcement signed by the backend key.
//!
//! Event shape:
//!
//! ```text
//! kind    = 0
//! content = JSON { "name": "<backend_name>" }
//! tags    = []
//! ```
//!
//! The `name` field is taken from `backendName` in `config.json`; when absent
//! the string `"TENEX"` is used as a generic fallback so the backend always
//! has a human-readable identity on Nostr.

use anyhow::{anyhow, Context, Result};
use nostr_sdk::{Client, ClientOptions, Event, EventBuilder, Keys, Kind};
use serde_json::json;

use crate::store::tenex_config::TenexConfigDoc;

pub fn build_backend_profile_event(keys: &Keys, backend_name: Option<&str>) -> Result<Event> {
    let name = backend_name.unwrap_or("TENEX");
    let content = json!({ "name": name }).to_string();
    let event = EventBuilder::new(Kind::Metadata, content)
        .sign_with_keys(keys)
        .map_err(|e| anyhow!("sign backend profile event: {e}"))?;
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

pub async fn publish_backend_profile(base_dir: &std::path::Path) -> Result<()> {
    let doc = TenexConfigDoc::load(base_dir)?;
    let relays = resolve_relays(&doc);
    let backend_name = doc.backend_name();

    let keys = tenex_backend_keys::ensure(base_dir)?;
    let event = build_backend_profile_event(&keys, backend_name.as_deref())?;

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
    fn build_event_is_kind_0() {
        let keys = make_keys();
        let event = build_backend_profile_event(&keys, Some("My Backend")).unwrap();
        assert_eq!(u16::from(event.kind), 0);
    }

    #[test]
    fn build_event_name_from_config() {
        let keys = make_keys();
        let event = build_backend_profile_event(&keys, Some("My Backend")).unwrap();
        let content: serde_json::Value = serde_json::from_str(&event.content).unwrap();
        assert_eq!(content["name"], "My Backend");
    }

    #[test]
    fn build_event_name_defaults_to_tenex() {
        let keys = make_keys();
        let event = build_backend_profile_event(&keys, None).unwrap();
        let content: serde_json::Value = serde_json::from_str(&event.content).unwrap();
        assert_eq!(content["name"], "TENEX");
    }

    #[test]
    fn build_event_signed_by_backend_pubkey() {
        let keys = make_keys();
        let event = build_backend_profile_event(&keys, None).unwrap();
        assert_eq!(event.pubkey, keys.public_key());
    }

    #[test]
    fn build_event_signature_verifies() {
        let keys = make_keys();
        let event = build_backend_profile_event(&keys, None).unwrap();
        event
            .verify()
            .expect("backend-signed profile event must verify");
    }
}
