use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use thiserror::Error;

use crate::inbound_runtime::InboundRuntimeOutcome;
use crate::nostr_classification::DaemonNostrEventClass;
use crate::nostr_ingress::NostrIngressOutcome;
use crate::nostr_subscription_action::{
    NostrSubscriptionIntakeAction, NostrSubscriptionIntakeActionInput,
    NostrSubscriptionIntakeIgnoredReason, plan_nostr_subscription_intake_action,
};
use crate::nostr_subscription_ingress::{
    NostrSubscriptionIngressError, NostrSubscriptionIngressInput, NostrSubscriptionIngressOutcome,
    process_relay_subscription_frame,
};
use crate::project_agent_whitelist::ingress::WhitelistIngress;
use crate::project_boot_state::ProjectBootState;
use crate::subscription_filters::RelaySubscriptionFrame;

#[derive(Debug, Clone, Copy)]
pub struct NostrSubscriptionTickInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub daemon_dir: &'a Path,
    pub planned_subscription_id: &'a str,
    pub source_relay: &'a str,
    pub raw_messages: &'a [&'a str],
    pub timestamp: u64,
    pub writer_version: &'a str,
    pub whitelist_ingress: Option<&'a WhitelistIngress>,
    pub project_boot_state: Option<&'a Arc<Mutex<ProjectBootState>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NostrSubscriptionTickDiagnostics {
    pub planned_subscription_id: String,
    pub source_relay: String,
    pub raw_message_count: usize,
    pub processed_events: Vec<NostrSubscriptionTickProcessedEvent>,
    pub ignored_frames: Vec<NostrSubscriptionTickIgnoredFrame>,
    pub dispatches: Vec<NostrSubscriptionTickDispatch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NostrSubscriptionTickProcessedEvent {
    pub frame_index: usize,
    pub subscription_id: String,
    pub event_id: String,
    pub kind: u64,
    pub pubkey: String,
    pub class: DaemonNostrEventClass,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NostrSubscriptionTickIgnoredFrame {
    pub frame_index: usize,
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum NostrSubscriptionTickDispatch {
    Queued {
        frame_index: usize,
        event_id: String,
        dispatch_id: String,
        project_id: String,
        agent_pubkey: String,
        conversation_id: String,
        queued: bool,
        already_existed: bool,
    },
    Ignored {
        frame_index: usize,
        event_id: String,
        code: String,
        detail: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        class: Option<DaemonNostrEventClass>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pubkeys: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dispatch_id: Option<String>,
    },
}

#[derive(Debug, Error)]
pub enum NostrSubscriptionTickError {
    #[error("nostr subscription ingress failed for frame {frame_index}: {source}")]
    Ingress {
        frame_index: usize,
        #[source]
        source: NostrSubscriptionIngressError,
    },
}

pub fn run_nostr_subscription_intake_tick(
    input: NostrSubscriptionTickInput<'_>,
) -> Result<NostrSubscriptionTickDiagnostics, NostrSubscriptionTickError> {
    let mut diagnostics = NostrSubscriptionTickDiagnostics {
        planned_subscription_id: input.planned_subscription_id.to_string(),
        source_relay: input.source_relay.to_string(),
        raw_message_count: input.raw_messages.len(),
        processed_events: Vec::new(),
        ignored_frames: Vec::new(),
        dispatches: Vec::new(),
    };

    for (frame_index, raw_message) in input.raw_messages.iter().enumerate() {
        let frame =
            match plan_nostr_subscription_intake_action(NostrSubscriptionIntakeActionInput {
                planned_subscription_id: input.planned_subscription_id,
                raw_message,
            }) {
                NostrSubscriptionIntakeAction::ProcessFrame { frame } => frame,
                NostrSubscriptionIntakeAction::Ignore { reason } => {
                    diagnostics
                        .ignored_frames
                        .push(intake_ignored_frame(frame_index, reason));
                    continue;
                }
            };

        let outcome = process_relay_subscription_frame(NostrSubscriptionIngressInput {
            daemon_dir: input.daemon_dir,
            tenex_base_dir: input.tenex_base_dir,
            frame: &frame,
            timestamp: input.timestamp,
            writer_version: input.writer_version,
            whitelist_ingress: input.whitelist_ingress,
            project_boot_state: input.project_boot_state,
        })
        .map_err(|source| NostrSubscriptionTickError::Ingress {
            frame_index,
            source,
        })?;

        record_ingress_outcome(frame_index, &frame, outcome, &mut diagnostics);
    }

    Ok(diagnostics)
}

fn record_ingress_outcome(
    frame_index: usize,
    frame: &RelaySubscriptionFrame,
    outcome: NostrSubscriptionIngressOutcome,
    diagnostics: &mut NostrSubscriptionTickDiagnostics,
) {
    match outcome {
        NostrSubscriptionIngressOutcome::Event {
            subscription_id,
            event_id,
            ingress,
        } => {
            let kind = frame_event_kind(frame).unwrap_or_default();
            let class = ingress_class(&ingress);
            diagnostics
                .processed_events
                .push(NostrSubscriptionTickProcessedEvent {
                    frame_index,
                    subscription_id,
                    event_id: event_id.clone(),
                    kind,
                    pubkey: frame_event_pubkey(frame).unwrap_or_default(),
                    class,
                });
            diagnostics
                .dispatches
                .push(dispatch_diagnostic(frame_index, event_id, ingress));
        }
        NostrSubscriptionIngressOutcome::Ignored { reason } => {
            diagnostics
                .ignored_frames
                .push(NostrSubscriptionTickIgnoredFrame {
                    frame_index,
                    code: reason.code,
                    subscription_id: reason.subscription_id,
                    detail: reason.detail,
                });
        }
    }
}

fn dispatch_diagnostic(
    frame_index: usize,
    event_id: String,
    ingress: NostrIngressOutcome,
) -> NostrSubscriptionTickDispatch {
    match ingress {
        NostrIngressOutcome::Routed { class, inbound } => match inbound {
            InboundRuntimeOutcome::Routed { route: _, dispatch } if dispatch.queued => {
                NostrSubscriptionTickDispatch::Queued {
                    frame_index,
                    event_id,
                    dispatch_id: dispatch.dispatch_id,
                    project_id: dispatch.project_id,
                    agent_pubkey: dispatch.agent_pubkey,
                    conversation_id: dispatch.conversation_id,
                    queued: dispatch.queued,
                    already_existed: dispatch.already_existed,
                }
            }
            InboundRuntimeOutcome::Routed { route, dispatch } => {
                NostrSubscriptionTickDispatch::Ignored {
                    frame_index,
                    event_id,
                    code: "dispatch_not_queued".to_string(),
                    detail: "inbound dispatch already exists in a non-queued state".to_string(),
                    class: Some(class),
                    project_id: Some(route.project_id),
                    pubkeys: vec![route.agent_pubkey],
                    dispatch_id: Some(dispatch.dispatch_id),
                }
            }
            InboundRuntimeOutcome::DelegationCompletion { dispatch, .. } => match dispatch {
                crate::inbound_dispatch::DelegationCompletionDispatchOutcome::Resumed {
                    dispatch_id,
                    project_id,
                    agent_pubkey,
                    conversation_id,
                    queued,
                    already_existed,
                    ..
                } if queued => NostrSubscriptionTickDispatch::Queued {
                    frame_index,
                    event_id,
                    dispatch_id,
                    project_id,
                    agent_pubkey,
                    conversation_id,
                    queued,
                    already_existed,
                },
                crate::inbound_dispatch::DelegationCompletionDispatchOutcome::Resumed {
                    dispatch_id,
                    project_id,
                    agent_pubkey,
                    ..
                } => NostrSubscriptionTickDispatch::Ignored {
                    frame_index,
                    event_id,
                    code: "delegation_resume_not_queued".to_string(),
                    detail:
                        "delegation completion resume dispatch already exists in a non-queued state"
                            .to_string(),
                    class: Some(class),
                    project_id: Some(project_id),
                    pubkeys: vec![agent_pubkey],
                    dispatch_id: Some(dispatch_id),
                },
                crate::inbound_dispatch::DelegationCompletionDispatchOutcome::Recorded {
                    ..
                } => NostrSubscriptionTickDispatch::Ignored {
                    frame_index,
                    event_id,
                    code: "delegation_completion_recorded".to_string(),
                    detail: "delegation completion was recorded without starting a new worker"
                        .to_string(),
                    class: Some(class),
                    project_id: None,
                    pubkeys: Vec::new(),
                    dispatch_id: None,
                },
            },
            InboundRuntimeOutcome::Ignored { reason } => NostrSubscriptionTickDispatch::Ignored {
                frame_index,
                event_id,
                code: reason.code,
                detail: reason.detail,
                class: Some(class),
                project_id: reason.project_id,
                pubkeys: reason.pubkeys,
                dispatch_id: None,
            },
        },
        NostrIngressOutcome::Ignored { class, reason } => NostrSubscriptionTickDispatch::Ignored {
            frame_index,
            event_id,
            code: reason.code,
            detail: reason.detail,
            class: Some(class),
            project_id: None,
            pubkeys: Vec::new(),
            dispatch_id: None,
        },
        NostrIngressOutcome::ProjectUpdated { class, project } => {
            NostrSubscriptionTickDispatch::Ignored {
                frame_index,
                event_id,
                code: "project_updated".to_string(),
                detail: format!("project {} state written to disk", project.project_d_tag),
                class: Some(class),
                project_id: Some(project.project_d_tag),
                pubkeys: Vec::new(),
                dispatch_id: None,
            }
        }
        NostrIngressOutcome::ProjectBooted { class, boot } => {
            NostrSubscriptionTickDispatch::Ignored {
                frame_index,
                event_id,
                code: "project_booted".to_string(),
                detail: format!(
                    "project {} boot state recorded in session state",
                    boot.project_d_tag
                ),
                class: Some(class),
                project_id: Some(boot.project_d_tag),
                pubkeys: Vec::new(),
                dispatch_id: None,
            }
        }
        NostrIngressOutcome::AgentConfigUpdated {
            class,
            config_update,
            republished_projects,
        } => NostrSubscriptionTickDispatch::Ignored {
            frame_index,
            event_id,
            code: if config_update.file_changed {
                "agent_config_updated".to_string()
            } else {
                "agent_config_update_noop".to_string()
            },
            detail: format!(
                "agent {} config update applied (changed={}, republished_projects={})",
                config_update.agent_pubkey,
                config_update.file_changed,
                republished_projects.len()
            ),
            class: Some(class),
            project_id: None,
            pubkeys: vec![config_update.agent_pubkey],
            dispatch_id: None,
        },
        NostrIngressOutcome::StopRequested {
            class,
            agent_pubkey,
            conversation_id,
        } => NostrSubscriptionTickDispatch::Ignored {
            frame_index,
            event_id,
            code: "stop_requested".to_string(),
            detail: format!(
                "stop request written for agent {} conversation {}",
                agent_pubkey, conversation_id
            ),
            class: Some(class),
            project_id: None,
            pubkeys: vec![agent_pubkey],
            dispatch_id: None,
        },
        NostrIngressOutcome::AgentInstalled { class, install } => {
            NostrSubscriptionTickDispatch::Ignored {
                frame_index,
                event_id,
                code: if install.already_installed {
                    "agent_already_installed".to_string()
                } else {
                    "agent_installed".to_string()
                },
                detail: format!(
                    "agent {} ({}) installed from definition {}",
                    install.slug, install.agent_pubkey, install.definition_event_id
                ),
                class: Some(class),
                project_id: None,
                pubkeys: vec![install.agent_pubkey],
                dispatch_id: None,
            }
        }
    }
}

fn ingress_class(ingress: &NostrIngressOutcome) -> DaemonNostrEventClass {
    match ingress {
        NostrIngressOutcome::Routed { class, .. }
        | NostrIngressOutcome::Ignored { class, .. }
        | NostrIngressOutcome::ProjectUpdated { class, .. }
        | NostrIngressOutcome::ProjectBooted { class, .. }
        | NostrIngressOutcome::AgentConfigUpdated { class, .. }
        | NostrIngressOutcome::StopRequested { class, .. }
        | NostrIngressOutcome::AgentInstalled { class, .. } => *class,
    }
}

fn frame_event_kind(frame: &RelaySubscriptionFrame) -> Option<u64> {
    match frame {
        RelaySubscriptionFrame::Event { event, .. } => Some(event.kind),
        RelaySubscriptionFrame::Eose { .. }
        | RelaySubscriptionFrame::Notice { .. }
        | RelaySubscriptionFrame::Closed { .. }
        | RelaySubscriptionFrame::Auth { .. } => None,
    }
}

fn frame_event_pubkey(frame: &RelaySubscriptionFrame) -> Option<String> {
    match frame {
        RelaySubscriptionFrame::Event { event, .. } => Some(event.pubkey.clone()),
        RelaySubscriptionFrame::Eose { .. }
        | RelaySubscriptionFrame::Notice { .. }
        | RelaySubscriptionFrame::Closed { .. }
        | RelaySubscriptionFrame::Auth { .. } => None,
    }
}

fn intake_ignored_frame(
    frame_index: usize,
    reason: NostrSubscriptionIntakeIgnoredReason,
) -> NostrSubscriptionTickIgnoredFrame {
    NostrSubscriptionTickIgnoredFrame {
        frame_index,
        code: reason.code,
        subscription_id: reason.subscription_id,
        detail: reason.detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::replay_dispatch_queue;
    use crate::nostr_event::{
        NormalizedNostrEvent, SignedNostrEvent, canonical_payload, event_hash_hex,
    };
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn intake_tick_processes_matching_event_and_reports_ignored_frames() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x11);
        let agent = pubkey_hex(0x21);

        write_project(base_dir, "project-alpha", &owner, "/repo/alpha");
        write_agent_index(base_dir, "project-alpha", &[&agent]);
        write_agent(base_dir, &agent, "alpha-agent");

        let event = signed_event(
            0x31,
            1,
            vec![vec!["p".to_string(), agent.clone()]],
            "hello from relay",
            1_710_001_100,
        );
        let mismatch_event = signed_event(
            0x32,
            1,
            vec![vec!["p".to_string(), agent.clone()]],
            "mismatched subscription",
            1_710_001_101,
        );
        let raw_messages = [
            relay_event_message("tenex-main", &event),
            r#"["EOSE","tenex-main"]"#.to_string(),
            r#"["NOTICE","relay maintenance"]"#.to_string(),
            relay_event_message("other-subscription", &mismatch_event),
            "not-json".to_string(),
        ];
        let raw_message_refs = raw_messages.iter().map(String::as_str).collect::<Vec<_>>();

        let diagnostics = run_nostr_subscription_intake_tick(NostrSubscriptionTickInput {
            tenex_base_dir: base_dir,
            daemon_dir: &daemon_dir,
            planned_subscription_id: "tenex-main",
            source_relay: "wss://relay.one",
            raw_messages: &raw_message_refs,
            timestamp: 1_710_001_100_000,
            writer_version: "nostr-subscription-tick-test@0",
            whitelist_ingress: None,
            project_boot_state: None,
        })
        .expect("subscription tick must process");

        assert_eq!(diagnostics.planned_subscription_id, "tenex-main");
        assert_eq!(diagnostics.source_relay, "wss://relay.one");
        assert_eq!(diagnostics.raw_message_count, 5);
        assert_eq!(
            diagnostics.processed_events,
            vec![NostrSubscriptionTickProcessedEvent {
                frame_index: 0,
                subscription_id: "tenex-main".to_string(),
                event_id: event.id.clone(),
                kind: 1,
                pubkey: event.pubkey.clone(),
                class: DaemonNostrEventClass::Conversation,
            }]
        );
        assert_eq!(diagnostics.ignored_frames.len(), 4);
        assert_eq!(diagnostics.ignored_frames[0].code, "eose");
        assert_eq!(diagnostics.ignored_frames[1].code, "notice");
        assert_eq!(diagnostics.ignored_frames[2].code, "subscription_mismatch");
        assert_eq!(diagnostics.ignored_frames[3].code, "invalid_json");
        assert_eq!(
            diagnostics.ignored_frames[2].subscription_id.as_deref(),
            Some("other-subscription")
        );

        let [
            NostrSubscriptionTickDispatch::Queued {
                frame_index,
                event_id,
                project_id,
                agent_pubkey,
                queued,
                already_existed,
                ..
            },
        ] = diagnostics.dispatches.as_slice()
        else {
            panic!("expected one queued dispatch");
        };
        assert_eq!(*frame_index, 0);
        assert_eq!(event_id, &event.id);
        assert_eq!(project_id, "project-alpha");
        assert_eq!(agent_pubkey, &agent);
        assert!(*queued);
        assert!(!already_existed);

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(queue.queued.len(), 1);
        assert_eq!(queue.queued[0].triggering_event_id, event.id);
    }

    #[test]
    fn intake_tick_reports_dispatch_ignored_without_writing_worker_artifacts() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let unknown_agent = pubkey_hex(0x42);
        let event = signed_event(
            0x33,
            1,
            vec![vec!["p".to_string(), unknown_agent.clone()]],
            "unrouted event",
            1_710_001_200,
        );
        let raw_message = relay_event_message("tenex-main", &event);
        let raw_messages = [raw_message.as_str()];

        let diagnostics = run_nostr_subscription_intake_tick(NostrSubscriptionTickInput {
            tenex_base_dir: base_dir,
            daemon_dir: &daemon_dir,
            planned_subscription_id: "tenex-main",
            source_relay: "wss://relay.one",
            raw_messages: &raw_messages,
            timestamp: 1_710_001_200_000,
            writer_version: "nostr-subscription-tick-test@0",
            whitelist_ingress: None,
            project_boot_state: None,
        })
        .expect("subscription tick must process");

        assert_eq!(diagnostics.processed_events.len(), 1);
        assert!(diagnostics.ignored_frames.is_empty());
        assert_eq!(
            diagnostics.dispatches,
            vec![NostrSubscriptionTickDispatch::Ignored {
                frame_index: 0,
                event_id: event.id,
                code: "no_project_match".to_string(),
                detail:
                    "no active project matched the envelope project binding or target recipients"
                        .to_string(),
                class: Some(DaemonNostrEventClass::Conversation),
                project_id: None,
                pubkeys: vec![unknown_agent],
                dispatch_id: None,
            }]
        );
        assert!(!daemon_dir.join("workers").exists());
    }

    fn relay_event_message(subscription_id: &str, event: &SignedNostrEvent) -> String {
        serde_json::to_string(&serde_json::json!(["EVENT", subscription_id, event]))
            .expect("relay event frame must serialize")
    }

    fn signed_event(
        secret_seed: u8,
        kind: u64,
        tags: Vec<Vec<String>>,
        content: &str,
        created_at: u64,
    ) -> SignedNostrEvent {
        let secret = SecretKey::from_byte_array([secret_seed; 32]).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        let pubkey = hex::encode(xonly.serialize());
        let normalized = NormalizedNostrEvent {
            kind,
            content: content.to_string(),
            tags,
            pubkey: Some(pubkey.clone()),
            created_at: Some(created_at),
        };
        let canonical = canonical_payload(&normalized).expect("canonical payload must serialize");
        let id = event_hash_hex(&canonical);
        let digest: [u8; 32] = hex::decode(&id)
            .expect("event id must decode")
            .try_into()
            .expect("event id must be 32 bytes");
        let sig = secp.sign_schnorr_no_aux_rand(digest.as_slice(), &keypair);

        SignedNostrEvent {
            id,
            pubkey,
            created_at,
            kind,
            tags: normalized.tags,
            content: normalized.content,
            sig: hex::encode(sig.to_byte_array()),
        }
    }

    fn write_project(base_dir: &Path, project_id: &str, owner: &str, project_base_path: &str) {
        let project_dir = base_dir.join("projects").join(project_id);
        fs::create_dir_all(&project_dir).expect("project dir must create");
        fs::write(
            project_dir.join("project.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "projectOwnerPubkey": owner,
                "projectDTag": project_id,
                "projectBasePath": project_base_path,
                "status": "active"
            }))
            .expect("project json must serialize"),
        )
        .expect("project descriptor must write");
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
