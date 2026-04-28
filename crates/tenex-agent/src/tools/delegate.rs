use crate::emit::EmitState;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_project::{Agent, Team};
use tenex_protocol::{
    DelegationIntent, DelegationRequest, Intent, MessageRef, PrincipalKind, PrincipalRef,
    ToolUseIntent,
};

#[derive(Debug, Deserialize, Serialize)]
pub struct DelegateArgs {
    pub recipient: String,
    pub prompt: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct DelegateError(String);

#[derive(Clone)]
pub struct DelegateTool {
    state: Arc<EmitState>,
    project_agents: Arc<Vec<Agent>>,
    teams: Arc<Vec<Team>>,
}

impl DelegateTool {
    pub fn new(
        state: Arc<EmitState>,
        project_agents: Arc<Vec<Agent>>,
        teams: Arc<Vec<Team>>,
    ) -> Self {
        Self { state, project_agents, teams }
    }

    /// Resolve a recipient string to (pubkey_hex, resolved_team_name).
    /// Tries agent slug first; falls back to team name → team lead → pubkey.
    fn resolve_recipient(&self, recipient: &str) -> Option<(String, Option<String>)> {
        if let Some(agent) = self.project_agents.iter().find(|a| a.slug == recipient) {
            return Some((agent.pubkey.clone(), None));
        }
        let team = self
            .teams
            .iter()
            .find(|t| t.name.eq_ignore_ascii_case(recipient))?;
        let agent = self
            .project_agents
            .iter()
            .find(|a| a.slug == team.team_lead)?;
        Some((agent.pubkey.clone(), Some(team.name.clone())))
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
            description: "Delegate a task to another agent by slug, or to a whole team by team name. The agent (or team lead) receives your message and will reply when done. Stop after delegating — do not take further actions this turn.".to_string(),
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
                    }
                },
                "required": ["recipient", "prompt"]
            }),
        }
    }

    async fn call(&self, args: DelegateArgs) -> Result<String, DelegateError> {
        let (pubkey_hex, resolved_team) = match self.resolve_recipient(&args.recipient) {
            Some(r) => r,
            None => {
                let agent_slugs = self
                    .project_agents
                    .iter()
                    .map(|a| a.slug.as_str())
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
                    args.recipient, agent_slugs, team_names
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

        let ral = self.state.meta.lock().unwrap().ral;
        let ctx = self.state.build_ctx_with_team(ral, resolved_team);

        let delegation_intent = DelegationIntent {
            items: vec![DelegationRequest {
                recipient: recipient.clone(),
                recipient_label: format!("@{}", args.recipient),
                request: args.prompt.clone(),
                branch: None,
            }],
        };

        let refs = self
            .state
            .channel
            .send(Intent::Delegation(delegation_intent), &ctx)
            .await
            .map_err(|e| DelegateError(format!("Failed to emit delegation: {e}")))?;
        let delegation_ref = refs
            .into_iter()
            .next()
            .ok_or_else(|| DelegateError("delegation produced no event".into()))?;

        let args_json = serde_json::to_string(&args).unwrap_or_default();
        let tool_use_intent = ToolUseIntent {
            tool_name: "delegate".to_string(),
            content: String::new(),
            args_json: Some(args_json),
            referenced_messages: vec![match delegation_ref {
                MessageRef::Nostr { event_id } => MessageRef::Nostr { event_id },
            }],
            usage: None,
        };

        self.state
            .channel
            .send(Intent::ToolUse(tool_use_intent), &ctx)
            .await
            .map_err(|e| DelegateError(format!("Failed to emit tool-use event: {e}")))?;

        Ok(format!(
            "Delegated to @{}. Stop here — do not take further actions this turn.",
            args.recipient
        ))
    }
}
