use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use nostr::Filter;
use nostr::Kind;
use nostr::PublicKey;
use nostr_sdk::Client;

use crate::cache::{now_secs, IdentityCache};
use crate::error::{IdentityError, Result};
use crate::fetch::fetch_identity;
use crate::model::IdentityView;

/// Full resolve: check cache → if miss, fetch from relays → upsert → return.
///
/// If the row exists but is stale, return the stale row immediately and spawn
/// a background task to silently refetch and upsert.
pub async fn resolve(
    pubkey: &str,
    client: Client,
    cache: Arc<IdentityCache>,
) -> Result<Option<IdentityView>> {
    // Fresh cache hit — return immediately.
    if let Some(view) = cache.get_cached(pubkey)? {
        return Ok(Some(view));
    }

    // Stale hit — return the stale row and schedule a background refresh.
    if let Some(stale_view) = cache.get_any(pubkey)? {
        if cache.is_stale(&stale_view) {
            let pk = pubkey.to_string();
            let client_bg = client.clone();
            let cache_bg = cache.clone();
            tokio::spawn(async move {
                match fetch_identity(&pk, &client_bg).await {
                    Ok(Some(fresh)) => {
                        if let Err(e) = cache_bg.upsert(&fresh) {
                            tracing::warn!(pubkey = %pk, error = %e, "background identity upsert failed");
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        tracing::warn!(pubkey = %pk, error = %e, "background identity refetch failed");
                    }
                }
            });
            return Ok(Some(stale_view));
        }
    }

    // Cache miss — fetch synchronously, upsert, return.
    let view = fetch_identity(pubkey, &client).await?;
    if let Some(ref v) = view {
        cache.upsert(v)?;
    }
    Ok(view)
}

/// Resolve multiple pubkeys in one relay round-trip.
///
/// Cache-fresh rows are returned immediately without any network call.
/// Pubkeys that are absent from the cache (or stale) are fetched together
/// using a single multi-author kind:0 subscription, then upserted and
/// returned. The return map contains only pubkeys for which an identity
/// was found; missing pubkeys are silently omitted.
pub async fn batch_resolve(
    pubkeys: &[&str],
    client: &Client,
    cache: Arc<IdentityCache>,
) -> Result<HashMap<String, IdentityView>> {
    let mut results: HashMap<String, IdentityView> = HashMap::new();
    let mut to_fetch: Vec<String> = Vec::new();

    // Serve fresh cache hits immediately; queue the rest for a network fetch.
    for &pk in pubkeys {
        match cache.get_cached(pk)? {
            Some(view) => {
                results.insert(pk.to_string(), view);
            }
            None => {
                to_fetch.push(pk.to_string());
            }
        }
    }

    if to_fetch.is_empty() {
        return Ok(results);
    }

    // Parse hex pubkeys and skip any that are invalid (log a warning).
    let parsed: Vec<(String, PublicKey)> = to_fetch
        .into_iter()
        .filter_map(|pk| match PublicKey::parse(&pk) {
            Ok(public_key) => Some((pk, public_key)),
            Err(e) => {
                tracing::warn!(pubkey = %pk, error = %e, "batch_resolve: skipping invalid pubkey");
                None
            }
        })
        .collect();

    if parsed.is_empty() {
        return Ok(results);
    }

    let authors: Vec<PublicKey> = parsed.iter().map(|(_, pk)| *pk).collect();
    let filter = Filter::new().authors(authors).kind(Kind::Metadata);

    let events = client
        .fetch_events(filter, Duration::from_secs(8))
        .await
        .map_err(|e| IdentityError::Relay(format!("fetch_events: {e}")))?;

    let fetched_at = now_secs();

    // Index events by author hex pubkey and keep the most-recent per author.
    let mut by_author: HashMap<String, nostr::Event> = HashMap::new();
    for event in events {
        let author_hex = event.pubkey.to_hex();
        by_author
            .entry(author_hex)
            .and_modify(|existing| {
                if event.created_at > existing.created_at {
                    *existing = event.clone();
                }
            })
            .or_insert(event);
    }

    for (hex_pk, event) in by_author {
        let metadata: nostr::Metadata = serde_json::from_str(&event.content).unwrap_or_default();
        let slug = crate::tags::first_tag_value(&event, "slug");
        let use_criteria = crate::tags::first_tag_value(&event, "use-criteria");

        let view = IdentityView {
            pubkey: hex_pk.clone(),
            display_name: metadata.display_name,
            name: metadata.name,
            nip05: metadata.nip05,
            picture: metadata.picture,
            banner: metadata.banner,
            about: metadata.about,
            lud16: metadata.lud16,
            slug,
            use_criteria,
            event_id: Some(event.id.to_hex()),
            created_at: Some(event.created_at.as_secs() as i64),
            fetched_at,
        };

        if let Err(e) = cache.upsert(&view) {
            tracing::warn!(pubkey = %hex_pk, error = %e, "batch_resolve: upsert failed");
        }

        results.insert(hex_pk, view);
    }

    Ok(results)
}
