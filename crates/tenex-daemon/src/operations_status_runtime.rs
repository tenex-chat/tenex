use std::collections::BTreeMap;

use crate::backend_events::operations_status::OperationsStatusInputs;
use crate::worker_heartbeat::WorkerHeartbeatState;
use crate::worker_runtime_state::{ActiveWorkerRuntimeSnapshot, WorkerRuntimeState};

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

pub fn plan_operations_status_drafts(
    input: OperationsStatusRuntimeInput<'_>,
) -> Vec<OperationsStatusDraft> {
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

fn worker_has_active_operation(worker: &ActiveWorkerRuntimeSnapshot) -> bool {
    let Some(heartbeat) = worker.last_heartbeat.as_ref() else {
        return false;
    };

    matches!(
        heartbeat.state,
        WorkerHeartbeatState::Streaming | WorkerHeartbeatState::Acting
    ) || heartbeat.active_tool_count > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_events::heartbeat::BackendSigner;
    use crate::backend_events::operations_status::encode_operations_status;
    use crate::nostr_event::verify_signed_event;
    use crate::ral_journal::RalJournalIdentity;
    use crate::worker_heartbeat::WorkerHeartbeatSnapshot;
    use crate::worker_runtime_state::{WorkerRuntimeStartedDispatch, WorkerRuntimeState};
    use secp256k1::{Keypair, Secp256k1, SecretKey, Signing};
    use std::str::FromStr;

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
}
