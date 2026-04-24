use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::agent_inventory::{
    AgentInventoryError, AgentInventoryReport, read_installed_agent_inventory,
};
use crate::backend_config::{BackendConfigError, BackendConfigSnapshot, read_backend_config};
use crate::backend_event_publish::{
    BackendEventPublishContext, BackendEventPublishError, publish_backend_project_status,
};
use crate::backend_events::project_status::ProjectStatusAgent;
use crate::project_status_agent_sources::{
    ProjectStatusAgentSourceError, ProjectStatusAgentSourceReport,
    read_project_status_agent_sources,
};
use crate::project_status_snapshot::ProjectStatusSnapshot;
use crate::project_status_sources::{ProjectStatusSourceError, read_project_scheduled_tasks};
use crate::project_worktrees::read_project_worktrees;
use crate::publish_runtime::BackendPublishRuntimeOutcome;

pub const PROJECT_STATUS_TIMEOUT_MS: u64 = 30_000;
pub const PROJECT_STATUS_REQUEST_SEQUENCE: u64 = 1;
pub const PROJECT_STATUS_RAL_NUMBER: u64 = 0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatusRuntimeInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub created_at: u64,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub project_owner_pubkey: &'a str,
    pub project_d_tag: &'a str,
    pub project_manager_pubkey: Option<&'a str>,
    pub project_base_path: Option<&'a Path>,
    pub agents: Option<&'a [ProjectStatusAgent]>,
    pub worktrees: Option<&'a [String]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatusRuntimeOutcome {
    pub config: BackendConfigSnapshot,
    pub agent_inventory: AgentInventoryReport,
    pub project_agent_sources: ProjectStatusAgentSourceReport,
    pub scheduled_tasks: Vec<crate::backend_events::project_status::ProjectStatusScheduledTask>,
    pub snapshot: ProjectStatusSnapshot,
    pub project_status: BackendPublishRuntimeOutcome,
}

