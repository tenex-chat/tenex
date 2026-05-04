//! Walk-backward bulk embedder.
//!
//! Phase 1: page through the relay history (`until` walking back) and
//! accumulate every event into the [`Accumulator`].
//! Phase 2: chunk + embed each accumulated conversation. Pacing applies
//! per embedding API call.
//!
//! Walking backward is the natural Nostr ordering — relays return
//! newest-first. Accumulating before embedding avoids re-chunking churn
//! that would otherwise happen as we discover older events. Memory
//! footprint is bounded by total event count × ~1 KB; a host with
//! 30 k events sits around 30 MB.

use std::sync::Arc;

use anyhow::{Context, Result};
use indicatif::{ProgressBar, ProgressStyle};
use tenex_identity::IdentityCache;
use tenex_rag::{EmbedConfig, RagStore};
use tracing::{info, warn};

use crate::accumulator::Accumulator;
use crate::config::EmbedderConfig;
use crate::cursor::{scope_hash, CursorStore};
use crate::identity::CacheResolver;
use crate::pacing::Pacer;
use crate::paths;
use crate::processor::Processor;
use crate::relay::Relay;
use crate::scope;
use crate::state::StateStore;
use crate::target::EmbedTarget;
use crate::tuning::BACKFILL_RATE_PER_SEC;

#[derive(Debug, Clone)]
pub struct BackfillOptions {
    /// Floor: never walk further back than this Unix timestamp (seconds).
    /// Default: 0 (walk to the beginning of time).
    pub since_secs: Option<i64>,
    /// Drop existing chunks + state before walking.
    pub reset: bool,
    /// Override embeddings/sec.
    pub rate_per_sec: Option<f64>,
    /// Page size for relay REQs.
    pub page_size: Option<usize>,
    /// Comma-separated relay URLs; overrides config.
    pub relays: Option<Vec<String>>,
    /// Don't write embeddings; just walk and report counts.
    pub dry_run: bool,
}

const DEFAULT_PAGE_SIZE: usize = 500;

