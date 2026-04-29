//! Main intervention daemon: subscribes to Nostr, manages per-conversation
//! timers, publishes review-request events on timeout.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use nostr_sdk::prelude::*;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};

use crate::config::Config;
use crate::detector;
use crate::model::{InterventionState, NotifiedEntry, PendingIntervention};
use crate::publish::Publisher;
use crate::resolver;
use crate::state;

const MAX_RETRY_ATTEMPTS: u32 = 5;
const RETRY_BASE_MS: u64 = 30_000;

struct DaemonState {
    /// conversation_id → pending entry.
    pending: HashMap<String, PendingIntervention>,
    /// conversation_id → notified_at_ms.
    notified: HashMap<String, u64>,
    /// conversation_id → running timer handle.
    timers: HashMap<String, JoinHandle<()>>,
}

impl DaemonState {
    fn new() -> Self {
        Self {
            pending: HashMap::new(),
            notified: HashMap::new(),
            timers: HashMap::new(),
        }
    }
}

pub async fn run(cfg: Config) -> Result<()> {
    if !cfg.intervention_enabled {
        info!("intervention is disabled (intervention.enabled = false)");
        return Ok(());
    }

    let agent_slug = match &cfg.intervention_agent {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => {
            error!("intervention enabled but no agent slug configured (intervention.agent)");
            return Ok(());
        }
    };

    let publisher = Arc::new(
        Publisher::new(&cfg.backend_secret_key, &cfg.relays)
            .await
            .context("init publisher")?,
    );

    let whitelisted: Arc<Vec<String>> = Arc::new(cfg.whitelisted_pubkeys.clone());
    let timeout_ms = cfg.timeout_ms;

    // Load per-project state from disk and rebuild catch-up timers.
    let ds: Arc<Mutex<DaemonState>> = Arc::new(Mutex::new(DaemonState::new()));
    let (trigger_tx, mut trigger_rx) = tokio::sync::mpsc::channel::<PendingIntervention>(64);

    load_all_project_states(Arc::clone(&ds), timeout_ms, trigger_tx.clone()).await;

    // Nostr subscription.
    let nostr_client = build_nostr_client(&cfg).await?;

    let white_pks: Vec<PublicKey> = cfg
        .whitelisted_pubkeys
        .iter()
        .filter_map(|pk| PublicKey::from_hex(pk).ok())
        .collect();

    // Filter 1: kind:1 that p-tags a whitelisted pubkey → completion candidates.
    let completion_filter = Filter::new()
        .kind(Kind::TextNote)
        .pubkeys(white_pks.iter().map(|pk| pk.to_owned()).collect::<Vec<_>>());

    // Filter 2: kind:1 from whitelisted authors → response candidates.
    let response_filter = Filter::new()
        .kind(Kind::TextNote)
        .authors(white_pks.clone());

    nostr_client
        .subscribe_with_id(SubscriptionId::generate(), completion_filter, None)
        .await?;
    nostr_client
        .subscribe_with_id(SubscriptionId::generate(), response_filter, None)
        .await?;

    info!(
        relays = cfg.relays.len(),
        agent_slug = %agent_slug,
        timeout_ms,
        "tenex-intervention daemon running"
    );

    let mut sigint = signal(SignalKind::interrupt()).context("SIGINT handler")?;
    let mut sigterm = signal(SignalKind::terminate()).context("SIGTERM handler")?;
    let mut notifications = nostr_client.notifications();

    loop {
        tokio::select! {
            _ = sigint.recv() => {
                info!("SIGINT received, shutting down");
                break;
            }
            _ = sigterm.recv() => {
                info!("SIGTERM received, shutting down");
                break;
            }
            Some(pending) = trigger_rx.recv() => {
                handle_trigger(
                    pending,
                    Arc::clone(&ds),
                    Arc::clone(&publisher),
                    Arc::clone(&whitelisted),
                    &agent_slug,
                    trigger_tx.clone(),
                ).await;
            }
            msg = notifications.recv() => {
                match msg {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        handle_event(
                            *event,
                            Arc::clone(&ds),
                            Arc::clone(&whitelisted),
                            timeout_ms,
                            &agent_slug,
                            trigger_tx.clone(),
                        )
                        .await;
                    }
                    Ok(_) => {}
                    Err(e) => warn!(error = %e, "relay notification error"),
                }
            }
        }
    }

    // Abort all timers.
    let mut guard = ds.lock().await;
    for (_, h) in guard.timers.drain() {
        h.abort();
    }
    Ok(())
}

