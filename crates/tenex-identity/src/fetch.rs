use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nostr::Filter;
use nostr::Kind;
use nostr::PublicKey;
use nostr_sdk::Client;

use crate::error::{IdentityError, Result};
use crate::model::IdentityView;

/// Default relays used when none are specified.
const DEFAULT_RELAYS: &[&str] = &["wss://relay.tenex.chat"];

/// Fetch kind:0 metadata from relays and return an [`IdentityView`].
///
/// Does **not** write to the cache. Returns `None` when no event is found.
pub async fn fetch_identity(pubkey: &str, relays: &[String]) -> Result<Option<IdentityView>> {
    let public_key = PublicKey::parse(pubkey)
        .map_err(|e| IdentityError::InvalidPubkey(format!("{pubkey}: {e}")))?;

    let effective_relays: Vec<&str> = if relays.is_empty() {
        DEFAULT_RELAYS.to_vec()
    } else {
        relays.iter().map(String::as_str).collect()
    };

    let client = Client::default();
    for relay in &effective_relays {
        client
            .add_relay(*relay)
            .await
            .map_err(|e| IdentityError::Relay(format!("add relay {relay}: {e}")))?;
    }
    client.connect().await;

    let filter = Filter::new()
        .author(public_key)
        .kind(Kind::Metadata)
        .limit(1);

    let events = client
        .fetch_events(filter, Duration::from_secs(8))
        .await
        .map_err(|e| IdentityError::Relay(format!("fetch_events: {e}")))?;

    client.disconnect().await;

    let event = match events.first() {
        Some(e) => e,
        None => return Ok(None),
    };

    let fetched_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let metadata: nostr::Metadata = serde_json::from_str(&event.content)
        .unwrap_or_default();

    Ok(Some(IdentityView {
        pubkey: pubkey.to_string(),
        display_name: metadata.display_name,
        name: metadata.name,
        nip05: metadata.nip05,
        picture: metadata.picture,
        banner: metadata.banner,
        about: metadata.about,
        lud16: metadata.lud16,
        event_id: Some(event.id.to_hex()),
        created_at: Some(event.created_at.as_secs() as i64),
        fetched_at,
    }))
}