pub async fn run(opts: BackfillOptions) -> Result<()> {
    let base = paths::base_dir();

    let scope = scope::derive(&base).context("derive owner scope")?;
    if scope.projects.is_empty() {
        anyhow::bail!(
            "no user-owned projects under {}/projects/. Embedder has nothing to filter on.",
            base.display()
        );
    }
    let a_tags = scope.a_tags();
    let scope_hash_value = scope_hash(&a_tags);

    let cfg_overrides = EmbedderConfig::load_from_base_dir(&base);
    let rate = opts
        .rate_per_sec
        .or(cfg_overrides.embeddings_per_second)
        .unwrap_or(BACKFILL_RATE_PER_SEC);
    let page_size = opts.page_size.unwrap_or(DEFAULT_PAGE_SIZE);

    let relays = opts
        .relays
        .clone()
        .unwrap_or_else(|| relays_from_config(&base));
    if relays.is_empty() {
        anyhow::bail!("no relays configured (set `relays` in config.json or pass --relays)");
    }

    let embed_config = EmbedConfig::load_from_base_dir(&base).ok_or_else(|| {
        anyhow::anyhow!(
            "no embedding config at {}/embed.json (run `tenex config embed` first)",
            base.display()
        )
    })?;

    let state = Arc::new(StateStore::open(&paths::state_db(&base)).context("open state db")?);
    let cursor = Arc::new(CursorStore::open(&paths::cursor_db(&base)).context("open cursor db")?);
    let pacer = Arc::new(Pacer::from_per_sec(rate));
    let mut processor = Processor::new(state.clone(), pacer.clone());
    processor.force_reembed = opts.reset;

    let cache = Arc::new(IdentityCache::open_default().context("open identity cache")?);
    let resolver = CacheResolver::new(cache);

    let rag = RagStore::open(&paths::embeddings_db(&base), &embed_config)
        .context("open embeddings.db")?;

    info!(
        owners = ?scope.owner_pubkeys,
        projects = scope.projects.len(),
        relays = relays.len(),
        rate_per_sec = rate,
        page_size,
        reset = opts.reset,
        dry_run = opts.dry_run,
        "starting backfill"
    );

    if opts.reset && !opts.dry_run {
        for relay in &relays {
            cursor.reset(relay, &scope_hash_value)?;
        }
        state.delete_all()?;
        info!("reset: cursors + state wiped");
    }

    let relay_client = Relay::connect(relays.clone()).await?;
    let floor = opts.since_secs.unwrap_or(0).max(0);

    // ---- Phase 1: walk back, accumulate ----
    let walk_bar = ProgressBar::new_spinner();
    walk_bar.set_style(
        ProgressStyle::with_template("{spinner} {prefix:.cyan} relay={msg}  events={pos}").unwrap(),
    );
    walk_bar.set_prefix("walking");
    walk_bar.enable_steady_tick(std::time::Duration::from_millis(120));

    let mut acc = Accumulator::new();
    for relay_url in &relays {
        // Cursor stored is the oldest second we've reached on this relay.
        // Resume from there if present; else start at "now".
        let starting_until = cursor
            .get(relay_url, &scope_hash_value)?
            .unwrap_or_else(now_secs);
        let mut until = starting_until;

        loop {
            walk_bar.set_message(format!("{relay_url}  until={until}"));
            if until <= floor {
                break;
            }
            let pre_count = acc.dedupe_count();
            let page = match relay_client.fetch_page(&a_tags, until, page_size).await {
                Ok(p) => p,
                Err(e) => {
                    warn!(relay = %relay_url, error = %e, "fetch_page failed; stopping this relay");
                    break;
                }
            };
            if page.events.is_empty() {
                break;
            }
            for ev in page.events {
                acc.ingest(ev);
                walk_bar.inc(1);
            }

            // Did this page bring us any new unique events?
            let new_unique = acc.dedupe_count() - pre_count;
            if new_unique == 0 {
                // Page was 100% duplicates — relay can't make progress
                // past this boundary (probably a `created_at` cluster
                // larger than the page limit). Bail.
                break;
            }

            // Advance `until` to the oldest second seen, INCLUSIVE.
            // We rely on accumulator dedupe to handle the boundary
            // event re-appearing on the next page. Using
            // `oldest - 1` skips events that share the oldest second.
            let oldest = page.oldest_secs.unwrap_or(until);
            let next_until = oldest;
            if next_until >= until {
                // No timestamp progress at all — same boundary or
                // higher. Avoid infinite loop.
                break;
            }
            until = next_until;

            if !opts.dry_run {
                cursor.put(relay_url, &scope_hash_value, until)?;
            }
        }
    }
    walk_bar.finish_and_clear();

    let conv_ids = acc.conversation_ids();
    info!(
        events = acc.dedupe_count(),
        conversations = conv_ids.len(),
        "phase 1 complete: relay walk"
    );

    // Per-project event distribution. An event may carry multiple a-tags;
    // we count it under each.
    {
        use std::collections::{BTreeMap, HashMap};
        let mut by_project: HashMap<String, (usize, std::collections::HashSet<String>)> =
            HashMap::new();
        let mut by_week: BTreeMap<i64, (usize, std::collections::HashSet<String>)> =
            BTreeMap::new();
        for conv_id in &conv_ids {
            for ev in acc.events_for(conv_id) {
                let secs = ev.created_at.as_secs() as i64;
                let week_start = monday_of_week_secs(secs);
                let entry = by_week
                    .entry(week_start)
                    .or_insert_with(|| (0, std::collections::HashSet::new()));
                entry.0 += 1;
                entry.1.insert(conv_id.clone());

                for tag in ev.tags.iter() {
                    let parts = tag.as_slice();
                    if parts.first().map(String::as_str) == Some("a") {
                        if let Some(value) = parts.get(1) {
                            if a_tags.iter().any(|t| t == value) {
                                let entry = by_project
                                    .entry(value.clone())
                                    .or_insert_with(|| (0, std::collections::HashSet::new()));
                                entry.0 += 1;
                                entry.1.insert(conv_id.clone());
                            }
                        }
                    }
                }
            }
        }
        let mut rows: Vec<(String, usize, usize)> = by_project
            .into_iter()
            .map(|(k, (events, convs))| (k, events, convs.len()))
            .collect();
        rows.sort_by(|a, b| b.1.cmp(&a.1));
        eprintln!("\nPer-project event distribution (events / conversations):");
        for (a_tag, events, convs) in rows.iter().take(50) {
            let label = a_tag.split(':').nth(2).unwrap_or(a_tag.as_str());
            eprintln!("  {events:6}  {convs:4}  {label}");
        }
        let zero_count = a_tags
            .iter()
            .filter(|t| !rows.iter().any(|(k, _, _)| k == *t))
            .count();
        if zero_count > 0 {
            eprintln!("  ({zero_count} owned projects with zero events on this relay)");
        }

        // Per-week event distribution (UTC, week starting Monday).
        let max_events = by_week.values().map(|(n, _)| *n).max().unwrap_or(1) as f32;
        eprintln!("\nPer-week event distribution (UTC, week starting Monday):");
        eprintln!("  {:<14} {:>6}  {:>5}  bar", "week of", "events", "convs");
        for (week_start, (events, convs)) in by_week.iter() {
            let bar_len = ((*events as f32 / max_events) * 40.0).round() as usize;
            let bar: String = "#".repeat(bar_len);
            let label = ymd_string(*week_start);
            eprintln!("  {label:<14} {events:>6}  {:>5}  {bar}", convs.len());
        }
    }

    if opts.dry_run {
        info!("dry-run; not embedding");
        return Ok(());
    }

    // ---- Phase 2: chunk + embed ----
    let embed_bar = ProgressBar::new(conv_ids.len() as u64);
    embed_bar.set_style(
        ProgressStyle::with_template(
            "{prefix:.green} [{bar:30.green/black}] {pos}/{len} convs  ·  chunks={msg}",
        )
        .unwrap()
        .progress_chars("=>-"),
    );
    embed_bar.set_prefix("embedding");

    let target = EmbedTarget::new(&rag);
    let mut total_chunks = 0usize;
    for conv_id in &conv_ids {
        let events = acc.events_for(conv_id);
        let project_ids = project_ids_for_events(events, &scope.projects);
        match processor
            .process_conversation(conv_id, events, &project_ids, &resolver, &target)
            .await
        {
            Ok(res) => total_chunks += res.chunks_embedded,
            Err(e) => warn!(
                conversation_id = %conv_id,
                error = %e,
                "process_conversation failed"
            ),
        }
        embed_bar.set_message(total_chunks.to_string());
        embed_bar.inc(1);
    }
    embed_bar.finish();

    info!(
        events = acc.dedupe_count(),
        conversations = conv_ids.len(),
        chunks_embedded = total_chunks,
        "backfill complete"
    );
    Ok(())
}

