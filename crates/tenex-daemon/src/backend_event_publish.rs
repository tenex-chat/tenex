use std::path::Path;

use thiserror::Error;

use crate::backend_events::heartbeat::{
    BackendSigner, HeartbeatEncodeError, HeartbeatInputs, encode_heartbeat,
};
use crate::backend_events::installed_agent_list::{
    InstalledAgentListEncodeError, InstalledAgentListInputs, encode_installed_agent_list,
};
use crate::backend_events::operations_status::{
    OperationsStatusEncodeError, OperationsStatusInputs, encode_operations_status,
};
use crate::backend_events::project_status::{
    ProjectStatusEncodeError, ProjectStatusInputs, encode_project_status,
};
use crate::nostr_event::SignedNostrEvent;
use crate::publish_outbox::PublishOutboxError;
use crate::publish_runtime::{
    BackendPublishRuntimeInput, BackendPublishRuntimeOutcome, enqueue_backend_event_for_publish,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendEventPublishContext<'a> {
    pub daemon_dir: &'a Path,
    pub accepted_at: u64,
    pub request_id: &'a str,
    pub request_sequence: u64,
    pub request_timestamp: u64,
    pub correlation_id: &'a str,
    pub project_id: &'a str,
    pub conversation_id: &'a str,
    pub ral_number: u64,
    pub wait_for_relay_ok: bool,
    pub timeout_ms: u64,
}

