use std::path::Path;

use serde::Serialize;
use thiserror::Error;

use crate::backend_config::{BackendConfigError, read_backend_config};
use crate::inbound_runtime::{
    InboundRuntimeError, InboundRuntimeInput, InboundRuntimeOutcome,
    resolve_and_enqueue_inbound_dispatch,
};
use crate::nostr_classification::{DaemonNostrEventClass, classify_for_daemon};
use crate::nostr_event::SignedNostrEvent;
use crate::nostr_inbound::signed_event_to_inbound_envelope;
use crate::project_boot_state::{
    ProjectBootOutcome, ProjectBootStateError, record_project_boot_event,
};
use crate::project_nostr_ingress::{
    ProjectNostrIngressError, ProjectNostrIngressOutcome, handle_project_nostr_event,
};

#[derive(Debug, Clone, Copy)]
pub struct NostrIngressInput<'a> {
    pub daemon_dir: &'a Path,
    pub tenex_base_dir: &'a Path,
    pub event: &'a SignedNostrEvent,
    pub timestamp: u64,
    pub writer_version: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum NostrIngressOutcome {
    Routed {
        class: DaemonNostrEventClass,
        inbound: InboundRuntimeOutcome,
    },
    ProjectUpdated {
        class: DaemonNostrEventClass,
        project: ProjectNostrIngressOutcome,
    },
    ProjectBooted {
        class: DaemonNostrEventClass,
        boot: ProjectBootOutcome,
    },
    Ignored {
        class: DaemonNostrEventClass,
        reason: NostrIngressIgnoredReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NostrIngressIgnoredReason {
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Error)]
pub enum NostrIngressError {
    #[error("nostr inbound runtime failed: {0}")]
    InboundRuntime(#[from] InboundRuntimeError),
    #[error("failed to read backend config for project ingress: {0}")]
    BackendConfig(#[from] BackendConfigError),
    #[error("failed to write project state: {0}")]
    ProjectIngress(#[from] ProjectNostrIngressError),
    #[error("failed to write project boot state: {0}")]
    ProjectBootState(#[from] ProjectBootStateError),
}

pub fn process_verified_nostr_event(
    input: NostrIngressInput<'_>,
) -> Result<NostrIngressOutcome, NostrIngressError> {
    let class = classify_for_daemon(input.event);

    if class == DaemonNostrEventClass::Project {
        let config = read_backend_config(input.tenex_base_dir)?;
        let projects_base = config
            .projects_base
            .as_deref()
            .unwrap_or("/tmp/tenex-projects");
        let project = handle_project_nostr_event(input.tenex_base_dir, input.event, projects_base)?;
        return Ok(NostrIngressOutcome::ProjectUpdated { class, project });
    }

    if class == DaemonNostrEventClass::Boot {
        let boot = record_project_boot_event(input.daemon_dir, input.event, input.timestamp)?;
        return Ok(NostrIngressOutcome::ProjectBooted { class, boot });
    }

    if !class.should_normalize_for_worker() {
        return Ok(NostrIngressOutcome::Ignored {
            class,
            reason: NostrIngressIgnoredReason {
                code: ignored_code_for_class(class).to_string(),
                detail: format!("nostr event class {class:?} is not a worker conversation"),
            },
        });
    }

    let envelope = signed_event_to_inbound_envelope(input.event);
    let inbound = resolve_and_enqueue_inbound_dispatch(InboundRuntimeInput {
        daemon_dir: input.daemon_dir,
        tenex_base_dir: input.tenex_base_dir,
        envelope: &envelope,
        timestamp: input.timestamp,
        writer_version: input.writer_version,
    })?;

    Ok(NostrIngressOutcome::Routed { class, inbound })
}

fn ignored_code_for_class(class: DaemonNostrEventClass) -> &'static str {
    match class {
        DaemonNostrEventClass::NeverRoute => "never_route",
        DaemonNostrEventClass::Project
        | DaemonNostrEventClass::Lesson
        | DaemonNostrEventClass::LessonComment
        | DaemonNostrEventClass::Boot
        | DaemonNostrEventClass::AgentCreate
        | DaemonNostrEventClass::ConfigUpdate => "daemon_control_event",
        DaemonNostrEventClass::Other => "unsupported_nostr_event_class",
        DaemonNostrEventClass::Conversation => "conversation_not_ignored",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::replay_dispatch_queue;
    use crate::inbound_runtime::InboundRuntimeOutcome;
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn conversation_event_routes_through_inbound_runtime_and_dispatch_queue() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x11);
        let agent = pubkey_hex(0x21);

        write_project(base_dir, "project-alpha", &owner, "/repo/alpha");
        write_agent_index(base_dir, "project-alpha", &[&agent]);
        write_agent(base_dir, &agent, "alpha-agent");

        let event = signed_event(1, "event-alpha", vec![vec!["p", agent.as_str()]]);
        let outcome = process_verified_nostr_event(NostrIngressInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            event: &event,
            timestamp: 1_710_000_800_000,
            writer_version: "nostr-ingress-test@0",
        })
        .expect("nostr ingress must process");

        let NostrIngressOutcome::Routed { class, inbound } = outcome else {
            panic!("expected routed outcome");
        };
        assert_eq!(class, DaemonNostrEventClass::Conversation);
        let InboundRuntimeOutcome::Routed { route, dispatch } = inbound else {
            panic!("expected inbound route");
        };
        assert_eq!(route.project_id, "project-alpha");
        assert_eq!(route.agent_pubkey, agent);
        assert_eq!(dispatch.triggering_event_id, "event-alpha");

        let queue = replay_dispatch_queue(&daemon_dir).expect("dispatch queue must replay");
        assert_eq!(queue.queued.len(), 1);
        assert_eq!(queue.queued[0].dispatch_id, dispatch.dispatch_id);
    }

    #[test]
    fn never_route_event_does_not_write_dispatch_artifacts() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let event = signed_event(24010, "status-event", Vec::new());

        let outcome = process_verified_nostr_event(NostrIngressInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            event: &event,
            timestamp: 1_710_000_800_001,
            writer_version: "nostr-ingress-test@0",
        })
        .expect("nostr ingress must process");

        assert_eq!(
            outcome,
            NostrIngressOutcome::Ignored {
                class: DaemonNostrEventClass::NeverRoute,
                reason: NostrIngressIgnoredReason {
                    code: "never_route".to_string(),
                    detail: "nostr event class NeverRoute is not a worker conversation".to_string(),
                },
            }
        );
        assert!(!daemon_dir.exists());
    }

    #[test]
    fn daemon_control_event_is_reported_without_worker_normalization() {
        let temp_dir = tempdir().expect("temp dir must create");
        let event = signed_event(24020, "config-event", vec![vec!["p", "agent"]]);

        let outcome = process_verified_nostr_event(NostrIngressInput {
            daemon_dir: &temp_dir.path().join("daemon"),
            tenex_base_dir: temp_dir.path(),
            event: &event,
            timestamp: 1_710_000_800_002,
            writer_version: "nostr-ingress-test@0",
        })
        .expect("nostr ingress must process");

        let NostrIngressOutcome::Ignored { class, reason } = outcome else {
            panic!("expected ignored outcome");
        };
        assert_eq!(class, DaemonNostrEventClass::ConfigUpdate);
        assert_eq!(reason.code, "daemon_control_event");
    }

    #[test]
    fn boot_event_records_project_boot_state_without_dispatch() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x11);
        let project_reference = format!("31933:{owner}:project-alpha");
        let event = signed_event(
            24000,
            "boot-event",
            vec![vec!["a", project_reference.as_str()]],
        );

        let outcome = process_verified_nostr_event(NostrIngressInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            event: &event,
            timestamp: 1_710_000_800_003,
            writer_version: "nostr-ingress-test@0",
        })
        .expect("nostr ingress must process");

        let NostrIngressOutcome::ProjectBooted { class, boot } = outcome else {
            panic!("expected project boot outcome");
        };
        assert_eq!(class, DaemonNostrEventClass::Boot);
        assert_eq!(boot.project_owner_pubkey, owner);
        assert_eq!(boot.project_d_tag, "project-alpha");
        assert!(!daemon_dir.join("dispatch-queue.jsonl").exists());
    }

    fn signed_event(kind: u64, event_id: &str, tags: Vec<Vec<&str>>) -> SignedNostrEvent {
        SignedNostrEvent {
            id: event_id.to_string(),
            pubkey: pubkey_hex(0x31),
            created_at: 1_710_000_800,
            kind,
            tags: tags
                .into_iter()
                .map(|tag| tag.into_iter().map(str::to_string).collect())
                .collect(),
            content: "hello".to_string(),
            sig: "0".repeat(128),
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
