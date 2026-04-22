use std::path::{Path, PathBuf};

use serde::Serialize;
use thiserror::Error;

use crate::backend_events_maintenance::{
    BackendEventsMaintenanceError, BackendEventsMaintenanceInput, BackendEventsMaintenanceOutcome,
    maintain_backend_events_from_filesystem,
};
use crate::backend_events_tick::BackendEventsTickProject;
use crate::project_status_descriptors::{
    ProjectStatusDescriptorError, ProjectStatusDescriptorReport, read_project_status_descriptors,
};
use crate::scheduler_wakeups::{
    SchedulerWakeupError, SchedulerWakeupsMaintenanceReport, run_scheduler_maintenance,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonMaintenanceInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub now_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonMaintenanceOutcome {
    pub tenex_base_dir: PathBuf,
    pub daemon_dir: PathBuf,
    pub now_ms: u64,
    pub now_seconds: u64,
    pub project_descriptor_report: ProjectStatusDescriptorReport,
    pub backend_events: BackendEventsMaintenanceOutcome,
    pub scheduler_wakeups: SchedulerWakeupsMaintenanceReport,
}

#[derive(Debug, Error)]
pub enum DaemonMaintenanceError {
    #[error("project descriptor discovery failed: {0}")]
    ProjectDescriptors(#[from] ProjectStatusDescriptorError),
    #[error("backend-events maintenance failed: {0}")]
    BackendEvents(#[from] BackendEventsMaintenanceError),
    #[error("scheduler wakeups maintenance failed: {0}")]
    SchedulerWakeups(#[from] SchedulerWakeupError),
}

pub fn run_daemon_maintenance_once_from_filesystem(
    input: DaemonMaintenanceInput<'_>,
) -> Result<DaemonMaintenanceOutcome, DaemonMaintenanceError> {
    let now_seconds = input.now_ms / 1_000;
    let project_descriptor_report = read_project_status_descriptors(input.tenex_base_dir)?;
    let projects = backend_events_projects_from_descriptors(&project_descriptor_report);
    let backend_events = maintain_backend_events_from_filesystem(BackendEventsMaintenanceInput {
        tenex_base_dir: input.tenex_base_dir,
        daemon_dir: input.daemon_dir,
        now: now_seconds,
        first_due_at: now_seconds,
        accepted_at: input.now_ms,
        request_timestamp: input.now_ms,
        projects: &projects,
    })?;
    let scheduler_wakeups = run_scheduler_maintenance(input.daemon_dir, input.now_ms)?;

    Ok(DaemonMaintenanceOutcome {
        tenex_base_dir: input.tenex_base_dir.to_path_buf(),
        daemon_dir: input.daemon_dir.to_path_buf(),
        now_ms: input.now_ms,
        now_seconds,
        project_descriptor_report,
        backend_events,
        scheduler_wakeups,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::publish_outbox::inspect_publish_outbox;
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

        let outcome = run_daemon_maintenance_once_from_filesystem(DaemonMaintenanceInput {
            tenex_base_dir: &tenex_base_dir,
            daemon_dir: &daemon_dir,
            now_ms: 1_710_001_000_000,
        })
        .expect("daemon maintenance must run");

        assert_eq!(outcome.now_seconds, 1_710_001_000);
        assert_eq!(outcome.project_descriptor_report.descriptors.len(), 1);
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
            2
        );
        assert_eq!(outcome.scheduler_wakeups.diagnostics_after.pending_count, 0);

        let publish_outbox = inspect_publish_outbox(&daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.pending_count, 3);

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
}
