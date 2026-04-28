//! Main daemon loop: file-watch + cron-timer management.
//!
//! Each active task gets a dedicated tokio task that sleeps until its next
//! fire time, publishes the kind:1 event, updates `lastRun`, and loops.
//! The file-watcher reconciles the in-memory task map when schedules.json
//! files change on disk.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::Utc;
use croner::Cron;
use notify::{Config as NotifyConfig, Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::model::ScheduledTask;
use crate::publish::Publisher;
use crate::resolver;
use crate::storage;

const CATCHUP_WINDOW_SECS: i64 = 24 * 60 * 60;
const CATCHUP_SPACING_MS: u64 = 5_000;
const ONEOFF_RECHECK_SECS: u64 = 24 * 60 * 60;

pub async fn run(cfg: Config) -> Result<()> {
    let publisher = Arc::new(
        Publisher::new(&cfg.backend_secret_key, &cfg.relays)
            .await
            .context("init publisher")?,
    );

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let task_handles: Arc<Mutex<HashMap<String, JoinHandle<()>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Load all projects and run catch-up, then arm initial timers.
    let dtags = storage::list_project_dtags().context("list project dtags")?;
    for d_tag in &dtags {
        let tasks = storage::load_tasks(d_tag).context("load tasks")?;
        for task in tasks.tasks {
            catch_up_and_arm(
                d_tag.clone(),
                task,
                Arc::clone(&publisher),
                Arc::clone(&task_handles),
                shutdown_rx.clone(),
            )
            .await;
        }
    }

    // File watcher — notify when schedules.json files change.
    let projects_dir = crate::paths::projects_dir();
    let (fs_tx, mut fs_rx) = tokio::sync::mpsc::channel::<Result<NotifyEvent, notify::Error>>(64);
    let mut watcher = RecommendedWatcher::new(
        move |res| {
            fs_tx.blocking_send(res).ok();
        },
        NotifyConfig::default(),
    )
    .context("create file watcher")?;

    if projects_dir.exists() {
        watcher
            .watch(&projects_dir, RecursiveMode::Recursive)
            .context("watch projects dir")?;
        info!(path = %projects_dir.display(), "watching for schedule changes");
    }

    let mut sigint = signal(SignalKind::interrupt()).context("SIGINT handler")?;
    let mut sigterm = signal(SignalKind::terminate()).context("SIGTERM handler")?;

    info!("tenex-scheduler daemon running");

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
            Some(event) = fs_rx.recv() => {
                match event {
                    Ok(ev) => {
                        reconcile_from_event(
                            ev,
                            Arc::clone(&publisher),
                            Arc::clone(&task_handles),
                            shutdown_rx.clone(),
                        )
                        .await;
                    }
                    Err(e) => warn!(error = %e, "file watcher error"),
                }
            }
        }
    }

    // Signal all task loops to stop and wait for them.
    let _ = shutdown_tx.send(true);
    let mut handles = task_handles.lock().await;
    for (_, handle) in handles.drain() {
        handle.abort();
    }
    Ok(())
}

/// After a file-system event, reload the affected project's schedules and
/// reconcile running task loops.
async fn reconcile_from_event(
    event: NotifyEvent,
    publisher: Arc<Publisher>,
    task_handles: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    shutdown_rx: watch::Receiver<bool>,
) {
    for path in &event.paths {
        let Some(d_tag) = project_dtag_from_path(path) else {
            continue;
        };
        let tasks = match storage::load_tasks(&d_tag) {
            Ok(f) => f.tasks,
            Err(e) => {
                warn!(d_tag, error = %e, "reload schedules failed");
                continue;
            }
        };

        let task_ids: std::collections::HashSet<String> =
            tasks.iter().map(|t| t.id.clone()).collect();

        // Abort loops for tasks that were removed.
        {
            let mut handles = task_handles.lock().await;
            let removed: Vec<String> = handles
                .keys()
                .filter(|id| id.starts_with(&format!("{d_tag}::")) && !task_ids.contains(*id))
                .cloned()
                .collect();
            for id in removed {
                if let Some(h) = handles.remove(&id) {
                    h.abort();
                }
            }
        }

        // Arm new or updated tasks.
        for task in tasks {
            let key = format!("{d_tag}::{}", task.id);
            let already_running = task_handles.lock().await.contains_key(&key);
            if !already_running {
                catch_up_and_arm(
                    d_tag.clone(),
                    task,
                    Arc::clone(&publisher),
                    Arc::clone(&task_handles),
                    shutdown_rx.clone(),
                )
                .await;
            }
        }

        info!(d_tag, "reconciled schedules");
    }
}

