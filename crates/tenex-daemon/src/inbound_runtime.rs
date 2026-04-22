use std::io;
use std::path::Path;

use serde::Serialize;
use thiserror::Error;

use crate::inbound_dispatch::{
    InboundDispatchEnqueueError, InboundDispatchEnqueueInput, InboundDispatchEnqueueOutcome,
    enqueue_inbound_dispatch,
};
use crate::inbound_envelope::InboundEnvelope;
use crate::inbound_routing::{
    InboundRoute, InboundRouteIgnoredReason, InboundRouteResolution, InboundRoutingCatalogError,
    InboundRoutingInput, build_inbound_routing_catalog, resolve_inbound_route,
};

#[derive(Debug, Clone, Copy)]
pub struct InboundRuntimeInput<'a> {
    pub daemon_dir: &'a Path,
    pub tenex_base_dir: &'a Path,
    pub envelope: &'a InboundEnvelope,
    pub timestamp: u64,
    pub writer_version: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum InboundRuntimeOutcome {
    Routed {
        route: InboundRoute,
        dispatch: InboundDispatchEnqueueOutcome,
    },
    Ignored {
        reason: InboundRouteIgnoredReason,
    },
}

#[derive(Debug, Error)]
pub enum InboundRuntimeError {
    #[error("inbound routing catalog failed: {0}")]
    Catalog(#[from] InboundRoutingCatalogError),
    #[error("inbound route resolution failed: {0}")]
    RouteResolution(#[from] io::Error),
    #[error("inbound dispatch enqueue failed: {0}")]
    Dispatch(#[from] InboundDispatchEnqueueError),
}

pub fn resolve_and_enqueue_inbound_dispatch(
    input: InboundRuntimeInput<'_>,
) -> Result<InboundRuntimeOutcome, InboundRuntimeError> {
    let catalog = build_inbound_routing_catalog(input.tenex_base_dir)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_queue::{DispatchQueueStatus, replay_dispatch_queue};
    use crate::inbound_envelope::{
        ChannelKind, ChannelRef, ExternalMessageRef, InboundMetadata, PrincipalRef,
        RuntimeTransport,
    };
    use crate::worker_dispatch_input::read_optional as read_worker_dispatch_input;
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

        write_project(base_dir, "project-alpha", &owner, "/repo/alpha");
        write_agent_index(base_dir, "project-alpha", &[&agent]);
        write_agent(base_dir, &agent, "alpha-agent");

        let envelope = nostr_envelope(&agent, "event-alpha");
        let outcome = resolve_and_enqueue_inbound_dispatch(InboundRuntimeInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            envelope: &envelope,
            timestamp: 1_710_000_700_000,
            writer_version: "inbound-runtime-test@0",
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
        assert_eq!(fields.project_base_path, "/repo/alpha");
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

        write_project(base_dir, "project-beta", &owner, "/repo/beta");
        write_agent(base_dir, &agent, "beta-agent");

        let envelope = nostr_envelope(&agent, "event-beta");
        let outcome = resolve_and_enqueue_inbound_dispatch(InboundRuntimeInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            envelope: &envelope,
            timestamp: 1_710_000_700_001,
            writer_version: "inbound-runtime-test@0",
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
