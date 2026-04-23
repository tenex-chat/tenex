use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use thiserror::Error;

use crate::backend_events::project_status::PROJECT_STATUS_KIND;
use crate::backend_events_maintenance::{
    BackendEventsMaintenanceError, BackendEventsMaintenanceOutcome,
    BackendEventsMaintenanceSharedSchedulerInput, maintain_backend_events_from_shared_scheduler,
};
use crate::backend_events_tick::{BackendEventsTickProject, ensure_backend_events_tasks};
use crate::backend_heartbeat_latch::BackendHeartbeatLatchPlanner;
use crate::intervention::{
    InterventionMaintenanceError, InterventionMaintenanceInput, InterventionMaintenanceOutcome,
    run_intervention_maintenance,
};
use crate::periodic_tick_state::{
    PeriodicTickStateError, read_periodic_scheduler_state, write_periodic_scheduler_state,
};
use crate::project_boot_state::{BootedProjectsState, is_project_booted};
use crate::project_status_descriptors::{
    ProjectStatusDescriptor, ProjectStatusDescriptorError, ProjectStatusDescriptorReport,
    read_project_status_descriptors,
};
use crate::publish_outbox::{
    PublishOutboxCancellationOutcome, PublishOutboxError,
    cancel_pending_publish_outbox_records_matching,
};
use crate::scheduled_task_maintenance::{
    ScheduledTaskMaintenanceError, ScheduledTaskMaintenanceOutcome,
    ScheduledTaskMaintenanceSharedSchedulerInput, maintain_scheduled_tasks_from_shared_scheduler,
};
use crate::scheduler_wakeups::{
    SchedulerWakeupError, SchedulerWakeupsMaintenanceReport, run_scheduler_maintenance,
};
use crate::telegram_outbox::{
    TelegramDeliveryPublisher, TelegramOutboxError, TelegramOutboxMaintenanceReport,
    run_telegram_outbox_maintenance, run_telegram_outbox_maintenance_without_drain,
};

pub const DAEMON_MAINTENANCE_WRITER_VERSION: &str =
    concat!("tenex-daemon@", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone)]
pub struct DaemonMaintenanceInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub now_ms: u64,
    pub project_boot_state: BootedProjectsState,
    /// When present, the backend-events maintenance pass gates the kind
    /// 24012 heartbeat on the latch state.
    pub heartbeat_latch: Option<Arc<Mutex<BackendHeartbeatLatchPlanner>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonMaintenanceOutcome {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
    pub now_ms: u64,
    pub now_seconds: u64,
    pub project_descriptor_report: ProjectStatusDescriptorReport,
    pub booted_project_descriptor_report: ProjectStatusDescriptorReport,
    pub project_boot_state: BootedProjectsState,
    pub canceled_unbooted_project_statuses: Vec<PublishOutboxCancellationOutcome>,
    pub backend_events: BackendEventsMaintenanceOutcome,
    pub scheduled_tasks: ScheduledTaskMaintenanceOutcome,
    pub scheduler_wakeups: SchedulerWakeupsMaintenanceReport,
    pub intervention: InterventionMaintenanceOutcome,
    pub telegram_outbox: TelegramOutboxMaintenanceReport,
}

