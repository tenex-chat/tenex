//! Subscribe to kind:513 conversation-metadata events from relays and
//! apply them to the local conversation DB.
//!
//! Backends that do not own the project's PM agent skip the LLM
//! summarization pass entirely (see `scheduler.rs`); this task is what
//! keeps their local conversation metadata in sync with the PM-owning
//! backend's output. Events are authenticated against the PM agent
//! pubkey listed first in the project's kind:31933 event — so an event
//! signed by anything other than that key for the project is dropped.
//!
//! The subscription is refreshed periodically: the daemon walks the
//! local project list, computes each project's `a` coordinate and PM
//! pubkey, and resubscribes when the set changes (e.g. a new project
//! arrived, or PM ownership rotated to another agent).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use nostr::event::Event;
use nostr::filter::Filter;
use nostr::key::Keys;
use nostr::types::Timestamp;
use nostr::{Alphabet, Kind, SingleLetterTag};
use nostr_sdk::{Client, ClientOptions, RelayPoolNotification, SubscriptionId};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::categories;
use crate::paths;
use crate::source::{self, MetadataUpdate};

const KIND_EVENT_METADATA: u16 = 513;
const REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const BACKFILL_SECS: u64 = 7 * 24 * 60 * 60;

/// Public entry point. Connects to relays, subscribes to kind:513 events
/// scoped to the locally-known projects, and writes metadata into each
/// project's `conversation.db` until `shutdown` fires.
pub async fn run(
    backend_secret_key: &str,
    relays: &[String],
    mut shutdown: mpsc::Receiver<()>,
) -> Result<()> {
    let keys = Keys::parse(backend_secret_key).context("parse backend secret key")?;
    let client = Client::builder()
        .signer(keys)
        .opts(ClientOptions::new().automatic_authentication(true))
        .build();
    for relay in relays {
        client
            .add_relay(relay.as_str())
            .await
            .with_context(|| format!("add relay {relay}"))?;
    }
    client.connect().await;

    info!(relays = ?relays, "tenex-summarizer ingest task started");

    let mut current_sub: Option<SubscriptionId> = None;
    let mut current_targets: HashMap<String, IngestTarget> = HashMap::new();

    refresh_subscription(&client, &mut current_sub, &mut current_targets).await;
    let mut refresh_ticker = tokio::time::interval(REFRESH_INTERVAL);
    refresh_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let _ = refresh_ticker.tick().await; // skip the immediate first tick — already refreshed

    let mut notifications = client.notifications();

    loop {
        tokio::select! {
            _ = shutdown.recv() => {
                info!("ingest task shutdown received");
                if let Some(id) = current_sub.take() {
                    client.unsubscribe(&id).await;
                }
                client.disconnect().await;
                return Ok(());
            }
            _ = refresh_ticker.tick() => {
                refresh_subscription(&client, &mut current_sub, &mut current_targets).await;
            }
            msg = notifications.recv() => {
                match msg {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        handle_event(&current_targets, *event);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        warn!(error = %e, "ingest relay notification error");
                    }
                }
            }
        }
    }
}

/// Per-project ingestion target: the location to write into and the PM
/// pubkey that authorizes events for the project's `a` coordinate.
#[derive(Debug, Clone)]
struct IngestTarget {
    d_tag: String,
    project_root: PathBuf,
    conversation_db: PathBuf,
    pm_pubkey: String,
}

async fn refresh_subscription(
    client: &Client,
    current_sub: &mut Option<SubscriptionId>,
    current_targets: &mut HashMap<String, IngestTarget>,
) {
    let new_targets = match build_targets() {
        Ok(t) => t,
        Err(e) => {
            warn!(error = ?e, "ingest: failed to build target set");
            return;
        }
    };

    if targets_eq(current_targets, &new_targets) {
        return;
    }

    if let Some(prev) = current_sub.take() {
        client.unsubscribe(&prev).await;
    }

    *current_targets = new_targets;

    if current_targets.is_empty() {
        debug!("ingest: no projects with PM identity; subscription idle");
        return;
    }

    let coords: Vec<String> = current_targets.keys().cloned().collect();
    let since =
        Timestamp::from(now_secs().saturating_sub(BACKFILL_SECS as i64).max(0) as u64);
    let filter = Filter::new()
        .kind(Kind::Custom(KIND_EVENT_METADATA))
        .custom_tags(
            SingleLetterTag::lowercase(Alphabet::A),
            coords.iter().map(|s| s.as_str()),
        )
        .since(since);

    let id = SubscriptionId::generate();
    match client.subscribe_with_id(id.clone(), filter, None).await {
        Ok(_) => {
            info!(projects = current_targets.len(), "ingest: subscribed to kind:513");
            *current_sub = Some(id);
        }
        Err(e) => {
            warn!(error = %e, "ingest: subscribe failed");
        }
    }
}

fn targets_eq(a: &HashMap<String, IngestTarget>, b: &HashMap<String, IngestTarget>) -> bool {
    if a.len() != b.len() {
        return false;
    }
    for (coord, target) in a {
        match b.get(coord) {
            Some(other) if other.pm_pubkey == target.pm_pubkey => {}
            _ => return false,
        }
    }
    true
}

