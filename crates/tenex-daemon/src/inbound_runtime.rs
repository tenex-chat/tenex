use std::io;
use std::path::Path;

use serde::Serialize;
use thiserror::Error;

use crate::conversation_store_files::{
    ConversationStoreFilesError, DelegationCompletionStoreInput, record_delegation_completion,
};
use crate::inbound_dispatch::{
    DelegationCompletionDispatchInput, DelegationCompletionDispatchOutcome,
    InboundDispatchEnqueueError, InboundDispatchEnqueueInput, InboundDispatchEnqueueOutcome,
    enqueue_delegation_completion_dispatch, enqueue_inbound_dispatch,
};
use crate::inbound_envelope::{ChannelKind, InboundEnvelope, RuntimeTransport};
use crate::backend_config::{BackendConfigError, read_backend_config};
use crate::inbound_routing::{
    InboundRoute, InboundRouteIgnoredReason, InboundRouteResolution, InboundRoutingCatalog,
    InboundRoutingCatalogError, InboundRoutingInput, build_inbound_routing_catalog,
    resolve_inbound_route,
};
use crate::project_event_index::ProjectEventIndex;
use std::sync::{Arc, Mutex};
use crate::ral_journal::{RalCompletedDelegation, RalJournalError, RalReplayStatus};
use crate::ral_scheduler::{
    RalDelegationCompletionLookup, RalDelegationCompletionLookupInput, RalScheduler,
    RalSchedulerError,
};
use crate::worker_injection_queue::{
    WorkerDelegationCompletionInjection, WorkerInjectionEnqueueInput, WorkerInjectionQueueError,
    WorkerInjectionRole, enqueue_worker_injection,
};

#[derive(Debug, Clone, Copy)]
pub struct InboundRuntimeInput<'a> {
    pub daemon_dir: &'a Path,
    pub tenex_base_dir: &'a Path,
    pub envelope: &'a InboundEnvelope,
    pub timestamp: u64,
    pub writer_version: &'a str,
    pub project_event_index: &'a Arc<Mutex<ProjectEventIndex>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum InboundRuntimeOutcome {
    Routed {
        route: InboundRoute,
        dispatch: InboundDispatchEnqueueOutcome,
    },
    DelegationCompletion {
        project_id: String,
        agent_pubkey: String,
        conversation_id: String,
        ral_number: u64,
        delegation_conversation_id: String,
        completion_event_id: String,
        child_message_appended: bool,
        parent_marker_appended: bool,
        dispatch: DelegationCompletionDispatchOutcome,
    },
    Ignored {
        reason: InboundRouteIgnoredReason,
    },
}

