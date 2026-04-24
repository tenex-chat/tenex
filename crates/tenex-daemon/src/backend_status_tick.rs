use thiserror::Error;

use crate::backend_status_runtime::{
    BackendStatusRuntimeError, BackendStatusRuntimeInput, BackendStatusRuntimeOutcome,
    publish_backend_status_from_filesystem,
};
use crate::periodic_tick::{PeriodicScheduler, PeriodicSchedulerSnapshot, PeriodicTickError};

pub const BACKEND_STATUS_TICK_TASK_NAME: &str = "backend-status";
pub const BACKEND_STATUS_TICK_INTERVAL_SECONDS: u64 = 30;

#[derive(Debug)]
pub struct BackendStatusTickInput<'a> {
    pub now: u64,
    pub scheduler: &'a mut PeriodicScheduler,
    pub runtime_input: BackendStatusRuntimeInput<'a>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendStatusTickPublishedOutcome {
    /// `None` when the heartbeat latch observed a matching kind 14199 and
    /// gated the heartbeat for this tick.
    pub heartbeat_event_id: Option<String>,
    /// One event id per installed agent — kind 24011 is published per-agent.
    pub agent_config_event_ids: Vec<String>,
    pub enqueued_event_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendStatusTickOutcome {
    pub due_task_names: Vec<String>,
    pub backend_status: Option<BackendStatusTickPublishedOutcome>,
    pub scheduler_snapshot: PeriodicSchedulerSnapshot,
}

