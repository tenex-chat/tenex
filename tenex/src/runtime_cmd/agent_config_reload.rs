//! Project-definition and per-agent config-update handlers, plus the
//! kind:0 profile republish helpers tied to those reload paths.
//!
//! All entry points expect a [`RuntimeReloadContext`] that the relay loop
//! builds once at startup and keeps alive for the lifetime of the runtime —
//! the borrowed handles inside it never move, so reload paths can pass it
//! by reference without re-deriving filters or owner keys.

use std::collections::HashSet;
use std::time::Duration;

use anyhow::{Context, Result};
use nostr::JsonUtil;
use nostr_sdk::prelude::*;
use notify::Event as NotifyEvent;
use tenex_project::{models::ProjectMetadata, Project};
use tracing::{info, warn};

use super::{
    agent_config_publish, agent_config_update, build_runtime_filters, subscribe_runtime_filters,
    RuntimeAgentSnapshot, RuntimeShared, RuntimeSubscriptionIds,
};
use crate::nostr_pub::project_status;
use crate::store::atomic;

pub(super) fn agent_config_event_is_relevant(event: &NotifyEvent) -> bool {
    event.paths.iter().any(|path| {
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension == "json")
    })
}

pub(super) struct RuntimeReloadContext<'a> {
    pub(super) subscription_ids: &'a RuntimeSubscriptionIds,
    pub(super) user_authors: &'a [PublicKey],
    pub(super) trusted_authors: &'a [PublicKey],
    pub(super) project_addr: &'a str,
    pub(super) owner: PublicKey,
    pub(super) project_dtag: &'a str,
    pub(super) since: Timestamp,
    pub(super) meta: &'a ProjectMetadata,
}

pub(super) async fn reload_agent_snapshot(
    shared: &RuntimeShared,
    ctx: &RuntimeReloadContext<'_>,
) -> Result<()> {
    let old_pubkeys = shared.agent_pubkeys();
    let snapshot = load_agent_snapshot_after_change(shared, &old_pubkeys).await?;
    let new_pubkeys = snapshot.agent_pubkeys.clone();
    {
        let mut current = shared.agent_snapshot.write().unwrap();
        *current = snapshot.clone();
    }

    subscribe_runtime_filters(
        &shared.client,
        ctx.subscription_ids,
        build_runtime_filters(
            ctx.user_authors,
            ctx.trusted_authors,
            ctx.project_addr,
            ctx.owner,
            ctx.project_dtag,
            ctx.since,
            &snapshot,
        ),
    )
    .await?;
    publish_project_status_now(shared, ctx.meta).await;

    let added = new_pubkeys.difference(&old_pubkeys).count();
    let removed = old_pubkeys.difference(&new_pubkeys).count();
    info!(
        agents = snapshot.agents.len(),
        added, removed, "reloaded agent configuration"
    );
    Ok(())
}

pub(super) async fn handle_project_definition_update(
    shared: &RuntimeShared,
    ctx: &RuntimeReloadContext<'_>,
    event: &Event,
) -> Result<()> {
    if event.pubkey != ctx.owner
        || project_definition_dtag(event).as_deref() != Some(ctx.project_dtag)
    {
        return Ok(());
    }
    let persisted = persist_newer_project_definition(shared, ctx.project_dtag, event)?;
    if !persisted {
        return Ok(());
    }

    reload_project_membership_snapshot(shared, ctx).await?;
    info!(
        event_id = %event.id.to_hex()[..8],
        project = ctx.project_dtag,
        "reloaded project definition"
    );
    Ok(())
}

fn project_definition_dtag(event: &Event) -> Option<String> {
    let d_kind = TagKind::SingleLetter(SingleLetterTag::lowercase(Alphabet::D));
    event
        .tags
        .iter()
        .find(|tag| tag.kind() == d_kind)
        .and_then(|tag| tag.content().map(str::to_owned))
}

fn persist_newer_project_definition(
    shared: &RuntimeShared,
    project_dtag: &str,
    event: &Event,
) -> Result<bool> {
    let current = Project::open(project_dtag, &shared.base_dir)
        .with_context(|| format!("opening project '{}'", project_dtag))?
        .metadata()
        .with_context(|| format!("reading project metadata for '{}'", project_dtag))?;
    let incoming_created_at = event.created_at.as_secs() as i64;
    if current
        .and_then(|meta| meta.ingested_at)
        .is_some_and(|current_created_at| current_created_at >= incoming_created_at)
    {
        return Ok(false);
    }

    let path = shared
        .base_dir
        .join("projects")
        .join(project_dtag)
        .join("event.json");
    atomic::write(&path, event.as_json().as_bytes())
        .with_context(|| format!("persisting project event {}", path.display()))?;
    Ok(true)
}