/// Walk the local project list and produce one ingest target per
/// project this backend does *not* own the PM for. PM-owned projects
/// are excluded: this backend already writes their metadata via the
/// scheduler's publish path, and adding them here would re-apply the
/// relay echo of every published event — double-counting categories
/// on the global tally.
fn build_targets() -> Result<HashMap<String, IngestTarget>> {
    let base_dir = paths::base_dir();
    let projects = source::discover_projects()?;
    let mut out = HashMap::new();
    for project in projects {
        let project_event = match source::load_project_event(&project) {
            Ok(p) => p,
            Err(e) => {
                debug!(d_tag = %project.d_tag, error = %e, "ingest: skip project, bad event.json");
                continue;
            }
        };
        let pm_pubkey = match source::pm_identity(&project.d_tag, &base_dir) {
            Ok(Some(pm)) if pm.local_signer.is_some() => continue,
            Ok(Some(pm)) => pm.pubkey,
            Ok(None) => continue,
            Err(e) => {
                debug!(d_tag = %project.d_tag, error = ?e, "ingest: skip project, pm identity failed");
                continue;
            }
        };
        out.insert(
            project_event.tag_id(),
            IngestTarget {
                d_tag: project.d_tag.clone(),
                project_root: project.root.clone(),
                conversation_db: project.conversation_db.clone(),
                pm_pubkey,
            },
        );
    }
    Ok(out)
}

fn handle_event(targets: &HashMap<String, IngestTarget>, event: Event) {
    if event.kind != Kind::Custom(KIND_EVENT_METADATA) {
        return;
    }

    let coord = match a_coordinate(&event) {
        Some(c) => c,
        None => {
            debug!(event_id = %event.id, "ingest: kind:513 with no a-tag, dropping");
            return;
        }
    };

    let target = match targets.get(&coord) {
        Some(t) => t,
        None => {
            debug!(coord = %coord, "ingest: kind:513 for unknown project, dropping");
            return;
        }
    };

    let author = event.pubkey.to_hex();
    if author != target.pm_pubkey {
        warn!(
            coord = %coord,
            author = %author,
            expected = %target.pm_pubkey,
            "ingest: kind:513 author is not project PM, dropping"
        );
        return;
    }

    let conversation_id = match e_tag(&event) {
        Some(id) => id,
        None => {
            debug!(coord = %coord, "ingest: kind:513 with no e-tag, dropping");
            return;
        }
    };

    let parsed = parse_metadata_tags(&event);

    if let Err(e) = apply_metadata(target, &conversation_id, &parsed) {
        warn!(
            d_tag = %target.d_tag,
            conversation_id = %conversation_id,
            error = %e,
            "ingest: apply metadata failed"
        );
        return;
    }

    if !parsed.categories.is_empty() {
        if let Err(e) = categories::record(&parsed.categories) {
            warn!(error = %e, "ingest: categories.record failed");
        }
    }

    debug!(
        d_tag = %target.d_tag,
        conversation_id = %conversation_id,
        "ingest: applied kind:513 metadata"
    );
}

#[derive(Debug, Default)]
struct ParsedTags {
    title: Option<String>,
    summary: Option<String>,
    status_label: Option<String>,
    status_current_activity: Option<String>,
    categories: Vec<String>,
}

fn parse_metadata_tags(event: &Event) -> ParsedTags {
    let mut out = ParsedTags::default();
    for tag in event.tags.iter() {
        let s = tag.as_slice();
        if s.len() < 2 {
            continue;
        }
        match s[0].as_str() {
            "title" => out.title = non_empty(&s[1]),
            "summary" => out.summary = non_empty(&s[1]),
            "status-label" => out.status_label = non_empty(&s[1]),
            "status-current-activity" => out.status_current_activity = non_empty(&s[1]),
            "t" => {
                if let Some(v) = non_empty(&s[1]) {
                    out.categories.push(v);
                }
            }
            _ => {}
        }
    }
    out
}

fn apply_metadata(
    target: &IngestTarget,
    conversation_id: &str,
    parsed: &ParsedTags,
) -> Result<()> {
    let project = tenex_conversations::ProjectRef {
        d_tag: target.d_tag.clone(),
        root: target.project_root.clone(),
        conversation_db: target.conversation_db.clone(),
    };
    let update = MetadataUpdate {
        title: parsed.title.clone(),
        summary: parsed.summary.clone(),
        status_label: parsed.status_label.clone(),
        status_current_activity: parsed.status_current_activity.clone(),
    };
    source::write_metadata(&project, conversation_id, &update)
}

fn a_coordinate(event: &Event) -> Option<String> {
    for tag in event.tags.iter() {
        let s = tag.as_slice();
        if s.len() >= 2 && s[0] == "a" && s[1].starts_with("31933:") {
            return Some(s[1].clone());
        }
    }
    None
}

fn e_tag(event: &Event) -> Option<String> {
    for tag in event.tags.iter() {
        let s = tag.as_slice();
        if s.len() >= 2 && s[0] == "e" {
            return Some(s[1].clone());
        }
    }
    None
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
