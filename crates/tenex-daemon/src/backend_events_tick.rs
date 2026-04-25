use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;
use thiserror::Error;

use crate::periodic_tick::{PeriodicScheduler, PeriodicSchedulerSnapshot, PeriodicTickError};
use crate::project_status_runtime::{
    PROJECT_STATUS_REQUEST_SEQUENCE, ProjectStatusRuntimeError, ProjectStatusRuntimeInput,
    publish_project_status_from_filesystem,
};

pub const PROJECT_STATUS_TICK_TASK_PREFIX: &str = "project-status";
pub const PROJECT_STATUS_TICK_INTERVAL_SECONDS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendEventsTickProject<'a> {
    pub project_owner_pubkey: &'a str,
    pub project_d_tag: &'a str,
    pub project_manager_pubkey: Option<&'a str>,
    pub project_base_path: Option<&'a Path>,
    pub worktrees: Option<&'a [String]>,
}

#[derive(Debug)]
pub struct BackendEventsTickInput<'a> {
    pub now: u64,
    pub scheduler: &'a mut PeriodicScheduler,
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub projects: &'a [BackendEventsTickProject<'a>],
}

#[derive(Debug)]
pub struct BackendEventsDueTickInput<'a> {
    pub now: u64,
    pub due_task_names: Vec<String>,
    pub scheduler_snapshot: PeriodicSchedulerSnapshot,
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub projects: &'a [BackendEventsTickProject<'a>],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEventsTaskRegistration {
    pub registered_task_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEventsTickProjectStatusOutcome {
    pub task_name: String,
    pub project_owner_pubkey: String,
    pub project_d_tag: String,
    pub project_status_event_id: String,
    pub request_sequence: u64,
    pub enqueued_event_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEventsTickOutcome {
    pub due_task_names: Vec<String>,
    pub project_statuses: Vec<BackendEventsTickProjectStatusOutcome>,
    pub scheduler_snapshot: PeriodicSchedulerSnapshot,
}

#[derive(Debug, Error)]
pub enum BackendEventsTickError {
    #[error("periodic scheduler failed: {0}")]
    Periodic(#[from] PeriodicTickError),
    #[error("project-status runtime failed for {task_name}: {source}")]
    ProjectStatus {
        task_name: String,
        #[source]
        source: ProjectStatusRuntimeError,
    },
}

pub fn backend_events_project_status_task_name(
    project_owner_pubkey: &str,
    project_d_tag: &str,
) -> String {
    format!("{PROJECT_STATUS_TICK_TASK_PREFIX}:{project_owner_pubkey}:{project_d_tag}")
}

pub fn ensure_backend_events_tasks(
    scheduler: &mut PeriodicScheduler,
    first_due_at: u64,
    projects: &[BackendEventsTickProject<'_>],
) -> Result<BackendEventsTaskRegistration, PeriodicTickError> {
    let mut registered_task_names = Vec::new();
    let desired_project_tasks = projects
        .iter()
        .map(|project| {
            backend_events_project_status_task_name(
                project.project_owner_pubkey,
                project.project_d_tag,
            )
        })
        .collect::<BTreeSet<_>>();
    for task in scheduler.inspect().tasks {
        if task
            .name
            .starts_with(&format!("{PROJECT_STATUS_TICK_TASK_PREFIX}:"))
            && !desired_project_tasks.contains(&task.name)
        {
            scheduler.remove_task(&task.name)?;
        }
    }

    for task_name in desired_project_tasks {
        if scheduler.has_task(&task_name) {
            continue;
        }
        scheduler.register_task(
            task_name.clone(),
            PROJECT_STATUS_TICK_INTERVAL_SECONDS,
            first_due_at,
        )?;
        registered_task_names.push(task_name);
    }

    registered_task_names.sort();
    Ok(BackendEventsTaskRegistration {
        registered_task_names,
    })
}

pub fn tick_backend_events(
    input: BackendEventsTickInput<'_>,
) -> Result<BackendEventsTickOutcome, BackendEventsTickError> {
    let due_task_names = input.scheduler.take_due(input.now);
    let scheduler_snapshot = input.scheduler.inspect();
    tick_backend_events_for_due_tasks(BackendEventsDueTickInput {
        now: input.now,
        due_task_names,
        scheduler_snapshot,
        tenex_base_dir: input.tenex_base_dir,
        daemon_dir: input.daemon_dir,
        accepted_at: input.accepted_at,
        request_timestamp: input.request_timestamp,
        projects: input.projects,
    })
}

pub fn tick_backend_events_for_due_tasks(
    input: BackendEventsDueTickInput<'_>,
) -> Result<BackendEventsTickOutcome, BackendEventsTickError> {
    let BackendEventsDueTickInput {
        now,
        due_task_names,
        scheduler_snapshot,
        tenex_base_dir,
        daemon_dir,
        accepted_at,
        request_timestamp,
        projects,
    } = input;
    let project_due_task_names = due_task_names
        .iter()
        .filter(|task_name| task_name.starts_with(PROJECT_STATUS_TICK_TASK_PREFIX))
        .cloned()
        .collect::<Vec<_>>();

    let mut project_statuses = Vec::new();
    for project in projects {
        let task_name = backend_events_project_status_task_name(
            project.project_owner_pubkey,
            project.project_d_tag,
        );
        if !project_due_task_names.iter().any(|due| due == &task_name) {
            continue;
        }

        let outcome = publish_project_status_from_filesystem(ProjectStatusRuntimeInput {
            tenex_base_dir,
            daemon_dir,
            created_at: now,
            accepted_at,
            request_timestamp,
            project_owner_pubkey: project.project_owner_pubkey,
            project_d_tag: project.project_d_tag,
            project_manager_pubkey: project.project_manager_pubkey,
            project_base_path: project.project_base_path,
            agents: None,
            worktrees: project.worktrees,
        })
        .map_err(|source| BackendEventsTickError::ProjectStatus {
            task_name: task_name.clone(),
            source,
        })?;

        project_statuses.push(BackendEventsTickProjectStatusOutcome {
            task_name,
            project_owner_pubkey: project.project_owner_pubkey.to_string(),
            project_d_tag: project.project_d_tag.to_string(),
            project_status_event_id: outcome.project_status.record.event.id,
            request_sequence: PROJECT_STATUS_REQUEST_SEQUENCE,
            enqueued_event_count: 1,
        });
    }

    Ok(BackendEventsTickOutcome {
        due_task_names: project_due_task_names,
        project_statuses,
        scheduler_snapshot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::backend_events::project_status::PROJECT_STATUS_KIND;
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    #[test]
    fn ensure_backend_events_tasks_registers_projects_once() {
        let owner = pubkey_hex(0x02);
        let project = BackendEventsTickProject {
            project_owner_pubkey: &owner,
            project_d_tag: "demo-project",
            project_manager_pubkey: None,
            project_base_path: None,
            worktrees: None,
        };
        let mut scheduler = PeriodicScheduler::new();

        let first =
            ensure_backend_events_tasks(&mut scheduler, 100, std::slice::from_ref(&project))
                .expect("initial registration must succeed");
        let second =
            ensure_backend_events_tasks(&mut scheduler, 100, std::slice::from_ref(&project))
                .expect("idempotent registration must succeed");

        assert_eq!(
            first.registered_task_names,
            vec![backend_events_project_status_task_name(&owner, "demo-project")]
        );
        assert!(second.registered_task_names.is_empty());
        assert_eq!(scheduler.inspect().tasks.len(), 1);
    }

    #[test]
    fn ensure_backend_events_tasks_removes_stale_project_tasks() {
        let owner = pubkey_hex(0x02);
        let active_project = BackendEventsTickProject {
            project_owner_pubkey: &owner,
            project_d_tag: "active-project",
            project_manager_pubkey: None,
            project_base_path: None,
            worktrees: None,
        };
        let mut scheduler = PeriodicScheduler::new();
        scheduler
            .register_task(
                backend_events_project_status_task_name(&owner, "stale-project"),
                30,
                100,
            )
            .expect("stale project task");

        let registration =
            ensure_backend_events_tasks(&mut scheduler, 100, std::slice::from_ref(&active_project))
                .expect("registration must succeed");

        assert_eq!(
            registration.registered_task_names,
            vec![backend_events_project_status_task_name(
                &owner,
                "active-project"
            )]
        );
        let task_names = scheduler
            .inspect()
            .tasks
            .into_iter()
            .map(|task| task.name)
            .collect::<Vec<_>>();
        assert_eq!(
            task_names,
            vec![backend_events_project_status_task_name(&owner, "active-project")]
        );
    }

    #[test]
    fn tick_backend_events_is_noop_before_first_deadline() {
        let tenex_base_dir = unique_temp_dir("noop-base");
        let daemon_dir = tenex_base_dir.join("daemon");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        let owner = pubkey_hex(0x03);
        let project = BackendEventsTickProject {
            project_owner_pubkey: &owner,
            project_d_tag: "demo-project",
            project_manager_pubkey: None,
            project_base_path: None,
            worktrees: None,
        };
        let mut scheduler = PeriodicScheduler::new();
        ensure_backend_events_tasks(&mut scheduler, 200, std::slice::from_ref(&project))
            .expect("task registration must succeed");

        let outcome = tick_backend_events(BackendEventsTickInput {
            now: 100,
            scheduler: &mut scheduler,
            tenex_base_dir: &tenex_base_dir,
            daemon_dir: &daemon_dir,
            accepted_at: 100_000,
            request_timestamp: 100_000,
            projects: std::slice::from_ref(&project),
        })
        .expect("not-due tick must succeed");

        assert!(outcome.due_task_names.is_empty());
        assert!(outcome.project_statuses.is_empty());
        assert_eq!(outcome.scheduler_snapshot.tasks.len(), 1);
        assert_eq!(outcome.scheduler_snapshot.tasks[0].next_due_at, 200);

        cleanup_temp_dir(tenex_base_dir);
    }

    #[test]
    fn tick_backend_events_enqueues_project_status_when_due() {
        let tenex_base_dir = unique_temp_dir("due-base");
        let daemon_dir = tenex_base_dir.join("daemon");
        let project_dir = tenex_base_dir.join("projects").join("demo-project");
        let agents_dir = tenex_base_dir.join("agents");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&project_dir).expect("project dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");

        let owner = pubkey_hex(0x04);
        let manager = pubkey_hex(0x05);
        write_config(&tenex_base_dir, &[&owner]);

        let worktrees = vec!["main".to_string()];
        let project = BackendEventsTickProject {
            project_owner_pubkey: &owner,
            project_d_tag: "demo-project",
            project_manager_pubkey: Some(&manager),
            project_base_path: None,
            worktrees: Some(&worktrees),
        };
        let mut scheduler = PeriodicScheduler::new();
        ensure_backend_events_tasks(&mut scheduler, 100, std::slice::from_ref(&project))
            .expect("task registration must succeed");

        let outcome = tick_backend_events(BackendEventsTickInput {
            now: 100,
            scheduler: &mut scheduler,
            tenex_base_dir: &tenex_base_dir,
            daemon_dir: &daemon_dir,
            accepted_at: 100_050,
            request_timestamp: 100_025,
            projects: std::slice::from_ref(&project),
        })
        .expect("due tick must enqueue project status");

        assert_eq!(
            outcome.due_task_names,
            vec![backend_events_project_status_task_name(&owner, "demo-project")]
        );
        assert_eq!(outcome.project_statuses.len(), 1);
        assert_eq!(outcome.project_statuses[0].project_d_tag, "demo-project");
        assert_eq!(outcome.project_statuses[0].enqueued_event_count, 1);
        assert_eq!(outcome.scheduler_snapshot.tasks[0].next_due_at, 130);

        let project_status = read_pending_publish_outbox_record(
            &daemon_dir,
            &outcome.project_statuses[0].project_status_event_id,
        )
        .expect("project-status record read must succeed")
        .expect("project-status record must exist");
        assert_eq!(project_status.event.kind, PROJECT_STATUS_KIND);

        let second = tick_backend_events(BackendEventsTickInput {
            now: 100,
            scheduler: &mut scheduler,
            tenex_base_dir: &tenex_base_dir,
            daemon_dir: &daemon_dir,
            accepted_at: 100_050,
            request_timestamp: 100_025,
            projects: std::slice::from_ref(&project),
        })
        .expect("same-now tick must be no-op");

        assert!(second.due_task_names.is_empty());
        assert!(second.project_statuses.is_empty());

        cleanup_temp_dir(tenex_base_dir);
    }

    fn write_config(base_dir: &Path, owners: &[&str]) {
        fs::create_dir_all(base_dir).expect("base dir must create");
        let owners_json = owners
            .iter()
            .map(|owner| format!(r#""{owner}""#))
            .collect::<Vec<_>>()
            .join(",");
        fs::write(
            backend_config_path(base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": [{owners_json}],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "tenex-backend-events-tick-{prefix}-{}-{counter}-{unique}",
            std::process::id()
        ))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if path.exists() {
            fs::remove_dir_all(path).expect("temp dir cleanup must succeed");
        }
    }
}