async fn reload_project_membership_snapshot(
    shared: &RuntimeShared,
    ctx: &RuntimeReloadContext<'_>,
) -> Result<()> {
    let project = Project::open(ctx.project_dtag, &shared.base_dir)
        .with_context(|| format!("opening project '{}'", ctx.project_dtag))?;
    let snapshot = RuntimeAgentSnapshot::load(&project)?;
    if snapshot.agents.is_empty() {
        anyhow::bail!(
            "project '{}' has no readable agents after project definition reload",
            ctx.project_dtag
        );
    }

    let old_pubkeys = shared.agent_pubkeys();
    let new_pubkeys = snapshot.agent_pubkeys.clone();
    {
        let mut current = shared.agent_snapshot.write().unwrap();
        *current = snapshot.clone();
    }

    subscribe_runtime_filters(
        &shared.client,
        ctx.subscription_ids,
        build_runtime_filters(
            ctx.user_authors,
            ctx.trusted_authors,
            ctx.project_addr,
            ctx.owner,
            ctx.project_dtag,
            ctx.since,
            &snapshot,
        ),
    )
    .await?;

    let project_meta = project
        .metadata()
        .context("reading reloaded project metadata")?
        .context("reloaded project metadata is missing")?;
    publish_project_status_now(shared, &project_meta).await;
    // Project membership reload (project definition event re-ingested).
    // The agent set may have shifted; mirror the per-agent kind:0 profiles
    // so the TUI's union-render stays consistent.
    republish_all_agent_configs(shared).await;

    let added = new_pubkeys.difference(&old_pubkeys).count();
    let removed = old_pubkeys.difference(&new_pubkeys).count();
    info!(
        agents = snapshot.agents.len(),
        added, removed, "reloaded project membership"
    );
    Ok(())
}

pub(super) async fn handle_agent_config_update(
    shared: &RuntimeShared,
    ctx: &RuntimeReloadContext<'_>,
    event: &Event,
) -> Result<()> {
    let agent_pubkeys = shared.agent_pubkeys();
    let outcome = agent_config_update::apply_event(
        &shared.base_dir,
        event,
        ctx.project_addr,
        ctx.project_dtag,
        &agent_pubkeys,
    )?;

    if let Some(reason) = outcome.ignored_reason {
        info!(
            event_id = %event.id.to_hex()[..8],
            agent_pubkey = outcome.agent_pubkey.as_deref().unwrap_or(""),
            reason,
            "ignored agent config update"
        );
        return Ok(());
    }

    info!(
        event_id = %event.id.to_hex()[..8],
        agent_pubkey = outcome.agent_pubkey.as_deref().unwrap_or(""),
        updated = outcome.config_updated,
        reset = outcome.has_reset,
        has_model = outcome.has_model,
        skill_count = outcome.skill_count,
        mcp_count = outcome.mcp_count,
        "processed agent config update"
    );

    if outcome.config_updated {
        reload_agent_snapshot(shared, ctx).await?;
        if let Some(agent_pubkey) = outcome.agent_pubkey.as_deref() {
            republish_agent_config(shared, agent_pubkey).await;
        }
    }

    Ok(())
}

