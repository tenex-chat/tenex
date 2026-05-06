use crate::emit::EmitState;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tenex_project::{resolve_recipient, Agent, RecipientResolution, Team};
use tenex_protocol::{
    DelegationIntent, DelegationRequest, Intent, MessageRef, PrincipalKind, PrincipalRef,
    ToolUseIntent,
};

#[derive(Debug, Deserialize, Serialize)]
pub struct DelegateArgs {
    pub recipient: String,
    pub prompt: String,
    pub branch: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct DelegateError(String);

enum ResolveOutcome {
    Agent(String, bool, Option<String>),
    Ambiguous(Vec<String>),
    NotFound,
}

#[derive(Clone)]
pub struct DelegateTool {
    state: Arc<EmitState>,
    project_agents: Arc<Vec<Agent>>,
    teams: Arc<Vec<Team>>,
    project_root: PathBuf,
}

impl DelegateTool {
    pub fn new(
        state: Arc<EmitState>,
        project_agents: Arc<Vec<Agent>>,
        teams: Arc<Vec<Team>>,
        project_root: PathBuf,
    ) -> Self {
        Self {
            state,
            project_agents,
            teams,
            project_root,
        }
    }

    /// Resolve a recipient string to (agent_pubkey, agent_is_local, resolved_team_name).
    /// Delegates agent matching to the shared [`resolve_recipient`]; falls back
    /// to team-name → team-lead lookup when the input matches no agent.
    fn resolve(&self, recipient: &str) -> ResolveOutcome {
        match resolve_recipient(&self.project_agents, recipient) {
            RecipientResolution::Resolved(agent) => {
                ResolveOutcome::Agent(agent.pubkey.clone(), agent.is_local, None)
            }
            RecipientResolution::Ambiguous(candidates) => ResolveOutcome::Ambiguous(
                candidates
                    .into_iter()
                    .map(|a| format!("{} ({})", a.slug, &a.pubkey[..8.min(a.pubkey.len())]))
                    .collect(),
            ),
            RecipientResolution::NotFound => {
                let Some(team) = self
                    .teams
                    .iter()
                    .find(|t| t.name.eq_ignore_ascii_case(recipient))
                else {
                    return ResolveOutcome::NotFound;
                };
                let Some(agent) = self
                    .project_agents
                    .iter()
                    .find(|a| a.slug == team.team_lead)
                else {
                    return ResolveOutcome::NotFound;
                };
                ResolveOutcome::Agent(agent.pubkey.clone(), agent.is_local, Some(team.name.clone()))
            }
        }
    }

