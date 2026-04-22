use std::collections::HashSet;
use std::str::FromStr;

use secp256k1::XOnlyPublicKey;
use thiserror::Error;

use super::heartbeat::BackendSigner;
use crate::nostr_event::{
    NormalizedNostrEvent, NostrEventError, SignedNostrEvent, canonical_payload, event_hash_hex,
};

pub const PROJECT_STATUS_KIND: u64 = 24010;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatusAgent {
    pub pubkey: String,
    pub slug: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatusModel {
    pub slug: String,
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatusTool {
    pub name: String,
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatusSkill {
    pub id: String,
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatusMcpServer {
    pub slug: String,
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectStatusScheduledTaskKind {
    Cron,
    Oneoff,
}

impl ProjectStatusScheduledTaskKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cron => "cron",
            Self::Oneoff => "oneoff",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectStatusScheduledTask {
    pub id: String,
    pub title: String,
    pub schedule: String,
    pub target_agent: String,
    pub kind: ProjectStatusScheduledTaskKind,
    pub last_run: Option<u64>,
}

pub struct ProjectStatusInputs<'a> {
    pub created_at: u64,
    pub project_tag: &'a [String],
    pub project_owner_pubkey: &'a str,
    pub whitelisted_pubkeys: &'a [String],
    pub project_manager_pubkey: Option<&'a str>,
    pub agents: &'a [ProjectStatusAgent],
    pub models: &'a [ProjectStatusModel],
    pub tools: &'a [ProjectStatusTool],
    pub skills: &'a [ProjectStatusSkill],
    pub mcp_servers: &'a [ProjectStatusMcpServer],
    pub worktrees: &'a [String],
    pub scheduled_tasks: &'a [ProjectStatusScheduledTask],
}

#[derive(Debug, Error)]
pub enum ProjectStatusEncodeError {
    #[error("project-status project tag must be an a-tag with a non-empty reference")]
    InvalidProjectTag,
    #[error("project-status owner pubkey is invalid: {reason}")]
    InvalidProjectOwnerPubkey { reason: String },
    #[error("project-status whitelisted pubkey at index {index} is invalid: {reason}")]
    InvalidWhitelistedPubkey { index: usize, reason: String },
    #[error("project-status project manager pubkey is invalid: {reason}")]
    InvalidProjectManagerPubkey { reason: String },
    #[error("project-status agent pubkey at index {index} is invalid: {reason}")]
    InvalidAgentPubkey { index: usize, reason: String },
    #[error("project-status agent slug at index {index} is empty")]
    EmptyAgentSlug { index: usize },
    #[error("project-status model slug at index {index} is empty")]
    EmptyModelSlug { index: usize },
    #[error("project-status model agent slug at model {model_index}, agent {agent_index} is empty")]
    EmptyModelAgentSlug {
        model_index: usize,
        agent_index: usize,
    },
    #[error("project-status tool name at index {index} is empty")]
    EmptyToolName { index: usize },
    #[error("project-status tool agent slug at tool {tool_index}, agent {agent_index} is empty")]
    EmptyToolAgentSlug {
        tool_index: usize,
        agent_index: usize,
    },
    #[error("project-status skill id at index {index} is empty")]
    EmptySkillId { index: usize },
    #[error("project-status skill agent slug at skill {skill_index}, agent {agent_index} is empty")]
    EmptySkillAgentSlug {
        skill_index: usize,
        agent_index: usize,
    },
    #[error("project-status mcp server slug at index {index} is empty")]
    EmptyMcpServerSlug { index: usize },
    #[error(
        "project-status mcp server agent slug at server {server_index}, agent {agent_index} is empty"
    )]
    EmptyMcpServerAgentSlug {
        server_index: usize,
        agent_index: usize,
    },
    #[error("project-status worktree branch at index {index} is empty")]
    EmptyWorktreeBranch { index: usize },
    #[error("project-status scheduled task id at index {index} is empty")]
    EmptyScheduledTaskId { index: usize },
    #[error("project-status scheduled task title at index {index} is empty")]
    EmptyScheduledTaskTitle { index: usize },
    #[error("project-status scheduled task schedule at index {index} is empty")]
    EmptyScheduledTaskSchedule { index: usize },
    #[error("project-status scheduled task target agent at index {index} is empty")]
    EmptyScheduledTaskTargetAgent { index: usize },
    #[error("project-status canonicalization failed: {0}")]
    Canonicalize(#[from] NostrEventError),
    #[error("project-status signing failed: {0}")]
    Sign(#[from] secp256k1::Error),
}

pub fn encode_project_status<S: BackendSigner>(
    inputs: &ProjectStatusInputs<'_>,
    signer: &S,
) -> Result<SignedNostrEvent, ProjectStatusEncodeError> {
    validate_inputs(inputs)?;

    let signer_pubkey = signer.xonly_pubkey_hex();
    let tags = project_status_tags(inputs);
    let normalized = NormalizedNostrEvent {
        kind: PROJECT_STATUS_KIND,
        content: String::new(),
        tags: tags.clone(),
        pubkey: Some(signer_pubkey.clone()),
        created_at: Some(inputs.created_at),
    };

    let canonical = canonical_payload(&normalized)?;
    let id = event_hash_hex(&canonical);
    let digest = decode_event_id(&id)?;
    let sig = signer.sign_schnorr(&digest)?;

    Ok(SignedNostrEvent {
        id,
        pubkey: signer_pubkey,
        created_at: inputs.created_at,
        kind: PROJECT_STATUS_KIND,
        tags,
        content: String::new(),
        sig,
    })
}

fn validate_inputs(inputs: &ProjectStatusInputs<'_>) -> Result<(), ProjectStatusEncodeError> {
    if inputs.project_tag.len() < 2
        || inputs.project_tag.first().map(String::as_str) != Some("a")
        || inputs
            .project_tag
            .get(1)
            .is_none_or(|reference| reference.is_empty())
    {
        return Err(ProjectStatusEncodeError::InvalidProjectTag);
    }

    validate_xonly_pubkey_hex(inputs.project_owner_pubkey).map_err(|err| {
        ProjectStatusEncodeError::InvalidProjectOwnerPubkey {
            reason: err.to_string(),
        }
    })?;

    for (index, pubkey) in inputs.whitelisted_pubkeys.iter().enumerate() {
        validate_xonly_pubkey_hex(pubkey).map_err(|err| {
            ProjectStatusEncodeError::InvalidWhitelistedPubkey {
                index,
                reason: err.to_string(),
            }
        })?;
    }

    if let Some(pubkey) = inputs.project_manager_pubkey {
        validate_xonly_pubkey_hex(pubkey).map_err(|err| {
            ProjectStatusEncodeError::InvalidProjectManagerPubkey {
                reason: err.to_string(),
            }
        })?;
    }

    for (index, agent) in inputs.agents.iter().enumerate() {
        validate_xonly_pubkey_hex(&agent.pubkey).map_err(|err| {
            ProjectStatusEncodeError::InvalidAgentPubkey {
                index,
                reason: err.to_string(),
            }
        })?;
        if agent.slug.is_empty() {
            return Err(ProjectStatusEncodeError::EmptyAgentSlug { index });
        }
    }

    for (model_index, model) in inputs.models.iter().enumerate() {
        if model.slug.is_empty() {
            return Err(ProjectStatusEncodeError::EmptyModelSlug { index: model_index });
        }
        for (agent_index, agent) in model.agents.iter().enumerate() {
            if agent.is_empty() {
                return Err(ProjectStatusEncodeError::EmptyModelAgentSlug {
                    model_index,
                    agent_index,
                });
            }
        }
    }

    for (tool_index, tool) in inputs.tools.iter().enumerate() {
        if tool.name.is_empty() {
            return Err(ProjectStatusEncodeError::EmptyToolName { index: tool_index });
        }
        for (agent_index, agent) in tool.agents.iter().enumerate() {
            if agent.is_empty() {
                return Err(ProjectStatusEncodeError::EmptyToolAgentSlug {
                    tool_index,
                    agent_index,
                });
            }
        }
    }

    for (skill_index, skill) in inputs.skills.iter().enumerate() {
        if skill.id.is_empty() {
            return Err(ProjectStatusEncodeError::EmptySkillId { index: skill_index });
        }
        for (agent_index, agent) in skill.agents.iter().enumerate() {
            if agent.is_empty() {
                return Err(ProjectStatusEncodeError::EmptySkillAgentSlug {
                    skill_index,
                    agent_index,
                });
            }
        }
    }

    for (server_index, server) in inputs.mcp_servers.iter().enumerate() {
        if server.slug.is_empty() {
            return Err(ProjectStatusEncodeError::EmptyMcpServerSlug {
                index: server_index,
            });
        }
        for (agent_index, agent) in server.agents.iter().enumerate() {
            if agent.is_empty() {
                return Err(ProjectStatusEncodeError::EmptyMcpServerAgentSlug {
                    server_index,
                    agent_index,
                });
            }
        }
    }

    for (index, branch) in inputs.worktrees.iter().enumerate() {
        if branch.is_empty() {
            return Err(ProjectStatusEncodeError::EmptyWorktreeBranch { index });
        }
    }

    for (index, task) in inputs.scheduled_tasks.iter().enumerate() {
        if task.id.is_empty() {
            return Err(ProjectStatusEncodeError::EmptyScheduledTaskId { index });
        }
        if task.title.is_empty() {
            return Err(ProjectStatusEncodeError::EmptyScheduledTaskTitle { index });
        }
        if task.schedule.is_empty() {
            return Err(ProjectStatusEncodeError::EmptyScheduledTaskSchedule { index });
        }
        if task.target_agent.is_empty() {
            return Err(ProjectStatusEncodeError::EmptyScheduledTaskTargetAgent { index });
        }
    }

    Ok(())
}

fn project_status_tags(inputs: &ProjectStatusInputs<'_>) -> Vec<Vec<String>> {
    let mut tags = Vec::new();
    tags.push(inputs.project_tag.to_vec());

    let mut p_tagged_pubkeys = HashSet::new();
    tags.push(vec![
        "p".to_string(),
        inputs.project_owner_pubkey.to_string(),
    ]);
    p_tagged_pubkeys.insert(inputs.project_owner_pubkey);

    for pubkey in inputs.whitelisted_pubkeys {
        if p_tagged_pubkeys.insert(pubkey.as_str()) {
            tags.push(vec!["p".to_string(), pubkey.clone()]);
        }
    }

    for agent in inputs.agents {
        let mut tag = vec![
            "agent".to_string(),
            agent.pubkey.clone(),
            agent.slug.clone(),
        ];
        if inputs.project_manager_pubkey == Some(agent.pubkey.as_str()) {
            tag.push("pm".to_string());
        }
        tags.push(tag);
    }

    for model in inputs.models {
        let mut tag = vec!["model".to_string(), model.slug.clone()];
        tag.extend(model.agents.iter().cloned());
        tags.push(tag);
    }

    for tool in inputs.tools {
        let mut tag = vec!["tool".to_string(), tool.name.clone()];
        tag.extend(tool.agents.iter().cloned());
        tags.push(tag);
    }

    for skill in inputs.skills {
        let mut tag = vec!["skill".to_string(), skill.id.clone()];
        tag.extend(skill.agents.iter().cloned());
        tags.push(tag);
    }

    for server in inputs.mcp_servers {
        let mut tag = vec!["mcp".to_string(), server.slug.clone()];
        tag.extend(server.agents.iter().cloned());
        tags.push(tag);
    }

    for branch in inputs.worktrees {
        tags.push(vec!["branch".to_string(), branch.clone()]);
    }

    for task in inputs.scheduled_tasks {
        tags.push(vec![
            "scheduled-task".to_string(),
            task.id.clone(),
            task.title.clone(),
            task.schedule.clone(),
            task.target_agent.clone(),
            task.kind.as_str().to_string(),
            task.last_run
                .map_or_else(String::new, |last_run| last_run.to_string()),
        ]);
    }

    tags
}

fn validate_xonly_pubkey_hex(value: &str) -> Result<(), secp256k1::Error> {
    XOnlyPublicKey::from_str(value)?;
    Ok(())
}

fn decode_event_id(id_hex: &str) -> Result<[u8; 32], NostrEventError> {
    let bytes = hex::decode(id_hex)?;
    bytes
        .try_into()
        .map_err(|bytes: Vec<u8>| NostrEventError::InvalidDigestLength {
            field: "event id",
            actual: bytes.len(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr_event::verify_signed_event;
    use secp256k1::{Keypair, Secp256k1, SecretKey, Signing};

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

    fn test_signer() -> Secp256k1Signer<secp256k1::All> {
        Secp256k1Signer::new(Secp256k1::new(), TEST_SECRET_KEY_HEX)
    }

    fn pubkey_hex(fill_byte: u8) -> String {
        let secret_bytes = [fill_byte; 32];
        let secret = SecretKey::from_byte_array(secret_bytes).expect("valid secret");
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let (xonly, _) = keypair.x_only_public_key();
        hex::encode(xonly.serialize())
    }

    fn project_tag(owner: &str) -> Vec<String> {
        vec!["a".to_string(), format!("31933:{owner}:demo-project")]
    }

    fn default_inputs<'a>(
        project_tag: &'a [String],
        owner: &'a str,
        whitelisted_pubkeys: &'a [String],
        project_manager_pubkey: Option<&'a str>,
        agents: &'a [ProjectStatusAgent],
        models: &'a [ProjectStatusModel],
        tools: &'a [ProjectStatusTool],
        skills: &'a [ProjectStatusSkill],
        mcp_servers: &'a [ProjectStatusMcpServer],
        worktrees: &'a [String],
        scheduled_tasks: &'a [ProjectStatusScheduledTask],
    ) -> ProjectStatusInputs<'a> {
        ProjectStatusInputs {
            created_at: 1_700_000_000,
            project_tag,
            project_owner_pubkey: owner,
            whitelisted_pubkeys,
            project_manager_pubkey,
            agents,
            models,
            tools,
            skills,
            mcp_servers,
            worktrees,
            scheduled_tasks,
        }
    }

    #[test]
    fn encodes_project_status_with_typescript_tag_order_and_valid_signature() {
        let signer = test_signer();
        let owner = pubkey_hex(0x02);
        let whitelisted = vec![owner.clone(), pubkey_hex(0x03), pubkey_hex(0x03)];
        let manager = pubkey_hex(0x04);
        let worker = pubkey_hex(0x05);
        let project_tag = project_tag(&owner);
        let agents = vec![
            ProjectStatusAgent {
                pubkey: worker.clone(),
                slug: "worker".to_string(),
            },
            ProjectStatusAgent {
                pubkey: manager.clone(),
                slug: "manager".to_string(),
            },
        ];
        let models = vec![ProjectStatusModel {
            slug: "anthropic".to_string(),
            agents: vec!["manager".to_string(), "worker".to_string()],
        }];
        let tools = vec![ProjectStatusTool {
            name: "shell".to_string(),
            agents: vec!["worker".to_string()],
        }];
        let skills = vec![ProjectStatusSkill {
            id: "skill-build".to_string(),
            agents: vec!["manager".to_string()],
        }];
        let mcp_servers = vec![ProjectStatusMcpServer {
            slug: "github".to_string(),
            agents: vec!["worker".to_string()],
        }];
        let worktrees = vec!["main".to_string(), "feature/rust".to_string()];
        let scheduled_tasks = vec![
            ProjectStatusScheduledTask {
                id: "task-1".to_string(),
                title: "Nightly build".to_string(),
                schedule: "0 1 * * *".to_string(),
                target_agent: "worker".to_string(),
                kind: ProjectStatusScheduledTaskKind::Cron,
                last_run: Some(1_699_999_999),
            },
            ProjectStatusScheduledTask {
                id: "task-2".to_string(),
                title: "One-shot review".to_string(),
                schedule: "2026-04-22T12:00:00Z".to_string(),
                target_agent: "manager".to_string(),
                kind: ProjectStatusScheduledTaskKind::Oneoff,
                last_run: None,
            },
        ];
        let inputs = default_inputs(
            &project_tag,
            &owner,
            &whitelisted,
            Some(&manager),
            &agents,
            &models,
            &tools,
            &skills,
            &mcp_servers,
            &worktrees,
            &scheduled_tasks,
        );

        let event = encode_project_status(&inputs, &signer).expect("encode project status");

        assert_eq!(event.kind, PROJECT_STATUS_KIND);
        assert_eq!(event.content, "");
        assert_eq!(event.pubkey, signer.xonly_pubkey_hex());
        assert_eq!(event.created_at, 1_700_000_000);
        assert_eq!(
            event.tags,
            vec![
                project_tag.clone(),
                vec!["p".to_string(), owner.clone()],
                vec!["p".to_string(), whitelisted[1].clone()],
                vec!["agent".to_string(), worker, "worker".to_string()],
                vec![
                    "agent".to_string(),
                    manager.clone(),
                    "manager".to_string(),
                    "pm".to_string(),
                ],
                vec![
                    "model".to_string(),
                    "anthropic".to_string(),
                    "manager".to_string(),
                    "worker".to_string(),
                ],
                vec![
                    "tool".to_string(),
                    "shell".to_string(),
                    "worker".to_string()
                ],
                vec![
                    "skill".to_string(),
                    "skill-build".to_string(),
                    "manager".to_string(),
                ],
                vec![
                    "mcp".to_string(),
                    "github".to_string(),
                    "worker".to_string()
                ],
                vec!["branch".to_string(), "main".to_string()],
                vec!["branch".to_string(), "feature/rust".to_string()],
                vec![
                    "scheduled-task".to_string(),
                    "task-1".to_string(),
                    "Nightly build".to_string(),
                    "0 1 * * *".to_string(),
                    "worker".to_string(),
                    "cron".to_string(),
                    "1699999999".to_string(),
                ],
                vec![
                    "scheduled-task".to_string(),
                    "task-2".to_string(),
                    "One-shot review".to_string(),
                    "2026-04-22T12:00:00Z".to_string(),
                    "manager".to_string(),
                    "oneoff".to_string(),
                    "".to_string(),
                ],
            ],
        );

        let expected_canonical = canonical_payload(&NormalizedNostrEvent {
            kind: event.kind,
            content: event.content.clone(),
            tags: event.tags.clone(),
            pubkey: Some(event.pubkey.clone()),
            created_at: Some(event.created_at),
        })
        .expect("canonical payload");
        assert_eq!(event.id, event_hash_hex(&expected_canonical));
        verify_signed_event(&event).expect("signature must verify");
    }

    #[test]
    fn encodes_minimal_project_status() {
        let signer = test_signer();
        let owner = pubkey_hex(0x02);
        let project_tag = project_tag(&owner);
        let whitelisted: Vec<String> = Vec::new();
        let agents: Vec<ProjectStatusAgent> = Vec::new();
        let models: Vec<ProjectStatusModel> = Vec::new();
        let tools: Vec<ProjectStatusTool> = Vec::new();
        let skills: Vec<ProjectStatusSkill> = Vec::new();
        let mcp_servers: Vec<ProjectStatusMcpServer> = Vec::new();
        let worktrees: Vec<String> = Vec::new();
        let scheduled_tasks: Vec<ProjectStatusScheduledTask> = Vec::new();
        let inputs = default_inputs(
            &project_tag,
            &owner,
            &whitelisted,
            None,
            &agents,
            &models,
            &tools,
            &skills,
            &mcp_servers,
            &worktrees,
            &scheduled_tasks,
        );

        let event = encode_project_status(&inputs, &signer).expect("encode project status");

        assert_eq!(
            event.tags,
            vec![project_tag.clone(), vec!["p".to_string(), owner]],
        );
        verify_signed_event(&event).expect("signature must verify");
    }

    #[test]
    fn encoding_is_deterministic_for_same_inputs() {
        let signer = test_signer();
        let owner = pubkey_hex(0x02);
        let project_tag = project_tag(&owner);
        let whitelisted = vec![pubkey_hex(0x03)];
        let agents: Vec<ProjectStatusAgent> = Vec::new();
        let models: Vec<ProjectStatusModel> = Vec::new();
        let tools: Vec<ProjectStatusTool> = Vec::new();
        let skills: Vec<ProjectStatusSkill> = Vec::new();
        let mcp_servers: Vec<ProjectStatusMcpServer> = Vec::new();
        let worktrees: Vec<String> = Vec::new();
        let scheduled_tasks: Vec<ProjectStatusScheduledTask> = Vec::new();
        let inputs = default_inputs(
            &project_tag,
            &owner,
            &whitelisted,
            None,
            &agents,
            &models,
            &tools,
            &skills,
            &mcp_servers,
            &worktrees,
            &scheduled_tasks,
        );

        let first = encode_project_status(&inputs, &signer).expect("first encode");
        let second = encode_project_status(&inputs, &signer).expect("second encode");

        assert_eq!(first, second);
    }

    #[test]
    fn rejects_invalid_project_tag() {
        let signer = test_signer();
        let owner = pubkey_hex(0x02);
        let project_tag = vec!["e".to_string(), "not-a-project-ref".to_string()];
        let whitelisted: Vec<String> = Vec::new();
        let agents: Vec<ProjectStatusAgent> = Vec::new();
        let models: Vec<ProjectStatusModel> = Vec::new();
        let tools: Vec<ProjectStatusTool> = Vec::new();
        let skills: Vec<ProjectStatusSkill> = Vec::new();
        let mcp_servers: Vec<ProjectStatusMcpServer> = Vec::new();
        let worktrees: Vec<String> = Vec::new();
        let scheduled_tasks: Vec<ProjectStatusScheduledTask> = Vec::new();
        let inputs = default_inputs(
            &project_tag,
            &owner,
            &whitelisted,
            None,
            &agents,
            &models,
            &tools,
            &skills,
            &mcp_servers,
            &worktrees,
            &scheduled_tasks,
        );

        let err = encode_project_status(&inputs, &signer).expect_err("must reject project tag");
        assert!(matches!(err, ProjectStatusEncodeError::InvalidProjectTag));
    }

    #[test]
    fn rejects_invalid_owner_whitelist_manager_and_agent_pubkeys() {
        let signer = test_signer();
        let owner = pubkey_hex(0x02);
        let project_tag = project_tag(&owner);
        let valid_whitelist = vec![pubkey_hex(0x03)];
        let empty: Vec<String> = Vec::new();
        let agents: Vec<ProjectStatusAgent> = Vec::new();
        let models: Vec<ProjectStatusModel> = Vec::new();
        let tools: Vec<ProjectStatusTool> = Vec::new();
        let skills: Vec<ProjectStatusSkill> = Vec::new();
        let mcp_servers: Vec<ProjectStatusMcpServer> = Vec::new();
        let scheduled_tasks: Vec<ProjectStatusScheduledTask> = Vec::new();

        let invalid_owner_inputs = default_inputs(
            &project_tag,
            "not-a-pubkey",
            &valid_whitelist,
            None,
            &agents,
            &models,
            &tools,
            &skills,
            &mcp_servers,
            &empty,
            &scheduled_tasks,
        );
        assert!(matches!(
            encode_project_status(&invalid_owner_inputs, &signer),
            Err(ProjectStatusEncodeError::InvalidProjectOwnerPubkey { .. })
        ));

        let invalid_whitelist = vec!["not-a-pubkey".to_string()];
        let invalid_whitelist_inputs = default_inputs(
            &project_tag,
            &owner,
            &invalid_whitelist,
            None,
            &agents,
            &models,
            &tools,
            &skills,
            &mcp_servers,
            &empty,
            &scheduled_tasks,
        );
        assert!(matches!(
            encode_project_status(&invalid_whitelist_inputs, &signer),
            Err(ProjectStatusEncodeError::InvalidWhitelistedPubkey { index: 0, .. })
        ));

        let invalid_manager_inputs = default_inputs(
            &project_tag,
            &owner,
            &valid_whitelist,
            Some("not-a-pubkey"),
            &agents,
            &models,
            &tools,
            &skills,
            &mcp_servers,
            &empty,
            &scheduled_tasks,
        );
        assert!(matches!(
            encode_project_status(&invalid_manager_inputs, &signer),
            Err(ProjectStatusEncodeError::InvalidProjectManagerPubkey { .. })
        ));

        let invalid_agents = vec![ProjectStatusAgent {
            pubkey: "not-a-pubkey".to_string(),
            slug: "worker".to_string(),
        }];
        let invalid_agent_inputs = default_inputs(
            &project_tag,
            &owner,
            &valid_whitelist,
            None,
            &invalid_agents,
            &models,
            &tools,
            &skills,
            &mcp_servers,
            &empty,
            &scheduled_tasks,
        );
        assert!(matches!(
            encode_project_status(&invalid_agent_inputs, &signer),
            Err(ProjectStatusEncodeError::InvalidAgentPubkey { index: 0, .. })
        ));
    }

    #[test]
    fn rejects_empty_required_status_fields() {
        let signer = test_signer();
        let owner = pubkey_hex(0x02);
        let project_tag = project_tag(&owner);
        let empty: Vec<String> = Vec::new();
        let whitelisted: Vec<String> = Vec::new();
        let agents = vec![ProjectStatusAgent {
            pubkey: pubkey_hex(0x03),
            slug: String::new(),
        }];
        let models: Vec<ProjectStatusModel> = Vec::new();
        let tools: Vec<ProjectStatusTool> = Vec::new();
        let skills: Vec<ProjectStatusSkill> = Vec::new();
        let mcp_servers: Vec<ProjectStatusMcpServer> = Vec::new();
        let scheduled_tasks: Vec<ProjectStatusScheduledTask> = Vec::new();

        let empty_agent_slug_inputs = default_inputs(
            &project_tag,
            &owner,
            &whitelisted,
            None,
            &agents,
            &models,
            &tools,
            &skills,
            &mcp_servers,
            &empty,
            &scheduled_tasks,
        );
        assert!(matches!(
            encode_project_status(&empty_agent_slug_inputs, &signer),
            Err(ProjectStatusEncodeError::EmptyAgentSlug { index: 0 })
        ));

        let agents: Vec<ProjectStatusAgent> = Vec::new();
        let models = vec![ProjectStatusModel {
            slug: String::new(),
            agents: Vec::new(),
        }];
        let empty_model_slug_inputs = default_inputs(
            &project_tag,
            &owner,
            &whitelisted,
            None,
            &agents,
            &models,
            &tools,
            &skills,
            &mcp_servers,
            &empty,
            &scheduled_tasks,
        );
        assert!(matches!(
            encode_project_status(&empty_model_slug_inputs, &signer),
            Err(ProjectStatusEncodeError::EmptyModelSlug { index: 0 })
        ));

        let models: Vec<ProjectStatusModel> = Vec::new();
        let scheduled_tasks = vec![ProjectStatusScheduledTask {
            id: "task".to_string(),
            title: "title".to_string(),
            schedule: String::new(),
            target_agent: "worker".to_string(),
            kind: ProjectStatusScheduledTaskKind::Cron,
            last_run: None,
        }];
        let empty_schedule_inputs = default_inputs(
            &project_tag,
            &owner,
            &whitelisted,
            None,
            &agents,
            &models,
            &tools,
            &skills,
            &mcp_servers,
            &empty,
            &scheduled_tasks,
        );
        assert!(matches!(
            encode_project_status(&empty_schedule_inputs, &signer),
            Err(ProjectStatusEncodeError::EmptyScheduledTaskSchedule { index: 0 })
        ));
    }
}