async fn handle_event(
    event: Event,
    ds: Arc<Mutex<DaemonState>>,
    whitelisted: Arc<Vec<String>>,
    timeout_ms: u64,
    agent_slug: &str,
    trigger_tx: tokio::sync::mpsc::Sender<PendingIntervention>,
) {
    let author_hex = event.pubkey.to_hex();
    let is_whitelisted_author = whitelisted.contains(&author_hex);

    if is_whitelisted_author {
        // Potential user response — cancel pending intervention if conditions met.
        let conv_id = detector::conversation_id(&event);
        let response_ms = event.created_at.as_secs() * 1000;

        let mut guard = ds.lock().await;
        if let Some(pending) = guard.pending.get(&conv_id).cloned() {
            if pending.user_pubkey == author_hex
                && detector::is_response_cancelling(
                    &event,
                    &whitelisted,
                    pending.completed_at,
                    timeout_ms,
                )
            {
                guard.pending.remove(&conv_id);
                if let Some(h) = guard.timers.remove(&conv_id) {
                    h.abort();
                }
                if let Some(ref pid) = pending.project_id {
                    save_state_for_project(&guard, pid);
                }
                info!(
                    conversation_id = %conv_id,
                    user_pubkey = %author_hex,
                    response_delay_ms = response_ms.saturating_sub(pending.completed_at),
                    "user responded, cancelled intervention timer"
                );
            }
        }
    } else {
        // Potential completion — check if it p-tags a whitelisted user.
        if let Some(user_pubkey) = detector::is_completion_candidate(&event, &whitelisted) {
            let conv_id = detector::conversation_id(&event);
            let completed_at_ms = event.created_at.as_secs() * 1000;
            let agent_pubkey = author_hex;

            // Intervention is project-scoped; skip events with no project a-tag.
            let project_id = match detector::project_id_from_event(&event) {
                Some(pid) => pid,
                None => {
                    debug!(conversation_id = %conv_id, "no project a-tag, skipping");
                    return;
                }
            };

            // Skip if the completing agent IS the intervention agent.
            let intervention_agent_pk = match resolver::resolve_slug(agent_slug) {
                Ok(pk) => pk,
                Err(e) => {
                    error!(error = %e, slug = agent_slug, "failed to resolve intervention agent slug");
                    return;
                }
            };
            if let Some(ref pk) = intervention_agent_pk {
                if pk == &agent_pubkey {
                    debug!(
                        conversation_id = %conv_id,
                        "skipping: completing agent is the intervention agent"
                    );
                    return;
                }
            }

            let mut guard = ds.lock().await;

            // Dedup: already notified.
            let now_ms = state::now_ms();
            if let Some(&notified_at) = guard.notified.get(&conv_id) {
                if now_ms.saturating_sub(notified_at) < state::notified_ttl_ms() {
                    debug!(conversation_id = %conv_id, "already notified, skipping");
                    return;
                }
                guard.notified.remove(&conv_id);
            }

            // Abort existing timer for this conversation (re-arm on updated completion).
            if let Some(h) = guard.timers.remove(&conv_id) {
                h.abort();
            }

            let pending = PendingIntervention {
                conversation_id: conv_id.clone(),
                completed_at: completed_at_ms,
                agent_pubkey,
                user_pubkey,
                project_id: Some(project_id.clone()),
                retry_count: 0,
            };

            guard.pending.insert(conv_id.clone(), pending.clone());
            save_state_for_project(&guard, &project_id);

            // Arm timer.
            let elapsed_ms = state::now_ms().saturating_sub(completed_at_ms);
            let remaining_ms = timeout_ms.saturating_sub(elapsed_ms);
            let tx = trigger_tx.clone();
            let p = pending.clone();
            let handle = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(remaining_ms)).await;
                tx.send(p).await.ok();
            });
            guard.timers.insert(conv_id.clone(), handle);

            info!(
                conversation_id = %conv_id,
                completed_at_ms,
                remaining_ms,
                "agent completion detected, intervention timer started"
            );
        }
    }
}

