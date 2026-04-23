use std::path::Path;

use crate::backend_config::{BackendConfigError, read_backend_config};
use crate::backend_event_publish::{
    BackendEventPublishContext, BackendEventPublishError, publish_backend_operations_status,
};
use crate::backend_events::operations_status::OperationsStatusInputs;
use crate::publish_runtime::BackendPublishRuntimeOutcome;
use thiserror::Error;

pub const OPERATIONS_STATUS_TIMEOUT_MS: u64 = 30_000;
pub const OPERATIONS_STATUS_REQUEST_SEQUENCE_BASE: u64 = 40;
pub const OPERATIONS_STATUS_RAL_NUMBER: u64 = 0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationsStatusDraft {
    pub created_at: u64,
    pub conversation_id: String,
    pub whitelisted_pubkeys: Vec<String>,
    pub agent_pubkeys: Vec<String>,
    pub project_tag: Vec<String>,
}

impl OperationsStatusDraft {
    pub fn as_inputs(&self) -> OperationsStatusInputs<'_> {
        OperationsStatusInputs {
            created_at: self.created_at,
            conversation_id: &self.conversation_id,
            whitelisted_pubkeys: &self.whitelisted_pubkeys,
            agent_pubkeys: &self.agent_pubkeys,
            project_tag: &self.project_tag,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationsStatusPublishConversationInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub project_id: &'a str,
    pub project_owner_pubkey: &'a str,
    pub project_d_tag: &'a str,
    pub created_at: u64,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub conversation_id: &'a str,
    pub agent_pubkeys: &'a [String],
    pub variant: &'a str,
    pub request_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationsStatusPublishedDraft {
    pub draft: OperationsStatusDraft,
    pub publish: BackendPublishRuntimeOutcome,
}

#[derive(Debug, Error)]
pub enum OperationsStatusRuntimeError {
    #[error("backend config failed: {0}")]
    Config(#[from] BackendConfigError),
    #[error("backend event publish failed: {0}")]
    EventPublish(#[from] BackendEventPublishError),
}

pub fn publish_operations_status_conversation(
    input: OperationsStatusPublishConversationInput<'_>,
) -> Result<OperationsStatusPublishedDraft, OperationsStatusRuntimeError> {
    let config = read_backend_config(input.tenex_base_dir)?;
    let signer = config.backend_signer()?;
    let project_tag = project_a_tag(input.project_owner_pubkey, input.project_d_tag);
    let draft = OperationsStatusDraft {
        created_at: input.created_at,
        conversation_id: input.conversation_id.to_string(),
        whitelisted_pubkeys: config.whitelisted_pubkeys,
        agent_pubkeys: input.agent_pubkeys.to_vec(),
        project_tag,
    };

    Ok(publish_operations_status_draft(
        input.daemon_dir,
        input.accepted_at,
        input.request_timestamp,
        input.project_id,
        input.project_d_tag,
        input.variant,
        input.request_sequence,
        draft,
        &signer,
    )?)
}

fn publish_operations_status_draft<S: crate::backend_events::heartbeat::BackendSigner>(
    daemon_dir: &Path,
    accepted_at: u64,
    request_timestamp: u64,
    project_id: &str,
    project_d_tag: &str,
    variant: &str,
    request_sequence: u64,
    draft: OperationsStatusDraft,
    signer: &S,
) -> Result<OperationsStatusPublishedDraft, BackendEventPublishError> {
    let request_id = operations_status_request_id(
        project_d_tag,
        &draft.conversation_id,
        variant,
        draft.created_at,
    );
    let correlation_id = operations_status_correlation_id(project_d_tag);
    let publish = publish_backend_operations_status(
        BackendEventPublishContext {
            daemon_dir,
            accepted_at,
            request_id: &request_id,
            request_sequence,
            request_timestamp,
            correlation_id: &correlation_id,
            project_id,
            conversation_id: &draft.conversation_id,
            ral_number: OPERATIONS_STATUS_RAL_NUMBER,
            wait_for_relay_ok: false,
            timeout_ms: OPERATIONS_STATUS_TIMEOUT_MS,
        },
        draft.as_inputs(),
        signer,
    )?;

    Ok(OperationsStatusPublishedDraft { draft, publish })
}

fn operations_status_request_id(
    project_d_tag: &str,
    conversation_id: &str,
    variant: &str,
    created_at: u64,
) -> String {
    format!("operations-status:{variant}:{project_d_tag}:{conversation_id}:{created_at}")
}

fn operations_status_correlation_id(project_d_tag: &str) -> String {
    format!("operations-status:{project_d_tag}")
}

fn project_a_tag(project_owner_pubkey: &str, project_d_tag: &str) -> Vec<String> {
    vec![
        "a".to_string(),
        format!("31933:{project_owner_pubkey}:{project_d_tag}"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_events::operations_status::OPERATIONS_STATUS_KIND;
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use std::path::PathBuf;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn publishes_active_operations_status_with_agent_pubkeys() {
        let tenex_base_dir = unique_temp_dir("operations-status-runtime-active");
        let daemon_dir = tenex_base_dir.join("daemon");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");

        let whitelisted = pubkey_hex(0x03);
        fs::write(
            tenex_base_dir.join("config.json"),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{whitelisted}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");

        let project_owner = pubkey_hex(0x02);
        let conversation_id = event_id_hex(0x30);
        let agent_one = pubkey_hex(0x05);
        let agent_two = pubkey_hex(0x06);

        let outcome =
            publish_operations_status_conversation(OperationsStatusPublishConversationInput {
                tenex_base_dir: &tenex_base_dir,
                daemon_dir: &daemon_dir,
                project_id: "demo-project",
                project_owner_pubkey: &project_owner,
                project_d_tag: "demo-project",
                created_at: 1_700_000_020,
                accepted_at: 1_700_000_020_100,
                request_timestamp: 1_700_000_020_050,
                conversation_id: &conversation_id,
                agent_pubkeys: &[agent_one.clone(), agent_two.clone()],
                variant: "active",
                request_sequence: OPERATIONS_STATUS_REQUEST_SEQUENCE_BASE,
            })
            .expect("operations status must publish");

        let record = &outcome.publish.record;
        assert_eq!(record.event.kind, OPERATIONS_STATUS_KIND);
        assert_eq!(record.request.conversation_id, conversation_id);
        assert_eq!(
            record.request.request_sequence,
            OPERATIONS_STATUS_REQUEST_SEQUENCE_BASE
        );
        assert!(
            record
                .event
                .tags
                .iter()
                .any(|tag| tag == &vec!["p".to_string(), agent_one.clone()])
        );
        assert!(
            record
                .event
                .tags
                .iter()
                .any(|tag| tag == &vec!["p".to_string(), agent_two.clone()])
        );
        assert!(
            record
                .event
                .tags
                .iter()
                .any(|tag| tag == &project_tag(&project_owner))
        );
        read_pending_publish_outbox_record(&daemon_dir, &record.event.id)
            .expect("active record read must succeed")
            .expect("active record must exist");

        cleanup_temp_dir(tenex_base_dir);
    }

    #[test]
    fn publishes_cleanup_operations_status_without_agent_pubkeys() {
        let tenex_base_dir = unique_temp_dir("operations-status-runtime-cleanup");
        let daemon_dir = tenex_base_dir.join("daemon");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");

        let whitelisted = pubkey_hex(0x03);
        fs::write(
            tenex_base_dir.join("config.json"),
            format!(
                r#"{{
                    "whitelistedPubkeys": ["{whitelisted}"],
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "relays": ["wss://relay.one"]
                }}"#
            ),
        )
        .expect("config must write");

        let project_owner = pubkey_hex(0x02);
        let conversation_id = event_id_hex(0x31);

        let outcome =
            publish_operations_status_conversation(OperationsStatusPublishConversationInput {
                tenex_base_dir: &tenex_base_dir,
                daemon_dir: &daemon_dir,
                project_id: "demo-project",
                project_owner_pubkey: &project_owner,
                project_d_tag: "demo-project",
                created_at: 1_700_000_021,
                accepted_at: 1_700_000_021_100,
                request_timestamp: 1_700_000_021_050,
                conversation_id: &conversation_id,
                agent_pubkeys: &[],
                variant: "cleanup",
                request_sequence: OPERATIONS_STATUS_REQUEST_SEQUENCE_BASE + 1,
            })
            .expect("cleanup operations status must publish");

        let record = &outcome.publish.record;
        assert_eq!(record.event.kind, OPERATIONS_STATUS_KIND);
        assert_eq!(record.request.conversation_id, conversation_id);
        assert!(
            record
                .event
                .tags
                .iter()
                .all(|tag| tag.first().is_none_or(|name| name != "p"))
        );
        read_pending_publish_outbox_record(&daemon_dir, &record.event.id)
            .expect("cleanup record read must succeed")
            .expect("cleanup record must exist");

        cleanup_temp_dir(tenex_base_dir);
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

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }

    fn cleanup_temp_dir(path: PathBuf) {
        if path.exists() {
            fs::remove_dir_all(path).expect("temp dir cleanup must succeed");
        }
    }

    #[test]
    fn secret_key_hex_is_valid() {
        SecretKey::from_str(TEST_SECRET_KEY_HEX).expect("valid secret");
    }
}
