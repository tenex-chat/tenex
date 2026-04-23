use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use thiserror::Error;

use crate::agent_config_update::{
    AgentConfigUpdateError, AgentConfigUpdateOutcome, AgentConfigUpdateScope,
    apply_agent_config_update,
};
use crate::agent_install::{AgentInstallError, AgentInstallOutcome, install_agent_from_nostr};
use crate::backend_config::{BackendConfigError, read_backend_config};
use crate::inbound_runtime::{
    InboundRuntimeError, InboundRuntimeInput, InboundRuntimeOutcome,
    resolve_and_enqueue_inbound_dispatch,
};
use crate::nostr_classification::{DaemonNostrEventClass, classify_for_daemon};
use crate::nostr_event::SignedNostrEvent;
use crate::nostr_inbound::signed_event_to_inbound_envelope;
use crate::project_boot_state::{
    ProjectBootOutcome, ProjectBootState, ProjectBootStateError, extract_project_boot_reference,
    is_project_booted,
};
use crate::project_event_index::ProjectEventIndex;
use crate::project_nostr_ingress::{
    ProjectNostrIngressError, ProjectNostrIngressOutcome, handle_project_nostr_event,
};
use crate::project_repository_init::{
    ProjectRepositoryInitError, ensure_project_repository_on_boot,
};
use crate::project_status_descriptors::{ProjectStatusDescriptor, ProjectStatusDescriptorError};
use crate::project_status_runtime::{
    ProjectStatusRuntimeError, ProjectStatusRuntimeInput, publish_project_status_from_filesystem,
};
use crate::worker_stop_request::{WorkerStopRequest, write_worker_stop_request};