/// Run catch-up for missed firings, then arm the ongoing timer loop.
async fn catch_up_and_arm(
    d_tag: String,
    task: ScheduledTask,
    publisher: Arc<Publisher>,
    task_handles: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    shutdown_rx: watch::Receiver<bool>,
) {
    let key = format!("{d_tag}::{}", task.id);

    // Abort any existing loop for this task before re-arming.
    {
        let mut handles = task_handles.lock().await;
        if let Some(old) = handles.remove(&key) {
            old.abort();
        }
    }

    let target_pubkey = match resolver::resolve_slug(&task.target_agent_slug) {
        Ok(pk) => pk,
        Err(e) => {
            error!(task_id = %task.id, error = %e, "failed to resolve agent slug");
            return;
        }
    };

    // Catch-up: fire missed cron occurrences within the last 24h.
    if task.is_cron() {
        let missed = missed_occurrences(&task);
        if !missed.is_empty() {
            info!(
                task_id = %task.id,
                count = missed.len(),
                "firing catch-up occurrences"
            );
            for _ in missed {
                if let Err(e) = publisher.publish_task(&task, target_pubkey.as_deref()).await {
                    error!(task_id = %task.id, error = %e, "catch-up publish failed");
                }
                tokio::time::sleep(Duration::from_millis(CATCHUP_SPACING_MS)).await;
            }
            let now_iso = Utc::now().to_rfc3339();
            storage::update_last_run(&d_tag, &task.id, &now_iso).ok();
        }
    } else if task.is_oneoff() {
        if let Some(fire_at) = oneoff_catchup_deadline(&task) {
            if fire_at <= Utc::now() {
                if let Err(e) = publisher.publish_task(&task, target_pubkey.as_deref()).await {
                    error!(task_id = %task.id, error = %e, "one-off catch-up publish failed");
                }
                // Remove the one-off task after firing.
                storage::remove_task(&d_tag, &task.id).ok();
                return;
            }
        }
    }

    // Spawn the ongoing timer loop.
    let d_tag_c = d_tag.clone();
    let task_c = task.clone();
    let pub_c = Arc::clone(&publisher);
    let mut rx = shutdown_rx;

    let handle = tokio::spawn(async move {
        run_task_loop(d_tag_c, task_c, pub_c, &mut rx).await;
    });

    task_handles.lock().await.insert(key, handle);
}

async fn run_task_loop(
    d_tag: String,
    task: ScheduledTask,
    publisher: Arc<Publisher>,
    shutdown_rx: &mut watch::Receiver<bool>,
) {
    if task.is_oneoff() {
        run_oneoff_loop(d_tag, task, publisher, shutdown_rx).await;
    } else {
        run_cron_loop(d_tag, task, publisher, shutdown_rx).await;
    }
}

async fn run_cron_loop(
    d_tag: String,
    task: ScheduledTask,
    publisher: Arc<Publisher>,
    shutdown_rx: &mut watch::Receiver<bool>,
) {
    let cron = match task.schedule.parse::<Cron>() {
        Ok(c) => c,
        Err(e) => {
            error!(task_id = %task.id, schedule = %task.schedule, error = %e, "invalid cron expression");
            return;
        }
    };

    loop {
        let next = match cron.find_next_occurrence(&Utc::now(), false) {
            Ok(t) => t,
            Err(e) => {
                error!(task_id = %task.id, error = %e, "cron next occurrence failed");
                return;
            }
        };

        let delay = (next - Utc::now())
            .to_std()
            .unwrap_or(Duration::ZERO);

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown_rx.changed() => return,
        }

        if *shutdown_rx.borrow() {
            return;
        }

        let target_pubkey = match resolver::resolve_slug(&task.target_agent_slug) {
            Ok(pk) => pk,
            Err(e) => {
                error!(task_id = %task.id, error = %e, "failed to resolve agent slug");
                return;
            }
        };
        if let Err(e) = publisher.publish_task(&task, target_pubkey.as_deref()).await {
            error!(task_id = %task.id, error = %e, "publish failed");
        } else {
            let now_iso = Utc::now().to_rfc3339();
            storage::update_last_run(&d_tag, &task.id, &now_iso).ok();
        }
    }
}

