//! Nostr subscription layer.
//!
//! Three filters:
//!   - Discovery: kind 31933 from whitelisted authors (no `since` — relay
//!     returns latest replaceable per d-tag).
//!   - Boot triggers: kind 1 + 24000 from whitelisted authors or this
//!     backend's own pubkey that #a-tag a known project. Resubscribed every
//!     time a new project is discovered.
//!   - Remote project status: kind 24010 p-tagged with any whitelisted user.
//!     When a remote backend is running a project that this backend has
//!     locally-signable agents for (and none overlap), auto-boot that project.
//!
//! Trust enforcement is relay-side via `authors` for discovery/boot filters.
//! The 24010 filter uses p-tag targeting instead of author filtering because
//! the publisher is a backend signer, not a whitelisted user.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::Instant;

use anyhow::{anyhow, Context, Result};
use nostr_sdk::prelude::*;
use notify::{
    Config as NotifyConfig, Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher,
};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::Duration;
use tracing::{debug, info, warn};

use super::boot_policy::{decide_boot, BootDecision, SkippedProjects};
use super::config::Config;
use super::display;
use super::identity_watch::push_remote_pubkey_watch;
use super::pending_boots::{self, PendingBoots};
use super::supervisor::Supervisor;
use crate::store::atomic;
use tenex_project;

const PROJECT_KIND: u16 = 31933;
const BOOT_KIND: u16 = 24000;
const PROJECT_STATUS_KIND: u16 = 24010;

struct RuntimeCtx<'a> {
    client: &'a Client,
    supervisor: &'a Supervisor,
    known: Arc<Mutex<HashSet<String>>>,
    boot_sub: Arc<Mutex<Option<SubscriptionId>>>,
    pending_boots: &'a Mutex<PendingBoots>,
    boot_authors: &'a [PublicKey],
    startup_ts: Timestamp,
    debounce_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
    base_dir: &'a Path,
    backend_pubkey: PublicKey,
    skipped_projects: Arc<SkippedProjects>,
    ignored_projects: &'a [String],
    only_projects: &'a [String],
    /// Projects already evaluated from a remote 24010: either booted or
    /// confirmed overlapping. Re-evaluation on every 30-second pulse is
    /// suppressed once a decision has been logged.
    remote_status_seen: Arc<Mutex<HashSet<String>>>,
    /// Timestamp of the last project boot triggered by a 24010 event.
    /// Enforces a minimum 5-second gap between successive 24010-driven boots
    /// to avoid a relay connection storm when many historical events arrive at
    /// startup.
    remote_status_boot_limiter: Arc<Mutex<Option<Instant>>>,
}

impl RuntimeCtx<'_> {
    fn decide(&self, d_tag: &str) -> BootDecision {
        decide_boot(
            self.base_dir,
            self.ignored_projects,
            self.only_projects,
            d_tag,
        )
    }
}