#[derive(Debug, Error)]
pub enum BackendStatusTickError {
    #[error("periodic scheduler failed: {0}")]
    Periodic(#[from] PeriodicTickError),
    #[error("backend status runtime failed: {0}")]
    Runtime(#[from] BackendStatusRuntimeError),
}

pub fn ensure_backend_status_task(
    scheduler: &mut PeriodicScheduler,
    first_due_at: u64,
) -> Result<bool, PeriodicTickError> {
    if scheduler.has_task(BACKEND_STATUS_TICK_TASK_NAME) {
        return Ok(false);
    }

    scheduler.register_task(
        BACKEND_STATUS_TICK_TASK_NAME,
        BACKEND_STATUS_TICK_INTERVAL_SECONDS,
        first_due_at,
    )?;

    Ok(true)
}

pub fn tick_backend_status(
    input: BackendStatusTickInput<'_>,
) -> Result<BackendStatusTickOutcome, BackendStatusTickError> {
    let due_task_names = input.scheduler.take_due(input.now);
    let backend_status = if due_task_names
        .iter()
        .any(|task_name| task_name == BACKEND_STATUS_TICK_TASK_NAME)
    {
        let outcome = publish_backend_status_from_filesystem(input.runtime_input)?;
        Some(published_backend_status(&outcome))
    } else {
        None
    };

    let scheduler_snapshot = input.scheduler.inspect();

    Ok(BackendStatusTickOutcome {
        due_task_names,
        backend_status,
        scheduler_snapshot,
    })
}

fn published_backend_status(
    outcome: &BackendStatusRuntimeOutcome,
) -> BackendStatusTickPublishedOutcome {
    let heartbeat_event_id = outcome
        .heartbeat
        .as_ref()
        .map(|heartbeat| heartbeat.record.event.id.clone());
    let agent_config_event_ids: Vec<String> = outcome
        .agent_configs
        .iter()
        .map(|publish| publish.record.event.id.clone())
        .collect();
    let enqueued_event_count =
        usize::from(heartbeat_event_id.is_some()) + agent_config_event_ids.len();
    BackendStatusTickPublishedOutcome {
        heartbeat_event_id,
        agent_config_event_ids,
        enqueued_event_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::backend_status_runtime::agents_dir;
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
    fn tick_backend_status_is_a_noop_when_task_is_not_due() {
        let tenex_base_dir = unique_temp_dir("not-due");
        let daemon_dir = tenex_base_dir.join("daemon");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");

        let mut scheduler = PeriodicScheduler::new();
        ensure_backend_status_task(&mut scheduler, 200).expect("task registration must succeed");

        let outcome = tick_backend_status(BackendStatusTickInput {
            now: 100,
            scheduler: &mut scheduler,
            runtime_input: backend_status_runtime_input(&tenex_base_dir, &daemon_dir, 100),
        })
        .expect("not-due tick must succeed");

        assert!(outcome.due_task_names.is_empty());
        assert!(outcome.backend_status.is_none());
        assert_eq!(outcome.scheduler_snapshot.tasks.len(), 1);
        assert_eq!(outcome.scheduler_snapshot.tasks[0].next_due_at, 200);

        cleanup_temp_dir(tenex_base_dir);
    }

    #[test]
    fn tick_backend_status_enqueues_heartbeat_and_installed_agent_list_when_due() {
        let tenex_base_dir = unique_temp_dir("due");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents = agents_dir(&tenex_base_dir);
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents).expect("agents dir must create");

        let owner = pubkey_hex(0x02);
        let alpha = pubkey_hex(0x03);
        let beta = pubkey_hex(0x04);
        write_config(&tenex_base_dir, &[&owner]);
        write_agent(&agents, &beta, "beta", "active");
        write_agent(&agents, &alpha, "alpha", "active");

        let mut scheduler = PeriodicScheduler::new();
        ensure_backend_status_task(&mut scheduler, 100).expect("task registration must succeed");

        let outcome = tick_backend_status(BackendStatusTickInput {
            now: 100,
            scheduler: &mut scheduler,
            runtime_input: backend_status_runtime_input(&tenex_base_dir, &daemon_dir, 100),
        })
        .expect("due tick must enqueue backend status");

        assert_eq!(
            outcome.due_task_names,
            vec![BACKEND_STATUS_TICK_TASK_NAME.to_string()]
        );
        let backend_status = outcome.backend_status.expect("backend status must publish");
        // 1 heartbeat + 1 per-agent 24011 per installed agent (2 agents).
        assert_eq!(backend_status.enqueued_event_count, 3);
        let heartbeat_event_id = backend_status
            .heartbeat_event_id
            .as_ref()
            .expect("heartbeat must publish when no latch is configured");
        assert!(!heartbeat_event_id.is_empty());
        assert!(!backend_status.agent_config_event_ids.is_empty());
        assert_eq!(outcome.scheduler_snapshot.tasks[0].next_due_at, 130);

        let heartbeat_record = read_pending_publish_outbox_record(&daemon_dir, heartbeat_event_id)
            .expect("heartbeat record read must succeed")
            .expect("heartbeat record must exist");
        let first_agent_config_event_id = backend_status
            .agent_config_event_ids
            .first()
            .expect("at least one per-agent 24011 must publish");
        let agent_config_record =
            read_pending_publish_outbox_record(&daemon_dir, first_agent_config_event_id)
                .expect("agent-config record read must succeed")
                .expect("agent-config record must exist");

        assert_eq!(&heartbeat_record.event.id, heartbeat_event_id);
        assert_eq!(
            &agent_config_record.event.id,
            first_agent_config_event_id
        );

        cleanup_temp_dir(tenex_base_dir);
    }

    #[test]
    fn tick_backend_status_collapses_catch_up_to_one_publish() {
        let tenex_base_dir = unique_temp_dir("catch-up");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents = agents_dir(&tenex_base_dir);
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::create_dir_all(&agents).expect("agents dir must create");

        let owner = pubkey_hex(0x05);
        write_config(&tenex_base_dir, &[&owner]);
        write_agent(&agents, &pubkey_hex(0x06), "worker", "active");

        let mut scheduler = PeriodicScheduler::new();
        ensure_backend_status_task(&mut scheduler, 100).expect("task registration must succeed");

        let outcome = tick_backend_status(BackendStatusTickInput {
            now: 500,
            scheduler: &mut scheduler,
            runtime_input: backend_status_runtime_input(&tenex_base_dir, &daemon_dir, 500),
        })
        .expect("catch-up tick must enqueue once");

        assert_eq!(
            outcome.due_task_names,
            vec![BACKEND_STATUS_TICK_TASK_NAME.to_string()]
        );
        assert_eq!(
            outcome
                .backend_status
                .as_ref()
                .expect("backend status must publish")
                .enqueued_event_count,
            2
        );
        assert_eq!(outcome.scheduler_snapshot.tasks[0].next_due_at, 530);

        let second = tick_backend_status(BackendStatusTickInput {
            now: 500,
            scheduler: &mut scheduler,
            runtime_input: backend_status_runtime_input(&tenex_base_dir, &daemon_dir, 500),
        })
        .expect("second tick must be a no-op");

        assert!(second.due_task_names.is_empty());
        assert!(second.backend_status.is_none());

        cleanup_temp_dir(tenex_base_dir);
    }

    fn backend_status_runtime_input<'a>(
        tenex_base_dir: &'a Path,
        daemon_dir: &'a Path,
        created_at: u64,
    ) -> BackendStatusRuntimeInput<'a> {
        BackendStatusRuntimeInput::new(
            tenex_base_dir,
            daemon_dir,
            created_at,
            created_at * 1_000,
            created_at * 1_000,
        )
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
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}"
                }}"#
            ),
        )
        .expect("config must write");
    }

    fn write_agent(agents_dir: &Path, pubkey: &str, slug: &str, status: &str) {
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            format!(r#"{{"slug":"{slug}","status":"{status}"}}"#),
        )
        .expect("agent must write");
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
            "tenex-backend-status-tick-{prefix}-{}-{counter}-{unique}",
            std::process::id()
        ))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if path.exists() {
            fs::remove_dir_all(path).expect("temp dir cleanup must succeed");
        }
    }
}
