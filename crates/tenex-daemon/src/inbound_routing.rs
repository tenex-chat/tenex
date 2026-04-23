use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

use crate::inbound_dispatch::{InboundDispatchProject, InboundDispatchRoute};
use crate::inbound_envelope::{InboundEnvelope, RuntimeTransport};
use crate::project_status_agent_sources::{
    ProjectStatusAgentSourceError, ProjectStatusAgentSourceSkippedFile,
    read_project_status_agent_sources,
};
use crate::project_status_descriptors::{
    ProjectStatusDescriptorError, ProjectStatusDescriptorSkippedFile,
    read_project_status_descriptors,
};
use crate::routing::extract_project_d_tag_from_address;

const CONVERSATIONS_DIR_NAME: &str = "conversations";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundRoutingCatalog {
    pub projects: Vec<InboundRoutingProject>,
    pub skipped_project_files: Vec<ProjectStatusDescriptorSkippedFile>,
    pub skipped_agent_files: Vec<ProjectStatusAgentSourceSkippedFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundRoutingProject {
    pub project_id: String,
    pub owner_pubkey: String,
    pub project_base_path: Option<String>,
    pub metadata_path: PathBuf,
    pub address: String,
    pub agents: Vec<InboundRoutingAgent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundRoutingAgent {
    pub pubkey: String,
    pub slug: String,
}

#[derive(Debug, Clone, Copy)]
pub struct InboundRoutingInput<'a> {
    pub catalog: &'a InboundRoutingCatalog,
    pub envelope: &'a InboundEnvelope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundRoute {
    pub project_id: String,
    pub project_base_path: String,
    pub metadata_path: PathBuf,
    pub project_address: String,
    pub agent_pubkey: String,
    pub conversation_id: String,
    pub method: String,
    pub ignored_target_agent_pubkeys: Vec<String>,
}

impl InboundRoute {
    pub fn dispatch_project(&self) -> InboundDispatchProject<'_> {
        InboundDispatchProject {
            project_id: &self.project_id,
            project_base_path: &self.project_base_path,
            metadata_path: self.metadata_path.to_str().unwrap_or_default(),
        }
    }

    pub fn dispatch_route(&self) -> InboundDispatchRoute<'_> {
        InboundDispatchRoute {
            agent_pubkey: &self.agent_pubkey,
            conversation_id: &self.conversation_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum InboundRouteResolution {
    Routed { route: InboundRoute },
    Ignored { reason: InboundRouteIgnoredReason },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundRouteIgnoredReason {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pubkeys: Vec<String>,
    pub detail: String,
}

#[derive(Debug, Error)]
pub enum InboundRoutingCatalogError {
    #[error("inbound routing project descriptors failed: {0}")]
    ProjectDescriptors(#[from] ProjectStatusDescriptorError),
    #[error("inbound routing agent sources failed: {0}")]
    AgentSources(#[from] ProjectStatusAgentSourceError),
}

pub fn build_inbound_routing_catalog(
    tenex_base_dir: impl AsRef<Path>,
) -> Result<InboundRoutingCatalog, InboundRoutingCatalogError> {
    let tenex_base_dir = tenex_base_dir.as_ref();
    let descriptor_report = read_project_status_descriptors(tenex_base_dir)?;
    let mut projects = Vec::new();
    let mut skipped_agent_files = Vec::new();

    for descriptor in descriptor_report.descriptors {
        let agent_report =
            read_project_status_agent_sources(tenex_base_dir, &descriptor.project_d_tag)?;
        skipped_agent_files.extend(agent_report.skipped_files);
        let mut agents = agent_report
            .agents
            .into_iter()
            .map(|agent| InboundRoutingAgent {
                pubkey: agent.pubkey,
                slug: agent.slug,
            })
            .collect::<Vec<_>>();
        agents.sort_by(|left, right| {
            left.pubkey
                .cmp(&right.pubkey)
                .then_with(|| left.slug.cmp(&right.slug))
        });

        projects.push(InboundRoutingProject {
            project_id: descriptor.project_d_tag.clone(),
            owner_pubkey: descriptor.project_owner_pubkey.clone(),
            project_base_path: descriptor.project_base_path,
            metadata_path: tenex_base_dir
                .join("projects")
                .join(&descriptor.project_d_tag),
            address: format!(
                "31933:{}:{}",
                descriptor.project_owner_pubkey, descriptor.project_d_tag
            ),
            agents,
        });
    }

    projects.sort_by(|left, right| left.project_id.cmp(&right.project_id));

    Ok(InboundRoutingCatalog {
        projects,
        skipped_project_files: descriptor_report.skipped_files,
        skipped_agent_files,
    })
}

pub fn resolve_inbound_route(
    input: InboundRoutingInput<'_>,
) -> Result<InboundRouteResolution, io::Error> {
    if !matches!(
        input.envelope.transport,
        RuntimeTransport::Nostr | RuntimeTransport::Telegram
    ) {
        return Ok(ignored(
            "unsupported_transport",
            None,
            Vec::new(),
            format!(
                "transport {:?} is not dispatched through the inbound route resolver",
                input.envelope.transport
            ),
        ));
    }

    let recipient_pubkeys = recipient_pubkeys(input.envelope);
    if recipient_pubkeys.is_empty() {
        return Ok(ignored(
            "no_recipients",
            None,
            Vec::new(),
            "normalized envelope has no target agent recipients".to_string(),
        ));
    }

    let (project, method) = match resolve_project(input.catalog, input.envelope, &recipient_pubkeys)
    {
        ProjectMatch::Matched { project, method } => (project, method),
        ProjectMatch::Ignored(reason) => return Ok(InboundRouteResolution::Ignored { reason }),
    };

    let Some(project_base_path) = project.project_base_path.as_deref() else {
        return Ok(ignored(
            "missing_project_base_path",
            Some(project.project_id.clone()),
            Vec::new(),
            "target project descriptor does not include projectBasePath".to_string(),
        ));
    };

    let sender_pubkey = input.envelope.principal.linked_pubkey.as_deref();
    let mut target_agents = recipient_pubkeys
        .iter()
        .filter(|pubkey| project_has_agent(project, pubkey))
        .filter(|pubkey| Some(pubkey.as_str()) != sender_pubkey)
        .cloned()
        .collect::<Vec<_>>();
    target_agents.dedup();
    let Some(agent_pubkey) = target_agents.first().cloned() else {
        if let Some(sender_pubkey) = sender_pubkey {
            if project_has_agent(project, sender_pubkey)
                && recipient_pubkeys
                    .iter()
                    .any(|pubkey| pubkey == sender_pubkey)
            {
                return Ok(ignored(
                    "self_authored_agent_echo",
                    Some(project.project_id.clone()),
                    vec![sender_pubkey.to_string()],
                    "agent-authored event targets the same agent and is treated as a publish echo"
                        .to_string(),
                ));
            }
        }

        return Ok(ignored(
            "no_project_agent_recipient",
            Some(project.project_id.clone()),
            recipient_pubkeys,
            "none of the envelope recipients are loaded agents in the target project".to_string(),
        ));
    };

    let conversation_id = resolve_conversation_id(&project.metadata_path, input.envelope)?;
    let ignored_target_agent_pubkeys = target_agents
        .iter()
        .skip(1)
        .map(|pubkey| (*pubkey).to_string())
        .collect();

    Ok(InboundRouteResolution::Routed {
        route: InboundRoute {
            project_id: project.project_id.clone(),
            project_base_path: project_base_path.to_string(),
            metadata_path: project.metadata_path.clone(),
            project_address: project.address.clone(),
            agent_pubkey,
            conversation_id,
            method,
            ignored_target_agent_pubkeys,
        },
    })
}

enum ProjectMatch<'a> {
    Matched {
        project: &'a InboundRoutingProject,
        method: String,
    },
    Ignored(InboundRouteIgnoredReason),
}

fn resolve_project<'a>(
    catalog: &'a InboundRoutingCatalog,
    envelope: &InboundEnvelope,
    recipient_pubkeys: &[String],
) -> ProjectMatch<'a> {
    if let Some(binding) = envelope.channel.project_binding.as_deref() {
        let project_id =
            extract_project_d_tag_from_address(binding).unwrap_or_else(|| binding.to_string());
        if let Some(project) = catalog
            .projects
            .iter()
            .find(|project| project.project_id == project_id)
        {
            return ProjectMatch::Matched {
                project,
                method: "project_binding".to_string(),
            };
        }

        return ProjectMatch::Ignored(InboundRouteIgnoredReason {
            code: "unknown_project_binding".to_string(),
            project_id: Some(project_id),
            pubkeys: Vec::new(),
            detail: format!("project binding {binding:?} did not match an active project"),
        });
    }

    for pubkey in recipient_pubkeys {
        let matching_projects = catalog
            .projects
            .iter()
            .filter(|project| project_has_agent(project, pubkey))
            .collect::<Vec<_>>();
        if matching_projects.len() == 1 {
            return ProjectMatch::Matched {
                project: matching_projects[0],
                method: "recipient_agent".to_string(),
            };
        }
        if matching_projects.len() > 1 {
            return ProjectMatch::Ignored(InboundRouteIgnoredReason {
                code: "ambiguous_recipient_agent_project".to_string(),
                project_id: None,
                pubkeys: vec![pubkey.clone()],
                detail: format!(
                    "recipient agent belongs to {} active projects",
                    matching_projects.len()
                ),
            });
        }
    }

    ProjectMatch::Ignored(InboundRouteIgnoredReason {
        code: "no_project_match".to_string(),
        project_id: None,
        pubkeys: recipient_pubkeys.to_vec(),
        detail: "no active project matched the envelope project binding or target recipients"
            .to_string(),
    })
}

fn project_has_agent(project: &InboundRoutingProject, pubkey: &str) -> bool {
    project.agents.iter().any(|agent| agent.pubkey == pubkey)
}

fn recipient_pubkeys(envelope: &InboundEnvelope) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut pubkeys = Vec::new();
    for recipient in &envelope.recipients {
        let Some(pubkey) = recipient
            .linked_pubkey
            .as_deref()
            .or_else(|| recipient.id.strip_prefix("nostr:"))
        else {
            continue;
        };
        if seen.insert(pubkey.to_string()) {
            pubkeys.push(pubkey.to_string());
        }
    }
    pubkeys
}

fn resolve_conversation_id(
    metadata_path: &Path,
    envelope: &InboundEnvelope,
) -> Result<String, io::Error> {
    let Some(reply_to_id) = envelope.message.reply_to_id.as_deref() else {
        return Ok(envelope.message.native_id.clone());
    };
    let reply_target = native_message_id(reply_to_id);
    match find_conversation_containing_event(metadata_path, &reply_target)? {
        Some(conversation_id) => Ok(conversation_id),
        None => Ok(reply_target),
    }
}

fn native_message_id(message_id: &str) -> String {
    message_id
        .split_once(':')
        .map(|(_, native)| native.to_string())
        .unwrap_or_else(|| message_id.to_string())
}

fn find_conversation_containing_event(
    metadata_path: &Path,
    event_id: &str,
) -> Result<Option<String>, io::Error> {
    let conversations_dir = metadata_path.join(CONVERSATIONS_DIR_NAME);
    let direct_path = conversations_dir.join(format!("{event_id}.json"));
    if direct_path.exists() {
        return Ok(Some(event_id.to_string()));
    }

    let entries = match fs::read_dir(&conversations_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) == Some("json") {
            paths.push(path);
        }
    }
    paths.sort();

    for path in paths {
        if conversation_file_contains_event(&path, event_id)? {
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            return Ok(Some(stem.to_string()));
        }
    }

    Ok(None)
}