async fn handle_trigger(
    mut pending: PendingIntervention,
    ds: Arc<Mutex<DaemonState>>,
    publisher: Arc<Publisher>,
    _whitelisted: Arc<Vec<String>>,
    agent_slug: &str,
    trigger_tx: tokio::sync::mpsc::Sender<PendingIntervention>,
) {
    let conv_id = pending.conversation_id.clone();

    // Verify still pending (might have been cancelled by a response).
    {
        let guard = ds.lock().await;
        if !guard.pending.contains_key(&conv_id) {
            return;
        }
        // Dedup.
        if let Some(&notified_at) = guard.notified.get(&conv_id) {
            if state::now_ms().saturating_sub(notified_at) < state::notified_ttl_ms() {
                return;
            }
        }
    }

    let Some(ref project_id) = pending.project_id else {
        warn!(conversation_id = %conv_id, "pending intervention has no project_id, dropping");
        let mut guard = ds.lock().await;
        guard.pending.remove(&conv_id);
        guard.timers.remove(&conv_id);
        return;
    };

    let intervention_agent_pk = match resolver::resolve_slug(agent_slug) {
        Ok(pk) => pk,
        Err(e) => {
            error!(error = %e, slug = agent_slug, "failed to resolve intervention agent slug");
            return;
        }
    };

    let Some(ref pk) = intervention_agent_pk else {
        warn!(
            slug = agent_slug,
            "intervention agent slug not found, dropping trigger"
        );
        let mut guard = ds.lock().await;
        guard.pending.remove(&conv_id);
        guard.timers.remove(&conv_id);
        if let Some(ref pid) = pending.project_id {
            save_state_for_project(&guard, pid);
        }
        return;
    };

    match publisher
        .publish_review_request(pk, project_id, &conv_id, None, None)
        .await
    {
        Ok(_) => {
            let now_ms = state::now_ms();
            let mut guard = ds.lock().await;
            guard.pending.remove(&conv_id);
            guard.timers.remove(&conv_id);
            guard.notified.insert(conv_id.clone(), now_ms);
            save_state_for_project(&guard, project_id);
            info!(conversation_id = %conv_id, "intervention review request sent");
        }
        Err(e) => {
            let retry = pending.retry_count;
            if retry >= MAX_RETRY_ATTEMPTS {
                error!(
                    conversation_id = %conv_id,
                    "max retries reached for intervention, dropping"
                );
                let mut guard = ds.lock().await;
                guard.pending.remove(&conv_id);
                guard.timers.remove(&conv_id);
                save_state_for_project(&guard, project_id);
                return;
            }

            let backoff_ms = RETRY_BASE_MS * (2u64.pow(retry));
            warn!(
                conversation_id = %conv_id,
                retry,
                backoff_ms,
                error = %e,
                "publish failed, scheduling retry"
            );

            pending.retry_count = retry + 1;
            {
                let mut guard = ds.lock().await;
                guard.pending.insert(conv_id.clone(), pending.clone());
                save_state_for_project(&guard, project_id);
            }

            let p = pending.clone();
            let tx = trigger_tx.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                tx.send(p).await.ok();
            });
        }
    }
}

async fn load_all_project_states(
    ds: Arc<Mutex<DaemonState>>,
    timeout_ms: u64,
    trigger_tx: tokio::sync::mpsc::Sender<PendingIntervention>,
) {
    let projects_dir = crate::paths::projects_dir();
    if !projects_dir.exists() {
        return;
    }

    let Ok(entries) = std::fs::read_dir(&projects_dir) else {
        return;
    };

    let now_ms = state::now_ms();

    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let d_tag = entry.file_name().to_string_lossy().into_owned();
        let (loaded_state, from_legacy) = match state::load_state(&d_tag) {
            Ok(r) => r,
            Err(e) => {
                warn!(d_tag, error = %e, "failed to load intervention state");
                continue;
            }
        };

        if from_legacy {
            // Re-save in canonical location.
            state::save_state(&d_tag, &loaded_state).ok();
        }

        let mut guard = ds.lock().await;

        if let Some(notified_list) = &loaded_state.notified {
            for entry in notified_list {
                guard
                    .notified
                    .insert(entry.conversation_id.clone(), entry.notified_at);
            }
        }

        for pending in loaded_state.pending {
            let conv_id = pending.conversation_id.clone();
            let elapsed_ms = now_ms.saturating_sub(pending.completed_at);
            let remaining_ms = timeout_ms.saturating_sub(elapsed_ms);

            guard.pending.insert(conv_id.clone(), pending.clone());

            let tx = trigger_tx.clone();
            let p = pending.clone();
            let handle = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(remaining_ms)).await;
                tx.send(p).await.ok();
            });
            guard.timers.insert(conv_id, handle);

            info!(
                d_tag,
                conversation_id = %pending.conversation_id,
                remaining_ms,
                "catch-up timer set"
            );
        }
    }
}

fn save_state_for_project(guard: &DaemonState, project_id: &str) {
    let pending: Vec<PendingIntervention> = guard
        .pending
        .values()
        .filter(|p| p.project_id.as_deref() == Some(project_id))
        .cloned()
        .collect();

    let notified: Vec<NotifiedEntry> = guard
        .notified
        .iter()
        .map(|(conv_id, &notified_at)| NotifiedEntry {
            conversation_id: conv_id.clone(),
            notified_at,
        })
        .collect();

    let save_state = InterventionState {
        pending,
        notified: if notified.is_empty() {
            None
        } else {
            Some(notified)
        },
    };

    if let Err(e) = state::save_state(project_id, &save_state) {
        warn!(error = %e, "failed to save intervention state");
    }
}

async fn build_nostr_client(cfg: &Config) -> Result<Client> {
    let keys = Keys::parse(&cfg.backend_secret_key).context("parse backend secret key")?;
    let client = Client::new(keys);
    for relay in &cfg.relays {
        client
            .add_relay(relay.as_str())
            .await
            .with_context(|| format!("add relay {relay}"))?;
    }
    client.connect().await;
    Ok(client)
}
