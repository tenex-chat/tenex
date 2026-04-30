//! Nostr subscription layer.
//!
//! Two filters:
//!   - Discovery: kind 31933 from whitelisted authors (no `since` — relay
//!     returns latest replaceable per d-tag).
//!   - Boot triggers: kind 1 + 24000 from whitelisted authors that #a-tag
//!     a known project. Resubscribed every time a new project is discovered.
//!
//! Whitelist enforcement is relay-side via `authors`. Author-untrusted boot
//! events never reach this process.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use nostr_sdk::prelude::*;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::Duration;
use tracing::{debug, info, warn};

use super::config::Config;
use super::supervisor::Supervisor;

const PROJECT_KIND: u16 = 31933;
const BOOT_KIND: u16 = 24000;

/// Tracks `--boot <prefix>` requests waiting for a matching project discovery.
/// `pending` shrinks as prefixes are matched against newly-discovered d-tags;
/// `consumed` retains them so a later discovery that would have also matched
/// an already-booted prefix can be reported as ambiguous.
struct PendingBoots {
    pending: Vec<String>,
    consumed: Vec<(String, String)>,
}

struct RuntimeCtx<'a> {
    client: &'a Client,
    supervisor: &'a Supervisor,
    known: Arc<Mutex<HashSet<String>>>,
    boot_sub: Arc<Mutex<Option<SubscriptionId>>>,
    pending_boots: &'a Mutex<PendingBoots>,
    authors: &'a [PublicKey],
    startup_ts: Timestamp,
    debounce_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
}

pub async fn run(
    cfg: Config,
    backend_keys: Keys,
    supervisor: Supervisor,
    pending_boot_prefixes: Vec<String>,
) -> Result<JoinHandle<()>> {
    let authors: Vec<PublicKey> = cfg
        .whitelisted_pubkeys
        .iter()
        .filter_map(|pk| match PublicKey::from_hex(pk) {
            Ok(p) => Some(p),
            Err(e) => {
                warn!(pubkey = pk, error = %e, "ignoring invalid whitelisted pubkey");
                None
            }
        })
        .collect();

    if authors.is_empty() {
        return Err(anyhow!("no valid whitelisted pubkeys"));
    }

    let client = Client::new(backend_keys);
    for relay in &cfg.relays {
        if let Err(e) = client.add_relay(relay.as_str()).await {
            warn!(relay, error = %e, "add_relay failed");
        }
    }
    client.connect().await;
    info!(relays = cfg.relays.len(), "connected to relays");

    let discovery_filter = Filter::new()
        .kind(Kind::Custom(PROJECT_KIND))
        .authors(authors.clone());
    let discovery_id = SubscriptionId::generate();
    client
        .subscribe_with_id(discovery_id, discovery_filter, None)
        .await?;
    info!("project discovery subscription active");

    // Bound the boot-trigger filter to events published after the supervisor
    // came up. Otherwise every historical kind:1/24000 a-tagging a known
    // project would replay on startup and warm-boot the whole fleet.
    // Use --boot to explicitly start a project regardless of recent activity.
    let startup_ts = Timestamp::from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    );

    let known: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let boot_sub: Arc<Mutex<Option<SubscriptionId>>> = Arc::new(Mutex::new(None));
    let pending_boots: Arc<Mutex<PendingBoots>> = Arc::new(Mutex::new(PendingBoots {
        pending: pending_boot_prefixes
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect(),
        consumed: Vec::new(),
    }));
    let debounce_handle: Arc<Mutex<Option<JoinHandle<()>>>> = Arc::new(Mutex::new(None));

    let task_client = client.clone();
    let handle = tokio::spawn(async move {
        let mut notifications = task_client.notifications();
        while let Ok(notification) = notifications.recv().await {
            if let RelayPoolNotification::Event { event, .. } = notification {
                let ctx = RuntimeCtx {
                    client: &task_client,
                    supervisor: &supervisor,
                    known: Arc::clone(&known),
                    boot_sub: Arc::clone(&boot_sub),
                    pending_boots: &pending_boots,
                    authors: &authors,
                    startup_ts,
                    debounce_handle: Arc::clone(&debounce_handle),
                };
                handle_event(&ctx, &event).await;
            }
        }
    });

    Ok(handle)
}

async fn handle_event(ctx: &RuntimeCtx<'_>, event: &Event) {
    match event.kind.as_u16() {
        PROJECT_KIND => handle_project(ctx, event).await,
        1 => handle_boot_trigger(ctx.supervisor, &ctx.known, event, BootKind::TextNote).await,
        BOOT_KIND => {
            handle_boot_trigger(ctx.supervisor, &ctx.known, event, BootKind::Explicit).await
        }
        _ => {}
    }
}