#[derive(Debug, Error)]
pub enum ProjectStatusRuntimeError {
    #[error("backend config failed: {0}")]
    Config(#[from] BackendConfigError),
    #[error("agent inventory failed: {0}")]
    AgentInventory(#[from] AgentInventoryError),
    #[error("project-status source failed: {0}")]
    Sources(#[from] ProjectStatusSourceError),
    #[error("project-status agent source failed: {0}")]
    AgentSources(#[from] ProjectStatusAgentSourceError),
    #[error("backend event publish failed: {0}")]
    EventPublish(#[from] BackendEventPublishError),
}

pub fn publish_project_status_from_filesystem(
    input: ProjectStatusRuntimeInput<'_>,
) -> Result<ProjectStatusRuntimeOutcome, ProjectStatusRuntimeError> {
    let config = read_backend_config(input.tenex_base_dir)?;
    let signer = config.backend_signer()?;
    let agent_inventory = read_installed_agent_inventory(agents_dir(input.tenex_base_dir))?;
    let project_agent_sources =
        read_project_status_agent_sources(input.tenex_base_dir, input.project_d_tag)?;
    let scheduled_tasks = read_project_scheduled_tasks(input.tenex_base_dir, input.project_d_tag)?;
    let project_tag =
        ProjectStatusSnapshot::project_a_tag(input.project_owner_pubkey, input.project_d_tag);
    let agents = input.agents.map_or_else(
        || {
            if project_agent_sources.agents.is_empty() {
                agent_inventory
                    .active_agents
                    .iter()
                    .map(|agent| ProjectStatusAgent {
                        pubkey: agent.pubkey.clone(),
                        slug: agent.slug.clone(),
                    })
                    .collect()
            } else {
                project_agent_sources.agents.clone()
            }
        },
        |agents| agents.to_vec(),
    );
    let worktrees = input.worktrees.map_or_else(
        || {
            input
                .project_base_path
                .map_or_else(Vec::new, read_project_worktrees)
        },
        |worktrees| worktrees.to_vec(),
    );
    let snapshot = ProjectStatusSnapshot::new(
        input.created_at,
        project_tag,
        input.project_owner_pubkey.to_string(),
        config.whitelisted_pubkeys.clone(),
        input.project_manager_pubkey.map(str::to_string),
        agents,
        worktrees,
        scheduled_tasks.clone(),
    );

    let request_id = project_status_request_id(input.project_d_tag, input.created_at);
    let correlation_id = project_status_correlation_id(input.project_d_tag);
    let project_status = publish_backend_project_status(
        BackendEventPublishContext {
            daemon_dir: input.daemon_dir,
            accepted_at: input.accepted_at,
            request_id: &request_id,
            request_sequence: PROJECT_STATUS_REQUEST_SEQUENCE,
            request_timestamp: input.request_timestamp,
            correlation_id: &correlation_id,
            project_id: input.project_d_tag,
            conversation_id: input.project_d_tag,
            ral_number: PROJECT_STATUS_RAL_NUMBER,
            wait_for_relay_ok: false,
            timeout_ms: PROJECT_STATUS_TIMEOUT_MS,
        },
        snapshot.as_inputs(),
        &signer,
    )?;

    Ok(ProjectStatusRuntimeOutcome {
        config,
        agent_inventory,
        project_agent_sources,
        scheduled_tasks,
        snapshot,
        project_status,
    })
}

pub fn agents_dir(tenex_base_dir: impl AsRef<Path>) -> PathBuf {
    tenex_base_dir.as_ref().join("agents")
}

fn project_status_request_id(project_d_tag: &str, created_at: u64) -> String {
    format!("project-status:{project_d_tag}:{created_at}")
}

fn project_status_correlation_id(project_d_tag: &str) -> String {
    format!("project-status:{project_d_tag}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_config::backend_config_path;
    use crate::backend_events::project_status::PROJECT_STATUS_KIND;
    use crate::nostr_event::verify_signed_event;
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

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

    fn write_agent(agents_dir: &Path, pubkey: &str, slug: &str) {
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            format!(r#"{{"slug":"{slug}","status":"active"}}"#),
        )
        .expect("write agent inventory file");
    }

    fn write_config(base_dir: &Path, whitelisted_pubkeys: &[&str]) {
        fs::create_dir_all(base_dir).expect("create base dir");
        fs::write(
            backend_config_path(base_dir),
            format!(
                r#"{{
                    "whitelistedPubkeys": {whitelisted_pubkeys:?},
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "projectsBase": "/workspace/projects",
                    "relays": ["wss://relay.tenex.chat"]
                }}"#
            ),
        )
        .expect("write config");
    }

    #[test]
    fn publishes_project_status_event_from_filesystem_inputs() {
        let tenex_base_dir = unique_temp_dir("project-status-runtime-base");
        let daemon_dir = unique_temp_dir("project-status-runtime-daemon");
        let agents_dir = agents_dir(&tenex_base_dir);
        let schedules_dir = tenex_base_dir.join("projects").join("demo-project");

        fs::create_dir_all(&agents_dir).expect("create agents dir");
        fs::create_dir_all(&daemon_dir).expect("create daemon dir");
        fs::create_dir_all(&schedules_dir).expect("create schedules dir");

        let owner = pubkey_hex(0x02);
        let extra_owner = pubkey_hex(0x03);
        let alpha = pubkey_hex(0x05);
        let beta = pubkey_hex(0x06);
        let manager = beta.clone();

        write_config(&tenex_base_dir, &[&owner, &extra_owner]);
        write_agent(&agents_dir, &beta, "beta");
        write_agent(&agents_dir, &alpha, "alpha");
        fs::write(
            schedules_dir.join("schedules.json"),
            r#"[
                {
                    "id": "task-beta",
                    "title": "Beta follow-up",
                    "schedule": "2026-04-22T12:00:00Z",
                    "prompt": "Run the beta follow-up",
                    "targetAgentSlug": "beta",
                    "type": "oneoff"
                }
            ]"#,
        )
        .expect("write schedules");

        let worktrees = vec!["main".to_string(), "feature/rust".to_string()];
        let outcome = publish_project_status_from_filesystem(ProjectStatusRuntimeInput {
            tenex_base_dir: &tenex_base_dir,
            daemon_dir: &daemon_dir,
            created_at: 1_710_001_100,
            accepted_at: 1_710_001_100_100,
            request_timestamp: 1_710_001_100_050,
            project_owner_pubkey: &owner,
            project_d_tag: "demo-project",
            project_manager_pubkey: Some(&manager),
            project_base_path: None,
            agents: None,
            worktrees: Some(&worktrees),
        })
        .expect("project status publish must succeed");

        assert_eq!(
            outcome.config.whitelisted_pubkeys,
            vec![owner.clone(), extra_owner.clone()]
        );
        assert_eq!(outcome.agent_inventory.active_agents.len(), 2);
        assert_eq!(outcome.scheduled_tasks.len(), 1);
        assert_eq!(outcome.snapshot.worktrees, worktrees);

        let event = &outcome.project_status.record.event;
        assert_eq!(event.kind, PROJECT_STATUS_KIND);
        assert_eq!(event.content, "");
        let expected_project_tag = ProjectStatusSnapshot::project_a_tag(&owner, "demo-project");
        assert_eq!(event.tags[0], expected_project_tag);
        assert_eq!(event.tags[1], vec!["p".to_string(), owner.clone()]);
        assert_eq!(event.tags[2], vec!["p".to_string(), extra_owner]);
        // 24010 no longer carries model/tool/skill/mcp tags.
        assert!(
            event.tags.iter().all(|tag| !matches!(
                tag.first().map(String::as_str),
                Some("model" | "tool" | "skill" | "mcp")
            )),
            "24010 must not contain model/tool/skill/mcp tags"
        );
        verify_signed_event(event).expect("signature must verify");

        let persisted = read_pending_publish_outbox_record(&daemon_dir, &event.id)
            .expect("pending record read must succeed")
            .expect("pending project status record must exist");
        assert_eq!(persisted, outcome.project_status.record);

        let _ = fs::remove_dir_all(tenex_base_dir);
        let _ = fs::remove_dir_all(daemon_dir);
    }
}
