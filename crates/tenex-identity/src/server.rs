use std::sync::Arc;

use nostr_sdk::prelude::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;
use tracing::{error, warn};

use crate::cache::{now_secs, IdentityCache};
use crate::model::IdentityView;
use crate::protocol::{parse_request, Request};
use crate::resolve::resolve;

/// Shared subscription handle for the always-on kind:0 watch. The daemon
/// keeps at most one such subscription; each `WATCH_AUTHORS` request unsubs
/// the previous one before opening the new filter.
type WatchSlot = Arc<Mutex<Option<SubscriptionId>>>;

pub async fn serve(listener: UnixListener, cache: Arc<IdentityCache>, client: Client) {
    let watch_slot: WatchSlot = Arc::new(Mutex::new(None));

    // Spawn the kind:0 notification consumer up-front, before we accept any
    // connections. The relay client's notification channel is broadcast, so a
    // late consumer would silently drop events that arrived between subscribe
    // and consumer-spawn.
    spawn_metadata_consumer(client.clone(), cache.clone());

    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let cache = cache.clone();
                let client = client.clone();
                let watch_slot = watch_slot.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_client(stream, cache, client, watch_slot).await {
                        warn!("[identity] client error: {e:#}");
                    }
                });
            }
            Err(e) => {
                error!("[identity] accept error: {e}");
            }
        }
    }
}

/// Listen for kind:0 events on the relay client's notification channel and
/// upsert each one into the cache. Filters by `Kind::Metadata` so events from
/// unrelated subscriptions on the same client (e.g. a future feature) don't
/// poison the identity table.
fn spawn_metadata_consumer(client: Client, cache: Arc<IdentityCache>) {
    tokio::spawn(async move {
        let mut notifications = client.notifications();
        loop {
            match notifications.recv().await {
                Ok(RelayPoolNotification::Event { event, .. }) => {
                    if event.kind != Kind::Metadata {
                        continue;
                    }
                    let view = IdentityView::from_event(&event, now_secs());
                    if let Err(e) = cache.upsert_if_newer(&view) {
                        warn!(pubkey = %view.pubkey, error = %e, "metadata consumer upsert failed");
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    warn!("metadata consumer lagged, dropped {n} notifications");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Replace the always-on kind:0 subscription with one filtered to `pubkeys`.
/// An empty list tears the subscription down without opening a new one.
/// Returns the number of pubkeys actually subscribed (i.e. those that parsed
/// as valid hex).
async fn apply_watch(
    client: &Client,
    slot: &WatchSlot,
    pubkeys: &[String],
) -> anyhow::Result<usize> {
    let valid: Vec<PublicKey> = pubkeys
        .iter()
        .filter_map(|s| PublicKey::parse(s).ok())
        .collect();

    let mut slot_guard = slot.lock().await;
    if let Some(old) = slot_guard.take() {
        client.unsubscribe(&old).await;
    }

    if valid.is_empty() {
        return Ok(0);
    }

    let count = valid.len();
    let id = SubscriptionId::generate();
    let filter = Filter::new().authors(valid).kind(Kind::Metadata);
    client
        .subscribe_with_id(id.clone(), filter, None)
        .await
        .map_err(|e| anyhow::anyhow!("subscribe_with_id: {e}"))?;
    *slot_guard = Some(id);
    Ok(count)
}

async fn handle_client(
    stream: UnixStream,
    cache: Arc<IdentityCache>,
    client: Client,
    watch_slot: WatchSlot,
) -> anyhow::Result<()> {
    let (reader_half, mut writer_half) = stream.into_split();
    let mut reader = BufReader::new(reader_half);
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Ok(());
        }

        let response = match parse_request(&line) {
            Some(Request::Resolve { pubkey }) => {
                let normalized = pubkey.trim().to_ascii_lowercase();
                if !is_hex64(&normalized) {
                    // Still return an object shape with ERR so callers know.
                    "ERR\n".to_string()
                } else {
                    match resolve(&normalized, client.clone(), cache.clone()).await {
                        Ok(Some(view)) => {
                            let mut json =
                                serde_json::to_string(&view).unwrap_or_else(|_| "ERR".to_string());
                            json.push('\n');
                            json
                        }
                        Ok(None) => {
                            // Not found — return an object with null fields so TypeScript
                            // can rely on the shape.
                            let empty = IdentityView {
                                pubkey: normalized.clone(),
                                display_name: None,
                                name: None,
                                nip05: None,
                                picture: None,
                                banner: None,
                                about: None,
                                lud16: None,
                                slug: None,
                                use_criteria: None,
                                backend_name: None,
                                event_id: None,
                                created_at: None,
                                fetched_at: now_secs(),
                            };
                            let mut json =
                                serde_json::to_string(&empty).unwrap_or_else(|_| "ERR".to_string());
                            json.push('\n');
                            json
                        }
                        Err(e) => {
                            warn!("[identity] resolve error for {normalized}: {e:#}");
                            "ERR\n".to_string()
                        }
                    }
                }
            }
            Some(Request::Status) => {
                let count = cache.count().unwrap_or(0);
                format!("OK cache={count}\n")
            }
            Some(Request::WatchAuthors { pubkeys }) => {
                match apply_watch(&client, &watch_slot, &pubkeys).await {
                    Ok(n) => format!("OK {n}\n"),
                    Err(e) => {
                        warn!("[identity] watch update failed: {e:#}");
                        "ERR\n".to_string()
                    }
                }
            }
            None => "ERR\n".to_string(),
        };

        writer_half.write_all(response.as_bytes()).await?;
        writer_half.flush().await?;
    }
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}
