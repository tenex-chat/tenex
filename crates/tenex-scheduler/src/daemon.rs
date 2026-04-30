//! Main daemon loop: file-watch + cron-timer management.
//!
//! Each active task gets a dedicated tokio task that sleeps until its next
//! fire time, publishes the kind:1 event, updates `lastRun`, and loops.
//! The file-watcher reconciles the in-memory task map when schedules.json
//! files change on disk.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use notify::{
    Config as NotifyConfig, Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher,
};
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};

use crate::config::Config;
use crate::cron;
use crate::model::ScheduledTask;
use crate::publish::Publisher;
use crate::resolver;
use crate::storage;

const CATCHUP_WINDOW_SECS: i64 = 24 * 60 * 60;
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
        for task in tasks {
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
    let projects_dir = crate::paths::projects_dir();
    let changed_dtags = project_dtags_from_schedule_paths(&projects_dir, &event.paths);

    for d_tag in changed_dtags {
        let tasks = match storage::load_tasks(&d_tag) {
            Ok(tasks) => tasks,
            Err(e) => {
                warn!(d_tag, error = %e, "reload schedules failed");
                continue;
            }
        };

        let task_ids: HashSet<String> = tasks.iter().map(|t| t.id.clone()).collect();

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

        debug!(d_tag, "reconciled schedules");
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
        let missed = match cron::missed_occurrences(&task, Utc::now(), CATCHUP_WINDOW_SECS) {
            Ok(missed) => missed,
            Err(e) => {
                error!(task_id = %task.id, schedule = %task.schedule, error = %e, "invalid cron expression");
                return;
            }
        };
        if !missed.is_empty() {
            info!(
                task_id = %task.id,
                missed = missed.len(),
                "catch-up: firing once for most recent missed occurrence",
            );
            if let Err(e) = publisher
                .publish_task(&task, target_pubkey.as_deref())
                .await
            {
                error!(task_id = %task.id, error = %e, "catch-up publish failed");
            }
            let now_iso = Utc::now().to_rfc3339();
            storage::update_last_run(&d_tag, &task.id, &now_iso).ok();
        }
    } else if task.is_oneoff() {
        if let Some(fire_at) = oneoff_catchup_deadline(&task) {
            if fire_at <= Utc::now() {
                if let Err(e) = publisher
                    .publish_task(&task, target_pubkey.as_deref())
                    .await
                {
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
    let cron = match cron::parse_schedule(&task.schedule) {
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

        let delay = match cron_delay_until(next, Utc::now()) {
            Ok(d) => d,
            Err(elapsed) => {
                // The runtime stalled between picking `next` and computing the
                // delay (e.g. system suspend, GC pause). Skip this occurrence
                // and let the next loop iteration find the following one.
                warn!(
                    task_id = %task.id,
                    target = %next.to_rfc3339(),
                    elapsed_secs = elapsed.as_secs(),
                    "cron next occurrence already in the past; advancing to next",
                );
                continue;
            }
        };

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
        if let Err(e) = publisher
            .publish_task(&task, target_pubkey.as_deref())
            .await
        {
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
        // The guard above ensures `execute_at > now`, so the difference is
        // strictly positive and `to_std` cannot fail.
        let remaining = match (execute_at - now).to_std() {
            Ok(d) => d,
            Err(_) => {
                error!(
                    task_id = %task.id,
                    "one-off remaining duration went negative after positive guard",
                );
                return;
            }
        };
        let delay = remaining.min(Duration::from_secs(ONEOFF_RECHECK_SECS));

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
    if let Err(e) = publisher
        .publish_task(&task, target_pubkey.as_deref())
        .await
    {
        error!(task_id = %task.id, error = %e, "one-off publish failed");
    } else {
        storage::remove_task(&d_tag, &task.id).ok();
        info!(task_id = %task.id, "one-off task fired and removed");
    }
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

/// Compute how long to sleep until `next`. Returns `Err(elapsed)` if `next`
/// is already in the past (clock skew, runtime stall, suspend), letting the
/// caller skip the occurrence and recompute against the next one.
fn cron_delay_until(next: DateTime<Utc>, now: DateTime<Utc>) -> Result<Duration, Duration> {
    let diff = next - now;
    diff.to_std()
        .map_err(|_| (now - next).to_std().unwrap_or(Duration::ZERO))
}

fn project_dtags_from_schedule_paths(projects_dir: &Path, paths: &[PathBuf]) -> BTreeSet<String> {
    paths
        .iter()
        .filter_map(|path| project_dtag_from_schedule_path_with_projects_dir(projects_dir, path))
        .collect()
}

fn project_dtag_from_schedule_path_with_projects_dir(
    projects_dir: &Path,
    path: &Path,
) -> Option<String> {
    let rel = path.strip_prefix(projects_dir).ok()?;
    let mut components = rel.components();
    let d_tag = components.next()?.as_os_str().to_str()?.to_string();
    let file_name = components.next()?.as_os_str().to_str()?;
    if file_name != "schedules.json" || components.next().is_some() {
        return None;
    }
    Some(d_tag)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use chrono::{TimeZone, Utc};

    use super::{
        cron_delay_until, project_dtag_from_schedule_path_with_projects_dir,
        project_dtags_from_schedule_paths,
    };

    #[test]
    fn cron_delay_until_future_returns_positive_duration() {
        let now = Utc.with_ymd_and_hms(2026, 4, 29, 9, 0, 0).unwrap();
        let next = Utc.with_ymd_and_hms(2026, 4, 29, 9, 0, 30).unwrap();

        assert_eq!(cron_delay_until(next, now), Ok(Duration::from_secs(30)));
    }

    #[test]
    fn cron_delay_until_past_returns_elapsed_so_caller_can_advance() {
        let now = Utc.with_ymd_and_hms(2026, 4, 29, 9, 0, 30).unwrap();
        let next = Utc.with_ymd_and_hms(2026, 4, 29, 9, 0, 0).unwrap();

        // Negative-duration case must surface as Err, not silently coerce to
        // ZERO. The caller's contract is to skip this occurrence and find the
        // next one rather than fire immediately.
        assert_eq!(cron_delay_until(next, now), Err(Duration::from_secs(30)));
    }

    #[test]
    fn schedule_path_maps_to_project_dtag() {
        let projects_dir = Path::new("/tenex/projects");
        let path = Path::new("/tenex/projects/project-a/schedules.json");

        assert_eq!(
            project_dtag_from_schedule_path_with_projects_dir(projects_dir, path).as_deref(),
            Some("project-a")
        );
    }

    #[test]
    fn non_schedule_project_paths_are_ignored() {
        let projects_dir = Path::new("/tenex/projects");

        for path in [
            Path::new("/tenex/projects/project-a/conversations/thread.json"),
            Path::new("/tenex/projects/project-a/schedules.json.tmp"),
            Path::new("/tenex/projects/project-a/nested/schedules.json"),
            Path::new("/tenex/projects/project-a"),
            Path::new("/other/projects/project-a/schedules.json"),
        ] {
            assert!(
                project_dtag_from_schedule_path_with_projects_dir(projects_dir, path).is_none(),
                "{} should not trigger schedule reconciliation",
                path.display()
            );
        }
    }

    #[test]
    fn schedule_paths_are_deduplicated_by_project() {
        let projects_dir = Path::new("/tenex/projects");
        let paths = vec![
            PathBuf::from("/tenex/projects/project-a/schedules.json"),
            PathBuf::from("/tenex/projects/project-a/schedules.json"),
            PathBuf::from("/tenex/projects/project-a/schedules.json.tmp"),
            PathBuf::from("/tenex/projects/project-b/schedules.json"),
        ];

        let dtags: Vec<_> = project_dtags_from_schedule_paths(projects_dir, &paths)
            .into_iter()
            .collect();

        assert_eq!(dtags, vec!["project-a", "project-b"]);
    }
}