async fn handle_project(ctx: &RuntimeCtx<'_>, event: &Event) {
    let Some(d_tag) = single_letter_tag(event, Alphabet::D) else {
        debug!(event_id = %event.id, "kind 31933 missing d-tag; ignoring");
        return;
    };
    let address = format!("{}:{}:{}", PROJECT_KIND, event.pubkey.to_hex(), d_tag);

    let inserted = {
        let mut k = ctx.known.lock().await;
        k.insert(address.clone())
    };
    if !inserted {
        return;
    }

    debug!(d_tag, address, "project discovered");

    let matched_prefixes = resolve_pending_boots(ctx.pending_boots, &d_tag).await;
    for prefix in matched_prefixes {
        info!(prefix, d_tag, "matched --boot prefix to discovered project");
        ctx.supervisor.boot(d_tag.clone()).await;
    }

    // Debounce: cancel any pending refresh and schedule a new one. During the
    // initial burst of 31933 events this collapses N refreshes into one.
    {
        let mut dh = ctx.debounce_handle.lock().await;
        if let Some(h) = dh.take() {
            h.abort();
        }
        let client = ctx.client.clone();
        let boot_sub = Arc::clone(&ctx.boot_sub);
        let known = Arc::clone(&ctx.known);
        let authors: Vec<PublicKey> = ctx.authors.to_vec();
        let startup_ts = ctx.startup_ts;
        *dh = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let addresses: Vec<String> = {
                let k = known.lock().await;
                k.iter().cloned().collect()
            };
            if let Err(e) =
                update_boot_subscription(&client, &boot_sub, &authors, startup_ts, &addresses).await
            {
                warn!(error = %e, "failed to update boot trigger subscription");
            }
        }));
    }
}

/// Pop every pending prefix that the freshly-discovered d-tag starts with,
/// move them into `consumed`, and warn for any already-consumed prefix that
/// would have also matched this discovery (first-match-wins ambiguity).
async fn resolve_pending_boots(pending_boots: &Mutex<PendingBoots>, d_tag: &str) -> Vec<String> {
    let mut pb = pending_boots.lock().await;
    let mut matched: Vec<String> = Vec::new();
    pb.pending.retain(|prefix| {
        if d_tag.starts_with(prefix) {
            matched.push(prefix.clone());
            false
        } else {
            true
        }
    });
    for p in &matched {
        pb.consumed.push((p.clone(), d_tag.to_string()));
    }
    for (prefix, prior_d_tag) in &pb.consumed {
        if prior_d_tag != d_tag && d_tag.starts_with(prefix) {
            warn!(
                prefix = %prefix,
                booted = %prior_d_tag,
                also_matches = %d_tag,
                "ambiguous --boot prefix: already booted earlier match; ignoring later discovery"
            );
        }
    }
    matched
}

#[derive(Debug)]
enum BootKind {
    TextNote,
    Explicit,
}

async fn handle_boot_trigger(
    supervisor: &Supervisor,
    known: &Mutex<HashSet<String>>,
    event: &Event,
    kind: BootKind,
) {
    info!(?kind, event_id = %event.id, pubkey = %event.pubkey, "boot trigger event received");

    let a_tags = a_tag_values(event);
    if a_tags.is_empty() {
        info!(?kind, event_id = %event.id, "boot trigger rejected: no #a tags");
        return;
    }

    let k = known.lock().await;
    let known_snapshot: Vec<String> = k.iter().cloned().collect();
    let matched: Option<String> = a_tags.iter().find(|a| k.contains(*a)).cloned();
    drop(k);

    let Some(address) = matched else {
        info!(
            ?kind,
            event_id = %event.id,
            a_tags = ?a_tags,
            known_projects = ?known_snapshot,
            "boot trigger rejected: no #a tag matches a known project",
        );
        return;
    };

    let parts: Vec<&str> = address.splitn(3, ':').collect();
    if parts.len() != 3 {
        warn!(address, "malformed project address; cannot extract d-tag");
        return;
    }
    let d_tag = parts[2].to_string();

    info!(d_tag, ?kind, event_id = %event.id, "boot trigger");
    supervisor.boot(d_tag).await;
}

async fn update_boot_subscription(
    client: &Client,
    boot_sub: &Mutex<Option<SubscriptionId>>,
    authors: &[PublicKey],
    startup_ts: Timestamp,
    addresses: &[String],
) -> Result<()> {
    let new_id = SubscriptionId::generate();
    let filter = Filter::new()
        .kinds([Kind::TextNote, Kind::Custom(BOOT_KIND)])
        .authors(authors.to_vec())
        .since(startup_ts)
        .custom_tags(
            SingleLetterTag::lowercase(Alphabet::A),
            addresses.iter().map(|s| s.as_str()),
        );

    let mut sub = boot_sub.lock().await;
    if let Some(old) = sub.replace(new_id.clone()) {
        client.unsubscribe(&old).await;
    }
    client.subscribe_with_id(new_id, filter, None).await?;
    Ok(())
}

fn single_letter_tag(event: &Event, letter: Alphabet) -> Option<String> {
    let want = TagKind::SingleLetter(SingleLetterTag::lowercase(letter));
    for tag in event.tags.iter() {
        if tag.kind() == want {
            return tag.content().map(|s| s.to_string());
        }
    }
    None
}

fn a_tag_values(event: &Event) -> Vec<String> {
    let want = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::A));
    let mut out = Vec::new();
    for tag in event.tags.iter() {
        if tag.kind() == want {
            if let Some(c) = tag.content() {
                out.push(c.to_string());
            }
        }
    }
    out
}