    /// Pre-flight a remote delegation that names a branch: ensure the branch's
    /// worktree is clean, push it to `origin`, and return the commit hash to
    /// pin on the kind:1 event so the receiver can sync to the same state.
    ///
    /// Returns a user-facing error message when the worktree is dirty or the
    /// branch is missing locally — both block the delegation.
    fn prepare_remote_branch(&self, branch: &str) -> Result<String, String> {
        let commit = tenex_project::branch_head_commit(&self.project_root, branch)
            .map_err(|e| format!("branch '{branch}' not found locally: {e}"))?;

        let worktree_path = tenex_project::list_worktrees(&self.project_root)
            .map_err(|e| format!("failed to list worktrees: {e}"))?
            .into_iter()
            .find(|w| w.branch.as_deref() == Some(branch))
            .map(|w| w.path)
            .unwrap_or_else(|| self.project_root.clone());

        let clean = tenex_project::is_worktree_clean(&worktree_path)
            .map_err(|e| format!("failed to check worktree status: {e}"))?;
        if !clean {
            return Err(format!(
                "branch '{branch}' has uncommitted changes at {}; commit before delegating to a remote agent",
                worktree_path.display()
            ));
        }

        tenex_project::push_branch_to_origin(&self.project_root, branch)
            .map_err(|e| format!("failed to push branch '{branch}' to origin: {e}"))?;

        Ok(commit)
    }
}

impl Tool for DelegateTool {
    const NAME: &'static str = "delegate";
    type Error = DelegateError;
    type Args = DelegateArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Delegate a task to another agent by slug, or to a whole team by team name. The agent (or team lead) receives your message and will reply when done. Optionally specify a branch to have the agent work in a dedicated git worktree. Stop after delegating — do not take further actions this turn.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "recipient": {
                        "type": "string",
                        "description": "Agent slug (e.g. 'architect') or team name (e.g. 'design')"
                    },
                    "prompt": {
                        "type": "string",
                        "description": "The task and full context for the delegated agent"
                    },
                    "branch": {
                        "type": "string",
                        "description": "Optional git branch name. When provided, a worktree is created at .worktrees/<branch> and the agent works there."
                    }
                },
                "required": ["recipient", "prompt"]
            }),
        }
    }

    async fn call(&self, args: DelegateArgs) -> Result<String, DelegateError> {
        let (pubkey_hex, recipient_is_local, resolved_team) = match self.resolve(&args.recipient) {
            ResolveOutcome::Agent(pk, is_local, team) => (pk, is_local, team),
            ResolveOutcome::Ambiguous(candidates) => {
                return Ok(format!(
                    "Error: '{}' matches multiple agents: {}. Use a longer pubkey prefix or the agent slug.",
                    args.recipient,
                    candidates.join(", ")
                ));
            }
            ResolveOutcome::NotFound => {
                let agents = self
                    .project_agents
                    .iter()
                    .map(|a| {
                        if a.slug == a.name {
                            a.slug.clone()
                        } else {
                            format!("{} ({})", a.slug, a.name)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                let team_names = self
                    .teams
                    .iter()
                    .map(|t| t.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                return Ok(format!(
                    "Error: no agent or team found with name '{}'. Agents: {}. Teams: {}.",
                    args.recipient, agents, team_names
                ));
            }
        };

        let pubkey = nostr::PublicKey::from_hex(&pubkey_hex)
            .map_err(|e| DelegateError(format!("invalid recipient pubkey: {e}")))?;

        let recipient = PrincipalRef::Nostr {
            pubkey,
            kind: PrincipalKind::Agent,
            display_name: None,
        };

        // Cross-host coordination: when delegating to a remote agent on a
        // specific branch, push the branch and pin the commit so the receiver
        // can fetch + sync to exactly the state we're handing off.
        let commit = match (recipient_is_local, args.branch.as_deref()) {
            (false, Some(branch)) => match self.prepare_remote_branch(branch) {
                Ok(commit) => Some(commit),
                Err(msg) => return Ok(format!("Error: {msg}")),
            },
            _ => None,
        };

        let ral = self.state.meta.lock().unwrap().ral;
        let ctx = self.state.build_ctx_with_team(ral, resolved_team);

        let delegation_intent = DelegationIntent {
            items: vec![DelegationRequest {
                recipient: recipient.clone(),
                recipient_label: format!("@{}", args.recipient),
                request: args.prompt.clone(),
                branch: args.branch.clone(),
                commit,
                followup_of: None,
                extra_tags: Vec::new(),
            }],
        };

        let refs = self
            .state
            .channel
            .send(Intent::Delegation(delegation_intent), &ctx)
            .await
            .map_err(|e| DelegateError(format!("Failed to emit delegation: {e}")))?;
        self.state.mark_pending_external_work();
        let delegation_ref = refs
            .into_iter()
            .next()
            .ok_or_else(|| DelegateError("delegation produced no event".into()))?;

        let delegation_event_id = match &delegation_ref {
            MessageRef::Nostr { event_id } => event_id.to_hex(),
        };

        let span = tracing::Span::current();
        span.record("delegated.conversation.id", delegation_event_id.as_str());
        span.record("delegated.agent.pubkey", pubkey_hex.as_str());
        span.record("delegated.event.id", delegation_event_id.as_str());

        let args_json = serde_json::to_string(&args).unwrap_or_default();
        let tool_use_intent = ToolUseIntent {
            tool_name: "delegate".to_string(),
            content: String::new(),
            args_json: Some(args_json),
            referenced_messages: vec![delegation_ref],
            usage: None,
            extra_tags: Vec::new(),
        };

        self.state
            .channel
            .send(Intent::ToolUse(tool_use_intent), &ctx)
            .await
            .map_err(|e| DelegateError(format!("Failed to emit tool-use event: {e}")))?;

        Ok(format!(
            "Delegated to @{}. Delegation event ID: {}. Use this ID with delegate_followup if you need to send corrections before they finish. Stop here — do not take further actions this turn.",
            args.recipient, delegation_event_id
        ))
    }
}
