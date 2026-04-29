use crate::emit::EmitState;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_project::{Agent, Team};
use tenex_protocol::{
    DelegationIntent, DelegationRequest, Intent, MessageRef, PrincipalKind, PrincipalRef,
};

#[derive(Debug, Deserialize, Serialize)]
pub struct DelegateFollowupArgs {
    pub recipient: String,
    pub delegation_event_id: String,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct DelegateFollowupError(String);

#[derive(Clone)]
pub struct DelegateFollowupTool {
    state: Arc<EmitState>,
    project_agents: Arc<Vec<Agent>>,
    teams: Arc<Vec<Team>>,
}

impl DelegateFollowupTool {
    pub fn new(
        state: Arc<EmitState>,
        project_agents: Arc<Vec<Agent>>,
        teams: Arc<Vec<Team>>,
    ) -> Self {
        Self {
            state,
            project_agents,
            teams,
        }
    }

    fn resolve_recipient(&self, recipient: &str) -> Option<String> {
        if let Some(agent) = self.project_agents.iter().find(|a| a.slug == recipient) {
            return Some(agent.pubkey.clone());
        }
        let team = self
            .teams
            .iter()
            .find(|t| t.name.eq_ignore_ascii_case(recipient))?;
        let agent = self
            .project_agents
            .iter()
            .find(|a| a.slug == team.team_lead)?;
        Some(agent.pubkey.clone())
    }
}

impl Tool for DelegateFollowupTool {
    const NAME: &'static str = "delegate_followup";
    type Error = DelegateFollowupError;
    type Args = DelegateFollowupArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Send a followup message to an agent you previously delegated to, referencing the original delegation event. Use for corrections, clarifications, or additional context after an initial delegate call. The original delegation event ID is returned by the delegate tool.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "recipient": {
                        "type": "string",
                        "description": "Agent slug — same as in the original delegate call"
                    },
                    "delegation_event_id": {
                        "type": "string",
                        "description": "Nostr event ID of the original delegation event (hex format)"
                    },
                    "message": {
                        "type": "string",
                        "description": "Additional instructions, corrections, or context"
                    }
                },
                "required": ["recipient", "delegation_event_id", "message"]
            }),
        }
    }

    async fn call(&self, args: DelegateFollowupArgs) -> Result<String, DelegateFollowupError> {
        let pubkey_hex = self.resolve_recipient(&args.recipient).ok_or_else(|| {
            let slugs: Vec<&str> = self
                .project_agents
                .iter()
                .map(|a| a.slug.as_str())
                .collect();
            DelegateFollowupError(format!(
                "no agent or team '{}'. Available: {}",
                args.recipient,
                slugs.join(", ")
            ))
        })?;

        let pubkey = nostr::PublicKey::from_hex(&pubkey_hex)
            .map_err(|e| DelegateFollowupError(format!("invalid pubkey: {e}")))?;

        let event_id = nostr::EventId::from_hex(&args.delegation_event_id)
            .map_err(|e| DelegateFollowupError(format!("invalid delegation event ID: {e}")))?;

        let recipient = PrincipalRef::Nostr {
            pubkey,
            kind: PrincipalKind::Agent,
            display_name: None,
        };

        let ral = self.state.meta.lock().unwrap().ral;
        let ctx = self.state.build_ctx(ral);

        let intent = DelegationIntent {
            items: vec![DelegationRequest {
                recipient,
                recipient_label: format!("@{}", args.recipient),
                request: args.message.clone(),
                branch: None,
                followup_of: Some(MessageRef::Nostr { event_id }),
            }],
        };

        self.state
            .channel
            .send(Intent::Delegation(intent), &ctx)
            .await
            .map_err(|e| DelegateFollowupError(format!("failed to emit followup: {e}")))?;

        let short_id = &args.delegation_event_id[..args.delegation_event_id.len().min(8)];
        Ok(format!(
            "Followup sent to @{} referencing delegation {}.",
            args.recipient, short_id
        ))
    }
}
