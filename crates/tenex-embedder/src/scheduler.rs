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
use crate::tuning::SCAN_INTERVAL_SECS;

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
                if let Err(e) = backfill::run(BackfillOptions {
                    since_secs: None,
                    reset: false,
                    rate_per_sec: cfg.embeddings_per_second,
                    page_size: None,
                    relays: None,
                    dry_run: false,
                }).await {
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