#[derive(Debug, Error)]
pub enum InboundRuntimeError {
    #[error("inbound routing catalog failed: {0}")]
    Catalog(#[from] InboundRoutingCatalogError),
    #[error("inbound backend config failed: {0}")]
    BackendConfig(#[from] BackendConfigError),
    #[error("inbound route resolution failed: {0}")]
    RouteResolution(#[from] io::Error),
    #[error("inbound dispatch enqueue failed: {0}")]
    Dispatch(#[from] InboundDispatchEnqueueError),
    #[error("inbound RAL scheduler failed: {0}")]
    RalScheduler(#[from] RalSchedulerError),
    #[error("inbound RAL journal failed: {0}")]
    RalJournal(#[from] RalJournalError),
    #[error("inbound conversation store update failed: {0}")]
    ConversationStore(#[from] ConversationStoreFilesError),
    #[error("inbound worker injection queue failed: {0}")]
    WorkerInjectionQueue(#[from] WorkerInjectionQueueError),
}

pub fn resolve_and_enqueue_inbound_dispatch(
    input: InboundRuntimeInput<'_>,
) -> Result<InboundRuntimeOutcome, InboundRuntimeError> {
    let config = read_backend_config(input.tenex_base_dir)?;
    let projects_base = config
        .projects_base
        .as_deref()
        .unwrap_or("/tmp/tenex-projects");
    let descriptor_report = input
        .project_event_index
        .lock()
        .expect("project event index mutex must not be poisoned")
        .descriptors_report(projects_base);
    let catalog = build_inbound_routing_catalog(input.tenex_base_dir, &descriptor_report)?;
    if let Some(outcome) = try_handle_delegation_completion(input, &catalog)? {
        return Ok(outcome);
    }

    let resolution = resolve_inbound_route(InboundRoutingInput {
        catalog: &catalog,
        envelope: input.envelope,
    })?;

    match resolution {
        InboundRouteResolution::Ignored { reason } => Ok(InboundRuntimeOutcome::Ignored { reason }),
        InboundRouteResolution::Routed { route } => {
            let dispatch = enqueue_inbound_dispatch(InboundDispatchEnqueueInput {
                daemon_dir: input.daemon_dir,
                project: route.dispatch_project(),
                route: route.dispatch_route(),
                envelope: input.envelope,
                timestamp: input.timestamp,
                writer_version: input.writer_version,
            })?;

            Ok(InboundRuntimeOutcome::Routed { route, dispatch })
        }
    }
}

fn try_handle_delegation_completion(
    input: InboundRuntimeInput<'_>,
    catalog: &InboundRoutingCatalog,
) -> Result<Option<InboundRuntimeOutcome>, InboundRuntimeError> {
    let Some(completion_sender_pubkey) = input.envelope.principal.linked_pubkey.as_deref() else {
        return Ok(None);
    };
    let Some(reply_targets) = input.envelope.metadata.reply_targets.as_deref() else {
        return Ok(None);
    };
    if reply_targets.is_empty() {
        return Ok(None);
    }

    let scheduler = RalScheduler::from_daemon_dir(input.daemon_dir)?;
    let Some(lookup) = scheduler.find_delegation_completion(RalDelegationCompletionLookupInput {
        reply_targets,
        completion_sender_pubkey,
        completion_event_id: &input.envelope.message.native_id,
    }) else {
        return Ok(None);
    };

    let target = match lookup {
        RalDelegationCompletionLookup::Pending(target) => target,
        RalDelegationCompletionLookup::AlreadyRecorded(recorded) => {
            return Ok(Some(InboundRuntimeOutcome::Ignored {
                reason: InboundRouteIgnoredReason {
                    code: "delegation_completion_already_recorded".to_string(),
                    project_id: Some(recorded.identity.project_id),
                    pubkeys: vec![completion_sender_pubkey.to_string()],
                    detail: format!(
                        "delegation completion {} for conversation {} was already recorded",
                        recorded.completion_event_id, recorded.delegation_conversation_id
                    ),
                },
            }));
        }
    };

    let Some(project) = catalog
        .projects
        .iter()
        .find(|project| project.project_id == target.identity.project_id)
    else {
        return Ok(Some(InboundRuntimeOutcome::Ignored {
            reason: InboundRouteIgnoredReason {
                code: "delegation_completion_missing_project".to_string(),
                project_id: Some(target.identity.project_id),
                pubkeys: vec![completion_sender_pubkey.to_string()],
                detail: "parent RAL project is not loaded in the inbound routing catalog"
                    .to_string(),
            },
        }));
    };
    let Some(project_base_path) = project.project_base_path.as_deref() else {
        return Ok(Some(InboundRuntimeOutcome::Ignored {
            reason: InboundRouteIgnoredReason {
                code: "delegation_completion_missing_project_base_path".to_string(),
                project_id: Some(project.project_id.clone()),
                pubkeys: vec![completion_sender_pubkey.to_string()],
                detail: "parent RAL project descriptor does not include projectBasePath"
                    .to_string(),
            },
        }));
    };

    let completed_at = input.envelope.occurred_at.max(0) as u64;
    let completion = RalCompletedDelegation {
        delegation_conversation_id: target.pending_delegation.delegation_conversation_id.clone(),
        sender_pubkey: completion_sender_pubkey.to_string(),
        recipient_pubkey: target.pending_delegation.sender_pubkey.clone(),
        response: input.envelope.content.clone(),
        completed_at,
        completion_event_id: input.envelope.message.native_id.clone(),
        full_transcript: None,
    };
    let store = record_delegation_completion(DelegationCompletionStoreInput {
        metadata_path: &project.metadata_path,
        parent_conversation_id: &target.identity.conversation_id,
        parent_agent_pubkey: &target.identity.agent_pubkey,
        parent_ral_number: target.identity.ral_number,
        pending_delegation: &target.pending_delegation,
        completion_envelope: input.envelope,
        parent_triggering_event_id: target.triggering_event_id.as_deref(),
    })?;
    let mut triggering_envelope = store
        .parent_triggering_envelope
        .clone()
        .unwrap_or_else(|| input.envelope.clone());
    bind_resume_trigger_to_project(&mut triggering_envelope, &project.address);
    let remaining_pending_delegation_ids = target
        .remaining_pending_delegations
        .iter()
        .map(|pending| pending.delegation_conversation_id.clone())
        .collect::<Vec<_>>();
    let dispatch = enqueue_delegation_completion_dispatch(DelegationCompletionDispatchInput {
        daemon_dir: input.daemon_dir,
        project: crate::inbound_dispatch::InboundDispatchProject {
            project_id: &project.project_id,
            project_base_path,
            metadata_path: project.metadata_path.to_str().unwrap_or_default(),
        },
        identity: &target.identity,
        parent_status: target.status,
        completion: &completion,
        triggering_envelope: &triggering_envelope,
        remaining_pending_delegation_ids: &remaining_pending_delegation_ids,
        resume_if_waiting: !target.deferred,
        timestamp: input.timestamp,
        writer_version: input.writer_version,
    })?;
    if target.status == RalReplayStatus::Claimed
        && !target.deferred
        && let (Some(worker_id), Some(lease_token)) = (
            target.worker_id.as_deref(),
            target.active_claim_token.as_deref(),
        )
    {
        let injection = enqueue_worker_injection(WorkerInjectionEnqueueInput {
            daemon_dir: input.daemon_dir.to_path_buf(),
            timestamp: input.timestamp,
            correlation_id: format!(
                "delegation-completion-inject:{}",
                completion.completion_event_id
            ),
            worker_id: worker_id.to_string(),
            identity: target.identity.clone(),
            injection_id: format!("delegation-completion:{}", completion.completion_event_id),
            lease_token: lease_token.to_string(),
            role: WorkerInjectionRole::System,
            content: completion.response.clone(),
            delegation_completion: Some(WorkerDelegationCompletionInjection {
                delegation_conversation_id: completion.delegation_conversation_id.clone(),
                recipient_pubkey: completion.sender_pubkey.clone(),
                completed_at: completion.completed_at,
                completion_event_id: completion.completion_event_id.clone(),
            }),
        })?;

        tracing::info!(
            worker_id = %worker_id,
            agent_pubkey = %target.identity.agent_pubkey,
            project_id = %target.identity.project_id,
            conversation_id = %target.identity.conversation_id,
            ral_number = target.identity.ral_number,
            injection_id = %injection.injection_id,
            queued = injection.queued,
            already_existed = injection.already_existed,
            "delegation completion injection queued for active worker"
        );
    }

    Ok(Some(InboundRuntimeOutcome::DelegationCompletion {
        project_id: target.identity.project_id,
        agent_pubkey: target.identity.agent_pubkey,
        conversation_id: target.identity.conversation_id,
        ral_number: target.identity.ral_number,
        delegation_conversation_id: completion.delegation_conversation_id,
        completion_event_id: completion.completion_event_id,
        child_message_appended: store.child_message_appended,
        parent_marker_appended: store.parent_marker_appended,
        dispatch,
    }))
}

fn bind_resume_trigger_to_project(envelope: &mut InboundEnvelope, project_address: &str) {
    envelope.channel.project_binding = Some(project_address.to_string());

    if envelope.transport == RuntimeTransport::Nostr {
        envelope.channel.id = format!("nostr:project:{project_address}");
        envelope.channel.kind = ChannelKind::Project;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{DispatchQueueStatus, replay_dispatch_queue};
    use crate::inbound_envelope::{
        ChannelKind, ChannelRef, ExternalMessageRef, InboundMetadata, PrincipalRef,
        RuntimeTransport,
    };
    use crate::ral_journal::{
        RAL_JOURNAL_WRITER_RUST_DAEMON, RalDelegationType, RalJournalEvent, RalJournalIdentity,
        RalJournalRecord, RalPendingDelegation, RalTerminalSummary, append_ral_journal_record,
    };
    use crate::worker_dispatch_input::read_optional as read_worker_dispatch_input;
    use crate::worker_injection_queue::replay_worker_injection_queue;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn route_and_enqueue_inbound_dispatch_writes_worker_artifacts() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x11);
        let agent = pubkey_hex(0x21);
        let project_event_index = fresh_project_event_index();

        write_backend_config(base_dir, "/repo");
        write_project(base_dir, &project_event_index, "project-alpha", &owner);
        write_agent_index(base_dir, "project-alpha", &[&agent]);
        write_agent(base_dir, &agent, "alpha-agent");

        let envelope = nostr_envelope(&agent, "event-alpha");
        let outcome = resolve_and_enqueue_inbound_dispatch(InboundRuntimeInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            envelope: &envelope,
            timestamp: 1_710_000_700_000,
            writer_version: "inbound-runtime-test@0",
            project_event_index: &project_event_index,
        })
        .expect("inbound runtime must enqueue");

        let InboundRuntimeOutcome::Routed { route, dispatch } = outcome else {
            panic!("expected routed outcome");
        };
        assert_eq!(route.project_id, "project-alpha");
        assert_eq!(route.agent_pubkey, agent);
        assert_eq!(route.conversation_id, "event-alpha");
        assert_eq!(dispatch.project_id, "project-alpha");
        assert_eq!(dispatch.agent_pubkey, route.agent_pubkey);
        assert_eq!(dispatch.conversation_id, route.conversation_id);
        assert!(dispatch.queued);
        assert!(!dispatch.already_existed);

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(queue.queued.len(), 1);
        assert_eq!(queue.queued[0], dispatch.dispatch_record);
        assert_eq!(queue.queued[0].status, DispatchQueueStatus::Queued);

        let sidecar = read_worker_dispatch_input(&daemon_dir, &dispatch.dispatch_id)
            .expect("sidecar must read")
            .expect("sidecar must exist");
        let fields = sidecar
            .resolved_execute_fields()
            .expect("worker dispatch fields must resolve");
        assert_eq!(sidecar.writer.writer_version, "inbound-runtime-test@0");
        assert_eq!(fields.project_base_path, "/repo/project-alpha");
        assert_eq!(
            fields.metadata_path,
            base_dir
                .join("projects")
                .join("project-alpha")
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(
            fields.triggering_envelope["message"]["nativeId"],
            "event-alpha"
        );

        if daemon_dir.exists() {
            fs::remove_dir_all(&daemon_dir).expect("daemon dir cleanup must succeed");
        }
    }

    #[test]
    fn route_and_enqueue_inbound_dispatch_returns_ignored_outcome_when_unmatched() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x12);
        let agent = pubkey_hex(0x22);
        let project_event_index = fresh_project_event_index();

        write_backend_config(base_dir, "/repo");
        write_project(base_dir, &project_event_index, "project-beta", &owner);
        write_agent(base_dir, &agent, "beta-agent");

        let envelope = nostr_envelope(&agent, "event-beta");
        let outcome = resolve_and_enqueue_inbound_dispatch(InboundRuntimeInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            envelope: &envelope,
            timestamp: 1_710_000_700_001,
            writer_version: "inbound-runtime-test@0",
            project_event_index: &project_event_index,
        })
        .expect("inbound runtime must resolve");

        let InboundRuntimeOutcome::Ignored { reason } = outcome else {
            panic!("expected ignored outcome");
        };
        assert_eq!(reason.code, "no_project_match");
        assert_eq!(reason.pubkeys, vec![agent]);

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert!(queue.queued.is_empty());
        assert!(!daemon_dir.join("workers").exists());
    }

    #[test]
    fn delegation_completion_records_child_reply_and_resumes_idle_parent_ral() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x13);
        let parent_agent = pubkey_hex(0x23);
        let delegatee_agent = pubkey_hex(0x33);
        let project_event_index = fresh_project_event_index();

        write_backend_config(base_dir, "/repo");
        write_project(base_dir, &project_event_index, "project-gamma", &owner);
        write_agent_index(
            base_dir,
            "project-gamma",
            &[&parent_agent, &delegatee_agent],
        );
        write_agent(base_dir, &parent_agent, "parent-agent");
        write_agent(base_dir, &delegatee_agent, "delegatee-agent");
        seed_waiting_parent_ral(
            &daemon_dir,
            "project-gamma",
            &parent_agent,
            &delegatee_agent,
            "parent-conversation",
            "root-event",
            "delegation-conversation",
        );
        write_parent_conversation(
            base_dir,
            "project-gamma",
            &owner,
            &parent_agent,
            "parent-conversation",
            "root-event",
            "delegation-conversation",
        );

        let envelope = delegation_completion_envelope(
            &parent_agent,
            &delegatee_agent,
            "completion-event",
            "delegation-conversation",
        );
        let outcome = resolve_and_enqueue_inbound_dispatch(InboundRuntimeInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            envelope: &envelope,
            timestamp: 1_710_000_900_000,
            writer_version: "inbound-runtime-test@0",
            project_event_index: &project_event_index,
        })
        .expect("delegation completion must route");

        let InboundRuntimeOutcome::DelegationCompletion {
            dispatch,
            child_message_appended,
            parent_marker_appended,
            ..
        } = outcome
        else {
            panic!("expected delegation completion outcome");
        };
        assert!(child_message_appended);
        assert!(parent_marker_appended);
        let crate::inbound_dispatch::DelegationCompletionDispatchOutcome::Resumed {
            dispatch_id,
            queued,
            ..
        } = dispatch
        else {
            panic!("expected resumed parent dispatch");
        };
        assert!(queued);

        let sidecar = read_worker_dispatch_input(&daemon_dir, &dispatch_id)
            .expect("sidecar must read")
            .expect("sidecar must exist");
        let fields = sidecar
            .resolved_execute_fields()
            .expect("sidecar execute fields must resolve");
        assert_eq!(fields.triggering_event_id, "root-event");
        assert_eq!(
            fields.triggering_envelope["message"]["nativeId"],
            "root-event"
        );
        assert_eq!(
            fields.triggering_envelope["channel"]["projectBinding"],
            format!("31933:{owner}:project-gamma")
        );
        assert_eq!(fields.triggering_envelope["channel"]["kind"], "project");
        assert!(fields.execution_flags.is_delegation_completion);
        assert!(!fields.execution_flags.has_pending_delegations);

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(queue.queued.len(), 1);
        assert_eq!(queue.queued[0].status, DispatchQueueStatus::Queued);

        let parent_conversation =
            read_conversation(base_dir, "project-gamma", "parent-conversation");
        assert!(
            parent_conversation["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| {
                    message["messageType"] == "delegation-marker"
                        && message["delegationMarker"]["delegationConversationId"]
                            == "delegation-conversation"
                        && message["delegationMarker"]["status"] == "completed"
                })
        );
        let child_conversation =
            read_conversation(base_dir, "project-gamma", "delegation-conversation");
        assert!(
            child_conversation["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| {
                    message["eventId"] == "completion-event"
                        && message["senderPubkey"] == delegatee_agent
                })
        );
    }

    #[test]
    fn delegation_completion_queues_injection_for_claimed_parent_ral() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x14);
        let parent_agent = pubkey_hex(0x24);
        let delegatee_agent = pubkey_hex(0x34);
        let project_event_index = fresh_project_event_index();

        write_backend_config(base_dir, "/repo");
        write_project(base_dir, &project_event_index, "project-delta", &owner);
        write_agent_index(
            base_dir,
            "project-delta",
            &[&parent_agent, &delegatee_agent],
        );
        write_agent(base_dir, &parent_agent, "parent-agent");
        write_agent(base_dir, &delegatee_agent, "delegatee-agent");
        seed_claimed_parent_ral_with_registered_delegation(
            &daemon_dir,
            "project-delta",
            &parent_agent,
            &delegatee_agent,
            "parent-conversation",
            "root-event",
            "delegation-conversation",
        );
        write_parent_conversation(
            base_dir,
            "project-delta",
            &owner,
            &parent_agent,
            "parent-conversation",
            "root-event",
            "delegation-conversation",
        );

        let envelope = delegation_completion_envelope(
            &parent_agent,
            &delegatee_agent,
            "completion-event",
            "delegation-conversation",
        );
        let outcome = resolve_and_enqueue_inbound_dispatch(InboundRuntimeInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            envelope: &envelope,
            timestamp: 1_710_000_901_000,
            writer_version: "inbound-runtime-test@0",
            project_event_index: &project_event_index,
        })
        .expect("delegation completion must route");

        let InboundRuntimeOutcome::DelegationCompletion { dispatch, .. } = outcome else {
            panic!("expected delegation completion outcome");
        };
        assert!(matches!(
            dispatch,
            crate::inbound_dispatch::DelegationCompletionDispatchOutcome::Recorded { .. }
        ));

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert!(queue.queued.is_empty());

        let injections =
            replay_worker_injection_queue(&daemon_dir).expect("injection queue must replay");
        assert_eq!(injections.queued.len(), 1);
        assert_eq!(injections.queued[0].worker_id, "worker-parent");
        assert_eq!(injections.queued[0].lease_token, "claim-parent");
        assert_eq!(
            injections.queued[0].injection_id,
            "delegation-completion:completion-event"
        );
        assert_eq!(
            injections.queued[0]
                .delegation_completion
                .as_ref()
                .expect("delegation completion payload must be present")
                .delegation_conversation_id,
            "delegation-conversation"
        );
    }

    fn nostr_envelope(agent_pubkey: &str, event_id: &str) -> InboundEnvelope {
        InboundEnvelope {
            transport: RuntimeTransport::Nostr,
            principal: PrincipalRef {
                id: "nostr:sender".to_string(),
                transport: RuntimeTransport::Nostr,
                linked_pubkey: Some("sender".to_string()),
                display_name: None,
                username: None,
                kind: None,
            },
            channel: ChannelRef {
                id: format!("nostr:conversation:{event_id}"),
                transport: RuntimeTransport::Nostr,
                kind: ChannelKind::Conversation,
                project_binding: None,
            },
            message: ExternalMessageRef {
                id: format!("nostr:{event_id}"),
                transport: RuntimeTransport::Nostr,
                native_id: event_id.to_string(),
                reply_to_id: None,
            },
            recipients: vec![PrincipalRef {
                id: format!("nostr:{agent_pubkey}"),
                transport: RuntimeTransport::Nostr,
                linked_pubkey: Some(agent_pubkey.to_string()),
                display_name: None,
                username: None,
                kind: None,
            }],
            content: "hello".to_string(),
            occurred_at: 1_710_000_700,
            capabilities: Vec::new(),
            metadata: InboundMetadata::default(),
        }
    }

    fn delegation_completion_envelope(
        parent_agent_pubkey: &str,
        delegatee_agent_pubkey: &str,
        event_id: &str,
        delegation_conversation_id: &str,
    ) -> InboundEnvelope {
        let mut envelope = nostr_envelope(parent_agent_pubkey, event_id);
        envelope.principal = PrincipalRef {
            id: format!("nostr:{delegatee_agent_pubkey}"),
            transport: RuntimeTransport::Nostr,
            linked_pubkey: Some(delegatee_agent_pubkey.to_string()),
            display_name: None,
            username: None,
            kind: None,
        };
        envelope.content = "delegation is complete".to_string();
        envelope.message.reply_to_id = Some(format!("nostr:{delegation_conversation_id}"));
        envelope.metadata.reply_targets = Some(vec![delegation_conversation_id.to_string()]);
        envelope
    }

    fn seed_waiting_parent_ral(
        daemon_dir: &Path,
        project_id: &str,
        parent_agent_pubkey: &str,
        delegatee_agent_pubkey: &str,
        conversation_id: &str,
        triggering_event_id: &str,
        delegation_conversation_id: &str,
    ) {
        let identity = RalJournalIdentity {
            project_id: project_id.to_string(),
            agent_pubkey: parent_agent_pubkey.to_string(),
            conversation_id: conversation_id.to_string(),
            ral_number: 1,
        };
        for record in [
            RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "inbound-runtime-test@0",
                1,
                1_710_000_700_000,
                "seed",
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some(triggering_event_id.to_string()),
                },
            ),
            RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "inbound-runtime-test@0",
                2,
                1_710_000_700_001,
                "seed",
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-parent".to_string(),
                    claim_token: "claim-parent".to_string(),
                },
            ),
            RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "inbound-runtime-test@0",
                3,
                1_710_000_700_002,
                "seed",
                RalJournalEvent::WaitingForDelegation {
                    identity,
                    worker_id: "worker-parent".to_string(),
                    claim_token: "claim-parent".to_string(),
                    pending_delegations: vec![RalPendingDelegation {
                        delegation_conversation_id: delegation_conversation_id.to_string(),
                        recipient_pubkey: delegatee_agent_pubkey.to_string(),
                        sender_pubkey: parent_agent_pubkey.to_string(),
                        prompt: "please handle this".to_string(),
                        delegation_type: RalDelegationType::Standard,
                        ral_number: 1,
                        parent_delegation_conversation_id: None,
                        pending_sub_delegations: None,
                        deferred_completion: None,
                        followup_event_id: None,
                        project_id: None,
                        suggestions: None,
                        killed: None,
                        killed_at: None,
                    }],
                    terminal: RalTerminalSummary {
                        published_user_visible_event: false,
                        pending_delegations_remain: true,
                        accumulated_runtime_ms: 0,
                        final_event_ids: Vec::new(),
                        keep_worker_warm: false,
                    },
                },
            ),
        ] {
            append_ral_journal_record(daemon_dir, &record).expect("seed RAL record must append");
        }
    }

    fn seed_claimed_parent_ral_with_registered_delegation(
        daemon_dir: &Path,
        project_id: &str,
        parent_agent_pubkey: &str,
        delegatee_agent_pubkey: &str,
        conversation_id: &str,
        triggering_event_id: &str,
        delegation_conversation_id: &str,
    ) {
        let identity = RalJournalIdentity {
            project_id: project_id.to_string(),
            agent_pubkey: parent_agent_pubkey.to_string(),
            conversation_id: conversation_id.to_string(),
            ral_number: 1,
        };
        for record in [
            RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "inbound-runtime-test@0",
                1,
                1_710_000_700_000,
                "seed",
                RalJournalEvent::Allocated {
                    identity: identity.clone(),
                    triggering_event_id: Some(triggering_event_id.to_string()),
                },
            ),
            RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "inbound-runtime-test@0",
                2,
                1_710_000_700_001,
                "seed",
                RalJournalEvent::Claimed {
                    identity: identity.clone(),
                    worker_id: "worker-parent".to_string(),
                    claim_token: "claim-parent".to_string(),
                },
            ),
            RalJournalRecord::new(
                RAL_JOURNAL_WRITER_RUST_DAEMON,
                "inbound-runtime-test@0",
                3,
                1_710_000_700_002,
                "seed",
                RalJournalEvent::DelegationRegistered {
                    identity,
                    worker_id: "worker-parent".to_string(),
                    claim_token: "claim-parent".to_string(),
                    pending_delegation: RalPendingDelegation {
                        delegation_conversation_id: delegation_conversation_id.to_string(),
                        recipient_pubkey: delegatee_agent_pubkey.to_string(),
                        sender_pubkey: parent_agent_pubkey.to_string(),
                        prompt: "please handle this".to_string(),
                        delegation_type: RalDelegationType::Standard,
                        ral_number: 1,
                        parent_delegation_conversation_id: None,
                        pending_sub_delegations: None,
                        deferred_completion: None,
                        followup_event_id: None,
                        project_id: None,
                        suggestions: None,
                        killed: None,
                        killed_at: None,
                    },
                },
            ),
        ] {
            append_ral_journal_record(daemon_dir, &record).expect("seed RAL record must append");
        }
    }

    fn write_parent_conversation(
        base_dir: &Path,
        project_id: &str,
        owner_pubkey: &str,
        parent_agent_pubkey: &str,
        conversation_id: &str,
        triggering_event_id: &str,
        delegation_conversation_id: &str,
    ) {
        let conversations_dir = base_dir
            .join("projects")
            .join(project_id)
            .join("conversations");
        fs::create_dir_all(&conversations_dir).expect("conversations dir must create");
        fs::write(
            conversations_dir.join(format!("{conversation_id}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "activeRal": {},
                "nextRalNumber": {},
                "injections": [],
                "messages": [
                    {
                        "id": format!("record:{triggering_event_id}"),
                        "pubkey": owner_pubkey,
                        "content": "root request",
                        "messageType": "text",
                        "eventId": triggering_event_id,
                        "timestamp": 1_710_000_700,
                        "targetedPubkeys": [parent_agent_pubkey],
                        "senderPubkey": owner_pubkey,
                        "senderPrincipal": {
                            "id": format!("nostr:{owner_pubkey}"),
                            "transport": "nostr",
                            "linkedPubkey": owner_pubkey
                        }
                    },
                    {
                        "id": format!("record:delegation:{delegation_conversation_id}:pending:1"),
                        "pubkey": parent_agent_pubkey,
                        "ral": 1,
                        "content": "",
                        "messageType": "delegation-marker",
                        "timestamp": 1_710_000_701,
                        "targetedPubkeys": [parent_agent_pubkey],
                        "delegationMarker": {
                            "delegationConversationId": delegation_conversation_id,
                            "recipientPubkey": "delegatee",
                            "parentConversationId": conversation_id,
                            "initiatedAt": 1_710_000_701,
                            "status": "pending"
                        }
                    }
                ],
                "metadata": {},
                "agentTodos": {},
                "todoNudgedAgents": [],
                "blockedAgents": [],
                "executionTime": {
                    "totalSeconds": 0,
                    "isActive": false,
                    "lastUpdated": 0
                },
                "contextManagementCompactions": {},
                "selfAppliedSkills": {},
                "agentPromptHistories": {},
                "contextManagementReminderStates": {}
            }))
            .expect("conversation json must serialize"),
        )
        .expect("conversation file must write");
    }

    fn read_conversation(
        base_dir: &Path,
        project_id: &str,
        conversation_id: &str,
    ) -> serde_json::Value {
        let path = base_dir
            .join("projects")
            .join(project_id)
            .join("conversations")
            .join(format!("{conversation_id}.json"));
        serde_json::from_slice(&fs::read(path).expect("conversation must read"))
            .expect("conversation json must parse")
    }

    fn write_project(
        base_dir: &Path,
        project_event_index: &Arc<Mutex<ProjectEventIndex>>,
        project_id: &str,
        owner: &str,
    ) {
        let project_dir = base_dir.join("projects").join(project_id);
        fs::create_dir_all(&project_dir).expect("project dir must create");
        project_event_index
            .lock()
            .expect("project event index lock")
            .upsert(crate::nostr_event::SignedNostrEvent {
                id: format!("project-event-{project_id}"),
                pubkey: owner.to_string(),
                created_at: 1,
                kind: 31933,
                tags: vec![vec!["d".to_string(), project_id.to_string()]],
                content: String::new(),
                sig: "0".repeat(128),
            });
    }

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    fn write_backend_config(base_dir: &Path, projects_base: &str) {
        fs::write(
            crate::backend_config::backend_config_path(base_dir),
            format!(
                r#"{{
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "projectsBase": "{projects_base}"
                }}"#
            ),
        )
        .expect("backend config must write");
    }

    fn fresh_project_event_index() -> Arc<Mutex<ProjectEventIndex>> {
        Arc::new(Mutex::new(ProjectEventIndex::new()))
    }

    fn write_agent_index(base_dir: &Path, project_id: &str, pubkeys: &[&str]) {
        let agents_dir = base_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            agents_dir.join("index.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "byProject": {
                    project_id: pubkeys,
                }
            }))
            .expect("agent index must serialize"),
        )
        .expect("agent index must write");
    }

    fn write_agent(base_dir: &Path, pubkey: &str, slug: &str) {
        let agents_dir = base_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        fs::write(
            agents_dir.join(format!("{pubkey}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "slug": slug,
                "status": "active",
                "default": {}
            }))
            .expect("agent json must serialize"),
        )
        .expect("agent file must write");
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
