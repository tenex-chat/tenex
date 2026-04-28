use crate::emit::EmitState;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_project::Agent;
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
}

impl DelegateTool {
    pub fn new(state: Arc<EmitState>, project_agents: Arc<Vec<Agent>>) -> Self {
        Self { state, project_agents }
    }

    fn lookup_pubkey(&self, slug: &str) -> Option<String> {
        self.project_agents
            .iter()
            .find(|a| a.slug == slug)
            .map(|a| a.pubkey.clone())
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
            description: "Delegate a task to another agent by slug. The agent receives your message and will reply when done. Stop after delegating — do not take further actions this turn.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "recipient": {
                        "type": "string",
                        "description": "Agent slug (e.g. 'architect', 'code-reviewer')"
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
        let pubkey_hex = match self.lookup_pubkey(&args.recipient) {
            Some(p) => p,
            None => {
                return Ok(format!(
                    "Error: no agent found with slug '{}'. Available agents: {}",
                    args.recipient,
                    self.project_agents
                        .iter()
                        .map(|a| a.slug.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
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
        let ctx = self.state.build_ctx(ral);

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