#[derive(Debug, Error)]
pub enum BackendEventPublishError {
    #[error("heartbeat encode failed: {0}")]
    Heartbeat(#[from] HeartbeatEncodeError),
    #[error("project-status encode failed: {0}")]
    ProjectStatus(#[from] ProjectStatusEncodeError),
    #[error("installed-agent-list encode failed: {0}")]
    InstalledAgentList(#[from] InstalledAgentListEncodeError),
    #[error("operations-status encode failed: {0}")]
    OperationsStatus(#[from] OperationsStatusEncodeError),
    #[error("publish outbox error: {0}")]
    PublishOutbox(#[from] PublishOutboxError),
}

pub fn publish_backend_heartbeat<S: BackendSigner>(
    context: BackendEventPublishContext<'_>,
    inputs: HeartbeatInputs<'_>,
    signer: &S,
) -> Result<BackendPublishRuntimeOutcome, BackendEventPublishError> {
    let event = encode_heartbeat(&inputs, signer)?;
    enqueue_backend_signed_event(context, event, signer).map_err(BackendEventPublishError::from)
}

pub fn publish_backend_project_status<S: BackendSigner>(
    context: BackendEventPublishContext<'_>,
    inputs: ProjectStatusInputs<'_>,
    signer: &S,
) -> Result<BackendPublishRuntimeOutcome, BackendEventPublishError> {
    let event = encode_project_status(&inputs, signer)?;
    enqueue_backend_signed_event(context, event, signer).map_err(BackendEventPublishError::from)
}

pub fn publish_backend_installed_agent_list<S: BackendSigner>(
    context: BackendEventPublishContext<'_>,
    inputs: InstalledAgentListInputs<'_>,
    signer: &S,
) -> Result<BackendPublishRuntimeOutcome, BackendEventPublishError> {
    let event = encode_installed_agent_list(&inputs, signer)?;
    enqueue_backend_signed_event(context, event, signer).map_err(BackendEventPublishError::from)
}

pub fn publish_backend_operations_status<S: BackendSigner>(
    context: BackendEventPublishContext<'_>,
    inputs: OperationsStatusInputs<'_>,
    signer: &S,
) -> Result<BackendPublishRuntimeOutcome, BackendEventPublishError> {
    let event = encode_operations_status(&inputs, signer)?;
    enqueue_backend_signed_event(context, event, signer).map_err(BackendEventPublishError::from)
}

fn enqueue_backend_signed_event<S: BackendSigner>(
    context: BackendEventPublishContext<'_>,
    event: SignedNostrEvent,
    signer: &S,
) -> Result<BackendPublishRuntimeOutcome, PublishOutboxError> {
    let expected_publisher_pubkey = signer.xonly_pubkey_hex();
    enqueue_backend_event_for_publish(BackendPublishRuntimeInput {
        daemon_dir: context.daemon_dir,
        event,
        accepted_at: context.accepted_at,
        request_id: context.request_id,
        request_sequence: context.request_sequence,
        request_timestamp: context.request_timestamp,
        correlation_id: context.correlation_id,
        project_id: context.project_id,
        conversation_id: context.conversation_id,
        expected_publisher_pubkey: &expected_publisher_pubkey,
        ral_number: context.ral_number,
        wait_for_relay_ok: context.wait_for_relay_ok,
        timeout_ms: context.timeout_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_events::heartbeat::BACKEND_HEARTBEAT_KIND;
    use crate::backend_events::installed_agent_list::{
        INSTALLED_AGENT_LIST_KIND, InstalledAgentListAgent,
    };
    use crate::backend_events::operations_status::OPERATIONS_STATUS_KIND;
    use crate::backend_events::project_status::{
        PROJECT_STATUS_KIND, ProjectStatusAgent, ProjectStatusMcpServer, ProjectStatusModel,
        ProjectStatusScheduledTask, ProjectStatusScheduledTaskKind, ProjectStatusSkill,
        ProjectStatusTool,
    };
    use crate::nostr_event::verify_signed_event;
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use secp256k1::{Keypair, Secp256k1, SecretKey, Signing};
    use std::fs;
    use std::path::PathBuf;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    struct Secp256k1Signer<C: Signing> {
        secp: Secp256k1<C>,
        keypair: Keypair,
        xonly_hex: String,
    }

    impl<C: Signing> Secp256k1Signer<C> {
        fn new(secp: Secp256k1<C>, secret_hex: &str) -> Self {
            let secret = SecretKey::from_str(secret_hex).expect("valid secret key hex");
            let keypair = Keypair::from_secret_key(&secp, &secret);
            let (xonly, _) = keypair.x_only_public_key();
            let xonly_hex = hex::encode(xonly.serialize());
            Self {
                secp,
                keypair,
                xonly_hex,
            }
        }
    }

    impl<C: Signing> BackendSigner for Secp256k1Signer<C> {
        fn xonly_pubkey_hex(&self) -> String {
            self.xonly_hex.clone()
        }

        fn sign_schnorr(&self, digest: &[u8; 32]) -> Result<String, secp256k1::Error> {
            let sig = self
                .secp
                .sign_schnorr_no_aux_rand(digest.as_slice(), &self.keypair);
            Ok(hex::encode(sig.to_byte_array()))
        }
    }

    fn test_signer() -> Secp256k1Signer<secp256k1::All> {
        Secp256k1Signer::new(Secp256k1::new(), TEST_SECRET_KEY_HEX)
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn event_id_hex(fill_byte: u8) -> String {
        hex::encode([fill_byte; 32])
    }

    fn project_tag(owner_pubkey: &str) -> Vec<String> {
        vec![
            "a".to_string(),
            format!("31933:{owner_pubkey}:demo-project"),
        ]
    }

    fn context<'a>(daemon_dir: &'a Path) -> BackendEventPublishContext<'a> {
        BackendEventPublishContext {
            daemon_dir,
            accepted_at: 1_710_001_100_100,
            request_id: "backend-event-publish-01",
            request_sequence: 7,
            request_timestamp: 1_710_001_100_000,
            correlation_id: "backend-event-correlation",
            project_id: "project-alpha",
            conversation_id: "conversation-alpha",
            ral_number: 12,
            wait_for_relay_ok: false,
            timeout_ms: 0,
        }
    }

    fn unique_temp_daemon_dir() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let daemon_dir = std::env::temp_dir().join(format!(
            "tenex-backend-event-publish-{}-{counter}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&daemon_dir).expect("temp daemon dir must be created");
        daemon_dir
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if path.exists() {
            fs::remove_dir_all(path).expect("temp daemon dir cleanup must succeed");
        }
    }

    fn heartbeat_inputs<'a>(owners: &'a [String]) -> HeartbeatInputs<'a> {
        HeartbeatInputs {
            created_at: 1_710_001_100,
            owner_pubkeys: owners,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn project_status_inputs<'a>(
        project_tag: &'a [String],
        owner: &'a str,
        whitelisted_pubkeys: &'a [String],
        project_manager_pubkey: Option<&'a str>,
        agents: &'a [ProjectStatusAgent],
        models: &'a [ProjectStatusModel],
        tools: &'a [ProjectStatusTool],
        skills: &'a [ProjectStatusSkill],
        mcp_servers: &'a [ProjectStatusMcpServer],
        worktrees: &'a [String],
        scheduled_tasks: &'a [ProjectStatusScheduledTask],
    ) -> ProjectStatusInputs<'a> {
        ProjectStatusInputs {
            created_at: 1_710_001_100,
            project_tag,
            project_owner_pubkey: owner,
            whitelisted_pubkeys,
            project_manager_pubkey,
            agents,
            models,
            tools,
            skills,
            mcp_servers,
            worktrees,
            scheduled_tasks,
        }
    }

    fn installed_agent_list_inputs<'a>(
        owners: &'a [String],
        agents: &'a [InstalledAgentListAgent],
    ) -> InstalledAgentListInputs<'a> {
        InstalledAgentListInputs {
            created_at: 1_710_001_100,
            owner_pubkeys: owners,
            agents,
        }
    }

    fn operations_status_inputs<'a>(
        conversation_id: &'a str,
        whitelisted_pubkeys: &'a [String],
        agent_pubkeys: &'a [String],
        project_tag: &'a [String],
    ) -> OperationsStatusInputs<'a> {
        OperationsStatusInputs {
            created_at: 1_710_001_100,
            conversation_id,
            whitelisted_pubkeys,
            agent_pubkeys,
            project_tag,
        }
    }

    #[test]
    fn publishes_backend_heartbeat_into_pending_outbox() {
        let signer = test_signer();
        let daemon_dir = unique_temp_daemon_dir();
        let owners = vec![pubkey_hex(0x02), pubkey_hex(0x03)];

        let outcome =
            publish_backend_heartbeat(context(&daemon_dir), heartbeat_inputs(&owners), &signer)
                .expect("heartbeat publish must succeed");

        assert_eq!(outcome.record.event.kind, BACKEND_HEARTBEAT_KIND);
        assert_eq!(outcome.record.request.project_id, "project-alpha");
        assert_eq!(outcome.record.request.conversation_id, "conversation-alpha");
        assert_eq!(
            outcome.record.request.agent_pubkey,
            signer.xonly_pubkey_hex()
        );
        verify_signed_event(&outcome.record.event).expect("accepted heartbeat must verify");

        let persisted = read_pending_publish_outbox_record(&daemon_dir, &outcome.record.event.id)
            .expect("pending heartbeat record read must succeed")
            .expect("pending heartbeat record must exist");
        assert_eq!(persisted, outcome.record);

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn publishes_backend_project_status_into_pending_outbox() {
        let signer = test_signer();
        let daemon_dir = unique_temp_daemon_dir();
        let owner = pubkey_hex(0x02);
        let project_tag = project_tag(&owner);
        let whitelisted = vec![pubkey_hex(0x03)];
        let manager = pubkey_hex(0x04);
        let agents = vec![ProjectStatusAgent {
            pubkey: manager.clone(),
            slug: "manager".to_string(),
        }];
        let models = vec![ProjectStatusModel {
            slug: "anthropic".to_string(),
            agents: vec!["manager".to_string()],
        }];
        let tools = vec![ProjectStatusTool {
            name: "shell".to_string(),
            agents: vec!["manager".to_string()],
        }];
        let skills = vec![ProjectStatusSkill {
            id: "skill-build".to_string(),
            agents: vec!["manager".to_string()],
        }];
        let mcp_servers = vec![ProjectStatusMcpServer {
            slug: "github".to_string(),
            agents: vec!["manager".to_string()],
        }];
        let worktrees = vec!["main".to_string()];
        let scheduled_tasks = vec![ProjectStatusScheduledTask {
            id: "task-1".to_string(),
            title: "Nightly build".to_string(),
            schedule: "0 1 * * *".to_string(),
            target_agent: "manager".to_string(),
            kind: ProjectStatusScheduledTaskKind::Cron,
            last_run: None,
        }];

        let outcome = publish_backend_project_status(
            context(&daemon_dir),
            project_status_inputs(
                &project_tag,
                &owner,
                &whitelisted,
                Some(&manager),
                &agents,
                &models,
                &tools,
                &skills,
                &mcp_servers,
                &worktrees,
                &scheduled_tasks,
            ),
            &signer,
        )
        .expect("project status publish must succeed");

        assert_eq!(outcome.record.event.kind, PROJECT_STATUS_KIND);
        assert_eq!(outcome.record.request.project_id, "project-alpha");
        assert_eq!(outcome.record.request.conversation_id, "conversation-alpha");
        assert_eq!(
            outcome.record.request.agent_pubkey,
            signer.xonly_pubkey_hex()
        );
        verify_signed_event(&outcome.record.event).expect("accepted project status must verify");

        let persisted = read_pending_publish_outbox_record(&daemon_dir, &outcome.record.event.id)
            .expect("pending project status record read must succeed")
            .expect("pending project status record must exist");
        assert_eq!(persisted, outcome.record);

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn publishes_backend_installed_agent_list_into_pending_outbox() {
        let signer = test_signer();
        let daemon_dir = unique_temp_daemon_dir();
        let owners = vec![pubkey_hex(0x02), pubkey_hex(0x03)];
        let agents = vec![
            InstalledAgentListAgent {
                pubkey: pubkey_hex(0x05),
                slug: "beta".to_string(),
            },
            InstalledAgentListAgent {
                pubkey: pubkey_hex(0x04),
                slug: "alpha".to_string(),
            },
        ];

        let outcome = publish_backend_installed_agent_list(
            context(&daemon_dir),
            installed_agent_list_inputs(&owners, &agents),
            &signer,
        )
        .expect("installed agent list publish must succeed");

        assert_eq!(outcome.record.event.kind, INSTALLED_AGENT_LIST_KIND);
        assert_eq!(outcome.record.request.project_id, "project-alpha");
        assert_eq!(outcome.record.request.conversation_id, "conversation-alpha");
        assert_eq!(
            outcome.record.request.agent_pubkey,
            signer.xonly_pubkey_hex()
        );
        verify_signed_event(&outcome.record.event)
            .expect("accepted installed agent list must verify");

        let persisted = read_pending_publish_outbox_record(&daemon_dir, &outcome.record.event.id)
            .expect("pending installed-agent-list record read must succeed")
            .expect("pending installed-agent-list record must exist");
        assert_eq!(persisted, outcome.record);

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn publishes_backend_operations_status_into_pending_outbox() {
        let signer = test_signer();
        let daemon_dir = unique_temp_daemon_dir();
        let owner = pubkey_hex(0x02);
        let project_tag = project_tag(&owner);
        let whitelisted = vec![pubkey_hex(0x03)];
        let agents = vec![pubkey_hex(0x04)];
        let conversation_id = event_id_hex(0x09);

        let outcome = publish_backend_operations_status(
            context(&daemon_dir),
            operations_status_inputs(&conversation_id, &whitelisted, &agents, &project_tag),
            &signer,
        )
        .expect("operations status publish must succeed");

        assert_eq!(outcome.record.event.kind, OPERATIONS_STATUS_KIND);
        assert_eq!(outcome.record.request.project_id, "project-alpha");
        assert_eq!(outcome.record.request.conversation_id, "conversation-alpha");
        assert_eq!(
            outcome.record.request.agent_pubkey,
            signer.xonly_pubkey_hex()
        );
        verify_signed_event(&outcome.record.event).expect("accepted operations status must verify");

        let persisted = read_pending_publish_outbox_record(&daemon_dir, &outcome.record.event.id)
            .expect("pending operations-status record read must succeed")
            .expect("pending operations-status record must exist");
        assert_eq!(persisted, outcome.record);

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn publishes_backend_heartbeat_rejects_invalid_input() {
        let signer = test_signer();
        let daemon_dir = unique_temp_daemon_dir();
        let owners: Vec<String> = Vec::new();

        let error =
            publish_backend_heartbeat(context(&daemon_dir), heartbeat_inputs(&owners), &signer)
                .expect_err("empty heartbeat owner list must be rejected");

        assert!(matches!(
            error,
            BackendEventPublishError::Heartbeat(HeartbeatEncodeError::NoOwnerPubkeys)
        ));
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &event_id_hex(0x01))
                .expect("pending heartbeat record read must succeed")
                .is_none()
        );

        cleanup_temp_dir(daemon_dir);
    }

    #[test]
    fn publishes_backend_operations_status_rejects_invalid_input() {
        let signer = test_signer();
        let daemon_dir = unique_temp_daemon_dir();
        let owner = pubkey_hex(0x02);
        let project_tag = vec!["p".to_string(), owner.clone()];
        let whitelisted: Vec<String> = Vec::new();
        let agents: Vec<String> = Vec::new();
        let conversation_id = event_id_hex(0x09);

        let error = publish_backend_operations_status(
            context(&daemon_dir),
            operations_status_inputs(&conversation_id, &whitelisted, &agents, &project_tag),
            &signer,
        )
        .expect_err("invalid project tag must be rejected");

        assert!(matches!(
            error,
            BackendEventPublishError::OperationsStatus(
                OperationsStatusEncodeError::InvalidProjectTag
            )
        ));
        assert!(
            read_pending_publish_outbox_record(&daemon_dir, &event_id_hex(0x01))
                .expect("pending operations-status record read must succeed")
                .is_none()
        );

        cleanup_temp_dir(daemon_dir);
    }
}