fn project_ids_for_events(
    events: &[nostr::Event],
    projects: &[scope::OwnedProject],
) -> Vec<String> {
    let mut project_ids = std::collections::BTreeSet::new();
    for event in events {
        for tag in event.tags.iter() {
            let parts = tag.as_slice();
            if parts.first().map(String::as_str) != Some("a") {
                continue;
            }
            let Some(coord) = parts.get(1) else {
                continue;
            };
            if let Some(project) = projects.iter().find(|project| project.a_tag == *coord) {
                project_ids.insert(project.d_tag.clone());
            }
        }
    }
    project_ids.into_iter().collect()
}

fn relays_from_config(base: &std::path::Path) -> Vec<String> {
    use serde::Deserialize;
    #[derive(Deserialize, Default)]
    struct Doc {
        #[serde(default)]
        relays: Vec<String>,
    }
    let path = base.join("config.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let doc: Doc = serde_json::from_slice(&bytes).unwrap_or_default();
    if doc.relays.is_empty() {
        vec!["wss://relay.tenex.chat".to_string()]
    } else {
        doc.relays
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

const SECS_PER_DAY: i64 = 86_400;

/// Return the unix-seconds timestamp of 00:00 UTC on the Monday of
/// the week containing `secs`. 1970-01-01 was a Thursday, so days
/// since epoch shift by 3 to make Monday=0.
fn monday_of_week_secs(secs: i64) -> i64 {
    let days = secs.div_euclid(SECS_PER_DAY);
    let dow_mon0 = ((days + 3).rem_euclid(7)) as i64; // Mon=0..Sun=6
    let monday_days = days - dow_mon0;
    monday_days * SECS_PER_DAY
}

/// Format a unix-seconds (UTC) timestamp as `YYYY-MM-DD`.
/// Implements Howard Hinnant's `civil_from_days` algorithm inline so we
/// don't pull in a date crate just for one debug print.
fn ymd_string(secs: i64) -> String {
    let days = secs.div_euclid(SECS_PER_DAY);
    let z = days + 719_468;
    let era = if z >= 0 {
        z / 146_097
    } else {
        (z - 146_096) / 146_097
    };
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", year, m, d)
}
