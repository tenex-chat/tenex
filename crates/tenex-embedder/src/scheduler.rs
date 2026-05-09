//! Daemon: tick on `SCAN_INTERVAL_SECS`, run a bounded walk backward
//! from `now` to the persisted oldest cursor.
//!
//! Same code path as backfill but with a tight `--since` floor that
//! stops the walk at the previous cursor, so we only pick up new tail
//! events each tick. Pacing applies per embedding call.

use std::time::Duration;

use anyhow::{Context, Result};
use tokio::signal::unix::{signal, SignalKind};
use tracing::{error, info};

use crate::backfill::{self, BackfillOptions};
use crate::config::EmbedderConfig;
use crate::paths;
use crate::tuning::{DAEMON_RATE_PER_SEC, SCAN_INTERVAL_SECS};

/// Build the per-tick `BackfillOptions` the daemon hands to `backfill::run`.
///
/// The daemon-default rate is `DAEMON_RATE_PER_SEC` (slow, intended for
/// continuous operation) — distinct from `BACKFILL_RATE_PER_SEC`, which
/// is `backfill::run`'s own fallback for one-shot CLI use. We materialise
/// the daemon default into `rate_per_sec` here so the daemon never falls
/// through to the backfill default.
fn daemon_backfill_options(cfg: &EmbedderConfig) -> BackfillOptions {
    BackfillOptions {
        since_secs: None,
        reset: false,
        rate_per_sec: Some(cfg.embeddings_per_second.unwrap_or(DAEMON_RATE_PER_SEC)),
        page_size: None,
        relays: None,
        dry_run: false,
        project_filter: None,
    }
}

pub async fn run() -> Result<()> {
    let base = paths::base_dir();
    let cfg = EmbedderConfig::load_from_base_dir(&base);
    let scan_interval = Duration::from_secs(cfg.scan_interval_secs.unwrap_or(SCAN_INTERVAL_SECS));

    info!(
        scan_interval_secs = scan_interval.as_secs(),
        "tenex-embedder daemon started"
    );

    let mut sigint = signal(SignalKind::interrupt()).context("install SIGINT handler")?;
    let mut sigterm = signal(SignalKind::terminate()).context("install SIGTERM handler")?;

    loop {
        tokio::select! {
            _ = sigint.recv() => { info!("SIGINT received; shutting down"); return Ok(()); }
            _ = sigterm.recv() => { info!("SIGTERM received; shutting down"); return Ok(()); }
            _ = tokio::time::sleep(scan_interval) => {
                if let Err(e) = backfill::run(daemon_backfill_options(&cfg)).await {
                    error!(error = %e, "embedder scan cycle failed");
                }
            }
        }
    }
}

pub fn print_status() -> Result<()> {
    let pid_path = paths::pid_file(&paths::base_dir());
    match crate::lockfile::Lockfile::probe(&pid_path)? {
        Some(pid) => println!("running (pid {pid})"),
        None => println!("not running"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_options_use_daemon_default_rate_when_no_override() {
        // Regression: the daemon used to pass `cfg.embeddings_per_second`
        // straight through, so when no `embedder.json` override was set
        // the `None` fell through to `BACKFILL_RATE_PER_SEC` (10/s) inside
        // `backfill::run`. The daemon ran at ~5x the documented intended
        // rate. Now the daemon materialises `DAEMON_RATE_PER_SEC` itself.
        let cfg = EmbedderConfig::default();
        let opts = daemon_backfill_options(&cfg);
        assert_eq!(opts.rate_per_sec, Some(DAEMON_RATE_PER_SEC));
    }

    #[test]
    fn daemon_options_respect_user_override() {
        let cfg = EmbedderConfig {
            embeddings_per_second: Some(7.5),
            ..EmbedderConfig::default()
        };
        let opts = daemon_backfill_options(&cfg);
        assert_eq!(opts.rate_per_sec, Some(7.5));
    }

    #[test]
    fn daemon_options_pin_other_fields_to_daemon_defaults() {
        // `since_secs = None` → walk from now back to the persisted
        // cursor, the daemon's intended behaviour. `reset = false`,
        // `dry_run = false`, no relay or page_size override — the
        // daemon never touches these.
        let cfg = EmbedderConfig::default();
        let opts = daemon_backfill_options(&cfg);
        assert_eq!(opts.since_secs, None);
        assert!(!opts.reset);
        assert!(!opts.dry_run);
        assert_eq!(opts.page_size, None);
        assert!(opts.relays.is_none());
    }
}
