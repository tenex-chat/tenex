//! Polling loop. Every `SCAN_INTERVAL`, walks every project and processes
//! conversations that meet the policy:
//!
//!   - last_activity is between DEBOUNCE_SECS (10s) and MAX_AGE_SECS (7d) old
//!   - last_activity has advanced since our last summarize
//!   - at least MIN_INTERVAL_MS (10 min) has passed since our last summarize (rate limit)
//!
//! Implements the host-level debounce policy without relying on an
//! in-process scheduler inside each project runtime.

use std::time::Duration;

use anyhow::Result;
use tokio::signal::unix::{signal, SignalKind};
use tracing::{debug, error, info, warn};

use crate::categories;
use crate::config::Config;
use crate::ingest;
use crate::paths;
use crate::publish::Publisher;
use tenex_conversations::ProjectRef;

use crate::source::{self, MetadataUpdate, ProjectEvent};
use crate::state::SummaryStateStore;
use crate::summarize::{self, Summary};
use tenex_project::Signer;

const SCAN_INTERVAL: Duration = Duration::from_secs(5);
const DEBOUNCE_SECS: i64 = 10;
const MIN_INTERVAL_MS: i64 = 10 * 60 * 1000;
const MAX_AGE_SECS: i64 = 7 * 24 * 60 * 60;

