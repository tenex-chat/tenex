use crate::emit::EmitState;
use rig_core::{completion::ToolDefinition, tool::Tool};
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
    pub variant: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SelfDelegateError(String);

#[derive(Clone)]
pub struct SelfDelegateTool {
    state: Arc<EmitState>,
    conv_db_path: std::path::PathBuf,
}

impl SelfDelegateTool {
    pub fn new(state: Arc<EmitState>, conv_db_path: std::path::PathBuf) -> Self {
        Self { state, conv_db_path }
    }

    fn parent_conversation_id(&self) -> Option<String> {
        match self.state.conversation_root.as_ref()? {
            tenex_protocol::ConversationRef::Nostr { root_event_id } => {
                Some(root_event_id.to_hex())
            }
        }
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
                    },
                    "variant": {
                        "type": "string",
                        "description": "Optional model variant name (e.g. 'fast', 'powerful'). Only available when the agent uses a meta model configuration with multiple variants."
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
        // Delayed-emit batch: `self_delegate` is listed in
        // `EmitHook::on_tool_call` as `emits_delayed_tool_use`, so the
        // hook intentionally skips both the generic ToolUse event and
        // the `take_runtime_delta()` call for this tool. We are
        // therefore responsible for consuming the delta here: the
        // primary Delegation event carries it, and the trailing ToolUse
        // record (below) leaves `llm_runtime_ms` unset to avoid
        // double-counting.
        let mut delegation_ctx = self.state.build_ctx(ral);
        delegation_ctx.llm_runtime_ms = self.state.take_runtime_delta();

        let recipient = PrincipalRef::Nostr {
            pubkey,
            kind: PrincipalKind::Agent,
            display_name: None,
        };

        let extra_tags = match &args.variant {
            Some(variant) => vec![vec!["variant".to_string(), variant.clone()]],
            None => Vec::new(),
        };

        let intent = DelegationIntent {
            items: vec![DelegationRequest {
                recipient,
                recipient_label: "@self".to_string(),
                request: args.request.clone(),
                branch: args.branch.clone(),
                commit: None,
                followup_of: None,
                extra_tags,
            }],
        };

        let refs = self
            .state
            .channel
            .send(Intent::Delegation(intent), &delegation_ctx)
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

        // Same lifecycle as `delegate`: a `Pending` marker now, the
        // runtime upserts `Completed` (or `Aborted`) when the self-spawned
        // child replies. Recipient is the agent's own pubkey because
        // self_delegate creates a new conversation owned by the same
        // pubkey.
        if let Some(parent_conv_id) = self.parent_conversation_id() {
            match tenex_conversations::ConversationStore::open(&self.conv_db_path) {
                Ok(store) => {
                    let initiated_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .ok();
                    let marker = tenex_conversations::DelegationMarker {
                        delegation_conversation_id: delegation_event_id.clone(),
                        recipient_pubkey: pubkey_hex.clone(),
                        parent_conversation_id: parent_conv_id.clone(),
                        initiated_at,
                        completed_at: None,
                        status: tenex_conversations::DelegationStatus::Pending,
                        abort_reason: None,
                    };
                    if let Err(e) = store.add_delegation_marker(
                        &parent_conv_id,
                        &marker,
                        &pubkey_hex,
                        Some(i64::from(ral)),
                    ) {
                        eprintln!(
                            "[self_delegate] failed to write pending DelegationMarker for {delegation_event_id}: {e}"
                        );
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[self_delegate] could not open conversation store at {} to write pending marker: {e}",
                        self.conv_db_path.display()
                    );
                }
            }
        }

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

        let tool_use_ctx = self.state.build_ctx(ral);
        self.state
            .channel
            .send(Intent::ToolUse(tool_use_intent), &tool_use_ctx)
            .await
            .map_err(|e| SelfDelegateError(format!("failed to emit tool-use event: {e}")))?;

        let short_id = tenex_utils::ids::shorten_full_event_id(&delegation_event_id);
        Ok(format!(
            "Self-delegation queued. Delegation event ID: {short_id}. Stop here — do not take further actions this turn."
        ))
    }
}
