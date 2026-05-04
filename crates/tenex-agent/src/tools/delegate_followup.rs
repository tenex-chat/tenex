use crate::emit::EmitState;
use crate::tools::delegate_followup_resolution::{resolve_delegation, StoredDelegationRoute};
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use tenex_project::{Agent, Team};
use tenex_protocol::{
    DelegationIntent, DelegationRequest, Intent, MessageRef, PrincipalKind, PrincipalRef,
    ToolUseIntent,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DelegateFollowupArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,
    #[serde(alias = "delegation_event_id")]
    pub delegation_conversation_id: String,
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
    conv_db_path: PathBuf,
}

impl DelegateFollowupTool {
    pub fn new(
        state: Arc<EmitState>,
        project_agents: Arc<Vec<Agent>>,
        teams: Arc<Vec<Team>>,
        conv_db_path: PathBuf,
    ) -> Self {
        Self {
            state,
            project_agents,
            teams,
            conv_db_path,
        }
    }

    fn resolve_named_recipient(&self, recipient: &str) -> Option<String> {
        if let Some(agent) = self.project_agents.iter().find(|a| a.slug == recipient) {
            return Some(agent.pubkey.clone());
        }
        if nostr::PublicKey::from_hex(recipient).is_ok() {
            return Some(recipient.to_string());
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

    fn label_for_pubkey(&self, pubkey: &str) -> String {
        self.project_agents
            .iter()
            .find(|agent| agent.pubkey == pubkey)
            .map(|agent| format!("@{}", agent.slug))
            .unwrap_or_else(|| format!("@{}", &pubkey[..pubkey.len().min(8)]))
    }

    fn resolve_recipient(
        &self,
        requested: Option<&str>,
        route: Option<&StoredDelegationRoute>,
    ) -> Result<(PrincipalRef, String), DelegateFollowupError> {
        let (pubkey_hex, label) = match requested {
            Some(recipient) => {
                let pubkey = self.resolve_named_recipient(recipient).ok_or_else(|| {
                    let slugs: Vec<&str> = self
                        .project_agents
                        .iter()
                        .map(|a| a.slug.as_str())
                        .collect();
                    DelegateFollowupError(format!(
                        "no agent or team '{}'. Available: {}",
                        recipient,
                        slugs.join(", ")
                    ))
                })?;
                (pubkey, format!("@{recipient}"))
            }
            None => {
                let Some(route) = route else {
                    return Err(DelegateFollowupError(
                        "recipient is required when the delegation is not in local conversation state"
                            .to_string(),
                    ));
                };
                (
                    route.child_agent_pubkey.clone(),
                    self.label_for_pubkey(&route.child_agent_pubkey),
                )
            }
        };

        if let Some(route) = route {
            if pubkey_hex != route.child_agent_pubkey {
                return Err(DelegateFollowupError(format!(
                    "recipient does not match original delegated agent {}",
                    self.label_for_pubkey(&route.child_agent_pubkey)
                )));
            }
        }

        let pubkey = nostr::PublicKey::from_hex(&pubkey_hex)
            .map_err(|e| DelegateFollowupError(format!("invalid pubkey: {e}")))?;
        Ok((
            PrincipalRef::Nostr {
                pubkey,
                kind: PrincipalKind::Agent,
                display_name: None,
            },
            label,
        ))
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
                        "description": "Optional agent slug or pubkey. If omitted, TENEX resolves the original delegatee from the delegation conversation."
                    },
                    "delegation_conversation_id": {
                        "type": "string",
                        "description": "Original delegation conversation event ID, or a unique 10-character prefix. Previous followup event IDs are canonicalized to the original delegation."
                    },
                    "message": {
                        "type": "string",
                        "description": "Additional instructions, corrections, or context"
                    }
                },
                "required": ["delegation_conversation_id", "message"]
            }),
        }
    }

    async fn call(&self, args: DelegateFollowupArgs) -> Result<String, DelegateFollowupError> {
        let resolved = resolve_delegation(&self.conv_db_path, &args.delegation_conversation_id)
            .map_err(DelegateFollowupError)?;
        let canonical_id = resolved.canonical_id;
        let route = resolved.route;
        if let Some(route) = route.as_ref() {
            if route.child_conversation_id != canonical_id {
                return Err(DelegateFollowupError(
                    "stored delegation route does not match canonical conversation".to_string(),
                ));
            }
        }
        let event_id = nostr::EventId::from_hex(&canonical_id)
            .map_err(|e| DelegateFollowupError(format!("invalid delegation event ID: {e}")))?;
        let (recipient, recipient_label) =
            self.resolve_recipient(args.recipient.as_deref(), route.as_ref())?;

        let ral = self.state.meta.lock().unwrap().ral;
        let ctx = self.state.build_ctx(ral);

        let intent = DelegationIntent {
            items: vec![DelegationRequest {
                recipient,
                recipient_label: recipient_label.clone(),
                request: args.message.clone(),
                branch: None,
                followup_of: Some(MessageRef::Nostr { event_id }),
                extra_tags: Vec::new(),
            }],
        };

        let refs = self
            .state
            .channel
            .send(Intent::Delegation(intent), &ctx)
            .await
            .map_err(|e| DelegateFollowupError(format!("failed to emit followup: {e}")))?;
        self.state.mark_pending_external_work();
        let followup_ref = refs
            .into_iter()
            .next()
            .ok_or_else(|| DelegateFollowupError("followup produced no event".into()))?;

        let tool_use_intent = ToolUseIntent {
            tool_name: "delegate_followup".to_string(),
            content: String::new(),
            args_json: Some(serde_json::to_string(&args).unwrap_or_default()),
            referenced_messages: vec![followup_ref.clone()],
            usage: None,
            extra_tags: Vec::new(),
        };
        self.state
            .channel
            .send(Intent::ToolUse(tool_use_intent), &ctx)
            .await
            .map_err(|e| DelegateFollowupError(format!("failed to emit tool-use event: {e}")))?;

        let followup_event_id = match followup_ref {
            MessageRef::Nostr { event_id } => event_id.to_hex(),
        };

        let short_id = &canonical_id[..canonical_id.len().min(8)];
        Ok(format!(
            "Followup sent to {} referencing delegation {}. Followup event ID: {}.",
            recipient_label, short_id, followup_event_id
        ))
    }
}