pub async fn run(
    cfg: Config,
    base_dir: PathBuf,
    client: Client,
    backend_pubkey: PublicKey,
    supervisor: Supervisor,
    pending_boot_prefixes: Vec<String>,
    skipped_projects: Arc<SkippedProjects>,
) -> Result<JoinHandle<()>> {
    let discovery_authors: Vec<PublicKey> = cfg
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

    if discovery_authors.is_empty() {
        return Err(anyhow!("no valid whitelisted pubkeys"));
    }

    let mut boot_authors = discovery_authors.clone();
    push_unique_pubkey(&mut boot_authors, backend_pubkey);

    display::watching(cfg.relays.len());

    let discovery_filter = Filter::new()
        .kind(Kind::Custom(PROJECT_KIND))
        .authors(discovery_authors.clone());
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

    // Subscribe to project status events (kind:24010) p-tagged with any
    // whitelisted user.  These are published by *other* backends running a
    // project runtime and let this daemon detect projects it should auto-boot.
    let status_filter = Filter::new()
        .kind(Kind::Custom(PROJECT_STATUS_KIND))
        .custom_tags(
            SingleLetterTag::lowercase(Alphabet::P),
            discovery_authors.iter().map(|pk| pk.to_hex()),
        );
    let status_id = SubscriptionId::generate();
    client
        .subscribe_with_id(status_id, status_filter, None)
        .await?;
    info!("project status (24010) subscription active");

    let known: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let boot_sub: Arc<Mutex<Option<SubscriptionId>>> = Arc::new(Mutex::new(None));
    let pending_boots: Arc<Mutex<PendingBoots>> =
        Arc::new(Mutex::new(PendingBoots::new(pending_boot_prefixes)));
    let debounce_handle: Arc<Mutex<Option<JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    let remote_status_seen: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let remote_status_boot_limiter: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));

    let agents_dir = base_dir.join("agents");
    std::fs::create_dir_all(&agents_dir)
        .with_context(|| format!("creating agents dir {}", agents_dir.display()))?;
    let (agent_fs_tx, mut agent_fs_rx) =
        tokio::sync::mpsc::channel::<Result<NotifyEvent, notify::Error>>(64);
    let mut agent_watcher = RecommendedWatcher::new(
        move |res| {
            let _ = agent_fs_tx.blocking_send(res);
        },
        NotifyConfig::default(),
    )
    .context("create agents-dir watcher")?;
    agent_watcher
        .watch(&agents_dir, RecursiveMode::NonRecursive)
        .with_context(|| format!("watch agents dir {}", agents_dir.display()))?;

    let task_client = client.clone();
    let task_ignored_projects = cfg.ignored_projects.clone();
    let task_only_projects = cfg.only_projects.clone();
    let handle = tokio::spawn(async move {
        // Keep watcher alive for the life of the loop.
        let _agent_watcher = agent_watcher;
        let mut notifications = task_client.notifications();
        loop {
            tokio::select! {
                notification = notifications.recv() => {
                    match notification {
                        Ok(RelayPoolNotification::Event { event, .. }) => {
                            let ctx = RuntimeCtx {
                                client: &task_client,
                                supervisor: &supervisor,
                                known: Arc::clone(&known),
                                boot_sub: Arc::clone(&boot_sub),
                                pending_boots: &pending_boots,
                                boot_authors: &boot_authors,
                                startup_ts,
                                debounce_handle: Arc::clone(&debounce_handle),
                                base_dir: &base_dir,
                                backend_pubkey,
                                skipped_projects: Arc::clone(&skipped_projects),
                                ignored_projects: &task_ignored_projects,
                                only_projects: &task_only_projects,
                                remote_status_seen: Arc::clone(&remote_status_seen),
                                remote_status_boot_limiter: Arc::clone(&remote_status_boot_limiter),
                            };
                            handle_event(&ctx, &event).await;
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
                Some(fs_event) = agent_fs_rx.recv() => {
                    let event = match fs_event {
                        Ok(e) => e,
                        Err(error) => {
                            warn!(%error, "agents-dir watcher error");
                            continue;
                        }
                    };
                    if !agent_event_is_relevant(&event) {
                        continue;
                    }
                    let ctx = RuntimeCtx {
                        client: &task_client,
                        supervisor: &supervisor,
                        known: Arc::clone(&known),
                        boot_sub: Arc::clone(&boot_sub),
                        pending_boots: &pending_boots,
                        boot_authors: &boot_authors,
                        startup_ts,
                        debounce_handle: Arc::clone(&debounce_handle),
                        base_dir: &base_dir,
                        backend_pubkey,
                        skipped_projects: Arc::clone(&skipped_projects),
                        ignored_projects: &task_ignored_projects,
                        only_projects: &task_only_projects,
                        remote_status_seen: Arc::clone(&remote_status_seen),
                        remote_status_boot_limiter: Arc::clone(&remote_status_boot_limiter),
                    };
                    retry_skipped_boots(&ctx).await;
                }
            }
        }
    });

    Ok(handle)
}

fn agent_event_is_relevant(event: &NotifyEvent) -> bool {
    event.paths.iter().any(|path| {
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension == "json")
    })
}

/// Re-evaluate every project we previously deferred. Triggered when a new
/// agent JSON file lands in `<base_dir>/agents/`, which may have flipped
/// the local-agent gate from no→yes for one or more deferred projects.
async fn retry_skipped_boots(ctx: &RuntimeCtx<'_>) {
    for d_tag in ctx.skipped_projects.snapshot().await {
        if let BootDecision::Allow = ctx.decide(&d_tag) {
            if ctx.skipped_projects.clear(&d_tag).await {
                info!(d_tag, "project now bootable — agents available locally");
            }
            ctx.supervisor.boot(d_tag).await;
        }
    }
}

async fn handle_event(ctx: &RuntimeCtx<'_>, event: &Event) {
    match event.kind.as_u16() {
        PROJECT_KIND => handle_project(ctx, event).await,
        1 => handle_boot_trigger(ctx, event, BootKind::TextNote).await,
        BOOT_KIND => handle_boot_trigger(ctx, event, BootKind::Explicit).await,
        PROJECT_STATUS_KIND => handle_project_status(ctx, event).await,
        _ => {}
    }
}

async fn handle_project(ctx: &RuntimeCtx<'_>, event: &Event) {
    let Some(d_tag) = single_letter_tag(event, Alphabet::D) else {
        debug!(event_id = %event.id, "kind 31933 missing d-tag; ignoring");
        return;
    };
    let address = format!("{}:{}:{}", PROJECT_KIND, event.pubkey.to_hex(), d_tag);

    // Persist the 31933 whenever the relay's copy is newer than what's on disk.
    // This must run before the per-session dedupe below: kind:31933 is a
    // replaceable event, so a republished version (e.g. updated p-tags) must
    // overwrite the cached `event.json` even when the project has already been
    // discovered this session — otherwise `tenex runtime <d_tag>` keeps
    // booting against stale membership.
    let event_path = ctx
        .base_dir
        .join("projects")
        .join(&d_tag)
        .join("event.json");
    let should_write = match std::fs::read(&event_path) {
        Err(_) => true,
        Ok(existing) => {
            let existing_created_at = serde_json::from_slice::<serde_json::Value>(&existing)
                .ok()
                .and_then(|v| v["created_at"].as_u64())
                .unwrap_or(0);
            event.created_at.as_secs() > existing_created_at
        }
    };
    if should_write {
        if let Err(e) = atomic::write(&event_path, event.as_json().as_bytes()) {
            warn!(d_tag, error = %e, "failed to persist project event");
        }
    }

    let inserted = {
        let mut k = ctx.known.lock().await;
        k.insert(address.clone())
    };
    let was_skipped = ctx.skipped_projects.contains(&d_tag).await;
    // Already-booted republish with no membership change for the boot
    // gate: nothing to do. (Skipped projects fall through so a new
    // member list can flip the decision.)
    if !inserted && !was_skipped {
        return;
    }

    debug!(d_tag, address, "project discovered");

    // Discovery alone never boots a runtime: registering the project as
    // known is enough for kind:1 / kind:24000 triggers to wake it on real
    // user activity. Auto-booting every discovered project caused a
    // startup-time connection + REQ storm against the relay (every project
    // with local agents would spawn its own runtime within the same tick).
    // Explicit `--boot <prefix>` matches below still warm a project on
    // demand.
    let decision = ctx.decide(&d_tag);
    match decision {
        BootDecision::Allow => {
            if ctx.skipped_projects.clear(&d_tag).await {
                info!(d_tag, "project now bootable — agents available locally");
            }
        }
        BootDecision::Filtered | BootDecision::NoLocalAgents => {
            ctx.skipped_projects
                .record(&d_tag, decision.skip_reason().unwrap_or("unknown"))
                .await;
        }
    }

    // First-discovery side effects: --boot prefix matching and
    // boot-trigger subscription refresh. Skip on republish — the
    // address is already known and already in the boot filter.
    if !inserted {
        return;
    }

    let matched_prefixes = pending_boots::resolve(ctx.pending_boots, &d_tag).await;
    for prefix in matched_prefixes {
        match decision {
            BootDecision::Allow => {
                info!(prefix, d_tag, "matched --boot prefix; booting discovered project");
                ctx.supervisor.boot(d_tag.clone()).await;
            }
            BootDecision::Filtered | BootDecision::NoLocalAgents => {
                info!(
                    prefix,
                    d_tag,
                    "matched --boot prefix but project is filtered or has no local agents; not booting"
                );
            }
        }
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
        let boot_authors: Vec<PublicKey> = ctx.boot_authors.to_vec();
        let startup_ts = ctx.startup_ts;
        let base_dir = ctx.base_dir.to_path_buf();
        let backend_pubkey = ctx.backend_pubkey;
        *dh = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let addresses: Vec<String> = {
                let k = known.lock().await;
                k.iter().cloned().collect()
            };
            if let Err(e) =
                update_boot_subscription(&client, &boot_sub, &boot_authors, startup_ts, &addresses)
                    .await
            {
                warn!(error = %e, "failed to update boot trigger subscription");
            }
            if let Err(e) =
                push_remote_pubkey_watch(&base_dir, &addresses, &backend_pubkey).await
            {
                warn!(error = %e, "failed to update remote-pubkey kind:0 watch");
            }
        }));
    }
}

