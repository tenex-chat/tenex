use crate::emit::EmitState;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_project::Project;
use tenex_protocol::{DelegationIntent, DelegationRequest, Intent, PrincipalKind, PrincipalRef};

#[derive(Debug, Deserialize, Serialize)]
pub struct DelegateCrossProjectArgs {
    pub project_id: String,
    pub recipient: String,
    pub request: String,
    pub branch: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct DelegateCrossProjectError(String);

#[derive(Clone)]
pub struct DelegateCrossProjectTool {
    state: Arc<EmitState>,
}

impl DelegateCrossProjectTool {
    pub fn new(state: Arc<EmitState>) -> Self {
        Self { state }
    }
}

impl Tool for DelegateCrossProjectTool {
    const NAME: &'static str = "delegate_crossproject";
    type Error = DelegateCrossProjectError;
    type Args = DelegateCrossProjectArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Delegate a task to an agent in a different project. Use project_list first to discover available projects and their agent slugs.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "project_id": {
                        "type": "string",
                        "description": "Target project ID (bare dTag or NIP-33 coordinate)"
                    },
                    "recipient": {
                        "type": "string",
                        "description": "Agent slug in the target project"
                    },
                    "request": {
                        "type": "string",
                        "description": "The task and full context for the delegated agent"
                    },
                    "branch": {
                        "type": "string",
                        "description": "Optional git branch context"
                    }
                },
                "required": ["project_id", "recipient", "request"]
            }),
        }
    }

    async fn call(&self, args: DelegateCrossProjectArgs) -> Result<String, DelegateCrossProjectError> {
        let project = Project::open_default(&args.project_id).map_err(|e| {
            DelegateCrossProjectError(format!(
                "failed to open project '{}': {e}",
                args.project_id
            ))
        })?;

        let agents = project.agents().map_err(|e| {
            DelegateCrossProjectError(format!("failed to read agents for '{}': {e}", args.project_id))
        })?;

        let agent = agents.iter().find(|a| a.slug == args.recipient).ok_or_else(|| {
            let slugs: Vec<&str> = agents.iter().map(|a| a.slug.as_str()).collect();
            DelegateCrossProjectError(format!(
                "no agent '{}' in project '{}'. Available: {}",
                args.recipient,
                args.project_id,
                slugs.join(", ")
            ))
        })?;

        let pubkey = nostr::PublicKey::from_hex(&agent.pubkey)
            .map_err(|e| DelegateCrossProjectError(format!("invalid agent pubkey: {e}")))?;

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
                request: args.request.clone(),
                branch: args.branch,
                followup_of: None,
            }],
        };

        self.state
            .channel
            .send(Intent::Delegation(intent), &ctx)
            .await
            .map_err(|e| DelegateCrossProjectError(format!("failed to emit delegation: {e}")))?;

        Ok(format!(
            "Delegated to @{} in project '{}'. Stop here — do not take further actions this turn.",
            args.recipient, args.project_id
        ))
    }
}