#[derive(Debug, Error)]
pub enum DaemonMaintenanceError {
    #[error("project descriptor discovery failed: {0}")]
    ProjectDescriptors(#[from] ProjectStatusDescriptorError),
    #[error("publish outbox maintenance failed: {0}")]
    PublishOutbox(#[from] PublishOutboxError),
    #[error("backend-events maintenance failed: {0}")]
    BackendEvents(#[from] BackendEventsMaintenanceError),
    #[error("scheduled task maintenance failed: {0}")]
    ScheduledTasks(#[from] ScheduledTaskMaintenanceError),
    #[error("periodic scheduler state failed: {0}")]
    SchedulerState(#[from] PeriodicTickStateError),
    #[error("scheduler wakeups maintenance failed: {0}")]
    SchedulerWakeups(#[from] SchedulerWakeupError),
    #[error("intervention maintenance failed: {0}")]
    Intervention(#[from] InterventionMaintenanceError),
    #[error("telegram outbox maintenance failed: {0}")]
    TelegramOutbox(#[from] TelegramOutboxError),
}

pub fn run_daemon_maintenance_once_from_filesystem(
    input: DaemonMaintenanceInput<'_>,
) -> Result<DaemonMaintenanceOutcome, DaemonMaintenanceError> {
    run_daemon_maintenance_once_from_filesystem_with_telegram(input, NoTelegramPublisher)
}

/// Maintenance entrypoint when a Telegram Bot API client is available.
/// Callers pass a [`TelegramDeliveryPublisher`] such as
/// [`crate::telegram::delivery::TelegramBotDeliveryPublisher`]; the
/// Telegram outbox is drained through it and the resulting
/// [`TelegramOutboxMaintenanceReport`] lands on the same
/// `DaemonMaintenanceOutcome.telegram_outbox` field as the drain-less path,
/// so upstream diagnostics are oblivious to whether a publisher was wired.
pub fn run_daemon_maintenance_once_from_filesystem_with_telegram<P>(
    input: DaemonMaintenanceInput<'_>,
    mut telegram_publisher: P,
) -> Result<DaemonMaintenanceOutcome, DaemonMaintenanceError>
where
    P: TelegramMaintenancePublisher,
{
    let now_seconds = input.now_ms / 1_000;
    let project_descriptor_report = read_project_status_descriptors(input.tenex_base_dir)?;
    let project_boot_state = input.project_boot_state;
    let booted_project_descriptor_report =
        filter_booted_project_descriptors(&project_descriptor_report, &project_boot_state);
    let projects = backend_events_projects_from_descriptors(&booted_project_descriptor_report);
    let canceled_unbooted_project_statuses =
        cancel_pending_unbooted_project_statuses(input.daemon_dir, &project_boot_state)?;
    let mut scheduler = read_periodic_scheduler_state(input.daemon_dir)?;
    let backend_events_registration =
        ensure_backend_events_tasks(&mut scheduler, now_seconds, &projects)
            .map_err(crate::backend_events_tick::BackendEventsTickError::from)
            .map_err(BackendEventsMaintenanceError::from)?;
    let scheduled_task_registration =
        crate::scheduled_task_due_planner::ensure_scheduled_task_due_planner_task(
            &mut scheduler,
            now_seconds,
        )
        .map_err(crate::scheduled_task_due_planner::ScheduledTaskDuePlannerError::from)
        .map_err(|source| ScheduledTaskMaintenanceError::Planner { source })?;
    let due_task_names = scheduler.take_due(now_seconds);
    let scheduler_snapshot = scheduler.inspect();

    let backend_events = maintain_backend_events_from_shared_scheduler(
        BackendEventsMaintenanceSharedSchedulerInput {
            tenex_base_dir: input.tenex_base_dir,
            daemon_dir: input.daemon_dir,
            now: now_seconds,
            first_due_at: now_seconds,
            accepted_at: input.now_ms,
            request_timestamp: input.now_ms,
            projects: &projects,
            registered: backend_events_registration,
            due_task_names: due_task_names.clone(),
            scheduler_snapshot: scheduler_snapshot.clone(),
            heartbeat_latch: input.heartbeat_latch.clone(),
        },
    )?;
    let scheduled_tasks = maintain_scheduled_tasks_from_shared_scheduler(
        ScheduledTaskMaintenanceSharedSchedulerInput {
            tenex_base_dir: input.tenex_base_dir,
            daemon_dir: input.daemon_dir,
            now: now_seconds,
            first_due_at: now_seconds,
            accepted_at: input.now_ms,
            request_timestamp: input.now_ms,
            writer_version: DAEMON_MAINTENANCE_WRITER_VERSION,
            grace_seconds:
                crate::scheduled_task_due_planner::SCHEDULED_TASK_DUE_PLANNER_DEFAULT_GRACE_SECONDS,
            max_plans:
                crate::scheduled_task_maintenance::SCHEDULED_TASK_MAINTENANCE_DEFAULT_MAX_PLANS,
            project_descriptor_report: booted_project_descriptor_report.clone(),
            registered_planner_task: scheduled_task_registration,
            due_task_names,
            scheduler_snapshot: scheduler_snapshot.clone(),
        },
    )?;
    write_periodic_scheduler_state(input.daemon_dir, &scheduler)?;
    let scheduler_wakeups = run_scheduler_maintenance(input.daemon_dir, input.now_ms)?;
    let intervention = run_intervention_maintenance(InterventionMaintenanceInput {
        tenex_base_dir: input.tenex_base_dir,
        daemon_dir: input.daemon_dir,
        now_ms: input.now_ms,
        project_descriptors: &booted_project_descriptor_report.descriptors,
        writer_version: DAEMON_MAINTENANCE_WRITER_VERSION,
    })?;
    let telegram_outbox = telegram_publisher.run_maintenance(input.daemon_dir, input.now_ms)?;

    Ok(DaemonMaintenanceOutcome {
        tenex_base_dir: input.tenex_base_dir.to_path_buf(),
        daemon_dir: input.daemon_dir.to_path_buf(),
        now_ms: input.now_ms,
        now_seconds,
        project_descriptor_report,
        booted_project_descriptor_report,
        project_boot_state,
        canceled_unbooted_project_statuses,
        backend_events,
        scheduled_tasks,
        scheduler_wakeups,
        intervention,
        telegram_outbox,
    })
}

/// Maintenance-pass bridge to the Telegram outbox: either no publisher
/// (drain-less path) or a wrapped real publisher. Keeping this as a trait
/// on the maintenance boundary lets daemon runtime code pass the real
/// Bot API client without widening the outbox library's surface.
pub trait TelegramMaintenancePublisher {
    fn run_maintenance(
        &mut self,
        daemon_dir: &Path,
        now_ms: u64,
    ) -> Result<TelegramOutboxMaintenanceReport, TelegramOutboxError>;
}

/// Sentinel "no publisher available": inspect and requeue but do not drain.
/// Used when the daemon has no Telegram configuration yet, during startup
/// before the adapter initialises, or in tests that don't need outbound
/// delivery.
pub struct NoTelegramPublisher;

impl TelegramMaintenancePublisher for NoTelegramPublisher {
    fn run_maintenance(
        &mut self,
        daemon_dir: &Path,
        now_ms: u64,
    ) -> Result<TelegramOutboxMaintenanceReport, TelegramOutboxError> {
        run_telegram_outbox_maintenance_without_drain(daemon_dir, now_ms)
    }
}

/// Adapter for a live [`TelegramDeliveryPublisher`] implementation (notably
/// the real Bot API client). Wraps the publisher in a one-shot maintenance
/// call so daemon code doesn't need to import the outbox library directly.
pub struct WithTelegramPublisher<'a, P: TelegramDeliveryPublisher>(pub &'a mut P);

impl<'a, P: TelegramDeliveryPublisher> TelegramMaintenancePublisher
    for WithTelegramPublisher<'a, P>
{
    fn run_maintenance(
        &mut self,
        daemon_dir: &Path,
        now_ms: u64,
    ) -> Result<TelegramOutboxMaintenanceReport, TelegramOutboxError> {
        run_telegram_outbox_maintenance(daemon_dir, self.0, now_ms)
    }
}

/// Blanket impl that lets daemon plumbing forward a trait-object maintenance
/// publisher through generic call sites without re-wrapping at every layer.
impl<T: TelegramMaintenancePublisher + ?Sized> TelegramMaintenancePublisher for &mut T {
    fn run_maintenance(
        &mut self,
        daemon_dir: &Path,
        now_ms: u64,
    ) -> Result<TelegramOutboxMaintenanceReport, TelegramOutboxError> {
        (**self).run_maintenance(daemon_dir, now_ms)
    }
}

fn backend_events_projects_from_descriptors<'a>(
    report: &'a ProjectStatusDescriptorReport,
) -> Vec<BackendEventsTickProject<'a>> {
    report
        .descriptors
        .iter()
        .map(|descriptor| BackendEventsTickProject {
            project_owner_pubkey: &descriptor.project_owner_pubkey,
            project_d_tag: &descriptor.project_d_tag,
            project_manager_pubkey: descriptor.project_manager_pubkey.as_deref(),
            project_base_path: descriptor.project_base_path.as_deref().map(Path::new),
            worktrees: if descriptor.worktrees.is_empty() {
                None
            } else {
                Some(&descriptor.worktrees)
            },
        })
        .collect()
}

fn filter_booted_project_descriptors(
    report: &ProjectStatusDescriptorReport,
    boot_state: &BootedProjectsState,
) -> ProjectStatusDescriptorReport {
    ProjectStatusDescriptorReport {
        descriptors: report
            .descriptors
            .iter()
            .filter(|descriptor| descriptor_is_booted(descriptor, boot_state))
            .cloned()
            .collect(),
        skipped_files: report.skipped_files.clone(),
    }
}

fn descriptor_is_booted(
    descriptor: &ProjectStatusDescriptor,
    boot_state: &BootedProjectsState,
) -> bool {
    is_project_booted(
        boot_state,
        &descriptor.project_owner_pubkey,
        &descriptor.project_d_tag,
    )
}

fn cancel_pending_unbooted_project_statuses(
    daemon_dir: &Path,
    boot_state: &BootedProjectsState,
) -> Result<Vec<PublishOutboxCancellationOutcome>, PublishOutboxError> {
    cancel_pending_publish_outbox_records_matching(daemon_dir, |record| {
        record.event.kind == PROJECT_STATUS_KIND
            && !pending_project_status_record_is_booted(record, boot_state)
    })
}

fn pending_project_status_record_is_booted(
    record: &crate::publish_outbox::PublishOutboxRecord,
    boot_state: &BootedProjectsState,
) -> bool {
    record
        .event
        .tags
        .iter()
        .filter(|tag| tag.first().map(String::as_str) == Some("a"))
        .filter_map(|tag| tag.get(1))
        .any(|reference| {
            boot_state
                .projects
                .iter()
                .any(|project| project.project_reference == *reference)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::backend_events_tick::{
        PROJECT_STATUS_TICK_INTERVAL_SECONDS, backend_events_project_status_task_name,
    };
    use crate::backend_status_tick::{
        BACKEND_STATUS_TICK_INTERVAL_SECONDS, BACKEND_STATUS_TICK_TASK_NAME,
    };
    use crate::dispatch_queue::replay_dispatch_queue;
    use crate::periodic_tick::PeriodicScheduler;
    use crate::periodic_tick_state::{
        read_periodic_scheduler_state, write_periodic_scheduler_state,
    };
    use crate::project_boot_state::{ProjectBootState, empty_booted_projects_state};
    use crate::publish_outbox::inspect_publish_outbox;
    use crate::scheduled_task_dispatch_input::read_optional as read_scheduled_task_dispatch_input;
    use crate::scheduled_task_due_planner::{
        SCHEDULED_TASK_DUE_PLANNER_INTERVAL_SECONDS, SCHEDULED_TASK_DUE_PLANNER_TASK_NAME,
    };
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    #[test]
    fn daemon_maintenance_discovers_projects_and_runs_backend_events_once() {
        let tenex_base_dir = unique_temp_dir("daemon-maintenance-base");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        let project_dir = tenex_base_dir.join("projects").join("demo-project");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&project_dir).expect("project dir must create");

        let owner = pubkey_hex(0x02);
        fs::write(
            backend_config_path(&tenex_base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");
        fs::write(
            project_dir.join("project.json"),
            format!(
                r#"{{
                    "schemaVersion": 1,
                    "status": "running",
                    "projectOwnerPubkey": "{owner}",
                    "projectDTag": "demo-project",
                    "worktrees": ["main"]
                }}"#
            ),
        )
        .expect("project descriptor must write");
        let project_boot_state = booted_state(
            &boot_event("boot-event", &owner, "demo-project"),
            1_710_000_999_000,
        );

        let outcome = run_daemon_maintenance_once_from_filesystem(DaemonMaintenanceInput {
            tenex_base_dir: &tenex_base_dir,
            daemon_dir: &daemon_dir,
            now_ms: 1_710_001_000_000,
            project_boot_state,
            heartbeat_latch: None,
        })
        .expect("daemon maintenance must run");

        assert_eq!(outcome.now_seconds, 1_710_001_000);
        assert_eq!(outcome.project_descriptor_report.descriptors.len(), 1);
        assert_eq!(
            outcome.booted_project_descriptor_report.descriptors.len(),
            1
        );
        assert_eq!(outcome.project_boot_state.projects.len(), 1);
        assert!(outcome.canceled_unbooted_project_statuses.is_empty());
        assert_eq!(
            outcome.backend_events.tick.due_task_names,
            vec![
                "backend-status".to_string(),
                format!("project-status:{owner}:demo-project"),
            ]
        );
        assert_eq!(outcome.backend_events.tick.project_statuses.len(), 1);
        assert_eq!(
            outcome
                .backend_events
                .persisted_scheduler_snapshot
                .tasks
                .len(),
            3
        );
        assert!(outcome.scheduled_tasks.triggers.is_empty());
        assert_eq!(
            outcome.scheduled_tasks.planner.due_task_names,
            vec!["scheduled-task-due-planner".to_string()]
        );
        assert_eq!(
            outcome
                .scheduled_tasks
                .persisted_scheduler_snapshot
                .tasks
                .len(),
            3
        );
        assert_eq!(
            outcome.backend_events.tick.scheduler_snapshot,
            outcome.scheduled_tasks.planner.scheduler_snapshot
        );
        assert_eq!(
            outcome.backend_events.persisted_scheduler_snapshot,
            outcome.scheduled_tasks.persisted_scheduler_snapshot
        );
        let persisted_scheduler_snapshot = read_periodic_scheduler_state(&daemon_dir)
            .expect("shared scheduler state must read")
            .inspect();
        assert_eq!(
            outcome.backend_events.persisted_scheduler_snapshot,
            persisted_scheduler_snapshot
        );
        assert_eq!(outcome.scheduler_wakeups.diagnostics_after.pending_count, 0);
        // Telegram outbox is empty on a fresh tenex dir; pass runs without
        // needing a Bot API client because drain is deliberately skipped.
        assert_eq!(outcome.telegram_outbox.diagnostics_after.pending_count, 0);
        assert!(outcome.telegram_outbox.drained.is_empty());
        assert!(outcome.telegram_outbox.requeued.is_empty());

        let publish_outbox = inspect_publish_outbox(&daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.pending_count, 3);

        fs::remove_dir_all(tenex_base_dir).expect("cleanup must succeed");
    }

    #[test]
    fn daemon_maintenance_enqueues_due_scheduled_tasks() {
        let tenex_base_dir = unique_temp_dir("daemon-maintenance-scheduled-base");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        let project_dir = tenex_base_dir.join("projects").join("demo-project");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&project_dir).expect("project dir must create");

        let owner = pubkey_hex(0x02);
        let agent_pubkey = pubkey_hex(0x03);
        fs::write(
            backend_config_path(&tenex_base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");
        fs::write(
            agents_dir.join("index.json"),
            format!(r#"{{"byProject":{{"demo-project":["{agent_pubkey}"]}}}}"#),
        )
        .expect("agent index must write");
        fs::write(
            agents_dir.join(format!("{agent_pubkey}.json")),
            r#"{"slug":"reporter","status":"active","default":{"model":"claude"}}"#,
        )
        .expect("agent source must write");
        fs::write(
            project_dir.join("project.json"),
            format!(
                r#"{{
                    "schemaVersion": 1,
                    "status": "running",
                    "projectOwnerPubkey": "{owner}",
                    "projectDTag": "demo-project",
                    "projectBasePath": "/repo/demo-project",
                    "worktrees": ["main"]
                }}"#
            ),
        )
        .expect("project descriptor must write");
        let project_boot_state = booted_state(
            &boot_event("boot-event", &owner, "demo-project"),
            1_710_000_999_000,
        );
        fs::write(
            project_dir.join("schedules.json"),
            format!(
                r#"[{{
                    "id": "task-one",
                    "title": "One off",
                    "schedule": "2024-03-09T16:00:00.000Z",
                    "executeAt": "2024-03-09T16:00:00.000Z",
                    "prompt": "Run the report",
                    "fromPubkey": "{owner}",
                    "targetAgentSlug": "reporter",
                    "projectId": "31933:{owner}:demo-project",
                    "projectRef": "31933:{owner}:demo-project",
                    "type": "oneoff"
                }}]"#
            ),
        )
        .expect("schedule must write");
        let mut scheduler = PeriodicScheduler::new();
        scheduler
            .register_task(
                BACKEND_STATUS_TICK_TASK_NAME,
                BACKEND_STATUS_TICK_INTERVAL_SECONDS,
                1_710_001_000,
            )
            .expect("backend-status task must register");
        scheduler
            .register_task(
                backend_events_project_status_task_name(&owner, "demo-project"),
                PROJECT_STATUS_TICK_INTERVAL_SECONDS,
                1_710_001_000,
            )
            .expect("project-status task must register");
        scheduler
            .register_task(
                SCHEDULED_TASK_DUE_PLANNER_TASK_NAME,
                SCHEDULED_TASK_DUE_PLANNER_INTERVAL_SECONDS,
                1_710_001_000,
            )
            .expect("scheduled task planner must register");
        write_periodic_scheduler_state(&daemon_dir, &scheduler)
            .expect("shared scheduler state must write");

        let outcome = run_daemon_maintenance_once_from_filesystem(DaemonMaintenanceInput {
            tenex_base_dir: &tenex_base_dir,
            daemon_dir: &daemon_dir,
            now_ms: 1_710_001_000_000,
            project_boot_state,
            heartbeat_latch: None,
        })
        .expect("daemon maintenance must run");

        assert_eq!(outcome.scheduled_tasks.triggers.len(), 1);
        let trigger = &outcome.scheduled_tasks.triggers[0];
        assert_eq!(trigger.plan.task_id, "task-one");
        assert_eq!(trigger.enqueue.project_d_tag, "demo-project");
        assert!(trigger.enqueue.queued);
        assert!(trigger.finalization.removed);
        let sidecar = read_scheduled_task_dispatch_input(&daemon_dir, &trigger.enqueue.dispatch_id)
            .expect("sidecar read must succeed")
            .expect("sidecar must exist");
        assert_eq!(sidecar.task_diagnostic_metadata.task_id, "task-one");
        assert_eq!(sidecar.worker_id, trigger.enqueue.worker_id);
        assert_eq!(
            replay_dispatch_queue(&daemon_dir)
                .expect("dispatch queue must replay")
                .queued
                .len(),
            1
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(project_dir.join("schedules.json"))
                    .expect("schedules must read")
            )
            .expect("schedules json"),
            serde_json::json!([])
        );

        fs::remove_dir_all(tenex_base_dir).expect("cleanup must succeed");
    }

    #[test]
    fn daemon_maintenance_does_not_publish_or_schedule_unbooted_project_status() {
        let tenex_base_dir = unique_temp_dir("daemon-maintenance-unbooted-base");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        let project_dir = tenex_base_dir.join("projects").join("demo-project");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&project_dir).expect("project dir must create");

        let owner = pubkey_hex(0x02);
        fs::write(
            backend_config_path(&tenex_base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");
        fs::write(
            project_dir.join("project.json"),
            format!(
                r#"{{
                    "schemaVersion": 1,
                    "status": "running",
                    "projectOwnerPubkey": "{owner}",
                    "projectDTag": "demo-project",
                    "worktrees": ["main"]
                }}"#
            ),
        )
        .expect("project descriptor must write");
        let mut scheduler = PeriodicScheduler::new();
        scheduler
            .register_task(
                backend_events_project_status_task_name(&owner, "demo-project"),
                PROJECT_STATUS_TICK_INTERVAL_SECONDS,
                1_710_001_000,
            )
            .expect("stale project-status task must register");
        write_periodic_scheduler_state(&daemon_dir, &scheduler)
            .expect("shared scheduler state must write");

        let outcome = run_daemon_maintenance_once_from_filesystem(DaemonMaintenanceInput {
            tenex_base_dir: &tenex_base_dir,
            daemon_dir: &daemon_dir,
            now_ms: 1_710_001_000_000,
            project_boot_state: empty_booted_projects_state(),
            heartbeat_latch: None,
        })
        .expect("daemon maintenance must run");

        assert_eq!(outcome.project_descriptor_report.descriptors.len(), 1);
        assert!(
            outcome
                .booted_project_descriptor_report
                .descriptors
                .is_empty()
        );
        assert!(outcome.project_boot_state.projects.is_empty());
        assert!(outcome.backend_events.tick.project_statuses.is_empty());
        assert_eq!(
            outcome.backend_events.tick.due_task_names,
            vec!["backend-status".to_string()]
        );
        assert_eq!(
            read_periodic_scheduler_state(&daemon_dir)
                .expect("scheduler must read")
                .inspect()
                .tasks
                .iter()
                .map(|task| task.name.as_str())
                .collect::<Vec<_>>(),
            vec!["backend-status", "scheduled-task-due-planner"]
        );
        let publish_outbox = inspect_publish_outbox(&daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.pending_count, 2);

        fs::remove_dir_all(tenex_base_dir).expect("cleanup must succeed");
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn boot_event(
        event_id: &str,
        owner: &str,
        project_d_tag: &str,
    ) -> crate::nostr_event::SignedNostrEvent {
        crate::nostr_event::SignedNostrEvent {
            id: event_id.to_string(),
            pubkey: owner.to_string(),
            created_at: 1_710_000_999,
            kind: 24000,
            tags: vec![vec![
                "a".to_string(),
                format!("31933:{owner}:{project_d_tag}"),
            ]],
            content: String::new(),
            sig: "0".repeat(128),
        }
    }

    fn booted_state(
        event: &crate::nostr_event::SignedNostrEvent,
        timestamp_ms: u64,
    ) -> BootedProjectsState {
        let mut state = ProjectBootState::new();
        state
            .record_boot_event(event, timestamp_ms)
            .expect("project boot state must record");
        state.snapshot()
    }
}
