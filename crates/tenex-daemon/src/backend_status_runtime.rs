use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::agent_inventory::{
    AgentInventoryError, AgentInventoryReport, read_installed_agent_inventory,
};
use crate::backend_config::{BackendConfigError, BackendConfigSnapshot, read_backend_config};
use crate::backend_event_publish::{
    BackendEventPublishContext, BackendEventPublishError, publish_backend_heartbeat,
    publish_backend_installed_agent_list,
};
use crate::backend_events::heartbeat::HeartbeatInputs;
use crate::backend_events::installed_agent_list::InstalledAgentListInputs;
use crate::publish_runtime::BackendPublishRuntimeOutcome;

pub const BACKEND_STATUS_PROJECT_ID: &str = "backend-status";
pub const BACKEND_STATUS_CONVERSATION_ID: &str = "backend-status";
pub const BACKEND_STATUS_CORRELATION_ID: &str = "backend-status";
pub const BACKEND_STATUS_TIMEOUT_MS: u64 = 30_000;
pub const BACKEND_STATUS_RAL_NUMBER: u64 = 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendStatusRuntimeInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub created_at: u64,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub timeout_ms: u64,
}

impl<'a> BackendStatusRuntimeInput<'a> {
    pub fn new(
        tenex_base_dir: &'a Path,
        daemon_dir: &'a Path,
        created_at: u64,
        accepted_at: u64,
        request_timestamp: u64,
    ) -> Self {
        Self {
            tenex_base_dir,
            daemon_dir,
            created_at,
            accepted_at,
            request_timestamp,
            timeout_ms: BACKEND_STATUS_TIMEOUT_MS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendStatusRuntimeOutcome {
    pub config: BackendConfigSnapshot,
    pub heartbeat: BackendPublishRuntimeOutcome,
    pub installed_agent_list: BackendPublishRuntimeOutcome,
    pub agent_inventory: AgentInventoryReport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendHeartbeatRuntimeOutcome {
    pub config: BackendConfigSnapshot,
    pub heartbeat: BackendPublishRuntimeOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendInstalledAgentListRuntimeOutcome {
    pub config: BackendConfigSnapshot,
    pub installed_agent_list: BackendPublishRuntimeOutcome,
    pub agent_inventory: AgentInventoryReport,
}

#[derive(Debug, Error)]
pub enum BackendStatusRuntimeError {
    #[error("backend config failed: {0}")]
    Config(#[from] BackendConfigError),
    #[error("agent inventory failed: {0}")]
    AgentInventory(#[from] AgentInventoryError),
    #[error("backend event publish failed: {0}")]
    EventPublish(#[from] BackendEventPublishError),
}

pub fn publish_backend_status_from_filesystem(
    input: BackendStatusRuntimeInput<'_>,
) -> Result<BackendStatusRuntimeOutcome, BackendStatusRuntimeError> {
    let config = read_backend_config(input.tenex_base_dir)?;
    let signer = config.backend_signer()?;
    let heartbeat_request_id = backend_status_request_id("heartbeat", input.created_at);

    let heartbeat = publish_backend_heartbeat(
        backend_status_context(&input, &heartbeat_request_id, 1),
        HeartbeatInputs {
            created_at: input.created_at,
            owner_pubkeys: &config.whitelisted_pubkeys,
        },
        &signer,
    )?;

    let agent_inventory = read_installed_agent_inventory(agents_dir(input.tenex_base_dir))?;
    let installed_agent_list_request_id =
        backend_status_request_id("installed-agent-list", input.created_at);
    let installed_agent_list = publish_backend_installed_agent_list(
        backend_status_context(&input, &installed_agent_list_request_id, 2),
        InstalledAgentListInputs {
            created_at: input.created_at,
            owner_pubkeys: &config.whitelisted_pubkeys,
            agents: &agent_inventory.active_agents,
        },
        &signer,
    )?;

    Ok(BackendStatusRuntimeOutcome {
        config,
        heartbeat,
        installed_agent_list,
        agent_inventory,
    })
}

pub fn publish_backend_heartbeat_from_filesystem(
    input: BackendStatusRuntimeInput<'_>,
) -> Result<BackendHeartbeatRuntimeOutcome, BackendStatusRuntimeError> {
    let config = read_backend_config(input.tenex_base_dir)?;
    let signer = config.backend_signer()?;
    let request_id = backend_status_request_id("heartbeat", input.created_at);
    let heartbeat = publish_backend_heartbeat(
        backend_status_context(&input, &request_id, 1),
        HeartbeatInputs {
            created_at: input.created_at,
            owner_pubkeys: &config.whitelisted_pubkeys,
        },
        &signer,
    )?;

    Ok(BackendHeartbeatRuntimeOutcome { config, heartbeat })
}

pub fn publish_backend_installed_agent_list_from_filesystem(
    input: BackendStatusRuntimeInput<'_>,
) -> Result<BackendInstalledAgentListRuntimeOutcome, BackendStatusRuntimeError> {
    let config = read_backend_config(input.tenex_base_dir)?;
    let signer = config.backend_signer()?;
    let agent_inventory = read_installed_agent_inventory(agents_dir(input.tenex_base_dir))?;
    let request_id = backend_status_request_id("installed-agent-list", input.created_at);
    let installed_agent_list = publish_backend_installed_agent_list(
        backend_status_context(&input, &request_id, 1),
        InstalledAgentListInputs {
            created_at: input.created_at,
            owner_pubkeys: &config.whitelisted_pubkeys,
            agents: &agent_inventory.active_agents,
        },
        &signer,
    )?;

    Ok(BackendInstalledAgentListRuntimeOutcome {
        config,
        installed_agent_list,
        agent_inventory,
    })
}

pub fn agents_dir(tenex_base_dir: impl AsRef<Path>) -> PathBuf {
    tenex_base_dir.as_ref().join("agents")
}

fn backend_status_context<'a>(
    input: &'a BackendStatusRuntimeInput<'_>,
    request_id: &'a str,
    request_sequence: u64,
) -> BackendEventPublishContext<'a> {
    BackendEventPublishContext {
        daemon_dir: input.daemon_dir,
        accepted_at: input.accepted_at,
        request_id,
        request_sequence,
        request_timestamp: input.request_timestamp,
        correlation_id: BACKEND_STATUS_CORRELATION_ID,
        project_id: BACKEND_STATUS_PROJECT_ID,
        conversation_id: BACKEND_STATUS_CONVERSATION_ID,
        ral_number: BACKEND_STATUS_RAL_NUMBER,
        wait_for_relay_ok: false,
        timeout_ms: input.timeout_ms,
    }
}

fn backend_status_request_id(kind: &str, created_at: u64) -> String {
    format!("backend-status:{kind}:{created_at}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::backend_events::heartbeat::BACKEND_HEARTBEAT_KIND;
    use crate::backend_events::installed_agent_list::INSTALLED_AGENT_LIST_KIND;
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const TEST_PUBKEY_HEX: &str =
        "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";

    #[test]
    fn publishes_heartbeat_and_installed_agent_inventory_from_filesystem() {
        let tenex_base_dir = unique_temp_dir("base");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = agents_dir(&tenex_base_dir);
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");

        let owner = pubkey_hex(0x02);
        let alpha = pubkey_hex(0x03);
        let beta = pubkey_hex(0x04);
        write_config(&tenex_base_dir, &[&owner]);
        write_agent(&agents_dir, &beta, "beta", "active");
        write_agent(&agents_dir, &alpha, "alpha", "active");

        let input = BackendStatusRuntimeInput::new(
            &tenex_base_dir,
            &daemon_dir,
            1_710_001_000,
            1_710_001_000_100,
            1_710_001_000_050,
        );
        let outcome =
            publish_backend_status_from_filesystem(input).expect("backend status must enqueue");

        assert_eq!(outcome.config.whitelisted_pubkeys, vec![owner.clone()]);
        assert_eq!(outcome.agent_inventory.active_agents.len(), 2);
        assert_eq!(outcome.heartbeat.record.event.kind, BACKEND_HEARTBEAT_KIND);
        assert_eq!(
            outcome.heartbeat.record.event.tags,
            vec![vec!["p".to_string(), owner.clone()]]
        );
        assert_eq!(
            outcome.installed_agent_list.record.event.kind,
            INSTALLED_AGENT_LIST_KIND
        );
        assert_eq!(
            outcome.installed_agent_list.record.event.tags,
            vec![
                vec!["p".to_string(), owner],
                vec!["agent".to_string(), alpha, "alpha".to_string()],
                vec!["agent".to_string(), beta, "beta".to_string()],
            ]
        );
        assert_eq!(outcome.heartbeat.record.event.pubkey, TEST_PUBKEY_HEX);
        assert_eq!(
            outcome.installed_agent_list.record.event.pubkey,
            TEST_PUBKEY_HEX
        );
        assert_eq!(
            outcome.heartbeat.record.request.request_id,
            "backend-status:heartbeat:1710001000"
        );
        assert_eq!(
            outcome.installed_agent_list.record.request.request_id,
            "backend-status:installed-agent-list:1710001000"
        );
        assert_eq!(outcome.heartbeat.record.request.request_sequence, 1);
        assert_eq!(
            outcome.installed_agent_list.record.request.request_sequence,
            2
        );

        let heartbeat_record =
            read_pending_publish_outbox_record(&daemon_dir, &outcome.heartbeat.record.event.id)
                .expect("pending heartbeat read must succeed")
                .expect("pending heartbeat must exist");
        let installed_record = read_pending_publish_outbox_record(
            &daemon_dir,
            &outcome.installed_agent_list.record.event.id,
        )
        .expect("pending installed-agent-list read must succeed")
        .expect("pending installed-agent-list must exist");

        assert_eq!(heartbeat_record, outcome.heartbeat.record);
        assert_eq!(installed_record, outcome.installed_agent_list.record);
    }

    #[test]
    fn publishes_heartbeat_without_requiring_agent_inventory_dir() {
        let tenex_base_dir = unique_temp_dir("heartbeat-only");
        let daemon_dir = tenex_base_dir.join("daemon");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");

        let owner = pubkey_hex(0x05);
        write_config(&tenex_base_dir, &[&owner]);

        let input = BackendStatusRuntimeInput::new(
            &tenex_base_dir,
            &daemon_dir,
            1_710_001_100,
            1_710_001_100_100,
            1_710_001_100_050,
        );
        let outcome = publish_backend_heartbeat_from_filesystem(input)
            .expect("heartbeat must enqueue without agents dir");

        assert_eq!(outcome.heartbeat.record.event.kind, BACKEND_HEARTBEAT_KIND);
        assert_eq!(
            outcome.heartbeat.record.event.tags,
            vec![vec!["p".to_string(), owner]]
        );
    }

    #[test]
    fn installed_agent_list_fails_closed_when_agent_inventory_dir_is_missing() {
        let tenex_base_dir = unique_temp_dir("missing-agents");
        let daemon_dir = tenex_base_dir.join("daemon");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");

        let owner = pubkey_hex(0x06);
        write_config(&tenex_base_dir, &[&owner]);

        let input = BackendStatusRuntimeInput::new(
            &tenex_base_dir,
            &daemon_dir,
            1_710_001_200,
            1_710_001_200_100,
            1_710_001_200_050,
        );
        let error = publish_backend_installed_agent_list_from_filesystem(input)
            .expect_err("missing agents dir must fail closed");

        assert!(matches!(
            error,
            BackendStatusRuntimeError::AgentInventory(AgentInventoryError::ReadDirectory { .. })
        ));
    }

    #[test]
    fn missing_private_key_fails_before_publishing() {
        let tenex_base_dir = unique_temp_dir("missing-key");
        let daemon_dir = tenex_base_dir.join("daemon");
        fs::create_dir_all(&tenex_base_dir).expect("base dir must create");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");
        fs::write(
            backend_config_path(&tenex_base_dir),
            format!(r#"{{"whitelistedPubkeys":["{}"]}}"#, pubkey_hex(0x07)),
        )
        .expect("config must write");

        let input = BackendStatusRuntimeInput::new(
            &tenex_base_dir,
            &daemon_dir,
            1_710_001_300,
            1_710_001_300_100,
            1_710_001_300_050,
        );
        let error = publish_backend_heartbeat_from_filesystem(input)
            .expect_err("missing signer key must fail");

        assert!(matches!(
            error,
            BackendStatusRuntimeError::Config(BackendConfigError::MissingPrivateKey)
        ));
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
            "tenex-backend-status-runtime-{prefix}-{}-{counter}-{unique}",
            std::process::id()
        ))
    }
}
