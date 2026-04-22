use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;

use crate::backend_config::{BackendConfigError, BackendConfigSnapshot, read_backend_config};
use crate::backend_event_publish::{
    BackendEventPublishContext, BackendEventPublishError, publish_backend_operations_status,
};
use crate::backend_events::operations_status::OperationsStatusInputs;
use crate::publish_runtime::BackendPublishRuntimeOutcome;
use crate::worker_heartbeat::WorkerHeartbeatState;
use crate::worker_runtime_state::{ActiveWorkerRuntimeSnapshot, WorkerRuntimeState};
use thiserror::Error;

pub const OPERATIONS_STATUS_TIMEOUT_MS: u64 = 30_000;
pub const OPERATIONS_STATUS_REQUEST_SEQUENCE_BASE: u64 = 40;
pub const OPERATIONS_STATUS_RAL_NUMBER: u64 = 0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationsStatusRuntimeInput<'a> {
    pub project_id: &'a str,
    pub created_at: u64,
    pub whitelisted_pubkeys: &'a [String],
    pub project_tag: &'a [String],
    pub runtime_state: &'a WorkerRuntimeState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationsStatusCleanupInput<'a> {
    pub created_at: u64,
    pub conversation_id: &'a str,
    pub whitelisted_pubkeys: &'a [String],
    pub project_tag: &'a [String],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationsStatusTransitionInput<'a> {
    pub previous_active_conversation_ids: &'a [String],
    pub runtime: OperationsStatusRuntimeInput<'a>,
}

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
pub struct OperationsStatusTransitionPlan {
    pub active_drafts: Vec<OperationsStatusDraft>,
    pub cleanup_drafts: Vec<OperationsStatusDraft>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationsStatusPublishRuntimeInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub project_id: &'a str,
    pub project_owner_pubkey: &'a str,
    pub project_d_tag: &'a str,
    pub created_at: u64,
    pub accepted_at: u64,
    pub request_timestamp: u64,
    pub previous_active_conversation_ids: &'a [String],
    pub runtime_state: &'a WorkerRuntimeState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationsStatusPublishedDraft {
    pub draft: OperationsStatusDraft,
    pub publish: BackendPublishRuntimeOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationsStatusPublishRuntimeOutcome {
    pub config: Option<BackendConfigSnapshot>,
    pub active: Vec<OperationsStatusPublishedDraft>,
    pub cleanup: Vec<OperationsStatusPublishedDraft>,
}

#[derive(Debug, Error)]
pub enum OperationsStatusRuntimeError {
    #[error("backend config failed: {0}")]
    Config(#[from] BackendConfigError),
    #[error("backend event publish failed: {0}")]
    EventPublish(#[from] BackendEventPublishError),
}

pub fn plan_operations_status_drafts(
    input: OperationsStatusRuntimeInput<'_>,
) -> Vec<OperationsStatusDraft> {
    active_operations_by_conversation(&input)
        .into_iter()
        .map(|(conversation_id, agent_pubkeys)| OperationsStatusDraft {
            created_at: input.created_at,
            conversation_id,
            whitelisted_pubkeys: input.whitelisted_pubkeys.to_vec(),
            agent_pubkeys,
            project_tag: input.project_tag.to_vec(),
        })
        .collect()
}

pub fn plan_operations_status_transition(
    input: OperationsStatusTransitionInput<'_>,
) -> OperationsStatusTransitionPlan {
    let active_by_conversation = active_operations_by_conversation(&input.runtime);
    let active_conversation_ids: BTreeSet<String> =
        active_by_conversation.keys().cloned().collect();
    let previous_conversation_ids: BTreeSet<String> = input
        .previous_active_conversation_ids
        .iter()
        .cloned()
        .collect();

    let active_drafts = active_by_conversation
        .into_iter()
        .map(|(conversation_id, agent_pubkeys)| OperationsStatusDraft {
            created_at: input.runtime.created_at,
            conversation_id,
            whitelisted_pubkeys: input.runtime.whitelisted_pubkeys.to_vec(),
            agent_pubkeys,
            project_tag: input.runtime.project_tag.to_vec(),
        })
        .collect();

    let cleanup_drafts = previous_conversation_ids
        .difference(&active_conversation_ids)
        .map(|conversation_id| {
            plan_operations_status_cleanup(OperationsStatusCleanupInput {
                created_at: input.runtime.created_at,
                conversation_id,
                whitelisted_pubkeys: input.runtime.whitelisted_pubkeys,
                project_tag: input.runtime.project_tag,
            })
        })
        .collect();

    OperationsStatusTransitionPlan {
        active_drafts,
        cleanup_drafts,
    }
}

pub fn plan_operations_status_cleanup(
    input: OperationsStatusCleanupInput<'_>,
) -> OperationsStatusDraft {
    OperationsStatusDraft {
        created_at: input.created_at,
        conversation_id: input.conversation_id.to_string(),
        whitelisted_pubkeys: input.whitelisted_pubkeys.to_vec(),
        agent_pubkeys: Vec::new(),
        project_tag: input.project_tag.to_vec(),
    }
}

pub fn publish_operations_status_transition_from_runtime(
    input: OperationsStatusPublishRuntimeInput<'_>,
) -> Result<OperationsStatusPublishRuntimeOutcome, OperationsStatusRuntimeError> {
    let empty_values: Vec<String> = Vec::new();
    let empty_project_tag: Vec<String> = Vec::new();
    let probe_plan = plan_operations_status_transition(OperationsStatusTransitionInput {
        previous_active_conversation_ids: input.previous_active_conversation_ids,
        runtime: OperationsStatusRuntimeInput {
            project_id: input.project_id,
            created_at: input.created_at,
            whitelisted_pubkeys: &empty_values,
            project_tag: &empty_project_tag,
            runtime_state: input.runtime_state,
        },
    });

    if probe_plan.active_drafts.is_empty() && probe_plan.cleanup_drafts.is_empty() {
        return Ok(OperationsStatusPublishRuntimeOutcome {
            config: None,
            active: Vec::new(),
            cleanup: Vec::new(),
        });
    }

    let config = read_backend_config(input.tenex_base_dir)?;
    let signer = config.backend_signer()?;
    let project_tag = project_a_tag(input.project_owner_pubkey, input.project_d_tag);
    let plan = plan_operations_status_transition(OperationsStatusTransitionInput {
        previous_active_conversation_ids: input.previous_active_conversation_ids,
        runtime: OperationsStatusRuntimeInput {
            project_id: input.project_id,
            created_at: input.created_at,
            whitelisted_pubkeys: &config.whitelisted_pubkeys,
            project_tag: &project_tag,
            runtime_state: input.runtime_state,
        },
    });

    let mut next_sequence = OPERATIONS_STATUS_REQUEST_SEQUENCE_BASE;
    let mut active = Vec::new();
    for draft in plan.active_drafts {
        active.push(publish_operations_status_draft(
            input.daemon_dir,
            input.accepted_at,
            input.request_timestamp,
            input.project_id,
            input.project_d_tag,
            "active",
            next_sequence,
            draft,
            &signer,
        )?);
        next_sequence = next_sequence.saturating_add(1);
    }

    let mut cleanup = Vec::new();
    for draft in plan.cleanup_drafts {
        cleanup.push(publish_operations_status_draft(
            input.daemon_dir,
            input.accepted_at,
            input.request_timestamp,
            input.project_id,
            input.project_d_tag,
            "cleanup",
            next_sequence,
            draft,
            &signer,
        )?);
        next_sequence = next_sequence.saturating_add(1);
    }

    Ok(OperationsStatusPublishRuntimeOutcome {
        config: Some(config),
        active,
        cleanup,
    })
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

fn worker_has_active_operation(worker: &ActiveWorkerRuntimeSnapshot) -> bool {
    let Some(heartbeat) = worker.last_heartbeat.as_ref() else {
        return false;
    };

    matches!(
        heartbeat.state,
        WorkerHeartbeatState::Streaming | WorkerHeartbeatState::Acting
    ) || heartbeat.active_tool_count > 0
}

fn active_operations_by_conversation(
    input: &OperationsStatusRuntimeInput<'_>,
) -> BTreeMap<String, Vec<String>> {
    let mut by_conversation: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for worker in input.runtime_state.workers() {
        if worker.identity.project_id != input.project_id || !worker_has_active_operation(worker) {
            continue;
        }

        by_conversation
            .entry(worker.identity.conversation_id.clone())
            .or_default()
            .push(worker.identity.agent_pubkey.clone());
    }

    by_conversation
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_events::heartbeat::BackendSigner;
    use crate::backend_events::operations_status::{
        OPERATIONS_STATUS_KIND, encode_operations_status,
    };
    use crate::nostr_event::verify_signed_event;
    use crate::publish_outbox::read_pending_publish_outbox_record;
    use crate::ral_journal::RalJournalIdentity;
    use crate::worker_heartbeat::WorkerHeartbeatSnapshot;
    use crate::worker_runtime_state::{WorkerRuntimeStartedDispatch, WorkerRuntimeState};
    use secp256k1::{Keypair, Secp256k1, SecretKey, Signing};
    use std::fs;
    use std::path::PathBuf;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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

    #[test]
    fn plans_active_operations_by_project_and_conversation() {
        let mut runtime_state = WorkerRuntimeState::default();
        let conversation_a = event_id_hex(0x0a);
        let conversation_b = event_id_hex(0x0b);
        let project_owner = pubkey_hex(0x02);
        let whitelisted = vec![pubkey_hex(0x03), pubkey_hex(0x04)];
        let project_tag = project_tag(&project_owner);
        let active_streaming_agent = pubkey_hex(0x05);
        let active_tool_agent = pubkey_hex(0x06);
        let other_conversation_agent = pubkey_hex(0x07);
        let idle_agent = pubkey_hex(0x08);
        let other_project_agent = pubkey_hex(0x09);

        register_worker(
            &mut runtime_state,
            WorkerFixture {
                worker_id: "worker-a",
                dispatch_id: "dispatch-a",
                project_id: "project-alpha",
                agent_pubkey: &active_streaming_agent,
                conversation_id: &conversation_a,
                state: Some(WorkerHeartbeatState::Streaming),
                active_tool_count: 0,
            },
        );
        register_worker(
            &mut runtime_state,
            WorkerFixture {
                worker_id: "worker-b",
                dispatch_id: "dispatch-b",
                project_id: "project-alpha",
                agent_pubkey: &active_tool_agent,
                conversation_id: &conversation_a,
                state: Some(WorkerHeartbeatState::Waiting),
                active_tool_count: 2,
            },
        );
        register_worker(
            &mut runtime_state,
            WorkerFixture {
                worker_id: "worker-c",
                dispatch_id: "dispatch-c",
                project_id: "project-alpha",
                agent_pubkey: &other_conversation_agent,
                conversation_id: &conversation_b,
                state: Some(WorkerHeartbeatState::Acting),
                active_tool_count: 0,
            },
        );
        register_worker(
            &mut runtime_state,
            WorkerFixture {
                worker_id: "worker-d",
                dispatch_id: "dispatch-d",
                project_id: "project-alpha",
                agent_pubkey: &idle_agent,
                conversation_id: &conversation_a,
                state: Some(WorkerHeartbeatState::Idle),
                active_tool_count: 0,
            },
        );
        register_worker(
            &mut runtime_state,
            WorkerFixture {
                worker_id: "worker-e",
                dispatch_id: "dispatch-e",
                project_id: "project-beta",
                agent_pubkey: &other_project_agent,
                conversation_id: &conversation_a,
                state: Some(WorkerHeartbeatState::Streaming),
                active_tool_count: 0,
            },
        );
        register_worker(
            &mut runtime_state,
            WorkerFixture {
                worker_id: "worker-f",
                dispatch_id: "dispatch-f",
                project_id: "project-alpha",
                agent_pubkey: &pubkey_hex(0x0f),
                conversation_id: &conversation_a,
                state: None,
                active_tool_count: 0,
            },
        );

        let drafts = plan_operations_status_drafts(OperationsStatusRuntimeInput {
            project_id: "project-alpha",
            created_at: 1_700_000_000,
            whitelisted_pubkeys: &whitelisted,
            project_tag: &project_tag,
            runtime_state: &runtime_state,
        });

        assert_eq!(
            drafts,
            vec![
                OperationsStatusDraft {
                    created_at: 1_700_000_000,
                    conversation_id: conversation_a.clone(),
                    whitelisted_pubkeys: whitelisted.clone(),
                    agent_pubkeys: vec![active_streaming_agent.clone(), active_tool_agent.clone()],
                    project_tag: project_tag.clone(),
                },
                OperationsStatusDraft {
                    created_at: 1_700_000_000,
                    conversation_id: conversation_b.clone(),
                    whitelisted_pubkeys: whitelisted.clone(),
                    agent_pubkeys: vec![other_conversation_agent.clone()],
                    project_tag: project_tag.clone(),
                },
            ]
        );

        let signer = Secp256k1Signer::new(Secp256k1::new(), TEST_SECRET_KEY_HEX);
        let event = encode_operations_status(&drafts[0].as_inputs(), &signer)
            .expect("planned draft must encode");
        assert_eq!(
            event.tags,
            vec![
                vec!["e".to_string(), conversation_a],
                vec!["P".to_string(), whitelisted[0].clone()],
                vec!["P".to_string(), whitelisted[1].clone()],
                vec!["p".to_string(), active_streaming_agent],
                vec!["p".to_string(), active_tool_agent],
                project_tag.clone(),
            ]
        );
        verify_signed_event(&event).expect("planned event signature must verify");
    }

    #[test]
    fn plans_cleanup_without_agent_p_tags() {
        let conversation_id = event_id_hex(0x10);
        let project_owner = pubkey_hex(0x02);
        let whitelisted = vec![pubkey_hex(0x03)];
        let project_tag = project_tag(&project_owner);

        let draft = plan_operations_status_cleanup(OperationsStatusCleanupInput {
            created_at: 1_700_000_001,
            conversation_id: &conversation_id,
            whitelisted_pubkeys: &whitelisted,
            project_tag: &project_tag,
        });

        assert_eq!(
            draft,
            OperationsStatusDraft {
                created_at: 1_700_000_001,
                conversation_id: conversation_id.clone(),
                whitelisted_pubkeys: whitelisted.clone(),
                agent_pubkeys: Vec::new(),
                project_tag: project_tag.clone(),
            }
        );

        let signer = Secp256k1Signer::new(Secp256k1::new(), TEST_SECRET_KEY_HEX);
        let event =
            encode_operations_status(&draft.as_inputs(), &signer).expect("cleanup must encode");
        assert_eq!(
            event.tags,
            vec![
                vec!["e".to_string(), conversation_id],
                vec!["P".to_string(), whitelisted[0].clone()],
                project_tag,
            ]
        );
        assert!(event.tags.iter().all(|tag| tag[0] != "p"));
        verify_signed_event(&event).expect("cleanup event signature must verify");
    }

    #[test]
    fn plans_transition_cleanup_for_stale_conversation_only() {
        let mut runtime_state = WorkerRuntimeState::default();
        let current_conversation = event_id_hex(0x20);
        let stale_conversation = event_id_hex(0x21);
        let project_owner = pubkey_hex(0x02);
        let whitelisted = vec![pubkey_hex(0x03)];
        let project_tag = project_tag(&project_owner);
        let active_agent = pubkey_hex(0x04);

        register_worker(
            &mut runtime_state,
            WorkerFixture {
                worker_id: "worker-current",
                dispatch_id: "dispatch-current",
                project_id: "project-alpha",
                agent_pubkey: &active_agent,
                conversation_id: &current_conversation,
                state: Some(WorkerHeartbeatState::Streaming),
                active_tool_count: 0,
            },
        );

        let previous_active_conversation_ids =
            vec![current_conversation.clone(), stale_conversation];
        let plan = plan_operations_status_transition(OperationsStatusTransitionInput {
            previous_active_conversation_ids: &previous_active_conversation_ids,
            runtime: OperationsStatusRuntimeInput {
                project_id: "project-alpha",
                created_at: 1_700_000_010,
                whitelisted_pubkeys: &whitelisted,
                project_tag: &project_tag,
                runtime_state: &runtime_state,
            },
        });

        assert_eq!(
            plan.active_drafts,
            vec![OperationsStatusDraft {
                created_at: 1_700_000_010,
                conversation_id: current_conversation,
                whitelisted_pubkeys: whitelisted.clone(),
                agent_pubkeys: vec![active_agent],
                project_tag: project_tag.clone(),
            }]
        );
        assert_eq!(
            plan.cleanup_drafts,
            vec![OperationsStatusDraft {
                created_at: 1_700_000_010,
                conversation_id: event_id_hex(0x21),
                whitelisted_pubkeys: whitelisted.clone(),
                agent_pubkeys: Vec::new(),
                project_tag: project_tag.clone(),
            }]
        );
    }

    #[test]
    fn plans_transition_without_cleanup_for_still_active_conversation() {
        let mut runtime_state = WorkerRuntimeState::default();
        let conversation_id = event_id_hex(0x22);
        let project_owner = pubkey_hex(0x02);
        let whitelisted = vec![pubkey_hex(0x03)];
        let project_tag = project_tag(&project_owner);
        let active_agent = pubkey_hex(0x04);

        register_worker(
            &mut runtime_state,
            WorkerFixture {
                worker_id: "worker-current",
                dispatch_id: "dispatch-current",
                project_id: "project-alpha",
                agent_pubkey: &active_agent,
                conversation_id: &conversation_id,
                state: Some(WorkerHeartbeatState::Acting),
                active_tool_count: 0,
            },
        );

        let previous_active_conversation_ids = vec![conversation_id.clone()];
        let plan = plan_operations_status_transition(OperationsStatusTransitionInput {
            previous_active_conversation_ids: &previous_active_conversation_ids,
            runtime: OperationsStatusRuntimeInput {
                project_id: "project-alpha",
                created_at: 1_700_000_011,
                whitelisted_pubkeys: &whitelisted,
                project_tag: &project_tag,
                runtime_state: &runtime_state,
            },
        });

        assert_eq!(plan.cleanup_drafts, Vec::<OperationsStatusDraft>::new());
        assert_eq!(
            plan.active_drafts,
            vec![OperationsStatusDraft {
                created_at: 1_700_000_011,
                conversation_id,
                whitelisted_pubkeys: whitelisted,
                agent_pubkeys: vec![active_agent],
                project_tag,
            }]
        );
    }

    #[test]
    fn plans_transition_without_cleanup_for_unrelated_project_activity() {
        let mut runtime_state = WorkerRuntimeState::default();
        let stale_conversation = event_id_hex(0x23);
        let unrelated_project_conversation = event_id_hex(0x24);
        let project_owner = pubkey_hex(0x02);
        let whitelisted = vec![pubkey_hex(0x03)];
        let project_tag = project_tag(&project_owner);
        let unrelated_agent = pubkey_hex(0x04);

        register_worker(
            &mut runtime_state,
            WorkerFixture {
                worker_id: "worker-unrelated",
                dispatch_id: "dispatch-unrelated",
                project_id: "project-beta",
                agent_pubkey: &unrelated_agent,
                conversation_id: &unrelated_project_conversation,
                state: Some(WorkerHeartbeatState::Streaming),
                active_tool_count: 0,
            },
        );

        let previous_active_conversation_ids = vec![stale_conversation.clone()];
        let plan = plan_operations_status_transition(OperationsStatusTransitionInput {
            previous_active_conversation_ids: &previous_active_conversation_ids,
            runtime: OperationsStatusRuntimeInput {
                project_id: "project-alpha",
                created_at: 1_700_000_012,
                whitelisted_pubkeys: &whitelisted,
                project_tag: &project_tag,
                runtime_state: &runtime_state,
            },
        });

        assert!(plan.active_drafts.is_empty());
        assert_eq!(
            plan.cleanup_drafts,
            vec![OperationsStatusDraft {
                created_at: 1_700_000_012,
                conversation_id: stale_conversation,
                whitelisted_pubkeys: whitelisted,
                agent_pubkeys: Vec::new(),
                project_tag,
            }]
        );
    }

    #[test]
    fn publishes_operations_status_transition_into_pending_outbox() {
        let tenex_base_dir = unique_temp_dir("operations-status-runtime-base");
        let daemon_dir = tenex_base_dir.join("daemon");
        fs::create_dir_all(&daemon_dir).expect("daemon dir must create");

        let project_owner = pubkey_hex(0x02);
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

        let mut runtime_state = WorkerRuntimeState::default();
        let current_conversation = event_id_hex(0x30);
        let stale_conversation = event_id_hex(0x31);
        let active_agent = pubkey_hex(0x04);
        register_worker(
            &mut runtime_state,
            WorkerFixture {
                worker_id: "worker-current",
                dispatch_id: "dispatch-current",
                project_id: "demo-project",
                agent_pubkey: &active_agent,
                conversation_id: &current_conversation,
                state: Some(WorkerHeartbeatState::Streaming),
                active_tool_count: 0,
            },
        );

        let previous_active_conversation_ids =
            vec![current_conversation.clone(), stale_conversation.clone()];
        let outcome = publish_operations_status_transition_from_runtime(
            OperationsStatusPublishRuntimeInput {
                tenex_base_dir: &tenex_base_dir,
                daemon_dir: &daemon_dir,
                project_id: "demo-project",
                project_owner_pubkey: &project_owner,
                project_d_tag: "demo-project",
                created_at: 1_700_000_020,
                accepted_at: 1_700_000_020_100,
                request_timestamp: 1_700_000_020_050,
                previous_active_conversation_ids: &previous_active_conversation_ids,
                runtime_state: &runtime_state,
            },
        )
        .expect("operations status transition must publish");

        assert!(outcome.config.is_some());
        assert_eq!(outcome.active.len(), 1);
        assert_eq!(outcome.cleanup.len(), 1);

        let active = &outcome.active[0].publish.record;
        let cleanup = &outcome.cleanup[0].publish.record;
        assert_eq!(active.event.kind, OPERATIONS_STATUS_KIND);
        assert_eq!(cleanup.event.kind, OPERATIONS_STATUS_KIND);
        assert_eq!(
            active.request.request_sequence,
            OPERATIONS_STATUS_REQUEST_SEQUENCE_BASE
        );
        assert_eq!(
            cleanup.request.request_sequence,
            OPERATIONS_STATUS_REQUEST_SEQUENCE_BASE + 1
        );
        assert_eq!(active.request.project_id, "demo-project");
        assert_eq!(cleanup.request.conversation_id, stale_conversation);
        assert!(
            active
                .event
                .tags
                .iter()
                .any(|tag| tag == &vec!["p".to_string(), active_agent.clone()])
        );
        assert!(
            cleanup
                .event
                .tags
                .iter()
                .all(|tag| tag.first().is_none_or(|name| name != "p"))
        );
        assert!(
            active
                .event
                .tags
                .iter()
                .any(|tag| tag == &project_tag(&project_owner))
        );

        read_pending_publish_outbox_record(&daemon_dir, &active.event.id)
            .expect("active record read must succeed")
            .expect("active record must exist");
        read_pending_publish_outbox_record(&daemon_dir, &cleanup.event.id)
            .expect("cleanup record read must succeed")
            .expect("cleanup record must exist");

        cleanup_temp_dir(tenex_base_dir);
    }

    struct WorkerFixture<'a> {
        worker_id: &'a str,
        dispatch_id: &'a str,
        project_id: &'a str,
        agent_pubkey: &'a str,
        conversation_id: &'a str,
        state: Option<WorkerHeartbeatState>,
        active_tool_count: u64,
    }

    fn register_worker(runtime_state: &mut WorkerRuntimeState, fixture: WorkerFixture<'_>) {
        let identity = RalJournalIdentity {
            project_id: fixture.project_id.to_string(),
            agent_pubkey: fixture.agent_pubkey.to_string(),
            conversation_id: fixture.conversation_id.to_string(),
            ral_number: 7,
        };
        runtime_state
            .register_started_dispatch(WorkerRuntimeStartedDispatch {
                worker_id: fixture.worker_id.to_string(),
                pid: 10,
                dispatch_id: fixture.dispatch_id.to_string(),
                identity: identity.clone(),
                claim_token: format!("claim-{}", fixture.worker_id),
                started_at: 1_700_000_000,
            })
            .expect("worker must register");

        let Some(state) = fixture.state else {
            return;
        };

        runtime_state
            .update_worker_heartbeat(
                fixture.worker_id,
                WorkerHeartbeatSnapshot {
                    worker_id: fixture.worker_id.to_string(),
                    correlation_id: format!("heartbeat-{}", fixture.worker_id),
                    sequence: 1,
                    worker_timestamp: 1_700_000_100,
                    observed_at: 1_700_000_101,
                    identity,
                    state,
                    active_tool_count: fixture.active_tool_count,
                    accumulated_runtime_ms: 500,
                },
            )
            .expect("heartbeat must update");
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
}
