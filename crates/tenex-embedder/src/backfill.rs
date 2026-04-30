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
use crate::relay::{FetchPageError, Relay, RelayFetcher};
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

    let result = walk_and_embed(
        &relay_client,
        &relays,
        &a_tags,
        &scope_hash_value,
        floor,
        page_size,
        opts.dry_run,
        &cursor,
        &mut processor,
        &resolver,
        &rag,
    )
    .await;

    // Always tear down the connection pool, regardless of how the walk
    // terminated. shutdown() is infallible (returns ()), so there's
    // nothing to surface.
    relay_client.shutdown().await;

    result
}

#[allow(clippy::too_many_arguments)]
async fn walk_and_embed(
    fetcher: &dyn RelayFetcher,
    relays: &[String],
    a_tags: &[String],
    scope_hash_value: &str,
    floor: i64,
    page_size: usize,
    dry_run: bool,
    cursor: &CursorStore,
    processor: &mut Processor,
    resolver: &CacheResolver,
    rag: &RagStore,
) -> Result<()> {
    // ---- Phase 1: walk back, accumulate ----
    let walk_bar = ProgressBar::new_spinner();
    walk_bar.set_style(
        ProgressStyle::with_template(
            "{spinner} {prefix:.cyan} relay={msg}  events={pos}",
        )
        .unwrap(),
    );
    walk_bar.set_prefix("walking");
    walk_bar.enable_steady_tick(std::time::Duration::from_millis(120));

    let mut acc = Accumulator::new();
    for relay_url in relays {
        walk_relay(
            fetcher,
            relay_url,
            a_tags,
            scope_hash_value,
            floor,
            page_size,
            dry_run,
            cursor,
            &mut acc,
            &walk_bar,
        )
        .await?;
    }
    walk_bar.finish_and_clear();

    let conv_ids = acc.conversation_ids();
    info!(
        events = acc.dedupe_count(),
        conversations = conv_ids.len(),
        "phase 1 complete: relay walk"
    );

    if dry_run {
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

    let target = EmbedTarget::new(rag);
    let mut total_chunks = 0usize;
    for conv_id in &conv_ids {
        let events = acc.events_for(conv_id);
        match processor
            .process_conversation(conv_id, events, resolver, &target)
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

/// Drive one relay backward from its persisted cursor (or `now` if
/// fresh) down to `floor`. Persists cursor progress on every successful
/// page and on every "stop walking this relay" signal so a restart
/// resumes from the oldest reached point rather than re-walking from
/// `now`.
///
/// Per-relay error policy:
/// - [`FetchPageError::Transient`] — log warning, persist cursor, stop
///   this relay. The next backfill tick picks up where we left off.
/// - [`FetchPageError::Permanent`] — bubble up to the caller. Cursor is
///   left at the last successful advance (no half-advance is ever
///   committed).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn walk_relay(
    fetcher: &dyn RelayFetcher,
    relay_url: &str,
    a_tags: &[String],
    scope_hash_value: &str,
    floor: i64,
    page_size: usize,
    dry_run: bool,
    cursor: &CursorStore,
    acc: &mut Accumulator,
    progress: &ProgressBar,
) -> Result<()> {
    // Cursor stored is the oldest second we've reached on this relay.
    // Resume from there if present; else start at "now".
    let starting_until = cursor
        .get(relay_url, scope_hash_value)?
        .unwrap_or_else(now_secs);
    let mut until = starting_until;

    let persist = |until: i64| -> Result<()> {
        if dry_run {
            return Ok(());
        }
        cursor.put(relay_url, scope_hash_value, until)
    };

    loop {
        progress.set_message(format!("{relay_url}  until={until}"));
        if until <= floor {
            // Reached the configured floor; record and stop. The end
            // boundary is `floor`, not `until`, because `until` may
            // have already crossed the floor by the time we get here.
            persist(floor.max(until))?;
            return Ok(());
        }
        let pre_count = acc.dedupe_count();
        let page = match fetcher.fetch_page(a_tags, until, page_size).await {
            Ok(p) => p,
            Err(FetchPageError::Transient(e)) => {
                warn!(
                    relay = %relay_url,
                    error = %e,
                    "transient relay error; persisting cursor and stopping this relay"
                );
                persist(until)?;
                return Ok(());
            }
            Err(FetchPageError::Permanent(e)) => {
                // Persist what we've already advanced — a permanent
                // error doesn't invalidate prior progress — and bubble
                // up. The current `until` is the next un-fetched
                // boundary; on a restart we want to resume there once
                // the underlying issue is fixed.
                persist(until)?;
                return Err(e.context(format!("permanent relay error on {relay_url}")));
            }
        };
        if page.events.is_empty() {
            // End of stream on this relay.
            persist(until)?;
            return Ok(());
        }
        for ev in page.events {
            acc.ingest(ev);
            progress.inc(1);
        }

        // Did this page bring us any new unique events?
        let new_unique = acc.dedupe_count() - pre_count;
        if new_unique == 0 {
            // Page was 100% duplicates — relay can't make progress
            // past this boundary (probably a `created_at` cluster
            // larger than the page limit). Stop and persist.
            persist(until)?;
            return Ok(());
        }

        // Advance `until` to the oldest second seen, INCLUSIVE.
        // We rely on accumulator dedupe to handle the boundary
        // event re-appearing on the next page. Using
        // `oldest - 1` skips events that share the oldest second.
        let oldest = page.oldest_secs.unwrap_or(until);
        let next_until = oldest;
        if next_until >= until {
            // No timestamp progress at all — same boundary or
            // higher. Stop and persist current position.
            persist(until)?;
            return Ok(());
        }
        until = next_until;
        persist(until)?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accumulator::Accumulator;
    use crate::cursor::CursorStore;
    use crate::relay::{FetchPageError, Page, RelayFetcher};
    use async_trait::async_trait;
    use indicatif::ProgressBar;
    use nostr::event::{EventBuilder, Kind};
    use nostr::key::Keys;
    use nostr::types::Timestamp;
    use std::sync::Mutex as StdMutex;
    use tempfile::TempDir;

    /// Fetcher that walks through a script of canned responses, one per
    /// `fetch_page` call. The script lets a test simulate "first call
    /// succeeds, second call fails transiently mid-stream", which is
    /// the partial-failure shape we need to verify cursor persistence
    /// against.
    struct ScriptedFetcher {
        script: StdMutex<Vec<Result<Page, FetchPageError>>>,
    }

    impl ScriptedFetcher {
        fn new(script: Vec<Result<Page, FetchPageError>>) -> Self {
            Self {
                script: StdMutex::new(script),
            }
        }
    }

    #[async_trait]
    impl RelayFetcher for ScriptedFetcher {
        async fn fetch_page(
            &self,
            _scope_a_tags: &[String],
            _until_secs: i64,
            _page_limit: usize,
        ) -> Result<Page, FetchPageError> {
            let next = self
                .script
                .lock()
                .unwrap()
                .drain(..1)
                .next()
                .expect("scripted fetcher exhausted");
            next
        }
    }

    fn make_event(created_at_secs: u64) -> nostr::event::Event {
        let keys = Keys::generate();
        EventBuilder::new(Kind::TextNote, format!("evt-{created_at_secs}"))
            .custom_created_at(Timestamp::from(created_at_secs))
            .sign_with_keys(&keys)
            .expect("sign event")
    }

    fn page_with_oldest(secs: u64) -> Page {
        let ev = make_event(secs);
        Page {
            events: vec![ev],
            event_count: 1,
            root_count: 1,
            oldest_secs: Some(secs as i64),
        }
    }

    fn open_cursor() -> (CursorStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let store = CursorStore::open(&dir.path().join("c.db")).unwrap();
        (store, dir)
    }

    #[tokio::test]
    async fn cursor_persists_progress_when_transient_error_occurs_mid_stream() {
        // Script: first fetch returns one event at secs=900; second
        // fetch fails transiently. The walk must persist cursor=900
        // before stopping.
        let fetcher = ScriptedFetcher::new(vec![
            Ok(page_with_oldest(900)),
            Err(FetchPageError::Transient(anyhow::anyhow!("simulated network blip"))),
        ]);
        let (cursor, _dir) = open_cursor();
        let mut acc = Accumulator::new();
        let bar = ProgressBar::hidden();
        let scope_h = "scope";
        let relay = "wss://test";
        // Seed the cursor at 1000 so we walk from 1000 → 900 → fail.
        cursor.put(relay, scope_h, 1000).unwrap();

        walk_relay(
            &fetcher,
            relay,
            &[],
            scope_h,
            0,
            500,
            false, // not a dry run — must persist
            &cursor,
            &mut acc,
            &bar,
        )
        .await
        .expect("transient error should not bubble out");

        let saved = cursor.get(relay, scope_h).unwrap();
        assert_eq!(
            saved,
            Some(900),
            "cursor must record oldest second reached before transient failure"
        );
    }

    #[tokio::test]
    async fn cursor_persists_on_empty_page_end_of_stream() {
        let fetcher = ScriptedFetcher::new(vec![Ok(Page {
            events: vec![],
            event_count: 0,
            root_count: 0,
            oldest_secs: None,
        })]);
        let (cursor, _dir) = open_cursor();
        let mut acc = Accumulator::new();
        let bar = ProgressBar::hidden();
        let scope_h = "scope";
        let relay = "wss://test";
        cursor.put(relay, scope_h, 500).unwrap();

        walk_relay(
            &fetcher, relay, &[], scope_h, 0, 500, false, &cursor, &mut acc, &bar,
        )
        .await
        .unwrap();

        // Empty page = end of stream; cursor should remain at 500
        // (the un-fetched boundary) rather than be cleared.
        assert_eq!(cursor.get(relay, scope_h).unwrap(), Some(500));
    }

    #[tokio::test]
    async fn permanent_error_bubbles_up_with_cursor_intact() {
        let fetcher = ScriptedFetcher::new(vec![
            Ok(page_with_oldest(900)),
            Err(FetchPageError::Permanent(anyhow::anyhow!("malformed filter"))),
        ]);
        let (cursor, _dir) = open_cursor();
        let mut acc = Accumulator::new();
        let bar = ProgressBar::hidden();
        let scope_h = "scope";
        let relay = "wss://test";
        cursor.put(relay, scope_h, 1000).unwrap();

        let err = walk_relay(
            &fetcher, relay, &[], scope_h, 0, 500, false, &cursor, &mut acc, &bar,
        )
        .await
        .expect_err("permanent error must bubble up");
        assert!(
            err.to_string().contains("permanent relay error"),
            "error should reference permanent classification, got: {err}"
        );

        // Even though we erred, the cursor must reflect what was
        // already fetched successfully (oldest=900).
        assert_eq!(cursor.get(relay, scope_h).unwrap(), Some(900));
    }
}