async fn run_oneoff_loop(
    d_tag: String,
    task: ScheduledTask,
    publisher: Arc<Publisher>,
    shutdown_rx: &mut watch::Receiver<bool>,
) {
    let execute_at_str = match task.execute_at.as_deref() {
        Some(s) => s,
        None => {
            error!(task_id = %task.id, "one-off task has no executeAt timestamp");
            return;
        }
    };
    let execute_at = match chrono::DateTime::parse_from_rfc3339(execute_at_str) {
        Ok(t) => t.with_timezone(&Utc),
        Err(e) => {
            error!(task_id = %task.id, schedule = %execute_at_str, error = %e, "invalid executeAt timestamp");
            return;
        }
    };

    loop {
        let now = Utc::now();
        if execute_at <= now {
            break;
        }
        let delay = (execute_at - now)
            .to_std()
            .unwrap_or(Duration::ZERO)
            .min(Duration::from_secs(ONEOFF_RECHECK_SECS));

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown_rx.changed() => return,
        }

        if *shutdown_rx.borrow() {
            return;
        }
    }

    let target_pubkey = match resolver::resolve_slug(&task.target_agent_slug) {
        Ok(pk) => pk,
        Err(e) => {
            error!(task_id = %task.id, error = %e, "failed to resolve agent slug");
            return;
        }
    };
    if let Err(e) = publisher.publish_task(&task, target_pubkey.as_deref()).await {
        error!(task_id = %task.id, error = %e, "one-off publish failed");
    } else {
        storage::remove_task(&d_tag, &task.id).ok();
        info!(task_id = %task.id, "one-off task fired and removed");
    }
}

/// Return occurrences of a cron task that were missed (within the last 24h).
fn missed_occurrences(task: &ScheduledTask) -> Vec<chrono::DateTime<Utc>> {
    let cron = match task.schedule.parse::<Cron>() {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let last_run = task
        .last_run
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc));

    let Some(from) = last_run else {
        return vec![];
    };

    let cutoff = Utc::now() - chrono::Duration::seconds(CATCHUP_WINDOW_SECS);
    let start = from.max(cutoff);
    let now = Utc::now();

    let mut missed = Vec::new();
    let mut iter = cron.iter_from(start);
    while let Some(t) = iter.next() {
        if t >= now {
            break;
        }
        missed.push(t);
    }
    missed
}

/// For a one-off task, return the fire time if it's within the catch-up window
/// and hasn't been fired yet (no `lastRun`). Returns `None` if already fired
/// or expired.
fn oneoff_catchup_deadline(task: &ScheduledTask) -> Option<chrono::DateTime<Utc>> {
    if task.last_run.is_some() {
        return None; // already fired
    }
    let execute_at_str = match task.execute_at.as_deref() {
        Some(s) => s,
        None => {
            warn!(task_id = %task.id, "one-off task has no executeAt, skipping catch-up");
            return None;
        }
    };
    let t = chrono::DateTime::parse_from_rfc3339(execute_at_str)
        .ok()?
        .with_timezone(&Utc);
    let cutoff = Utc::now() - chrono::Duration::seconds(CATCHUP_WINDOW_SECS);
    if t < cutoff {
        return None; // expired, outside 24h window
    }
    Some(t)
}

fn project_dtag_from_path(path: &PathBuf) -> Option<String> {
    let projects_dir = crate::paths::projects_dir();
    let rel = path.strip_prefix(&projects_dir).ok()?;
    let d_tag = rel.components().next()?.as_os_str().to_str()?.to_string();
    Some(d_tag)
}
