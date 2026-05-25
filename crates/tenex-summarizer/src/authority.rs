//! Resolve which agents may publish or be accepted for kind:513 metadata.

use std::collections::HashSet;
use std::path::Path;

use anyhow::{Context, Result};
use tenex_project::Signer;

use crate::source;

pub struct ConversationPublisher {
    pub signer: Box<dyn Signer>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectAuthority {
    pub authorized_pubkeys: HashSet<String>,
    pub local_pubkeys: HashSet<String>,
}

pub fn project_authority(d_tag: &str, base_dir: &Path) -> Result<Option<ProjectAuthority>> {
    let project = tenex_project::Project::open(d_tag, base_dir)
        .with_context(|| format!("open project {d_tag}"))?;
    let agents = project
        .project_agents()
        .with_context(|| format!("read project agents for {d_tag}"))?;
    if agents.is_empty() {
        return Ok(None);
    }

    let mut authorized_pubkeys = HashSet::with_capacity(agents.len());
    let mut local_pubkeys = HashSet::new();
    for agent in agents {
        authorized_pubkeys.insert(agent.agent_pubkey.clone());
        if project
            .agent_by_pubkey(&agent.agent_pubkey)
            .with_context(|| format!("read agent {} for {d_tag}", agent.agent_pubkey))?
            .map(|a| a.is_local)
            .unwrap_or(false)
        {
            local_pubkeys.insert(agent.agent_pubkey);
        }
    }

    Ok(Some(ProjectAuthority {
        authorized_pubkeys,
        local_pubkeys,
    }))
}

pub fn conversation_publisher(
    project_ref: &tenex_conversations::ProjectRef,
    conversation_id: &str,
    base_dir: &Path,
) -> Result<Option<ConversationPublisher>> {
    let project = tenex_project::Project::open(&project_ref.d_tag, base_dir)
        .with_context(|| format!("open project {}", project_ref.d_tag))?;
    let agents = project
        .project_agents()
        .with_context(|| format!("read project agents for {}", project_ref.d_tag))?;
    let member_pubkeys: HashSet<String> = agents.into_iter().map(|a| a.agent_pubkey).collect();
    if member_pubkeys.is_empty() {
        return Ok(None);
    }

    let targets = source::root_targeted_pubkeys(project_ref, conversation_id)?;
    let Some(target_pubkey) = targets.into_iter().find(|pk| member_pubkeys.contains(pk)) else {
        return Ok(None);
    };

    let Some(agent) = project
        .agent_by_pubkey(&target_pubkey)
        .with_context(|| format!("read OP-targeted agent {target_pubkey}"))?
    else {
        return Ok(None);
    };
    if !agent.is_local {
        return Ok(None);
    }

    let signer = match project.signer_for_agent(&target_pubkey)? {
        Ok(signer) => signer,
        Err(e) => {
            return Err(anyhow::anyhow!(
                "OP-targeted agent {target_pubkey} for {} has signer_ref but signer_for_agent failed: {e}",
                project_ref.d_tag
            ));
        }
    };
    Ok(Some(ConversationPublisher { signer }))
}
