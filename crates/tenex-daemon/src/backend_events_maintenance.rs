use std::path::{Path, PathBuf};

use serde::Serialize;
use thiserror::Error;

use crate::backend_events_tick::{
    BackendEventsDueTickInput, BackendEventsTaskRegistration, BackendEventsTickError,
    BackendEventsTickInput, BackendEventsTickOutcome, BackendEventsTickProject,
    ensure_backend_events_tasks, tick_backend_events, tick_backend_events_for_due_tasks,
};
use crate::periodic_tick::PeriodicSchedulerSnapshot;
use crate::periodic_tick_state::{
    PeriodicTickStateError, periodic_scheduler_state_path, read_periodic_scheduler_state,
    write_periodic_scheduler_state,
};
use crate::publish_outbox::{PublishOutboxDiagnostics, PublishOutboxError, inspect_publish_outbox};

#[derive(Debug, Clone)]
pub struct BackendEventsMaintenanceInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub now: u64,
    pub first_due_at: u64,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub projects: &'a [BackendEventsTickProject<'a>],
}

#[derive(Debug, Clone)]
pub struct BackendEventsMaintenanceSharedSchedulerInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub now: u64,
    pub first_due_at: u64,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub projects: &'a [BackendEventsTickProject<'a>],
    pub registered: BackendEventsTaskRegistration,
    pub due_task_names: Vec<String>,
    pub scheduler_snapshot: PeriodicSchedulerSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEventsMaintenanceOutcome {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
    pub now: u64,
    pub first_due_at: u64,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub scheduler_state_path: PathBuf,
    pub registered: BackendEventsTaskRegistration,
    pub tick: BackendEventsTickOutcome,
    pub persisted_scheduler_snapshot: PeriodicSchedulerSnapshot,
    pub publish_outbox_after: PublishOutboxDiagnostics,
}

#[derive(Debug, Error)]
pub enum BackendEventsMaintenanceError {
    #[error("periodic scheduler state failed: {0}")]
    SchedulerState(#[from] PeriodicTickStateError),
    #[error("backend events tick failed: {0}")]
    Tick(#[from] BackendEventsTickError),
    #[error("publish outbox diagnostics failed: {0}")]
    PublishOutbox(#[from] PublishOutboxError),
}

pub fn maintain_backend_events_from_filesystem(
    input: BackendEventsMaintenanceInput<'_>,
) -> Result<BackendEventsMaintenanceOutcome, BackendEventsMaintenanceError> {
    let mut scheduler = read_periodic_scheduler_state(input.daemon_dir)?;
    let registered =
        ensure_backend_events_tasks(&mut scheduler, input.first_due_at, input.projects)
            .map_err(BackendEventsTickError::from)?;
    let tick = tick_backend_events(BackendEventsTickInput {
        now: input.now,
        scheduler: &mut scheduler,
        tenex_base_dir: input.tenex_base_dir,
        daemon_dir: input.daemon_dir,
        accepted_at: input.accepted_at,
        request_timestamp: input.request_timestamp,
        projects: input.projects,
    })?;
    let persisted_scheduler_snapshot =
        write_periodic_scheduler_state(input.daemon_dir, &scheduler)?;
    let publish_outbox_after = inspect_publish_outbox(input.daemon_dir, input.accepted_at)?;

    Ok(BackendEventsMaintenanceOutcome {
        tenex_base_dir: input.tenex_base_dir.to_path_buf(),
        daemon_dir: input.daemon_dir.to_path_buf(),
        now: input.now,
        first_due_at: input.first_due_at,
        accepted_at: input.accepted_at,
        request_timestamp: input.request_timestamp,
        scheduler_state_path: periodic_scheduler_state_path(input.daemon_dir),
        registered,
        tick,
        persisted_scheduler_snapshot,
        publish_outbox_after,
    })
}

pub fn maintain_backend_events_from_shared_scheduler(
    input: BackendEventsMaintenanceSharedSchedulerInput<'_>,
) -> Result<BackendEventsMaintenanceOutcome, BackendEventsMaintenanceError> {
    let tick = tick_backend_events_for_due_tasks(BackendEventsDueTickInput {
        now: input.now,
        due_task_names: input.due_task_names,
        scheduler_snapshot: input.scheduler_snapshot.clone(),
        tenex_base_dir: input.tenex_base_dir,
        daemon_dir: input.daemon_dir,
        accepted_at: input.accepted_at,
        request_timestamp: input.request_timestamp,
        projects: input.projects,
    })?;
    let publish_outbox_after = inspect_publish_outbox(input.daemon_dir, input.accepted_at)?;

    Ok(BackendEventsMaintenanceOutcome {
        tenex_base_dir: input.tenex_base_dir.to_path_buf(),
        daemon_dir: input.daemon_dir.to_path_buf(),
        now: input.now,
        first_due_at: input.first_due_at,
        accepted_at: input.accepted_at,
        request_timestamp: input.request_timestamp,
        scheduler_state_path: periodic_scheduler_state_path(input.daemon_dir),
        registered: input.registered,
        tick,
        persisted_scheduler_snapshot: input.scheduler_snapshot,
        publish_outbox_after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const TEST_OWNER_PUBKEY_HEX: &str =
        "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";

    #[test]
    fn backend_events_maintenance_with_no_projects_is_a_noop() {
        // Backend-status (kind 24012/24011) now publishes from the dedicated
        // backend_status_driver, not from this maintenance pass. With zero
        // booted projects, this pass has no work to do.
        let base_dir = unique_temp_dir("backend-events-maintenance-base");
        let daemon_dir = base_dir.join("daemon");
        let agents_dir = base_dir.join("agents");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            backend_config_path(&base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{TEST_OWNER_PUBKEY_HEX}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");

        let outcome = maintain_backend_events_from_filesystem(BackendEventsMaintenanceInput {
            tenex_base_dir: &base_dir,
            daemon_dir: &daemon_dir,
            now: 1_710_001_000,
            first_due_at: 1_710_001_000,
            accepted_at: 1_710_001_000_100,
            request_timestamp: 1_710_001_000_050,
            projects: &[],
        })
        .expect("maintenance run must succeed");

        assert!(outcome.tick.due_task_names.is_empty());
        assert!(outcome.tick.project_statuses.is_empty());
        assert_eq!(outcome.publish_outbox_after.pending_count, 0);
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }
}
