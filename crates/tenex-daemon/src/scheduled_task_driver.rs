//! Async supervisor + per-project scheduled-task driver. Replaces the
//! `scheduled-task-due-planner` entry in the `PeriodicScheduler`.
//!
//! Each booted project gets its own driver task that computes the next due
//! time across that project's `schedules.json` and sleeps until then. There
//! is no central tick — each per-project task owns its own `sleep_until`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::backend_config::read_backend_config;
use crate::daemon_maintenance::DAEMON_MAINTENANCE_WRITER_VERSION;
use crate::daemon_signals::BootedProject;
use crate::project_event_index::ProjectEventIndex;
use crate::scheduled_task_due_planner::{
    SCHEDULED_TASK_DUE_PLANNER_DEFAULT_GRACE_SECONDS, ScheduledTaskDuePlannerInput,
    ScheduledTaskDuePlannerProject, finalize_scheduled_task_trigger_plan,
    next_project_scheduled_task_due_at, plan_due_scheduled_tasks,
};
use crate::scheduled_task_enqueue::{ScheduledTaskEnqueueInput, enqueue_scheduled_task_dispatch};

pub struct ScheduledTaskDriverDeps {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
    pub project_event_index: Arc<Mutex<ProjectEventIndex>>,
}

/// Outer supervisor. Awaits `project_booted_rx` and spawns/replaces a
/// per-project driver task for each booted project.
pub async fn run_scheduled_task_supervisor(
    deps: ScheduledTaskDriverDeps,
    mut project_booted_rx: mpsc::UnboundedReceiver<BootedProject>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let deps = Arc::new(deps);
    let mut tasks: BTreeMap<(String, String), JoinHandle<()>> = BTreeMap::new();

    loop {
        tokio::select! {
            maybe = project_booted_rx.recv() => {
                let Some(booted) = maybe else {
                    break;
                };
                let key = (booted.project_owner_pubkey.clone(), booted.project_d_tag.clone());
                if let Some(old) = tasks.remove(&key) {
                    old.abort();
                }
                let task = tokio::spawn(run_scheduled_task_project_driver(
                    Arc::clone(&deps),
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

    for (_, task) in tasks {
        task.abort();
    }
}

/// Per-project driver. Computes the next due time across the project's
/// `schedules.json`, sleeps until then, fires due tasks, then repeats.
/// If there are no schedulable tasks, it waits for shutdown.
async fn run_scheduled_task_project_driver(
    deps: Arc<ScheduledTaskDriverDeps>,
    project_owner_pubkey: String,
    project_d_tag: String,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    loop {
        let now_seconds = current_unix_time_seconds();
        let tenex_base_dir = deps.tenex_base_dir.clone();
        let d_tag = project_d_tag.clone();

        let next_due = tokio::task::spawn_blocking(move || {
            next_project_scheduled_task_due_at(&tenex_base_dir, &d_tag, now_seconds)
        })
        .await;

        let next_due_seconds = match next_due {
            Ok(Ok(Some(t))) => t,
            Ok(Ok(None)) => {
                // No schedulable tasks — wait for shutdown only. The supervisor
                // will re-spawn this task when the project boots again.
                tokio::select! {
                    _ = shutdown_rx.changed() => return,
                }
            }
            Ok(Err(error)) => {
                tracing::warn!(
                    project_owner = %project_owner_pubkey,
                    project_d_tag = %project_d_tag,
                    error = %error,
                    "scheduled-task driver: failed to compute next due time; will retry in 30s"
                );
                tokio::select! {
                    _ = shutdown_rx.changed() => return,
                    _ = tokio::time::sleep(Duration::from_secs(30)) => continue,
                }
            }
            Err(join_error) => {
                tracing::warn!(
                    project_owner = %project_owner_pubkey,
                    project_d_tag = %project_d_tag,
                    error = %join_error,
                    "scheduled-task driver: spawn_blocking panicked computing next due; will retry in 30s"
                );
                tokio::select! {
                    _ = shutdown_rx.changed() => return,
                    _ = tokio::time::sleep(Duration::from_secs(30)) => continue,
                }
            }
        };

        // Sleep until the next due time.
        let now_seconds_now = current_unix_time_seconds();
        let sleep_secs = next_due_seconds.saturating_sub(now_seconds_now);
        let wake_at = Instant::now() + Duration::from_secs(sleep_secs);

        tokio::select! {
            _ = shutdown_rx.changed() => return,
            _ = tokio::time::sleep_until(wake_at) => {}
        }

        // Fire due tasks.
        let now_ms = current_unix_time_ms();
        let now_seconds = now_ms / 1_000;
        let tenex_base_dir = deps.tenex_base_dir.clone();
        let daemon_dir = deps.daemon_dir.clone();
        let project_event_index = Arc::clone(&deps.project_event_index);
        let owner = project_owner_pubkey.clone();
        let d_tag = project_d_tag.clone();

        let result = tokio::task::spawn_blocking(move || {
            fire_due_scheduled_tasks(
                &tenex_base_dir,
                &daemon_dir,
                &project_event_index,
                &owner,
                &d_tag,
                now_ms,
                now_seconds,
            )
        })
        .await;

        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(
                    project_owner = %project_owner_pubkey,
                    project_d_tag = %project_d_tag,
                    error = %error,
                    "scheduled-task driver: firing due tasks failed"
                );
            }
            Err(join_error) => {
                tracing::warn!(
                    project_owner = %project_owner_pubkey,
                    project_d_tag = %project_d_tag,
                    error = %join_error,
                    "scheduled-task driver: spawn_blocking panicked firing due tasks"
                );
            }
        }
    }
}

fn fire_due_scheduled_tasks(
    tenex_base_dir: &std::path::Path,
    daemon_dir: &std::path::Path,
    project_event_index: &Arc<Mutex<ProjectEventIndex>>,
    project_owner_pubkey: &str,
    project_d_tag: &str,
    now_ms: u64,
    now_seconds: u64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = read_backend_config(tenex_base_dir)?;
    let projects_base = config
        .projects_base
        .as_deref()
        .unwrap_or("/tmp/tenex-projects");

    let descriptor = {
        let index = project_event_index
            .lock()
            .expect("project event index mutex must not be poisoned");
        let report = index.descriptors_report(projects_base);
        report
            .descriptors
            .into_iter()
            .find(|d| {
                d.project_owner_pubkey == project_owner_pubkey && d.project_d_tag == project_d_tag
            })
    };

    let Some(descriptor) = descriptor else {
        tracing::debug!(
            project_owner = %project_owner_pubkey,
            project_d_tag = %project_d_tag,
            "scheduled-task driver: project descriptor not found in index; skipping fire"
        );
        return Ok(());
    };

    let outcome = plan_due_scheduled_tasks(ScheduledTaskDuePlannerInput {
        tenex_base_dir,
        projects: &[ScheduledTaskDuePlannerProject { project_d_tag }],
        now: now_seconds,
        grace_seconds: SCHEDULED_TASK_DUE_PLANNER_DEFAULT_GRACE_SECONDS,
        max_plans: usize::MAX,
    })?;

    for plan in &outcome.plans {
        let enqueue_result = enqueue_scheduled_task_dispatch(ScheduledTaskEnqueueInput {
            daemon_dir,
            tenex_base_dir,
            project: &descriptor,
            plan,
            timestamp: now_ms,
            writer_version: DAEMON_MAINTENANCE_WRITER_VERSION.to_string(),
        });
        match enqueue_result {
            Ok(enqueue) => {
                tracing::info!(
                    project_d_tag = %project_d_tag,
                    task_id = %plan.task_id,
                    dispatch_id = %enqueue.dispatch_id,
                    queued = enqueue.queued,
                    "scheduled-task driver: task dispatched"
                );
                if let Err(error) = finalize_scheduled_task_trigger_plan(tenex_base_dir, plan) {
                    tracing::warn!(
                        project_d_tag = %project_d_tag,
                        task_id = %plan.task_id,
                        error = %error,
                        "scheduled-task driver: finalization failed after dispatch"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(
                    project_d_tag = %project_d_tag,
                    task_id = %plan.task_id,
                    error = %error,
                    "scheduled-task driver: enqueue failed"
                );
            }
        }
    }

    Ok(())
}

fn current_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time must be after UNIX_EPOCH")
        .as_millis() as u64
}

fn current_unix_time_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time must be after UNIX_EPOCH")
        .as_secs()
}
