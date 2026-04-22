use std::path::Path;

use serde::Serialize;
use thiserror::Error;

use crate::backend_status_runtime::{
    BackendStatusRuntimeError, BackendStatusRuntimeInput, publish_backend_status_from_filesystem,
};
use crate::backend_status_tick::{
    BACKEND_STATUS_TICK_INTERVAL_SECONDS, BACKEND_STATUS_TICK_TASK_NAME,
};
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEventsTaskRegistration {
    pub registered_task_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEventsTickBackendStatusOutcome {
    pub task_name: String,
    pub heartbeat_event_id: String,
    pub installed_agent_list_event_id: String,
    pub enqueued_event_count: usize,
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
    pub backend_status: Option<BackendEventsTickBackendStatusOutcome>,
    pub project_statuses: Vec<BackendEventsTickProjectStatusOutcome>,
    pub scheduler_snapshot: PeriodicSchedulerSnapshot,
}

#[derive(Debug, Error)]
pub enum BackendEventsTickError {
    #[error("periodic scheduler failed: {0}")]
    Periodic(#[from] PeriodicTickError),
    #[error("backend status runtime failed: {0}")]
    BackendStatus(#[from] BackendStatusRuntimeError),
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

    if !scheduler.has_task(BACKEND_STATUS_TICK_TASK_NAME) {
        scheduler.register_task(
            BACKEND_STATUS_TICK_TASK_NAME,
            BACKEND_STATUS_TICK_INTERVAL_SECONDS,
            first_due_at,
        )?;
        registered_task_names.push(BACKEND_STATUS_TICK_TASK_NAME.to_string());
    }

    for project in projects {
        let task_name = backend_events_project_status_task_name(
            project.project_owner_pubkey,
            project.project_d_tag,
        );
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
    let backend_status = if due_task_names
        .iter()
        .any(|task_name| task_name == BACKEND_STATUS_TICK_TASK_NAME)
    {
        let outcome = publish_backend_status_from_filesystem(BackendStatusRuntimeInput::new(
            input.tenex_base_dir,
            input.daemon_dir,
            input.now,
            input.accepted_at,
            input.request_timestamp,
        ))?;
        Some(BackendEventsTickBackendStatusOutcome {
            task_name: BACKEND_STATUS_TICK_TASK_NAME.to_string(),
            heartbeat_event_id: outcome.heartbeat.record.event.id,
            installed_agent_list_event_id: outcome.installed_agent_list.record.event.id,
            enqueued_event_count: 2,
        })
    } else {
        None
    };

    let mut project_statuses = Vec::new();
    for project in input.projects {
        let task_name = backend_events_project_status_task_name(
            project.project_owner_pubkey,
            project.project_d_tag,
        );
        if !due_task_names.iter().any(|due| due == &task_name) {
            continue;
        }

        let outcome = publish_project_status_from_filesystem(ProjectStatusRuntimeInput {
            tenex_base_dir: input.tenex_base_dir,
            daemon_dir: input.daemon_dir,
            created_at: input.now,
            accepted_at: input.accepted_at,
            request_timestamp: input.request_timestamp,
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

    let scheduler_snapshot = input.scheduler.inspect();

    Ok(BackendEventsTickOutcome {
        due_task_names,
        backend_status,
        project_statuses,
        scheduler_snapshot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::backend_events::heartbeat::BACKEND_HEARTBEAT_KIND;
    use crate::backend_events::installed_agent_list::INSTALLED_AGENT_LIST_KIND;
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
    fn ensure_backend_events_tasks_registers_backend_and_projects_once() {
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
            vec![
                BACKEND_STATUS_TICK_TASK_NAME.to_string(),
                backend_events_project_status_task_name(&owner, "demo-project"),
            ]
        );
        assert!(second.registered_task_names.is_empty());
        assert_eq!(scheduler.inspect().tasks.len(), 2);
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
        assert!(outcome.backend_status.is_none());
        assert!(outcome.project_statuses.is_empty());
        assert_eq!(outcome.scheduler_snapshot.tasks.len(), 2);
        assert_eq!(outcome.scheduler_snapshot.tasks[0].next_due_at, 200);
        assert_eq!(outcome.scheduler_snapshot.tasks[1].next_due_at, 200);

        cleanup_temp_dir(tenex_base_dir);
    }

    #[test]
    fn tick_backend_events_enqueues_backend_and_project_status_when_due() {
        let tenex_base_dir = unique_temp_dir("due-base");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = tenex_base_dir.join("agents");
        let project_dir = tenex_base_dir.join("projects").join("demo-project");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&project_dir).expect("project dir must create");

        let owner = pubkey_hex(0x04);
        let manager = pubkey_hex(0x05);
        let worker = pubkey_hex(0x06);
        write_config(&tenex_base_dir, &[&owner]);
        write_agent(&agents_dir, &manager, "manager");
        write_agent(&agents_dir, &worker, "worker");
        fs::write(
            tenex_base_dir.join("llms.json"),
            r#"{"configurations":{"alpha":{"provider":"openai","model":"gpt-4o"}}}"#,
        )
        .expect("llms file must write");
        fs::write(
            project_dir.join("schedules.json"),
            r#"[{
                "id": "task-1",
                "title": "Nightly report",
                "schedule": "0 1 * * *",
                "prompt": "Run nightly report",
                "targetAgentSlug": "worker"
            }]"#,
        )
        .expect("schedules file must write");

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
        .expect("due tick must enqueue backend events");

        assert_eq!(
            outcome.due_task_names,
            vec![
                BACKEND_STATUS_TICK_TASK_NAME.to_string(),
                backend_events_project_status_task_name(&owner, "demo-project"),
            ]
        );
        let backend_status = outcome
            .backend_status
            .as_ref()
            .expect("backend status must publish");
        assert_eq!(backend_status.enqueued_event_count, 2);
        assert_eq!(outcome.project_statuses.len(), 1);
        assert_eq!(outcome.project_statuses[0].project_d_tag, "demo-project");
        assert_eq!(outcome.project_statuses[0].enqueued_event_count, 1);
        assert_eq!(outcome.scheduler_snapshot.tasks[0].next_due_at, 130);
        assert_eq!(outcome.scheduler_snapshot.tasks[1].next_due_at, 130);

        let heartbeat =
            read_pending_publish_outbox_record(&daemon_dir, &backend_status.heartbeat_event_id)
                .expect("heartbeat record read must succeed")
                .expect("heartbeat record must exist");
        let installed = read_pending_publish_outbox_record(
            &daemon_dir,
            &backend_status.installed_agent_list_event_id,
        )
        .expect("installed-agent-list record read must succeed")
        .expect("installed-agent-list record must exist");
        let project_status = read_pending_publish_outbox_record(
            &daemon_dir,
            &outcome.project_statuses[0].project_status_event_id,
        )
        .expect("project-status record read must succeed")
        .expect("project-status record must exist");

        assert_eq!(heartbeat.event.kind, BACKEND_HEARTBEAT_KIND);
        assert_eq!(installed.event.kind, INSTALLED_AGENT_LIST_KIND);
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
        assert!(second.backend_status.is_none());
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

    fn write_agent(agents_dir: &Path, pubkey: &str, slug: &str) {
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            format!(r#"{{"slug":"{slug}","status":"active"}}"#),
        )
        .expect("agent file must write");
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
