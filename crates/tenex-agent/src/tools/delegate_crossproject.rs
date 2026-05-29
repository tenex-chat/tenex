use crate::emit::EmitState;
use rig_core::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_project::{resolve_recipient, Project, RecipientResolution};
use tenex_protocol::{
    DelegationIntent, DelegationRequest, Intent, MessageRef, PrincipalKind, PrincipalRef,
    ProjectRef, ToolUseIntent,
};

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
    conv_db_path: std::path::PathBuf,
}

impl DelegateCrossProjectTool {
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
                        "description": "Agent in the target project"
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

    async fn call(
        &self,
        args: DelegateCrossProjectArgs,
    ) -> Result<String, DelegateCrossProjectError> {
        let project = Project::open_default(&args.project_id).map_err(|e| {
            DelegateCrossProjectError(format!("failed to open project '{}': {e}", args.project_id))
        })?;

        let metadata = project
            .metadata()
            .map_err(|e| {
                DelegateCrossProjectError(format!(
                    "failed to read metadata for '{}': {e}",
                    args.project_id
                ))
            })?
            .ok_or_else(|| {
                DelegateCrossProjectError(format!(
                    "no project event for '{}' — cannot resolve owner pubkey",
                    args.project_id
                ))
            })?;
        let owner_hex = metadata.owner_pubkey.ok_or_else(|| {
            DelegateCrossProjectError(format!("project '{}' has no owner pubkey", args.project_id))
        })?;
        let owner_pubkey = nostr::PublicKey::from_hex(&owner_hex)
            .map_err(|e| DelegateCrossProjectError(format!("invalid project owner pubkey: {e}")))?;
        let target_project = ProjectRef {
            author: owner_pubkey,
            d_tag: metadata.d_tag,
        };

        let agents = project.agents().map_err(|e| {
            DelegateCrossProjectError(format!(
                "failed to read agents for '{}': {e}",
                args.project_id
            ))
        })?;

        let agent = match resolve_recipient(&agents, &args.recipient) {
            RecipientResolution::Resolved(a) => a,
            RecipientResolution::Ambiguous(candidates) => {
                let labels: Vec<String> = candidates
                    .iter()
                    .map(|a| format!("{} ({})", a.slug, &a.pubkey[..8.min(a.pubkey.len())]))
                    .collect();
                return Err(DelegateCrossProjectError(format!(
                    "'{}' matches multiple agents in '{}': {}. Use a longer pubkey prefix or the agent slug.",
                    args.recipient,
                    args.project_id,
                    labels.join(", ")
                )));
            }
            RecipientResolution::NotFound => {
                let slugs: Vec<&str> = agents.iter().map(|a| a.slug.as_str()).collect();
                return Err(DelegateCrossProjectError(format!(
                    "no agent '{}' in project '{}'. Available: {}",
                    args.recipient,
                    args.project_id,
                    slugs.join(", ")
                )));
            }
        };

        let pubkey = nostr::PublicKey::from_hex(&agent.pubkey)
            .map_err(|e| DelegateCrossProjectError(format!("invalid agent pubkey: {e}")))?;

        let recipient = PrincipalRef::Nostr {
            pubkey,
            kind: PrincipalKind::Agent,
            display_name: None,
        };

        let ral = self.state.meta.lock().unwrap().ral;
        let source_project_addr = self.state.project.coordinate();
        let target_project_addr = target_project.coordinate();
        let extra_tags = if source_project_addr != target_project_addr {
            vec![vec!["a".to_string(), source_project_addr]]
        } else {
            Vec::new()
        };
        // Delayed-emit batch (cross-project): `delegate_crossproject`
        // is listed in `EmitHook::on_tool_call` as
        // `emits_delayed_tool_use`, so the hook skips both the generic
        // ToolUse event and `take_runtime_delta()` for this tool. We
        // are therefore responsible for consuming the delta below. The
        // source-tagged ToolUse record carries the runtime delta
        // because the LLM work happened in the source project's
        // accounting context. The outbound Delegation (target a-tag)
        // leaves `llm_runtime_ms` unset so downstream per-project
        // summing attributes the LLM time to the source project, not
        // the target.
        let target_ctx = self.state.build_ctx_with_project(ral, target_project);

        let intent = DelegationIntent {
            items: vec![DelegationRequest {
                recipient,
                recipient_label: format!("@{}", args.recipient),
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
            .send(Intent::Delegation(intent), &target_ctx)
            .await
            .map_err(|e| DelegateCrossProjectError(format!("failed to emit delegation: {e}")))?;
        self.state.mark_pending_external_work();

        let delegation_ref = refs
            .into_iter()
            .next()
            .ok_or_else(|| DelegateCrossProjectError("delegation produced no event".into()))?;
        let delegation_event_id = match &delegation_ref {
            MessageRef::Nostr { event_id } => event_id.to_hex(),
        };

        // Pending marker lives in the SOURCE project's conversation
        // store — that's where the parent agent runs and where its
        // projection will surface the marker. The cross-project routing
        // happens at the runtime level (target project's runtime sees
        // the event, handles it), but the parent's view of "I have a
        // pending delegation" is local to the source.
        if let Some(parent_conv_id) = self.parent_conversation_id() {
            let agent_pubkey_hex = match self.state.channel.identity() {
                tenex_protocol::PrincipalRef::Nostr { pubkey, .. } => pubkey.to_hex(),
            };
            match tenex_conversations::ConversationStore::open(&self.conv_db_path) {
                Ok(store) => {
                    let initiated_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .ok();
                    let marker = tenex_conversations::DelegationMarker {
                        delegation_conversation_id: delegation_event_id.clone(),
                        recipient_pubkey: agent.pubkey.clone(),
                        parent_conversation_id: parent_conv_id.clone(),
                        initiated_at,
                        completed_at: None,
                        status: tenex_conversations::DelegationStatus::Pending,
                        abort_reason: None,
                    };
                    if let Err(e) = store.add_delegation_marker(
                        &parent_conv_id,
                        &marker,
                        &agent_pubkey_hex,
                        Some(i64::from(ral)),
                    ) {
                        eprintln!(
                            "[delegate_crossproject] failed to write pending DelegationMarker for {delegation_event_id}: {e}"
                        );
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[delegate_crossproject] could not open conversation store at {} to write pending marker: {e}",
                        self.conv_db_path.display()
                    );
                }
            }
        }

        let span = tracing::Span::current();
        span.record("delegated.conversation.id", delegation_event_id.as_str());
        span.record("delegated.agent.pubkey", agent.pubkey.as_str());
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

        let mut source_ctx = self.state.build_ctx(ral);
        source_ctx.llm_runtime_ms = self.state.take_runtime_delta();
        self.state
            .channel
            .send(Intent::ToolUse(tool_use_intent), &source_ctx)
            .await
            .map_err(|e| {
                DelegateCrossProjectError(format!("failed to emit tool-use event: {e}"))
            })?;

        let short_id = tenex_ids::shorten_full_event_id(&delegation_event_id);
        Ok(format!(
            "Delegated to @{} in project '{}'. Delegation event ID: {}. Stop here — do not take further actions this turn.",
            args.recipient, args.project_id, short_id
        ))
    }
}
