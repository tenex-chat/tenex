use crate::emit::EmitState;
use crate::tools::{TodoItem, TodoStatus};
use rig::agent::{HookAction, PromptHook, ToolCallHookAction};
use rig::completion::{AssistantContent, CompletionModel, CompletionResponse, Message};
use std::sync::{Arc, Mutex};
use tenex_protocol::{ConversationIntent, Intent, LlmUsage, ToolUseIntent};
use tenex_supervision::{
    supervisor::Supervisor,
    types::{AgentCategory, TodoEntry, TodoStatus as SupTodoStatus},
};

fn to_supervision_entries(items: &[TodoItem]) -> Vec<TodoEntry> {
    items
        .iter()
        .map(|t| TodoEntry {
            id: t.id.clone(),
            status: match t.status {
                TodoStatus::Pending => SupTodoStatus::Pending,
                TodoStatus::InProgress => SupTodoStatus::InProgress,
                TodoStatus::Done => SupTodoStatus::Done,
                TodoStatus::Skipped => SupTodoStatus::Skipped,
            },
        })
        .collect()
}

#[derive(Clone)]
pub struct EmitHook {
    state: Arc<EmitState>,
    supervisor: Arc<Mutex<Supervisor>>,
    todos: Arc<Mutex<Vec<TodoItem>>>,
    agent_category: Option<AgentCategory>,
}

impl EmitHook {
    pub fn new(
        state: Arc<EmitState>,
        supervisor: Arc<Mutex<Supervisor>>,
        todos: Arc<Mutex<Vec<TodoItem>>>,
        agent_category: Option<AgentCategory>,
    ) -> Self {
        Self { state, supervisor, todos, agent_category }
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
                if let Err(e) = channel.send(Intent::Conversation(intent), &ctx).await {
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

        // Pre-tool supervision check (synchronous, before async block)
        let block_reason: Option<String> = self.agent_category.as_ref().and_then(|category| {
            let todos_snapshot = {
                let lock = self.todos.lock().unwrap();
                to_supervision_entries(&lock)
            };
            let sup = self.supervisor.lock().unwrap();
            sup.check_pre_tool(&name, &todos_snapshot, category)
        });

        if block_reason.is_none() {
            let mut sup = self.supervisor.lock().unwrap();
            sup.record_tool_call(&name);
        }

        let ctx = {
            let meta = self.state.meta.lock().unwrap();
            self.state.build_ctx(meta.ral)
        };
        let channel = self.state.channel.clone();

        async move {
            if let Some(reason) = block_reason {
                return ToolCallHookAction::skip(reason);
            }
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