async fn load_agent_snapshot_after_change(
    shared: &RuntimeShared,
    old_pubkeys: &HashSet<String>,
) -> Result<RuntimeAgentSnapshot> {
    let mut missing_existing = Vec::new();
    for attempt in 0..5 {
        let project = Project::open(&shared.project_id, &shared.base_dir)
            .with_context(|| format!("opening project '{}'", shared.project_id))?;
        let snapshot = RuntimeAgentSnapshot::load(&project)?;
        if snapshot.agents.is_empty() {
            anyhow::bail!(
                "project '{}' has no readable agents after reload",
                shared.project_id
            );
        }
        missing_existing = old_pubkeys
            .difference(&snapshot.agent_pubkeys)
            .filter(|pubkey| {
                shared
                    .base_dir
                    .join("agents")
                    .join(format!("{pubkey}.json"))
                    .exists()
            })
            .cloned()
            .collect();
        if missing_existing.is_empty() {
            return Ok(snapshot);
        }
        if attempt < 4 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    anyhow::bail!(
        "agent config reload left existing agent files unreadable: {}",
        missing_existing.join(", ")
    )
}

/// Build + send a kind:0 profile for a single agent (looked up in the current
/// snapshot). Bound to `RuntimeShared` so call sites stay one-liners; all
/// failure modes are logged inside `agent_config_publish::publish_one`.
pub(super) async fn republish_agent_config(shared: &RuntimeShared, agent_pubkey: &str) {
    let snapshot = shared.agent_snapshot();
    agent_config_publish::publish_one(
        agent_pubkey,
        &snapshot.agents,
        &shared.backend_keys.public_key(),
        &shared.base_dir,
        &shared.client,
        &shared.kind0_throttle,
        shared.backend_name.as_deref(),
    )
    .await;
}

/// Republish kind:0 for **every** agent in the current snapshot. Used after
/// a bulk reload (`reload_agent_snapshot`) where individual change
/// attribution is unavailable — keeps the relay-side view consistent with
/// the post-reload truth.
async fn republish_all_agent_configs(shared: &RuntimeShared) {
    let snapshot = shared.agent_snapshot();
    for agent in &snapshot.agents {
        agent_config_publish::publish_one(
            &agent.pubkey,
            &snapshot.agents,
            &shared.backend_keys.public_key(),
            &shared.base_dir,
            &shared.client,
            &shared.kind0_throttle,
            shared.backend_name.as_deref(),
        )
        .await;
    }
}

/// Startup-only: REQ kind:0 for every managed agent's pubkey, wait up to
/// 5s for EOSE (or take whatever is buffered if the relay times out), then
/// for each agent build the candidate kind:0 and compare its canonical
/// `(tags, content)` against the relay's stored event. Skip when they
/// match — the agent's announced state is already in sync. Otherwise
/// publish via the runtime's [`Kind0Throttle`].
///
/// Failures during the REQ are logged and treated as "relay silent" —
/// every agent then gets a publish, which is the safe direction.
pub(super) async fn startup_publish_missing_agent_configs(shared: &RuntimeShared) {
    let snapshot = shared.agent_snapshot();
    if snapshot.agents.is_empty() {
        return;
    }

    let authors: Vec<PublicKey> = snapshot
        .agents
        .iter()
        .filter_map(|a| PublicKey::from_hex(&a.pubkey).ok())
        .collect();

    let existing = if authors.is_empty() {
        // Couldn't parse any agent pubkey — skip the REQ and publish all.
        std::collections::HashMap::new()
    } else {
        let filter = agent_config_publish::startup_filter(&authors);
        match shared
            .client
            .fetch_events(filter, agent_config_publish::STARTUP_FETCH_TIMEOUT)
            .await
        {
            Ok(events) => {
                let collected: Vec<_> = events.into_iter().collect();
                info!(
                    count = collected.len(),
                    "startup: fetched existing kind:0 agent profiles"
                );
                agent_config_publish::fold_existing_agent_configs(&collected)
            }
            Err(error) => {
                warn!(error = %error, "startup: kind:0 fetch failed; treating all agents as missing");
                std::collections::HashMap::new()
            }
        }
    };

    let mut to_publish: Vec<String> = Vec::new();
    let mut already_in_sync: usize = 0;
    let backend_pubkey = shared.backend_keys.public_key();
    for agent in &snapshot.agents {
        let candidate = match agent_config_publish::build_event_for(
            agent,
            &backend_pubkey,
            &shared.base_dir,
            shared.backend_name.as_deref(),
        )
        .await
        {
            Ok(ev) => ev,
            Err(error) => {
                warn!(agent = %agent.slug, error = %error, "startup: kind:0 build failed; will retry on next reload");
                continue;
            }
        };
        let in_sync = existing
            .get(&agent.pubkey)
            .map(|relay_event| {
                agent_config_publish::canonical_payload_equal(&candidate, relay_event)
            })
            .unwrap_or(false);
        if in_sync {
            already_in_sync += 1;
        } else {
            to_publish.push(agent.pubkey.clone());
        }
    }

    if to_publish.is_empty() {
        info!(
            in_sync = already_in_sync,
            "startup: every agent's kind:0 profile already in sync"
        );
        return;
    }
    info!(
        count = to_publish.len(),
        in_sync = already_in_sync,
        "startup: publishing missing/changed kind:0 agent profiles"
    );
    for pubkey in to_publish {
        agent_config_publish::publish_one(
            &pubkey,
            &snapshot.agents,
            &backend_pubkey,
            &shared.base_dir,
            &shared.client,
            &shared.kind0_throttle,
            shared.backend_name.as_deref(),
        )
        .await;
    }
}

pub(super) async fn publish_project_status_now(shared: &RuntimeShared, meta: &ProjectMetadata) {
    match project_status::build_project_status_event(
        &shared.backend_keys,
        meta,
        &shared.project_dir,
        &shared.whitelisted_pubkeys,
    ) {
        Ok(event) => {
            if let Err(error) = shared.client.send_event(&event).await {
                warn!(error = %error, "24010 publish failed");
            }
        }
        Err(error) => warn!(error = %error, "24010 build failed"),
    }
}
