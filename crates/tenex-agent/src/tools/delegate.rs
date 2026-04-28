use crate::hook::AgentMeta;
use crate::nostr::{AgentSigner, LlmTags};
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tenex_project::Agent;

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
    signer: Arc<AgentSigner>,
    root_id: String,
    reply_id: Option<String>,
    model: String,
    meta: Arc<Mutex<AgentMeta>>,
    project_agents: Arc<Vec<Agent>>,
}

impl DelegateTool {
    pub fn new(
        signer: Arc<AgentSigner>,
        root_id: String,
        reply_id: Option<String>,
        model: String,
        meta: Arc<Mutex<AgentMeta>>,
        project_agents: Arc<Vec<Agent>>,
    ) -> Self {
        Self { signer, root_id, reply_id, model, meta, project_agents }
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
        let pubkey = match self.lookup_pubkey(&args.recipient) {
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

        let llm = {
            let meta = self.meta.lock().unwrap();
            LlmTags {
                model: self.model.clone(),
                ral: meta.ral,
                input_tokens: None,
                output_tokens: None,
                total_tokens: None,
                cached_input_tokens: None,
            }
        };

        let delegation_id = self
            .signer
            .emit_delegation(&pubkey, &args.prompt, &llm)
            .map_err(|e| DelegateError(format!("Failed to emit delegation: {e}")))?;

        let args_json = serde_json::to_string(&args).unwrap_or_default();
        self.signer
            .emit_tool_use(
                "delegate",
                &args_json,
                &self.root_id,
                self.reply_id.as_deref(),
                &llm,
                &[delegation_id.clone()],
            )
            .map_err(|e| DelegateError(format!("Failed to emit tool-use event: {e}")))?;

        Ok(format!(
            "Delegated to @{}. Stop here — do not take further actions this turn.",
            args.recipient
        ))
    }
}