#[derive(Debug)]
enum BootKind {
    TextNote,
    Explicit,
}

async fn handle_boot_trigger(ctx: &RuntimeCtx<'_>, event: &Event, kind: BootKind) {
    info!(?kind, event_id = %event.id, pubkey = %event.pubkey, "boot trigger event received");

    let a_tags = a_tag_values(event);
    if a_tags.is_empty() {
        info!(?kind, event_id = %event.id, "boot trigger rejected: no #a tags");
        return;
    }

    let k = ctx.known.lock().await;
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

    let decision = ctx.decide(&d_tag);
    match decision {
        BootDecision::Allow => {
            // The project may have been deferred earlier (e.g. a kind:0
            // sync race); a successful trigger means we're booting now.
            ctx.skipped_projects.clear(&d_tag).await;
            display::project_booted(&d_tag);
            ctx.supervisor.boot(d_tag).await;
        }
        BootDecision::Filtered | BootDecision::NoLocalAgents => {
            ctx.skipped_projects
                .record(&d_tag, decision.skip_reason().unwrap_or("unknown"))
                .await;
        }
    }
}

/// Handle a kind:24010 project status event from a remote backend.
///
/// Auto-boots the project when this backend has locally-signable agents that
/// are not already covered by the remote backend's running agent set.  Skips
/// if our own backend published the event, if the project is already running,
/// or if any local agent overlaps with the remote agent list.
async fn handle_project_status(ctx: &RuntimeCtx<'_>, event: &Event) {
    // Only react to 24010 from other backends.
    if event.pubkey == ctx.backend_pubkey {
        return;
    }

    let Some(a_value) = single_letter_tag(event, Alphabet::A) else {
        debug!(event_id = %event.id, "24010 missing a-tag; ignoring");
        return;
    };

    // a-tag format: "31933:<owner_pk>:<d_tag>"
    let d_tag = match a_value.splitn(3, ':').nth(2) {
        Some(d) if !d.is_empty() => d.to_string(),
        _ => {
            debug!(a_value, "24010 a-tag has unexpected format; ignoring");
            return;
        }
    };

    // Suppress repeated evaluation of the same project (24010 fires every 30s).
    {
        let seen = ctx.remote_status_seen.lock().await;
        if seen.contains(&d_tag) {
            return;
        }
    }

    // Apply operator filters and local-agent gate.
    match ctx.decide(&d_tag) {
        BootDecision::Allow => {}
        BootDecision::Filtered | BootDecision::NoLocalAgents => {
            return;
        }
    }

    // Collect remote agent pubkeys from ["agent", <pubkey>, <slug>] tags.
    let remote_pubkeys: HashSet<String> = event
        .tags
        .iter()
        .filter_map(|t| {
            let s = t.as_slice();
            if s.first().map(String::as_str) == Some("agent") {
                s.get(1).cloned()
            } else {
                None
            }
        })
        .collect();

    // Collect our locally-signable agent pubkeys for this project.
    let local_pubkeys: HashSet<String> =
        match tenex_project::Project::open(&d_tag, ctx.base_dir) {
            Ok(p) => match p.agents() {
                Ok(agents) => agents.into_iter().map(|a| a.pubkey).collect(),
                Err(e) => {
                    warn!(d_tag, error = %e, "failed to read local agents for 24010 auto-boot check");
                    return;
                }
            },
            Err(e) => {
                debug!(d_tag, error = %e, "project not on disk; skipping 24010 auto-boot");
                return;
            }
        };

    if local_pubkeys.is_empty() {
        return;
    }

    let has_overlap = local_pubkeys.iter().any(|pk| remote_pubkeys.contains(pk));
    if has_overlap {
        info!(
            d_tag,
            remote_pubkey = %event.pubkey,
            "24010 received: local agents overlap with remote backend; not auto-booting"
        );
        ctx.remote_status_seen.lock().await.insert(d_tag);
        return;
    }

    const REMOTE_STATUS_BOOT_INTERVAL: Duration = Duration::from_secs(5);
    {
        let mut last = ctx.remote_status_boot_limiter.lock().await;
        if let Some(t) = *last {
            if t.elapsed() < REMOTE_STATUS_BOOT_INTERVAL {
                info!(
                    d_tag,
                    remote_pubkey = %event.pubkey,
                    elapsed_ms = t.elapsed().as_millis(),
                    "24010 auto-boot deferred: rate limit (1 per 5s); will retry on next pulse"
                );
                // Don't mark as seen — let it be re-evaluated on the next 24010 pulse.
                return;
            }
        }
        *last = Some(Instant::now());
    }
    info!(
        d_tag,
        remote_pubkey = %event.pubkey,
        "24010 received: local agents not covered by remote backend; auto-booting"
    );
    ctx.remote_status_seen.lock().await.insert(d_tag.clone());
    ctx.skipped_projects.clear(&d_tag).await;
    ctx.supervisor.boot(d_tag).await;
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

fn push_unique_pubkey(pubkeys: &mut Vec<PublicKey>, pubkey: PublicKey) {
    if !pubkeys.contains(&pubkey) {
        pubkeys.push(pubkey);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_unique_pubkey_dedupes_backend_author() {
        let keys = Keys::generate();
        let pubkey = keys.public_key();
        let mut authors = vec![pubkey];

        push_unique_pubkey(&mut authors, pubkey);

        assert_eq!(authors, vec![pubkey]);
    }
}
