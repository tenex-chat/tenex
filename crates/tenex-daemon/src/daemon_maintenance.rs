use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use thiserror::Error;

use crate::backend_config::{BackendConfigError, read_backend_config};
use crate::backend_heartbeat_latch::BackendHeartbeatLatchPlanner;
use crate::project_boot_state::{BootedProjectsState, is_project_booted};
use crate::project_event_index::ProjectEventIndex;
use crate::project_status_descriptors::{ProjectStatusDescriptor, ProjectStatusDescriptorReport};
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
    pub project_event_index: Arc<Mutex<ProjectEventIndex>>,
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
    pub scheduler_wakeups: SchedulerWakeupsMaintenanceReport,
    pub telegram_outbox: TelegramOutboxMaintenanceReport,
}

#[derive(Debug, Error)]
pub enum DaemonMaintenanceError {
    #[error("maintenance backend config failed: {0}")]
    BackendConfig(#[from] BackendConfigError),
    #[error("scheduler wakeups maintenance failed: {0}")]
    SchedulerWakeups(#[from] SchedulerWakeupError),
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
    let config = read_backend_config(input.tenex_base_dir)?;
    let projects_base = config
        .projects_base
        .as_deref()
        .unwrap_or("/tmp/tenex-projects");
    let project_descriptor_report = input
        .project_event_index
        .lock()
        .expect("project event index mutex must not be poisoned")
        .descriptors_report(projects_base);
    let project_boot_state = input.project_boot_state;
    let booted_project_descriptor_report =
        filter_booted_project_descriptors(&project_descriptor_report, &project_boot_state);
    tracing::info!(
        target: "tenex_daemon::daemon_maintenance::project_status_filter",
        index_descriptor_count = project_descriptor_report.descriptors.len(),
        boot_state_count = project_boot_state.projects.len(),
        booted_descriptor_count = booted_project_descriptor_report.descriptors.len(),
        index_coordinates = ?project_descriptor_report
            .descriptors
            .iter()
            .map(|d| format!("{}:{}", &d.project_owner_pubkey[..8.min(d.project_owner_pubkey.len())], d.project_d_tag))
            .collect::<Vec<_>>(),
        boot_coordinates = ?project_boot_state
            .projects
            .iter()
            .map(|p| format!("{}:{}", &p.project_owner_pubkey[..8.min(p.project_owner_pubkey.len())], p.project_d_tag))
            .collect::<Vec<_>>(),
        "project-status filter trace"
    );
    let scheduler_wakeups = run_scheduler_maintenance(input.daemon_dir, input.now_ms)?;
    let telegram_outbox = telegram_publisher.run_maintenance(input.daemon_dir, input.now_ms)?;

    Ok(DaemonMaintenanceOutcome {
        tenex_base_dir: input.tenex_base_dir.to_path_buf(),
        daemon_dir: input.daemon_dir.to_path_buf(),
        now_ms: input.now_ms,
        now_seconds,
        project_descriptor_report,
        booted_project_descriptor_report,
        project_boot_state,
        scheduler_wakeups,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::project_boot_state::{ProjectBootState, empty_booted_projects_state};
    use crate::publish_outbox::inspect_publish_outbox;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    #[test]
    fn daemon_maintenance_discovers_booted_projects() {
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
        let project_event_index =
            project_event_index_with(project_event(&owner, "demo-project", 1_710_000_998));

        let outcome = run_daemon_maintenance_once_from_filesystem(DaemonMaintenanceInput {
            tenex_base_dir: &tenex_base_dir,
            daemon_dir: &daemon_dir,
            now_ms: 1_710_001_000_000,
            project_boot_state,
            project_event_index,
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
        // Project-status (kind 31934) is now handled by the project_status_driver,
        // not by daemon maintenance. The publish outbox is empty here.
        let publish_outbox = inspect_publish_outbox(&daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.pending_count, 0);
        assert_eq!(outcome.scheduler_wakeups.diagnostics_after.pending_count, 0);
        assert_eq!(outcome.telegram_outbox.diagnostics_after.pending_count, 0);
        assert!(outcome.telegram_outbox.drained.is_empty());
        assert!(outcome.telegram_outbox.requeued.is_empty());

        fs::remove_dir_all(tenex_base_dir).expect("cleanup must succeed");
    }

    #[test]
    fn daemon_maintenance_filters_unbooted_projects() {
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
        let project_event_index =
            project_event_index_with(project_event(&owner, "demo-project", 1_710_000_998));

        let outcome = run_daemon_maintenance_once_from_filesystem(DaemonMaintenanceInput {
            tenex_base_dir: &tenex_base_dir,
            daemon_dir: &daemon_dir,
            now_ms: 1_710_001_000_000,
            project_boot_state: empty_booted_projects_state(),
            project_event_index,
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
        // No project-status events in the outbox — driver handles those.
        let publish_outbox = inspect_publish_outbox(&daemon_dir, 1_710_001_000_000)
            .expect("publish outbox diagnostics must read");
        assert_eq!(publish_outbox.pending_count, 0);

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

    fn project_event(
        owner: &str,
        project_d_tag: &str,
        created_at: u64,
    ) -> crate::nostr_event::SignedNostrEvent {
        crate::nostr_event::SignedNostrEvent {
            id: format!("project-event-{project_d_tag}"),
            pubkey: owner.to_string(),
            created_at,
            kind: 31933,
            tags: vec![vec!["d".to_string(), project_d_tag.to_string()]],
            content: String::new(),
            sig: "0".repeat(128),
        }
    }

    fn project_event_index_with(
        event: crate::nostr_event::SignedNostrEvent,
    ) -> Arc<Mutex<ProjectEventIndex>> {
        let index = Arc::new(Mutex::new(ProjectEventIndex::new()));
        index
            .lock()
            .expect("project event index lock")
            .upsert(event);
        index
    }
}
