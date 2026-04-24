use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use thiserror::Error;

use crate::agent_inventory::{
    AgentInventoryError, AgentInventoryReport, read_installed_agent_inventory,
};
use crate::backend_config::{BackendConfigError, BackendConfigSnapshot, read_backend_config};
use crate::backend_event_publish::{
    BackendEventPublishContext, BackendEventPublishError, publish_backend_agent_config,
    publish_backend_heartbeat, publish_backend_profile,
};
use crate::backend_events::heartbeat::HeartbeatInputs;
use crate::backend_events::installed_agent_list::AgentConfigInputs;
use crate::backend_heartbeat_latch::BackendHeartbeatLatchPlanner;
use crate::backend_profile::BackendProfileInputs;
use crate::per_agent_config_snapshot::{AgentConfigSnapshot, build_agent_config_snapshot};
use crate::publish_runtime::BackendPublishRuntimeOutcome;

pub const BACKEND_STATUS_PROJECT_ID: &str = "backend-status";
pub const BACKEND_STATUS_CONVERSATION_ID: &str = "backend-status";
pub const BACKEND_STATUS_CORRELATION_ID: &str = "backend-status";
pub const BACKEND_STATUS_TIMEOUT_MS: u64 = 30_000;
pub const BACKEND_STATUS_RAL_NUMBER: u64 = 0;

