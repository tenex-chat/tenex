use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use thiserror::Error;
use tokio::sync::Notify;
use tokio::sync::mpsc::UnboundedSender;

use crate::daemon_signals::{BootedProject, DispatchEnqueued, PublishEnqueued};
use crate::nostr_event::SignedNostrEvent;
use crate::nostr_ingress::{
    NostrIngressError, NostrIngressInput, NostrIngressOutcome, process_verified_nostr_event,
};
use crate::project_agent_whitelist::ingress::WhitelistIngress;
use crate::project_boot_state::ProjectBootState;
use crate::project_event_index::ProjectEventIndex;
use crate::subscription_filters::{RelaySubscriptionFrame, SubscriptionMessageError};

pub struct NostrSubscriptionIngressInput<'a> {
    pub daemon_dir: &'a Path,
    pub tenex_base_dir: &'a Path,
    pub frame: &'a RelaySubscriptionFrame,
    pub timestamp: u64,
    pub writer_version: &'a str,
    pub whitelist_ingress: Option<&'a WhitelistIngress>,
    pub project_boot_state: Option<&'a Arc<Mutex<ProjectBootState>>>,
    pub project_event_index: &'a Arc<Mutex<ProjectEventIndex>>,
    pub project_index_changed: Option<Arc<Notify>>,
    pub project_booted_tx: Option<UnboundedSender<BootedProject>>,
    pub dispatch_enqueued_tx: Option<UnboundedSender<DispatchEnqueued>>,
    pub publish_enqueued_tx: Option<UnboundedSender<PublishEnqueued>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum NostrSubscriptionIngressOutcome {
    Event {
        subscription_id: String,
        event_id: String,
        ingress: NostrIngressOutcome,
    },
    Ignored {
        reason: NostrSubscriptionIgnoredReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NostrSubscriptionIgnoredReason {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
    pub detail: String,
}

#[derive(Debug, Error)]
pub enum NostrSubscriptionIngressError {
    #[error("nostr subscription message failed: {0}")]
    Message(#[from] SubscriptionMessageError),
    #[error("nostr ingress failed: {0}")]
    Ingress(#[from] NostrIngressError),
}

pub fn process_relay_subscription_frame(
    input: NostrSubscriptionIngressInput<'_>,
) -> Result<NostrSubscriptionIngressOutcome, NostrSubscriptionIngressError> {
    match input.frame {
        RelaySubscriptionFrame::Event {
            subscription_id,
            event,
        } => process_event_frame(input, subscription_id, event),
        RelaySubscriptionFrame::Eose { subscription_id } => {
            if let Some(whitelist_ingress) = input.whitelist_ingress {
                whitelist_ingress.handle_eose();
            }
            Ok(ignored(
                "eose",
                Some(subscription_id.clone()),
                "relay sent end-of-stored-events marker",
            ))
        }
        RelaySubscriptionFrame::Notice { message } => {
            Ok(ignored("notice", None, format!("relay notice: {message}")))
        }
        RelaySubscriptionFrame::Closed {
            subscription_id,
            message,
        } => Ok(ignored(
            "closed",
            Some(subscription_id.clone()),
            format!("relay closed subscription: {message}"),
        )),
        RelaySubscriptionFrame::Auth { challenge } => Ok(ignored(
            "auth",
            None,
            format!("relay requested auth challenge: {challenge}"),
        )),
        RelaySubscriptionFrame::Ok {
            event_id,
            accepted,
            message,
        } => Ok(ignored(
            "ok",
            None,
            format!("relay acknowledged event {event_id} accepted={accepted} message={message:?}"),
        )),
    }
}

fn process_event_frame(
    input: NostrSubscriptionIngressInput<'_>,
    subscription_id: &str,
    event: &SignedNostrEvent,
) -> Result<NostrSubscriptionIngressOutcome, NostrSubscriptionIngressError> {
    if let Some(whitelist_ingress) = input.whitelist_ingress {
        whitelist_ingress.handle_event(event);
    }

    let ingress = process_verified_nostr_event(NostrIngressInput {
        daemon_dir: input.daemon_dir,
        tenex_base_dir: input.tenex_base_dir,
        event,
        timestamp: input.timestamp,
        writer_version: input.writer_version,
        project_boot_state: input.project_boot_state,
        project_event_index: input.project_event_index,
        project_index_changed: input.project_index_changed.clone(),
        project_booted_tx: input.project_booted_tx.clone(),
        dispatch_enqueued_tx: input.dispatch_enqueued_tx.clone(),
        publish_enqueued_tx: input.publish_enqueued_tx.clone(),
    })?;

    Ok(NostrSubscriptionIngressOutcome::Event {
        subscription_id: subscription_id.to_string(),
        event_id: event.id.clone(),
        ingress,
    })
}

fn ignored(
    code: impl Into<String>,
    subscription_id: Option<String>,
    detail: impl Into<String>,
) -> NostrSubscriptionIngressOutcome {
    NostrSubscriptionIngressOutcome::Ignored {
        reason: NostrSubscriptionIgnoredReason {
            code: code.into(),
            subscription_id,
            detail: detail.into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::replay_dispatch_queue;
    use crate::inbound_runtime::InboundRuntimeOutcome;
    use crate::nostr_ingress::NostrIngressOutcome;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn event_frame_runs_nostr_ingress_and_keeps_subscription_context() {
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

        let event = signed_event(1, "event-alpha", vec![vec!["p", agent.as_str()]]);
        let frame = RelaySubscriptionFrame::Event {
            subscription_id: "tenex-main".to_string(),
            event,
        };
        let outcome = process_relay_subscription_frame(NostrSubscriptionIngressInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            frame: &frame,
            timestamp: 1_710_000_900_000,
            writer_version: "nostr-subscription-ingress-test@0",
            whitelist_ingress: None,
            project_boot_state: None,
            project_event_index: &project_event_index,
            project_index_changed: None,
            project_booted_tx: None,
            dispatch_enqueued_tx: None,
            publish_enqueued_tx: None,
        })
        .expect("subscription frame must process");

        let NostrSubscriptionIngressOutcome::Event {
            subscription_id,
            event_id,
            ingress,
        } = outcome
        else {
            panic!("expected event outcome");
        };
        assert_eq!(subscription_id, "tenex-main");
        assert_eq!(event_id, "event-alpha");
        let NostrIngressOutcome::Routed {
            inbound: ingress, ..
        } = ingress
        else {
            panic!("expected routed ingress");
        };
        let InboundRuntimeOutcome::Routed { dispatch, .. } = ingress else {
            panic!("expected inbound dispatch");
        };

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(queue.queued.len(), 1);
        assert_eq!(queue.queued[0].dispatch_id, dispatch.dispatch_id);
    }

    #[test]
    fn relay_lifecycle_frames_are_structured_ignored_outcomes() {
        let temp_dir = tempdir().expect("temp dir must create");
        let daemon_dir = temp_dir.path().join("daemon");
        let frames = [
            (
                RelaySubscriptionFrame::Eose {
                    subscription_id: "tenex-main".to_string(),
                },
                "eose",
                Some("tenex-main"),
            ),
            (
                RelaySubscriptionFrame::Notice {
                    message: "rate limited".to_string(),
                },
                "notice",
                None,
            ),
            (
                RelaySubscriptionFrame::Closed {
                    subscription_id: "tenex-main".to_string(),
                    message: "closed".to_string(),
                },
                "closed",
                Some("tenex-main"),
            ),
            (
                RelaySubscriptionFrame::Auth {
                    challenge: "challenge".to_string(),
                },
                "auth",
                None,
            ),
        ];

        let project_event_index = fresh_project_event_index();
        for (frame, expected_code, expected_subscription_id) in frames {
            let outcome = process_relay_subscription_frame(NostrSubscriptionIngressInput {
                daemon_dir: &daemon_dir,
                tenex_base_dir: temp_dir.path(),
                frame: &frame,
                timestamp: 1_710_000_900_001,
                writer_version: "nostr-subscription-ingress-test@0",
                whitelist_ingress: None,
                project_boot_state: None,
                project_event_index: &project_event_index,
                project_index_changed: None,
                project_booted_tx: None,
                dispatch_enqueued_tx: None,
                publish_enqueued_tx: None,
            })
            .expect("lifecycle frame must process");

            let NostrSubscriptionIngressOutcome::Ignored { reason } = outcome else {
                panic!("expected ignored lifecycle outcome");
            };
            assert_eq!(reason.code, expected_code);
            assert_eq!(reason.subscription_id.as_deref(), expected_subscription_id);
            assert!(!daemon_dir.exists());
        }
    }

    fn signed_event(kind: u64, event_id: &str, tags: Vec<Vec<&str>>) -> SignedNostrEvent {
        SignedNostrEvent {
            id: event_id.to_string(),
            pubkey: pubkey_hex(0x31),
            created_at: 1_710_000_900,
            kind,
            tags: tags
                .into_iter()
                .map(|tag| tag.into_iter().map(str::to_string).collect())
                .collect(),
            content: "hello".to_string(),
            sig: "0".repeat(128),
        }
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
            .upsert(SignedNostrEvent {
                id: format!("project-event-{project_id}"),
                pubkey: owner.to_string(),
                created_at: 1,
                kind: 31933,
                tags: vec![vec!["d".to_string(), project_id.to_string()]],
                content: String::new(),
                sig: "0".repeat(128),
            });
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