#[derive(Debug, Clone, Copy)]
pub struct NostrIngressInput<'a> {
    pub daemon_dir: &'a Path,
    pub tenex_base_dir: &'a Path,
    pub event: &'a SignedNostrEvent,
    pub timestamp: u64,
    pub writer_version: &'a str,
    pub project_boot_state: Option<&'a Arc<Mutex<ProjectBootState>>>,
    pub project_event_index: &'a Arc<Mutex<ProjectEventIndex>>,
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
    AgentConfigUpdated {
        class: DaemonNostrEventClass,
        config_update: AgentConfigUpdateOutcome,
        /// Project d-tags for which a fresh kind 24010 project-status event was
        /// enqueued in response to this config update. Empty when the update
        /// was a no-op, when no boot state was supplied, or when no booted
        /// project matched the update scope.
        republished_projects: Vec<String>,
    },
    AgentInstalled {
        class: DaemonNostrEventClass,
        install: AgentInstallOutcome,
    },
    StopRequested {
        class: DaemonNostrEventClass,
        agent_pubkey: String,
        conversation_id: String,
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
    #[error("failed to record project boot state: {0}")]
    ProjectBootState(#[from] ProjectBootStateError),
    #[error("failed to prepare project repository on boot: {0}")]
    ProjectRepositoryInit(#[from] ProjectRepositoryInitError),
    #[error("failed to apply agent config update: {0}")]
    AgentConfigUpdate(#[from] AgentConfigUpdateError),
    #[error("failed to enumerate project descriptors for status republish: {0}")]
    ProjectDescriptors(#[from] ProjectStatusDescriptorError),
    #[error("failed to republish project status for {project_d_tag}: {source}")]
    ProjectStatusRepublish {
        project_d_tag: String,
        #[source]
        source: ProjectStatusRuntimeError,
    },
    #[error("failed to write stop request to filesystem: {0}")]
    StopRequest(#[from] io::Error),
    #[error("failed to install agent from Nostr: {0}")]
    AgentInstall(#[from] AgentInstallError),
}

pub fn process_verified_nostr_event(
    input: NostrIngressInput<'_>,
) -> Result<NostrIngressOutcome, NostrIngressError> {
    let class = classify_for_daemon(input.event);

    if class == DaemonNostrEventClass::Project {
        let project = handle_project_nostr_event(
            input.tenex_base_dir,
            input.event,
            input.project_event_index,
        )?;
        return Ok(NostrIngressOutcome::ProjectUpdated { class, project });
    }

    if class == DaemonNostrEventClass::Boot {
        let Some(project_boot_state) = input.project_boot_state else {
            return Ok(NostrIngressOutcome::Ignored {
                class,
                reason: NostrIngressIgnoredReason {
                    code: "project_boot_state_unavailable".to_string(),
                    detail: "project boot event received without a session boot-state handle"
                        .to_string(),
                },
            });
        };
        let reference = extract_project_boot_reference(input.event)?;
        let config = read_backend_config(input.tenex_base_dir)?;
        let projects_base = config
            .projects_base
            .as_deref()
            .unwrap_or("/tmp/tenex-projects");
        let project_base_path = format!(
            "{}/{}",
            projects_base.trim_end_matches('/'),
            reference.project_d_tag
        );
        let repo_url = input
            .project_event_index
            .lock()
            .expect("project event index mutex must not be poisoned")
            .get(&reference.project_owner_pubkey, &reference.project_d_tag)
            .and_then(|event| {
                event
                    .tags
                    .iter()
                    .find(|tag| tag.first().map(String::as_str) == Some("repo"))
                    .and_then(|tag| tag.get(1))
                    .cloned()
            });
        ensure_project_repository_on_boot(
            &reference.project_d_tag,
            Path::new(&project_base_path),
            repo_url.as_deref(),
        )?;
        let boot = project_boot_state
            .lock()
            .expect("project boot state mutex must not be poisoned")
            .record_boot_event(input.event, input.timestamp)?;
        crate::stdout_status::print_project_booted(
            &boot.project_d_tag,
            boot.booted_project_count,
            boot.already_booted,
        );
        return Ok(NostrIngressOutcome::ProjectBooted { class, boot });
    }

    if class == DaemonNostrEventClass::AgentCreate {
        let config = read_backend_config(input.tenex_base_dir)?;
        let relay_urls = config.effective_relay_urls();
        let install = install_agent_from_nostr(
            input.daemon_dir,
            input.tenex_base_dir,
            input.event,
            &relay_urls,
            input.writer_version,
            input.timestamp,
        )?;
        crate::stdout_status::print_agent_installed(
            &install.slug,
            &install.agent_pubkey,
            install.already_installed,
        );
        return Ok(NostrIngressOutcome::AgentInstalled { class, install });
    }

    if class == DaemonNostrEventClass::ConfigUpdate {
        let agents_dir = input.tenex_base_dir.join("agents");
        let config_update = apply_agent_config_update(&agents_dir, input.event)?;
        let republished_projects = if config_update.file_changed {
            republish_project_status_after_config_update(&input, &config_update.scope)?
        } else {
            Vec::new()
        };
        return Ok(NostrIngressOutcome::AgentConfigUpdated {
            class,
            config_update,
            republished_projects,
        });
    }

    if class == DaemonNostrEventClass::StopCommand {
        return handle_stop_command(input.daemon_dir, input.event, input.timestamp);
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
        project_event_index: input.project_event_index,
    })?;

    Ok(NostrIngressOutcome::Routed { class, inbound })
}

/// Immediately publishes a fresh kind 24010 project-status event for every
/// booted project affected by an agent-config update. A project-scoped update
/// targets a single project; a global update fans out to every booted project.
/// Returns the project d-tags that were republished, in filesystem order.
///
/// When the session has no boot state handle, no republish happens — the
/// daemon cannot safely enqueue project-status events before the project boot
/// gate has observed the project.
fn republish_project_status_after_config_update(
    input: &NostrIngressInput<'_>,
    scope: &AgentConfigUpdateScope,
) -> Result<Vec<String>, NostrIngressError> {
    let Some(boot_state_handle) = input.project_boot_state else {
        return Ok(Vec::new());
    };
    let boot_snapshot = boot_state_handle
        .lock()
        .expect("project boot state mutex must not be poisoned")
        .snapshot();

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

    let accepted_at = input.timestamp;
    let request_timestamp = input.timestamp;
    let created_at = accepted_at / 1_000;

    let mut republished = Vec::new();
    for descriptor in descriptor_report.descriptors {
        if !scope_matches_descriptor(scope, &descriptor) {
            continue;
        }
        if !is_project_booted(
            &boot_snapshot,
            &descriptor.project_owner_pubkey,
            &descriptor.project_d_tag,
        ) {
            continue;
        }
        let project_base_path = descriptor.project_base_path.as_deref().map(Path::new);
        let worktrees_vec = project_base_path
            .map(crate::project_worktrees::read_project_worktrees)
            .unwrap_or_default();
        let worktrees_slice: Option<&[String]> = if worktrees_vec.is_empty() {
            None
        } else {
            Some(&worktrees_vec)
        };
        publish_project_status_from_filesystem(ProjectStatusRuntimeInput {
            tenex_base_dir: input.tenex_base_dir,
            daemon_dir: input.daemon_dir,
            created_at,
            accepted_at,
            request_timestamp,
            project_owner_pubkey: &descriptor.project_owner_pubkey,
            project_d_tag: &descriptor.project_d_tag,
            project_manager_pubkey: descriptor.project_manager_pubkey.as_deref(),
            project_base_path,
            agents: None,
            worktrees: worktrees_slice,
        })
        .map_err(|source| NostrIngressError::ProjectStatusRepublish {
            project_d_tag: descriptor.project_d_tag.clone(),
            source,
        })?;
        republished.push(descriptor.project_d_tag);
    }
    Ok(republished)
}

fn scope_matches_descriptor(
    scope: &AgentConfigUpdateScope,
    descriptor: &ProjectStatusDescriptor,
) -> bool {
    match scope {
        AgentConfigUpdateScope::Global => true,
        AgentConfigUpdateScope::Project {
            project_owner_pubkey,
            project_d_tag,
        } => {
            descriptor.project_owner_pubkey == *project_owner_pubkey
                && descriptor.project_d_tag == *project_d_tag
        }
    }
}

fn handle_stop_command(
    daemon_dir: &Path,
    event: &SignedNostrEvent,
    timestamp: u64,
) -> Result<NostrIngressOutcome, NostrIngressError> {
    let class = DaemonNostrEventClass::StopCommand;

    let Some(agent_pubkey) = event
        .tags
        .iter()
        .find(|tag| tag.first().is_some_and(|name| name == "p"))
        .and_then(|tag| tag.get(1))
        .cloned()
    else {
        return Ok(NostrIngressOutcome::Ignored {
            class,
            reason: NostrIngressIgnoredReason {
                code: "stop_command_missing_p_tag".to_string(),
                detail: "stop command event has no p-tag identifying the target agent".to_string(),
            },
        });
    };

    let Some(conversation_id) = event
        .tags
        .iter()
        .find(|tag| tag.first().is_some_and(|name| name == "e"))
        .and_then(|tag| tag.get(1))
        .cloned()
    else {
        return Ok(NostrIngressOutcome::Ignored {
            class,
            reason: NostrIngressIgnoredReason {
                code: "stop_command_missing_e_tag".to_string(),
                detail: "stop command event has no e-tag identifying the target conversation"
                    .to_string(),
            },
        });
    };

    write_worker_stop_request(
        daemon_dir,
        &WorkerStopRequest {
            agent_pubkey: agent_pubkey.clone(),
            conversation_id: conversation_id.clone(),
            stop_event_id: event.id.clone(),
            requested_at: timestamp,
        },
    )?;

    Ok(NostrIngressOutcome::StopRequested {
        class,
        agent_pubkey,
        conversation_id,
    })
}

fn ignored_code_for_class(class: DaemonNostrEventClass) -> &'static str {
    match class {
        DaemonNostrEventClass::NeverRoute => "never_route",
        DaemonNostrEventClass::Project
        | DaemonNostrEventClass::Lesson
        | DaemonNostrEventClass::LessonComment
        | DaemonNostrEventClass::Boot => "daemon_control_event",
        DaemonNostrEventClass::AgentCreate => "agent_install_not_ignored",
        DaemonNostrEventClass::ConfigUpdate => "config_update_not_ignored",
        DaemonNostrEventClass::StopCommand => "stop_command_not_ignored",
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
        let project_event_index = fresh_project_event_index();

        write_backend_config(base_dir, Path::new("/repo"));
        write_project(base_dir, &project_event_index, "project-alpha", &owner);
        write_agent_index(base_dir, "project-alpha", &[&agent]);
        write_agent(base_dir, &agent, "alpha-agent");

        let event = signed_event(1, "event-alpha", vec![vec!["p", agent.as_str()]]);
        let outcome = process_verified_nostr_event(NostrIngressInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            event: &event,
            timestamp: 1_710_000_800_000,
            writer_version: "nostr-ingress-test@0",
            project_boot_state: None,
            project_event_index: &project_event_index,
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
        let project_event_index = fresh_project_event_index();

        let outcome = process_verified_nostr_event(NostrIngressInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            event: &event,
            timestamp: 1_710_000_800_001,
            writer_version: "nostr-ingress-test@0",
            project_boot_state: None,
            project_event_index: &project_event_index,
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
    fn config_update_event_applies_agent_config_update() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let agent_pubkey = pubkey_hex(0x21);
        write_agent(base_dir, &agent_pubkey, "alpha-agent");
        let project_event_index = fresh_project_event_index();

        let event = signed_event(
            24020,
            "config-event",
            vec![
                vec!["p", agent_pubkey.as_str()],
                vec!["model", "anthropic:claude-opus-4-7"],
                vec!["tool", "web_search"],
            ],
        );

        let outcome = process_verified_nostr_event(NostrIngressInput {
            daemon_dir: &daemon_dir,
            tenex_base_dir: base_dir,
            event: &event,
            timestamp: 1_710_000_800_002,
            writer_version: "nostr-ingress-test@0",
            project_boot_state: None,
            project_event_index: &project_event_index,
        })
        .expect("nostr ingress must process");

        let NostrIngressOutcome::AgentConfigUpdated {
            class,
            config_update,
            republished_projects,
        } = outcome
        else {
            panic!("expected agent config updated outcome");
        };
        assert_eq!(class, DaemonNostrEventClass::ConfigUpdate);
        assert_eq!(config_update.agent_pubkey, agent_pubkey);
        assert_eq!(config_update.model, "anthropic:claude-opus-4-7");
        assert!(config_update.file_changed);
        assert!(
            republished_projects.is_empty(),
            "no boot state supplied so no republish should happen"
        );

        let stored: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(base_dir.join("agents").join(format!("{agent_pubkey}.json")))
                .expect("agent file must read"),
        )
        .expect("agent file must parse");
        assert_eq!(stored["default"]["model"], "anthropic:claude-opus-4-7");
        assert_eq!(
            stored["default"]["tools"],
            serde_json::json!(["web_search"])
        );
    }

    #[test]
    fn boot_event_records_project_boot_state_without_dispatch() {
        let temp_dir = tempdir().expect("temp dir must create");
        let base_dir = temp_dir.path();
        let daemon_dir = base_dir.join("daemon");
        let owner = pubkey_hex(0x11);
        let projects_base = base_dir.join("work");
        let project_base_path = projects_base.join("project-alpha");
        let project_event_index = fresh_project_event_index();
        write_backend_config(base_dir, &projects_base);
        write_project(base_dir, &project_event_index, "project-alpha", &owner);
        let project_reference = format!("31933:{owner}:project-alpha");
        let project_boot_state = Arc::new(Mutex::new(ProjectBootState::new()));
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
            project_boot_state: Some(&project_boot_state),
            project_event_index: &project_event_index,
        })
        .expect("nostr ingress must process");

        let NostrIngressOutcome::ProjectBooted { class, boot } = outcome else {
            panic!("expected project boot outcome");
        };
        assert_eq!(class, DaemonNostrEventClass::Boot);
        assert_eq!(boot.project_owner_pubkey, owner);
        assert_eq!(boot.project_d_tag, "project-alpha");
        assert!(project_base_path.join(".git").exists());
        assert!(!daemon_dir.join("dispatch-queue.jsonl").exists());
        assert_eq!(
            project_boot_state
                .lock()
                .expect("project boot state lock must not poison")
                .snapshot()
                .projects
                .len(),
            1
        );
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

    const TEST_SECRET_KEY_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    fn write_backend_config(base_dir: &Path, projects_base: &Path) {
        fs::write(
            crate::backend_config::backend_config_path(base_dir),
            format!(
                r#"{{
                    "tenexPrivateKey": "{TEST_SECRET_KEY_HEX}",
                    "projectsBase": "{}"
                }}"#,
                projects_base.to_str().expect("projects base utf8")
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