#[derive(Debug, Clone)]
pub struct BackendStatusRuntimeInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub created_at: u64,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub timeout_ms: u64,
    /// Optional latch that, when present and in the `Stopped` state, causes
    /// the runtime to skip the kind 24012 heartbeat publish. Per-agent 24011
    /// and backend profile publishes remain independent of the latch.
    pub heartbeat_latch: Option<Arc<Mutex<BackendHeartbeatLatchPlanner>>>,
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
            heartbeat_latch: None,
        }
    }

    pub fn with_heartbeat_latch(
        mut self,
        heartbeat_latch: Arc<Mutex<BackendHeartbeatLatchPlanner>>,
    ) -> Self {
        self.heartbeat_latch = Some(heartbeat_latch);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendStatusRuntimeOutcome {
    pub config: BackendConfigSnapshot,
    /// `None` when the heartbeat latch gated this tick.
    pub heartbeat: Option<BackendPublishRuntimeOutcome>,
    /// One entry per installed agent — one kind 24011 publish per agent.
    pub agent_configs: Vec<BackendPublishRuntimeOutcome>,
    /// Agents whose snapshot could not be built (missing file, malformed
    /// JSON, etc.). Those agents are skipped; the rest still publish.
    pub skipped_agents: Vec<BackendAgentConfigSkip>,
    pub backend_profile: Option<BackendPublishRuntimeOutcome>,
    pub agent_inventory: AgentInventoryReport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendAgentConfigSkip {
    pub agent_pubkey: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendHeartbeatRuntimeOutcome {
    pub config: BackendConfigSnapshot,
    pub heartbeat: BackendPublishRuntimeOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendAgentConfigListRuntimeOutcome {
    pub config: BackendConfigSnapshot,
    pub agent_configs: Vec<BackendPublishRuntimeOutcome>,
    pub skipped_agents: Vec<BackendAgentConfigSkip>,
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
    let backend_profile = if config.generated_tenex_private_key {
        let request_id = backend_status_request_id("backend-profile", input.created_at);
        Some(publish_backend_profile(
            backend_status_context(&input, &request_id, 0),
            BackendProfileInputs {
                created_at: input.created_at,
                backend_name: config.backend_name_or_default(),
                whitelisted_pubkeys: &config.whitelisted_pubkeys,
            },
            &signer,
        )?)
    } else {
        None
    };

    let heartbeat = if heartbeat_latch_allows_publish(input.heartbeat_latch.as_ref()) {
        let heartbeat_request_id = backend_status_request_id("heartbeat", input.created_at);
        Some(publish_backend_heartbeat(
            backend_status_context(&input, &heartbeat_request_id, 1),
            HeartbeatInputs {
                created_at: input.created_at,
                owner_pubkeys: &config.whitelisted_pubkeys,
            },
            &signer,
        )?)
    } else {
        None
    };

    let agent_inventory = read_installed_agent_inventory(agents_dir(input.tenex_base_dir))?;
    let (agent_configs, skipped_agents) = publish_agent_configs(
        &input,
        &config,
        &agent_inventory,
        &signer,
        /* sequence_base */ 2,
    )?;

    Ok(BackendStatusRuntimeOutcome {
        config,
        heartbeat,
        agent_configs,
        skipped_agents,
        backend_profile,
        agent_inventory,
    })
}

fn heartbeat_latch_allows_publish(
    latch: Option<&Arc<Mutex<BackendHeartbeatLatchPlanner>>>,
) -> bool {
    match latch {
        None => true,
        Some(latch) => latch
            .lock()
            .expect("backend heartbeat latch must not be poisoned")
            .should_heartbeat(),
    }
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

/// Publish one kind 24011 event per installed agent, signed by the backend.
/// Each event carries the agent's available + active models, skills, and
/// mcp servers. Replaces the old single-event installed-agent-list publish.
pub fn publish_backend_agent_configs_from_filesystem(
    input: BackendStatusRuntimeInput<'_>,
) -> Result<BackendAgentConfigListRuntimeOutcome, BackendStatusRuntimeError> {
    let config = read_backend_config(input.tenex_base_dir)?;
    let signer = config.backend_signer()?;
    let agent_inventory = read_installed_agent_inventory(agents_dir(input.tenex_base_dir))?;
    let (agent_configs, skipped_agents) =
        publish_agent_configs(&input, &config, &agent_inventory, &signer, 1)?;

    Ok(BackendAgentConfigListRuntimeOutcome {
        config,
        agent_configs,
        skipped_agents,
        agent_inventory,
    })
}

fn publish_agent_configs<S: crate::backend_events::heartbeat::BackendSigner>(
    input: &BackendStatusRuntimeInput<'_>,
    config: &BackendConfigSnapshot,
    agent_inventory: &AgentInventoryReport,
    signer: &S,
    sequence_base: u64,
) -> Result<
    (
        Vec<BackendPublishRuntimeOutcome>,
        Vec<BackendAgentConfigSkip>,
    ),
    BackendStatusRuntimeError,
> {
    let mut outcomes = Vec::with_capacity(agent_inventory.active_agents.len());
    let mut skipped = Vec::new();
    // Cache of the last 34011 content hash we published per agent. Kind
    // 34011 is addressable — the relay stores one event per agent — so
    // we only need to republish when the effective config actually
    // differs from what we last sent. In steady state this path emits
    // zero events.
    let mut cache = crate::agent_config_publish_cache::read_cache(input.daemon_dir)
        .unwrap_or_else(|_| crate::agent_config_publish_cache::AgentConfigPublishCache::empty());
    let mut cache_dirty = false;
    let mut next_sequence = sequence_base;
    for agent in agent_inventory.active_agents.iter() {
        let snapshot = match build_agent_config_snapshot(input.tenex_base_dir, &agent.pubkey) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                skipped.push(BackendAgentConfigSkip {
                    agent_pubkey: agent.pubkey.clone(),
                    reason: error.to_string(),
                });
                continue;
            }
        };
        let hash = crate::agent_config_publish_cache::snapshot_hash(
            &snapshot,
            &config.whitelisted_pubkeys,
        );
        if cache.is_fresh(&snapshot.agent_pubkey, &hash) {
            continue;
        }
        let request_id = agent_config_request_id(&snapshot.agent_pubkey, input.created_at);
        let context = backend_status_context(input, &request_id, next_sequence);
        next_sequence += 1;
        let outcome = publish_backend_agent_config(
            context,
            agent_config_inputs(&snapshot, config, input.created_at),
            signer,
        )?;
        cache.record_published(&snapshot.agent_pubkey, &hash, input.accepted_at);
        cache_dirty = true;
        outcomes.push(outcome);
    }
    if cache_dirty {
        if let Err(error) = crate::agent_config_publish_cache::write_cache(input.daemon_dir, &cache)
        {
            tracing::warn!(
                error = %error,
                "failed to persist agent config publish cache; next tick will republish the same diffs"
            );
        }
    }
    Ok((outcomes, skipped))
}

fn agent_config_inputs<'a>(
    snapshot: &'a AgentConfigSnapshot,
    config: &'a BackendConfigSnapshot,
    created_at: u64,
) -> AgentConfigInputs<'a> {
    AgentConfigInputs {
        created_at,
        agent_pubkey: &snapshot.agent_pubkey,
        agent_slug: &snapshot.agent_slug,
        owner_pubkeys: &config.whitelisted_pubkeys,
        available_models: &snapshot.available_models,
        active_models: &snapshot.active_model_set,
        available_skills: &snapshot.available_skills,
        active_skills: &snapshot.active_skills,
        available_mcps: &snapshot.available_mcps,
        active_mcps: &snapshot.active_mcps,
    }
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

fn agent_config_request_id(agent_pubkey: &str, created_at: u64) -> String {
    format!("backend-status:agent-config:{agent_pubkey}:{created_at}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::backend_events::heartbeat::BACKEND_HEARTBEAT_KIND;
    use crate::backend_events::installed_agent_list::AGENT_CONFIG_KIND;
    use crate::backend_profile::BACKEND_PROFILE_KIND;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    #[test]
    fn publishes_one_agent_config_per_installed_agent() {
        let tenex_base_dir = unique_temp_dir("per-agent");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = agents_dir(&tenex_base_dir);
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");

        let owner = pubkey_hex(0x02);
        let alpha = pubkey_hex(0x03);
        let beta = pubkey_hex(0x04);
        write_config(&tenex_base_dir, &[&owner]);
        write_agent(&agents_dir, &alpha, "alpha", "active");
        write_agent(&agents_dir, &beta, "beta", "active");

        let input = BackendStatusRuntimeInput::new(
            &tenex_base_dir,
            &daemon_dir,
            1_710_001_000,
            1_710_001_000_100,
            1_710_001_000_050,
        );
        let outcome = publish_backend_status_from_filesystem(input).expect("publish");

        assert_eq!(outcome.agent_configs.len(), 2);
        assert!(outcome.skipped_agents.is_empty());
        for publish in &outcome.agent_configs {
            assert_eq!(publish.record.event.kind, AGENT_CONFIG_KIND);
            // First tag is the addressable `d` tag, then `agent`.
            assert_eq!(publish.record.event.tags[0][0], "d");
            assert_eq!(publish.record.event.tags[1][0], "agent");
        }
        assert_eq!(outcome.agent_inventory.active_agents.len(), 2);

        // The heartbeat still publishes on its own.
        let heartbeat = outcome.heartbeat.expect("heartbeat must publish");
        assert_eq!(heartbeat.record.event.kind, BACKEND_HEARTBEAT_KIND);
    }

    #[test]
    fn publishes_backend_profile_when_backend_key_is_generated() {
        let tenex_base_dir = unique_temp_dir("generated-profile");
        let daemon_dir = tenex_base_dir.join("daemon");
        let agents_dir = agents_dir(&tenex_base_dir);
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");

        let owner = pubkey_hex(0x08);
        fs::write(
            backend_config_path(&tenex_base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{owner}"],
                    "backendName": "local backend"
                }}"#
            ),
        )
        .expect("config must write");

        let input = BackendStatusRuntimeInput::new(
            &tenex_base_dir,
            &daemon_dir,
            1_710_001_050,
            1_710_001_050_100,
            1_710_001_050_050,
        );
        let outcome = publish_backend_status_from_filesystem(input).expect("publish");
        let profile = outcome
            .backend_profile
            .expect("generated backend key must enqueue backend profile");
        assert_eq!(profile.record.event.kind, BACKEND_PROFILE_KIND);
    }

    #[test]
    fn missing_agents_dir_fails_backend_status() {
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
        let error = publish_backend_status_from_filesystem(input)
            .expect_err("missing agents dir must fail closed");
        assert!(matches!(
            error,
            BackendStatusRuntimeError::AgentInventory(AgentInventoryError::ReadDirectory { .. })
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
            format!(r#"{{"slug":"{slug}","status":"{status}","default":{{"model":"opus"}}}}"#),
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
