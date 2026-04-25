//! Async supervisor + per-project timer tasks for periodic project-status
//! publish (kind 31934). Replaces the `project-status:<owner>:<d_tag>` entries
//! in the `PeriodicScheduler`. Each booted project gets its own
//! `tokio::time::sleep_until` loop; no central tick is involved.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::backend_events_tick::PROJECT_STATUS_TICK_INTERVAL_SECONDS;
use crate::daemon_signals::BootedProject;
use crate::project_status_runtime::{ProjectStatusRuntimeInput, publish_project_status_from_filesystem};

pub struct ProjectStatusDriverDeps {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
}

/// Outer supervisor. Awaits `project_booted_rx` and spawns/replaces a
/// per-project timer task for each booted project.
pub async fn run_project_status_supervisor(
    deps: ProjectStatusDriverDeps,
    mut project_booted_rx: mpsc::UnboundedReceiver<BootedProject>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let mut tasks: BTreeMap<(String, String), JoinHandle<()>> = BTreeMap::new();

    loop {
        tokio::select! {
            maybe = project_booted_rx.recv() => {
                let Some(booted) = maybe else {
                    // Channel closed — all senders dropped; shut down.
                    break;
                };
                let key = (booted.project_owner_pubkey.clone(), booted.project_d_tag.clone());
                // If there's already a task for this project, abort it before
                // spawning a replacement. Boot events are idempotent but the
                // plan says "first publish immediately on boot" — re-spawning
                // ensures the timer resets and the status is published promptly.
                if let Some(old) = tasks.remove(&key) {
                    old.abort();
                }
                let task = tokio::spawn(run_project_status_task(
                    deps.tenex_base_dir.clone(),
                    deps.daemon_dir.clone(),
                    booted.project_owner_pubkey,
                    booted.project_d_tag,
                    shutdown_rx.clone(),
                ));
                tasks.insert(key, task);
            }
            _ = shutdown_rx.changed() => {
                break;
            }
        }
    }

    // Abort all per-project tasks on supervisor exit.
    for (_, task) in tasks {
        task.abort();
    }
}

/// Per-project timer task. Publishes the project's kind 31934 status
/// immediately on start, then every 30 seconds.
async fn run_project_status_task(
    tenex_base_dir: PathBuf,
    daemon_dir: PathBuf,
    project_owner_pubkey: String,
    project_d_tag: String,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let interval = Duration::from_secs(PROJECT_STATUS_TICK_INTERVAL_SECONDS);
    // First publish fires immediately (matches the current "register with
    // first_due_at = now" behaviour in backend_events_tick.rs:163).
    let mut next_at = Instant::now();

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => break,
            _ = tokio::time::sleep_until(next_at) => {
                let now_ms = current_unix_time_ms();
                let tenex_base_dir = tenex_base_dir.clone();
                let daemon_dir = daemon_dir.clone();
                let owner = project_owner_pubkey.clone();
                let d_tag = project_d_tag.clone();

                let result = tokio::task::spawn_blocking(move || {
                    publish_project_status_from_filesystem(ProjectStatusRuntimeInput {
                        tenex_base_dir: &tenex_base_dir,
                        daemon_dir: &daemon_dir,
                        created_at: now_ms / 1_000,
                        accepted_at: now_ms,
                        request_timestamp: now_ms,
                        project_owner_pubkey: &owner,
                        project_d_tag: &d_tag,
                        project_manager_pubkey: None,
                        project_base_path: None,
                        agents: None,
                        worktrees: None,
                    })
                })
                .await;

                match result {
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => {
                        tracing::warn!(
                            project_owner = %project_owner_pubkey,
                            project_d_tag = %project_d_tag,
                            error = %error,
                            "project-status driver: publish failed; will retry next interval"
                        );
                    }
                    Err(join_error) => {
                        tracing::warn!(
                            project_owner = %project_owner_pubkey,
                            project_d_tag = %project_d_tag,
                            error = %join_error,
                            "project-status driver: spawn_blocking panicked; will retry next interval"
                        );
                    }
                }

                next_at = Instant::now() + interval;
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
