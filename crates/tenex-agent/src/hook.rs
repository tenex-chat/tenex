use crate::emit::EmitState;
use rig::agent::{HookAction, PromptHook, ToolCallHookAction};
use rig::completion::{AssistantContent, CompletionModel, CompletionResponse, Message};
use std::sync::Arc;
use tenex_protocol::{
    ConversationIntent, Intent, LlmUsage, ToolUseIntent,
};

#[derive(Clone)]
pub struct EmitHook {
    state: Arc<EmitState>,
}

impl EmitHook {
    pub fn new(state: Arc<EmitState>) -> Self {
        Self { state }
    }
}

impl<M: CompletionModel> PromptHook<M> for EmitHook {
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

        let usage = LlmUsage {
            input_tokens: Some(response.usage.input_tokens),
            output_tokens: Some(response.usage.output_tokens),
            total_tokens: Some(response.usage.total_tokens),
            cached_input_tokens: Some(response.usage.cached_input_tokens),
            ..Default::default()
        };

        let (ral, ctx) = {
            let mut meta = self.state.meta.lock().unwrap();
            meta.ral += 1;
            meta.input_tokens += response.usage.input_tokens;
            meta.output_tokens += response.usage.output_tokens;
            meta.total_tokens += response.usage.total_tokens;
            meta.cached_input_tokens += response.usage.cached_input_tokens;
            (meta.ral, self.state.build_ctx(meta.ral))
        };
        let _ = ral;

        let channel = self.state.channel.clone();
        async move {
            if !content.is_empty() {
                let intent = ConversationIntent {
                    content,
                    is_reasoning: false,
                    usage: Some(usage),
                    metadata: None,
                };
                if let Err(e) =
                    channel.send(Intent::Conversation(intent), &ctx).await
                {
                    eprintln!("[tenex-agent] warn: failed to emit conversation event: {e}");
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
        let is_delegate = tool_name == "delegate";
        let name = tool_name.to_string();
        let args_string = args.to_string();
        let ctx = {
            let meta = self.state.meta.lock().unwrap();
            self.state.build_ctx(meta.ral)
        };
        let channel = self.state.channel.clone();

        async move {
            // DelegateTool emits its own tool-use event (with a q-tag) after the call.
            if !is_delegate {
                let intent = ToolUseIntent {
                    tool_name: name,
                    content: String::new(),
                    args_json: Some(args_string),
                    referenced_messages: Vec::new(),
                    usage: None,
                };
                if let Err(e) = channel.send(Intent::ToolUse(intent), &ctx).await {
                    eprintln!("[tenex-agent] warn: failed to emit tool-use event: {e}");
                }
            }
            ToolCallHookAction::cont()
        }
    }
}