fn conversation_file_contains_event(path: &Path, event_id: &str) -> Result<bool, io::Error> {
    let content = fs::read_to_string(path)?;
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return Ok(false);
    };
    let Some(messages) = value.get("messages").and_then(Value::as_array) else {
        return Ok(false);
    };

    Ok(messages.iter().any(|message| {
        message
            .get("eventId")
            .and_then(Value::as_str)
            .is_some_and(|candidate| candidate == event_id)
    }))
}

fn ignored(
    code: impl Into<String>,
    project_id: Option<String>,
    pubkeys: Vec<String>,
    detail: impl Into<String>,
) -> InboundRouteResolution {
    InboundRouteResolution::Ignored {
        reason: InboundRouteIgnoredReason {
            code: code.into(),
            project_id,
            pubkeys,
            detail: detail.into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbound_envelope::{
        ChannelKind, ChannelRef, ExternalMessageRef, InboundMetadata, PrincipalRef,
    };
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn resolves_project_binding_and_first_target_agent_from_filesystem_catalog() {
        let temp_dir = unique_temp_dir("project-binding");
        let owner = pubkey_hex(0x11);
        let first_agent = pubkey_hex(0x21);
        let second_agent = pubkey_hex(0x31);
        write_project(&temp_dir, "project-alpha", &owner, "/repo/alpha");
        write_agent_index(&temp_dir, "project-alpha", &[&first_agent, &second_agent]);
        write_agent(&temp_dir, &first_agent, "alpha-one");
        write_agent(&temp_dir, &second_agent, "alpha-two");

        let catalog = build_inbound_routing_catalog(&temp_dir).expect("catalog must build");
        let mut envelope = nostr_envelope(&first_agent, "event-new");
        envelope.recipients.push(nostr_recipient(&second_agent));
        envelope.channel.project_binding = Some(format!("31933:{owner}:project-alpha"));

        let resolution = resolve_inbound_route(InboundRoutingInput {
            catalog: &catalog,
            envelope: &envelope,
        })
        .expect("route resolution must not fail");

        let InboundRouteResolution::Routed { route } = resolution else {
            panic!("expected routed resolution");
        };
        assert_eq!(route.project_id, "project-alpha");
        assert_eq!(route.project_base_path, "/repo/alpha");
        assert_eq!(
            route.metadata_path,
            temp_dir.join("projects").join("project-alpha")
        );
        assert_eq!(route.agent_pubkey, first_agent);
        assert_eq!(
            route.ignored_target_agent_pubkeys,
            vec![second_agent.clone()]
        );
        assert_eq!(route.conversation_id, "event-new");
        assert_eq!(route.method, "project_binding");
        assert_eq!(route.dispatch_project().project_id, "project-alpha");
        assert_eq!(route.dispatch_route().agent_pubkey, first_agent);

        fs::remove_dir_all(temp_dir).expect("temp dir cleanup must succeed");
    }

    #[test]
    fn resolves_project_by_unique_recipient_agent_without_project_binding() {
        let temp_dir = unique_temp_dir("recipient-project");
        let owner = pubkey_hex(0x12);
        let agent = pubkey_hex(0x22);
        write_project(&temp_dir, "project-beta", &owner, "/repo/beta");
        write_agent_index(&temp_dir, "project-beta", &[&agent]);
        write_agent(&temp_dir, &agent, "beta-agent");

        let catalog = build_inbound_routing_catalog(&temp_dir).expect("catalog must build");
        let envelope = nostr_envelope(&agent, "event-new");

        let resolution = resolve_inbound_route(InboundRoutingInput {
            catalog: &catalog,
            envelope: &envelope,
        })
        .expect("route resolution must not fail");

        let InboundRouteResolution::Routed { route } = resolution else {
            panic!("expected routed resolution");
        };
        assert_eq!(route.project_id, "project-beta");
        assert_eq!(route.agent_pubkey, agent);
        assert_eq!(route.method, "recipient_agent");

        fs::remove_dir_all(temp_dir).expect("temp dir cleanup must succeed");
    }

    #[test]
    fn ignores_agent_authored_self_addressed_project_echo() {
        let temp_dir = unique_temp_dir("self-addressed-agent-echo");
        let owner = pubkey_hex(0x17);
        let agent = pubkey_hex(0x27);
        write_project(&temp_dir, "project-echo", &owner, "/repo/echo");
        write_agent_index(&temp_dir, "project-echo", &[&agent]);
        write_agent(&temp_dir, &agent, "echo-agent");

        let catalog = build_inbound_routing_catalog(&temp_dir).expect("catalog must build");
        let mut envelope = nostr_envelope(&agent, "event-self");
        envelope.principal = nostr_recipient(&agent);
        envelope.channel.project_binding = Some(format!("31933:{owner}:project-echo"));

        let resolution = resolve_inbound_route(InboundRoutingInput {
            catalog: &catalog,
            envelope: &envelope,
        })
        .expect("route resolution must not fail");

        let InboundRouteResolution::Ignored { reason } = resolution else {
            panic!("expected ignored resolution");
        };
        assert_eq!(reason.code, "self_authored_agent_echo");
        assert_eq!(reason.project_id.as_deref(), Some("project-echo"));
        assert_eq!(reason.pubkeys, vec![agent]);

        fs::remove_dir_all(temp_dir).expect("temp dir cleanup must succeed");
    }

    #[test]
    fn resolves_reply_to_existing_conversation_file_that_contains_event() {
        let temp_dir = unique_temp_dir("conversation-lookup");
        let owner = pubkey_hex(0x13);
        let agent = pubkey_hex(0x23);
        write_project(&temp_dir, "project-gamma", &owner, "/repo/gamma");
        write_agent_index(&temp_dir, "project-gamma", &[&agent]);
        write_agent(&temp_dir, &agent, "gamma-agent");
        let conversations_dir = temp_dir
            .join("projects")
            .join("project-gamma")
            .join("conversations");
        fs::create_dir_all(&conversations_dir).expect("conversations dir must create");
        fs::write(
            conversations_dir.join("root-event.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "messages": [
                    {"eventId": "root-event", "content": "root"},
                    {"eventId": "intermediate-event", "content": "reply"}
                ]
            }))
            .expect("conversation json must serialize"),
        )
        .expect("conversation file must write");

        let catalog = build_inbound_routing_catalog(&temp_dir).expect("catalog must build");
        let mut envelope = nostr_envelope(&agent, "event-reply");
        envelope.message.reply_to_id = Some("nostr:intermediate-event".to_string());

        let resolution = resolve_inbound_route(InboundRoutingInput {
            catalog: &catalog,
            envelope: &envelope,
        })
        .expect("route resolution must not fail");

        let InboundRouteResolution::Routed { route } = resolution else {
            panic!("expected routed resolution");
        };
        assert_eq!(route.conversation_id, "root-event");

        fs::remove_dir_all(temp_dir).expect("temp dir cleanup must succeed");
    }

    #[test]
    fn ambiguous_recipient_agent_project_is_ignored() {
        let temp_dir = unique_temp_dir("ambiguous-agent");
        let owner_a = pubkey_hex(0x14);
        let owner_b = pubkey_hex(0x15);
        let shared_agent = pubkey_hex(0x24);
        write_project(&temp_dir, "project-a", &owner_a, "/repo/a");
        write_project(&temp_dir, "project-b", &owner_b, "/repo/b");
        write_agent_index(&temp_dir, "project-a", &[&shared_agent]);
        write_agent_index(&temp_dir, "project-b", &[&shared_agent]);
        write_agent(&temp_dir, &shared_agent, "shared-agent");

        let catalog = build_inbound_routing_catalog(&temp_dir).expect("catalog must build");
        let envelope = nostr_envelope(&shared_agent, "event-new");
        let resolution = resolve_inbound_route(InboundRoutingInput {
            catalog: &catalog,
            envelope: &envelope,
        })
        .expect("route resolution must not fail");

        let InboundRouteResolution::Ignored { reason } = resolution else {
            panic!("expected ignored resolution");
        };
        assert_eq!(reason.code, "ambiguous_recipient_agent_project");
        assert_eq!(reason.pubkeys, vec![shared_agent]);

        fs::remove_dir_all(temp_dir).expect("temp dir cleanup must succeed");
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
            recipients: vec![nostr_recipient(agent_pubkey)],
            content: "hello".to_string(),
            occurred_at: 1_710_001_000,
            capabilities: Vec::new(),
            metadata: InboundMetadata::default(),
        }
    }

    fn nostr_recipient(pubkey: &str) -> PrincipalRef {
        PrincipalRef {
            id: format!("nostr:{pubkey}"),
            transport: RuntimeTransport::Nostr,
            linked_pubkey: Some(pubkey.to_string()),
            display_name: None,
            username: None,
            kind: None,
        }
    }

    fn write_project(temp_dir: &Path, project_id: &str, owner: &str, project_base_path: &str) {
        let project_dir = temp_dir.join("projects").join(project_id);
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

    fn write_agent_index(temp_dir: &Path, project_id: &str, pubkeys: &[&str]) {
        let agents_dir = temp_dir.join("agents");
        fs::create_dir_all(&agents_dir).expect("agents dir must create");
        let path = agents_dir.join("index.json");
        let mut by_project = match fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str::<Value>(&content)
                .expect("existing agent index must parse")
                .get("byProject")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
            Err(error) if error.kind() == io::ErrorKind::NotFound => serde_json::json!({}),
            Err(error) => panic!("agent index read failed: {error}"),
        };
        by_project[project_id] = serde_json::json!(pubkeys);
        fs::write(
            path,
            serde_json::to_vec_pretty(&serde_json::json!({ "byProject": by_project }))
                .expect("agent index json must serialize"),
        )
        .expect("agent index must write");
    }

    fn write_agent(temp_dir: &Path, pubkey: &str, slug: &str) {
        let agents_dir = temp_dir.join("agents");
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

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }
}