pub async fn run(cfg: Config, state: SummaryStateStore) -> Result<()> {
    let publisher = Publisher::new(&cfg.backend_secret_key, &cfg.relays).await?;
    let startup_secs = now_secs();
    info!(
        relays = ?cfg.relays,
        provider = %cfg.llm.provider,
        model = %cfg.llm.model,
        startup_secs,
        "tenex-summarizer started",
    );

    // Spawn the ingester. It receives kind:513 events for projects
    // whose PM agent is hosted on a different backend and applies the
    // metadata to the local conversation DB, so non-PM backends do
    // not have to run a redundant LLM pass.
    let (ingest_shutdown_tx, ingest_shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
    let ingest_task = tokio::spawn({
        let secret_key = cfg.backend_secret_key.clone();
        let relays = cfg.relays.clone();
        async move {
            if let Err(e) = ingest::run(&secret_key, &relays, ingest_shutdown_rx).await {
                error!(error = %e, "ingest task exited with error");
            }
        }
    });

    let mut sigint = signal(SignalKind::interrupt())?;
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut ticker = tokio::time::interval(SCAN_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let shutdown_reason: &str = loop {
        tokio::select! {
            _ = sigint.recv() => { break "SIGINT"; }
            _ = sigterm.recv() => { break "SIGTERM"; }
            _ = ticker.tick() => {
                if let Err(e) = scan_once(&cfg, &state, &publisher, startup_secs).await {
                    error!(error = %e, "scan cycle failed");
                }
            }
        }
    };

    info!(reason = shutdown_reason, "shutting down; signalling ingest");
    let _ = ingest_shutdown_tx.send(()).await;
    if let Err(e) = ingest_task.await {
        warn!(error = %e, "ingest task join failed");
    }
    Ok(())
}

async fn scan_once(
    cfg: &Config,
    state: &SummaryStateStore,
    publisher: &Publisher,
    startup_secs: i64,
) -> Result<()> {
    let projects = match source::discover_projects() {
        Ok(p) => p,
        Err(e) => {
            warn!(error = %e, "discover projects failed");
            return Ok(());
        }
    };

    let mut total_candidates = 0usize;
    let mut total_processed = 0usize;
    let mut total_skipped = 0usize;

    let base_dir = paths::base_dir();
    for project in &projects {
        let project_event = match source::load_project_event(project) {
            Ok(p) => p,
            Err(e) => {
                debug!(d_tag = %project.d_tag, error = %e, "skip project: bad event.json");
                continue;
            }
        };

        // Only the backend that owns the project's PM agent (the first
        // agent in the kind:31933 event) does any summarization work for
        // this project. Backends without the PM signer rely on the
        // `ingest` task to receive kind:513 events from the PM-owning
        // backend and apply them to the local conversation.db — they
        // must not run a redundant LLM pass.
        //
        // A read or parse failure of the PM identity skips the project
        // entirely so the next scan retries — otherwise a transient
        // agent-file error would permanently suppress publishing.
        let pm_signer = match source::pm_identity(&project.d_tag, &base_dir) {
            Ok(Some(pm)) => match pm.local_signer {
                Some(s) => s,
                None => continue,
            },
            Ok(None) => continue,
            Err(e) => {
                warn!(
                    d_tag = %project.d_tag,
                    error = ?e,
                    "pm identity lookup failed; skipping project this cycle",
                );
                continue;
            }
        };

        let candidates = match source::list_candidates(project, DEBOUNCE_SECS, MAX_AGE_SECS) {
            Ok(c) => c,
            Err(e) => {
                // Debug-format anyhow so the underlying cause chain (e.g. the
                // rusqlite error behind a `with_context("open <path>")`) is
                // not swallowed by the top-level context message.
                warn!(d_tag = %project.d_tag, error = ?e, "list_candidates failed");
                continue;
            }
        };

        total_candidates += candidates.len();

        let scan_ctx = ProjectScanContext {
            project,
            project_event: &project_event,
            pm_signer: pm_signer.as_ref(),
        };

        for cand in candidates {
            match should_process(state, &cand.conversation_id, cand.last_activity, startup_secs)? {
                Decision::Skip => {
                    total_skipped += 1;
                }
                Decision::Baseline => {
                    if let Err(e) = state.record(&cand.conversation_id, cand.last_activity, 0) {
                        warn!(error = %e, "state.record (baseline) failed");
                    }
                    total_skipped += 1;
                }
                Decision::Process => {
                    if process_one(
                        cfg,
                        state,
                        publisher,
                        &scan_ctx,
                        &cand.conversation_id,
                        cand.last_activity,
                    )
                    .await
                    {
                        total_processed += 1;
                    }
                }
            }
        }
    }

    if total_processed > 0 {
        info!(
            projects = projects.len(),
            candidates = total_candidates,
            processed = total_processed,
            skipped = total_skipped,
            "scan cycle complete",
        );
    } else {
        debug!(
            projects = projects.len(),
            candidates = total_candidates,
            skipped = total_skipped,
            "scan cycle complete",
        );
    }
    Ok(())
}

struct ProjectScanContext<'a> {
    project: &'a ProjectRef,
    project_event: &'a ProjectEvent,
    pm_signer: &'a dyn Signer,
}

enum Decision {
    Skip,
    /// First time we've seen this conversation and its latest activity
    /// predates summarizer startup — record state so the next advance
    /// triggers a real summary, but do not backfill the existing history.
    Baseline,
    Process,
}

fn should_process(
    state: &SummaryStateStore,
    conversation_id: &str,
    last_activity: i64,
    startup_secs: i64,
) -> Result<Decision> {
    let now_ms = now_ms();
    let prior = state.get(conversation_id)?;
    Ok(match prior {
        None => {
            if last_activity <= startup_secs {
                Decision::Baseline
            } else {
                Decision::Process
            }
        }
        Some(s) => {
            if last_activity > s.last_activity_summarized
                && now_ms - s.last_summarized_at_ms >= MIN_INTERVAL_MS
            {
                Decision::Process
            } else {
                Decision::Skip
            }
        }
    })
}

async fn process_one(
    cfg: &Config,
    state: &SummaryStateStore,
    publisher: &Publisher,
    ctx: &ProjectScanContext<'_>,
    conversation_id: &str,
    catalog_last_activity: i64,
) -> bool {
    let started = std::time::Instant::now();
    let result = process_inner(cfg, publisher, ctx, conversation_id).await;
    match result {
        Ok(Some(summary)) => {
            if let Err(e) = state.record(conversation_id, catalog_last_activity, now_ms()) {
                warn!(error = %e, "state.record failed");
            }
            if !summary.categories.is_empty() {
                if let Err(e) = categories::record(&summary.categories) {
                    warn!(error = %e, "categories.record failed");
                }
            }
            info!(
                conversation_id = %short(conversation_id),
                d_tag = %ctx.project.d_tag,
                model = %cfg.llm.model,
                latency_ms = started.elapsed().as_millis() as u64,
                "summarized"
            );
            true
        }
        Ok(None) => {
            if let Err(e) = state.record(conversation_id, catalog_last_activity, now_ms()) {
                warn!(error = %e, "state.record failed");
            }
            false
        }
        Err(e) => {
            warn!(
                conversation_id = %short(conversation_id),
                d_tag = %ctx.project.d_tag,
                error = %e,
                latency_ms = started.elapsed().as_millis() as u64,
                "summarize failed"
            );
            false
        }
    }
}

async fn process_inner(
    cfg: &Config,
    publisher: &Publisher,
    ctx: &ProjectScanContext<'_>,
    conversation_id: &str,
) -> Result<Option<Summary>> {
    let content = match source::fetch_content(ctx.project, ctx.project_event, conversation_id)? {
        Some(c) => c,
        None => return Ok(None),
    };
    if content.transcript.trim().is_empty() {
        return Ok(None);
    }

    let summary = summarize::summarize(
        &cfg.llm,
        &content.transcript,
        summarize::SummarizeContext {
            conversation_id: Some(conversation_id.to_string()),
            project_id: Some(ctx.project.d_tag.clone()),
        },
    )
    .await?;

    let update = MetadataUpdate {
        title: non_empty(&summary.title),
        summary: non_empty(&summary.summary),
        status_label: non_empty(&summary.status_label),
        status_current_activity: non_empty(&summary.status_current_activity),
    };
    source::write_metadata(ctx.project, conversation_id, &update)?;

    publisher
        .publish(
            conversation_id,
            &content.project_event,
            &cfg.llm.model,
            &summary,
            ctx.pm_signer,
        )
        .await?;

    Ok(Some(summary))
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn short(id: &str) -> String {
    if id.len() > 8 {
        id[..8].to_string()
    } else {
        id.to_string()
    }
}
