use crate::emit::EmitState;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_protocol::{
    DelegationIntent, DelegationRequest, Intent, MessageRef, PrincipalKind, PrincipalRef,
    ToolUseIntent,
};

#[derive(Debug, Deserialize, Serialize)]
pub struct SelfDelegateArgs {
    pub request: String,
    pub branch: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SelfDelegateError(String);

#[derive(Clone)]
pub struct SelfDelegateTool {
    state: Arc<EmitState>,
}

impl SelfDelegateTool {
    pub fn new(state: Arc<EmitState>) -> Self {
        Self { state }
    }
}

impl Tool for SelfDelegateTool {
    const NAME: &'static str = "self_delegate";
    type Error = SelfDelegateError;
    type Args = SelfDelegateArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Schedule follow-on work for yourself as a new top-level task. Use when you need to continue work after the current turn ends, or to defer a task to a future invocation. The request is sent to your own pubkey as a fresh delegation.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "request": {
                        "type": "string",
                        "description": "The follow-on task to execute in the next invocation"
                    },
                    "branch": {
                        "type": "string",
                        "description": "Optional git branch context to pass along"
                    }
                },
                "required": ["request"]
            }),
        }
    }

    async fn call(&self, args: SelfDelegateArgs) -> Result<String, SelfDelegateError> {
        let PrincipalRef::Nostr { pubkey, .. } = self.state.channel.identity().clone();
        let pubkey_hex = pubkey.to_hex();

        let ral = self.state.meta.lock().unwrap().ral;
        let ctx = self.state.build_ctx(ral);

        let recipient = PrincipalRef::Nostr {
            pubkey,
            kind: PrincipalKind::Agent,
            display_name: None,
        };

        let intent = DelegationIntent {
            items: vec![DelegationRequest {
                recipient,
                recipient_label: "@self".to_string(),
                request: args.request.clone(),
                branch: args.branch.clone(),
                followup_of: None,
                extra_tags: Vec::new(),
            }],
        };

        let refs = self
            .state
            .channel
            .send(Intent::Delegation(intent), &ctx)
            .await
            .map_err(|e| SelfDelegateError(format!("failed to emit self-delegation: {e}")))?;
        self.state.mark_pending_external_work();

        let delegation_ref = refs
            .into_iter()
            .next()
            .ok_or_else(|| SelfDelegateError("self-delegation produced no event".into()))?;
        let delegation_event_id = match &delegation_ref {
            MessageRef::Nostr { event_id } => event_id.to_hex(),
        };

        let span = tracing::Span::current();
        span.record("delegated.conversation.id", delegation_event_id.as_str());
        span.record("delegated.agent.pubkey", pubkey_hex.as_str());
        span.record("delegated.event.id", delegation_event_id.as_str());

        let args_json = serde_json::to_string(&args).unwrap_or_default();
        let tool_use_intent = ToolUseIntent {
            tool_name: Self::NAME.to_string(),
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
            .map_err(|e| SelfDelegateError(format!("failed to emit tool-use event: {e}")))?;

        Ok(format!(
            "Self-delegation queued. Delegation event ID: {delegation_event_id}. Stop here — do not take further actions this turn."
        ))
    }
}
