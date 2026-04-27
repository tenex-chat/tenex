//! Async driver for periodic backend-status publish (kind 24012 heartbeat +
//! kind 34011 per-agent config + kind 24011 agent list). Replaces the
//! `backend-status` entry in the `PeriodicScheduler`. The driver owns a
//! 30-second timer for heartbeat/per-agent-config and a 60-second timer for
//! the agent list, and never touches the shared `periodic-scheduler.json` file.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

use crate::backend_heartbeat_latch::BackendHeartbeatLatchPlanner;
use crate::backend_status_runtime::{
    BackendStatusRuntimeInput, publish_backend_agent_list_from_filesystem,
    publish_backend_status_from_filesystem,
};
pub use crate::backend_status_tick::BACKEND_STATUS_TICK_INTERVAL_SECONDS;
use crate::backend_status_tick::AGENT_LIST_PUBLISH_INTERVAL_SECONDS;
use crate::daemon_signals::PublishEnqueued;

pub struct BackendStatusDriverDeps {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
    pub heartbeat_latch: Option<Arc<Mutex<BackendHeartbeatLatchPlanner>>>,
    pub publish_enqueued_tx: Option<mpsc::UnboundedSender<PublishEnqueued>>,
}

pub async fn run_backend_status_driver(
    deps: BackendStatusDriverDeps,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let heartbeat_interval = Duration::from_secs(BACKEND_STATUS_TICK_INTERVAL_SECONDS);
    let agent_list_interval = Duration::from_secs(AGENT_LIST_PUBLISH_INTERVAL_SECONDS);
    let mut next_heartbeat_at = Instant::now() + heartbeat_interval;
    // Publish the agent list immediately on startup so clients connecting
    // right after daemon boot see the current inventory without waiting 60s.
    let mut next_agent_list_at = Instant::now();

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => break,
            _ = tokio::time::sleep_until(next_heartbeat_at) => {
                let now_ms = current_unix_time_ms();
                let tenex_base_dir = deps.tenex_base_dir.clone();
                let daemon_dir = deps.daemon_dir.clone();
                let heartbeat_latch = deps.heartbeat_latch.clone();

                let result = tokio::task::spawn_blocking(move || {
                    let mut input = BackendStatusRuntimeInput::new(
                        &tenex_base_dir,
                        &daemon_dir,
                        now_ms / 1_000,
                        now_ms,
                        now_ms,
                    );
                    if let Some(latch) = heartbeat_latch {
                        input = input.with_heartbeat_latch(latch);
                    }
                    publish_backend_status_from_filesystem(input)
                })
                .await;

                match result {
                    Ok(Ok(_)) => {
                        if let Some(ref tx) = deps.publish_enqueued_tx {
                            let _ = tx.send(PublishEnqueued);
                        }
                    }
                    Ok(Err(error)) => {
                        tracing::warn!(
                            error = %error,
                            "backend-status driver: publish failed; will retry next interval"
                        );
                    }
                    Err(join_error) => {
                        tracing::warn!(
                            error = %join_error,
                            "backend-status driver: spawn_blocking panicked; will retry next interval"
                        );
                    }
                }

                next_heartbeat_at = Instant::now() + heartbeat_interval;
            }
            _ = tokio::time::sleep_until(next_agent_list_at) => {
                let now_ms = current_unix_time_ms();
                let tenex_base_dir = deps.tenex_base_dir.clone();
                let daemon_dir = deps.daemon_dir.clone();

                let result = tokio::task::spawn_blocking(move || {
                    publish_backend_agent_list_from_filesystem(BackendStatusRuntimeInput::new(
                        &tenex_base_dir,
                        &daemon_dir,
                        now_ms / 1_000,
                        now_ms,
                        now_ms,
                    ))
                })
                .await;

                match result {
                    Ok(Ok(_)) => {
                        if let Some(ref tx) = deps.publish_enqueued_tx {
                            let _ = tx.send(PublishEnqueued);
                        }
                    }
                    Ok(Err(error)) => {
                        tracing::warn!(
                            error = %error,
                            "agent-list driver: publish failed; will retry next interval"
                        );
                    }
                    Err(join_error) => {
                        tracing::warn!(
                            error = %join_error,
                            "agent-list driver: spawn_blocking panicked; will retry next interval"
                        );
                    }
                }

                next_agent_list_at = Instant::now() + agent_list_interval;
            }
        }
    }
}

fn current_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time must be after UNIX_EPOCH")
        .as_millis() as u64
}
