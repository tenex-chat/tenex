use crate::nostr::{AgentSigner, LlmTags};
use rig::agent::{HookAction, PromptHook, ToolCallHookAction};
use rig::completion::{AssistantContent, CompletionModel, CompletionResponse, Message};
use std::sync::{Arc, Mutex};

/// Accumulated LLM state across all turns of a single agent invocation.
pub struct AgentMeta {
    pub ral: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cached_input_tokens: u64,
}

impl AgentMeta {
    fn new() -> Self {
        Self {
            ral: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cached_input_tokens: 0,
        }
    }
}

#[derive(Clone)]
pub struct NostrHook {
    signer: Arc<AgentSigner>,
    root_id: String,
    reply_id: Option<String>,
    model: String,
    meta: Arc<Mutex<AgentMeta>>,
}

impl NostrHook {
    /// Create a hook and return the shared meta handle so main can read final totals.
    pub fn new(
        signer: Arc<AgentSigner>,
        root_id: String,
        reply_id: Option<String>,
        model: String,
    ) -> (Self, Arc<Mutex<AgentMeta>>) {
        let meta = Arc::new(Mutex::new(AgentMeta::new()));
        let hook = Self { signer, root_id, reply_id, model, meta: meta.clone() };
        (hook, meta)
    }
}

impl<M: CompletionModel> PromptHook<M> for NostrHook {
    fn on_completion_response(
        &self,
        _prompt: &Message,
        response: &CompletionResponse<M::Response>,
    ) -> impl std::future::Future<Output = HookAction> + Send {
        let texts: Vec<String> = response
            .choice
            .iter()
            .filter_map(|c| {
                if let AssistantContent::Text(t) = c {
                    Some(t.text.clone())
                } else {
                    None
                }
            })
            .collect();
        let content = texts.join("\n");

        // Update accumulated state and snapshot tags for this turn.
        let llm = {
            let mut meta = self.meta.lock().unwrap();
            meta.ral += 1;
            meta.input_tokens += response.usage.input_tokens;
            meta.output_tokens += response.usage.output_tokens;
            meta.total_tokens += response.usage.total_tokens;
            meta.cached_input_tokens += response.usage.cached_input_tokens;
            LlmTags {
                model: self.model.clone(),
                ral: meta.ral,
                input_tokens: Some(response.usage.input_tokens),
                output_tokens: Some(response.usage.output_tokens),
                total_tokens: Some(response.usage.total_tokens),
                cached_input_tokens: Some(response.usage.cached_input_tokens),
            }
        };

        let signer = self.signer.clone();
        let root_id = self.root_id.clone();
        let reply_id = self.reply_id.clone();
        async move {
            if !content.is_empty() {
                if let Err(e) =
                    signer.emit_intermediate(&content, &root_id, reply_id.as_deref(), &llm)
                {
                    eprintln!("[tenex-agent] warn: failed to emit intermediate event: {e}");
                }
            }
            HookAction::cont()
        }
    }

    fn on_tool_call(
        &self,
        tool_name: &str,
        _tool_call_id: Option<String>,
        _internal_call_id: &str,
        args: &str,
    ) -> impl std::future::Future<Output = ToolCallHookAction> + Send {
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

        let is_delegate = tool_name == "delegate";
        let signer = self.signer.clone();
        let root_id = self.root_id.clone();
        let reply_id = self.reply_id.clone();
        let name = tool_name.to_string();
        let args = args.to_string();
        async move {
            // DelegateTool emits its own tool-use event (with a q-tag) after the call.
            if !is_delegate {
                if let Err(e) =
                    signer.emit_tool_use(&name, &args, &root_id, reply_id.as_deref(), &llm, &[])
                {
                    eprintln!("[tenex-agent] warn: failed to emit tool-use event: {e}");
                }
            }
            ToolCallHookAction::cont()
        }
    }
}
