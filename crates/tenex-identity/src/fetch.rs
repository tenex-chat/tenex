use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nostr::Filter;
use nostr::Kind;
use nostr::PublicKey;
use nostr_sdk::Client;

use crate::error::{IdentityError, Result};
use crate::model::IdentityView;

/// Fetch kind:0 metadata using the provided relay client and return an [`IdentityView`].
///
/// Does **not** write to the cache. Returns `None` when no event is found.
/// The caller is responsible for the client's lifecycle (connecting, disconnecting).
pub async fn fetch_identity(pubkey: &str, client: &Client) -> Result<Option<IdentityView>> {
    let public_key = PublicKey::parse(pubkey)
        .map_err(|e| IdentityError::InvalidPubkey(format!("{pubkey}: {e}")))?;

    let filter = Filter::new()
        .author(public_key)
        .kind(Kind::Metadata)
        .limit(1);

    let events = client
        .fetch_events(filter, Duration::from_secs(8))
        .await
        .map_err(|e| IdentityError::Relay(format!("fetch_events: {e}")))?;

    let event = match events.first() {
        Some(e) => e,
        None => return Ok(None),
    };

    let fetched_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    Ok(Some(IdentityView::from_event(event, fetched_at)))
}
