use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

use crate::emit::EmitState;
use crate::tools::{TodoItem, TodoStatus};
use rig::agent::{HookAction, PromptHook, ToolCallHookAction};
use rig::completion::{CompletionModel, Message};
use tenex_protocol::{ConversationIntent, Intent, StreamTextDeltaIntent, ToolUseIntent};
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
    /// Accumulates text for the current streaming turn; cleared after each turn.
    accumulated_text: Arc<Mutex<String>>,
    /// Monotonic counter reset to 0 at the start of each new LLM turn.
    sequence: Arc<AtomicU64>,
    /// Holds the completed text and RAL for the most recent turn, not yet emitted.
    /// Intermediate turns are emitted when the next turn starts; the final turn
    /// is emitted by main.rs (with usage from FinalResponse).
    pending: Arc<Mutex<Option<(String, u32)>>>,
}

impl EmitHook {
    pub fn new(
        state: Arc<EmitState>,
        supervisor: Arc<Mutex<Supervisor>>,
        todos: Arc<Mutex<Vec<TodoItem>>>,
        agent_category: Option<AgentCategory>,
    ) -> Self {
        Self {
            state,
            supervisor,
            todos,
            agent_category,
            accumulated_text: Arc::new(Mutex::new(String::new())),
            sequence: Arc::new(AtomicU64::new(0)),
            pending: Arc::new(Mutex::new(None)),
        }
    }

    /// Take the pending final turn content and RAL. Called by main.rs after the
    /// stream ends to emit the last ConversationIntent with usage attached.
    pub fn take_pending(&self) -> Option<(String, u32)> {
        self.pending.lock().unwrap().take()
    }
}

impl<M: CompletionModel> PromptHook<M> for EmitHook {
    fn on_text_delta(
        &self,
        text_delta: &str,
        _aggregated_text: &str,
    ) -> impl std::future::Future<Output = HookAction> + Send {
        let seq = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        {
            let mut acc = self.accumulated_text.lock().unwrap();
            acc.push_str(text_delta);
        }
        let delta = text_delta.to_string();
        let ctx = {
            let meta = self.state.meta.lock().unwrap();
            self.state.build_ctx(meta.ral)
        };
        let channel = self.state.channel.clone();
        async move {
            let intent = StreamTextDeltaIntent { delta, sequence: seq };
            if let Err(e) = channel.send(Intent::StreamTextDelta(intent), &ctx).await {
                eprintln!("[tenex-agent] warn: stream delta emit failed: {e}");
            }
            HookAction::cont()
        }
    }

    fn on_stream_completion_response_finish(
        &self,
        _prompt: &Message,
        _response: &<M as CompletionModel>::StreamingResponse,
    ) -> impl std::future::Future<Output = HookAction> + Send {
        let content = std::mem::take(&mut *self.accumulated_text.lock().unwrap());
        self.sequence.store(0, Ordering::Relaxed);

        let ral = {
            let mut meta = self.state.meta.lock().unwrap();
            meta.ral += 1;
            meta.ral
        };

        // Swap: emit the previous pending turn (intermediate), store this one.
        // The final pending is emitted by main.rs with usage from FinalResponse.
        let prev_pending = std::mem::replace(
            &mut *self.pending.lock().unwrap(),
            if content.is_empty() { None } else { Some((content, ral)) },
        );

        let state = self.state.clone();
        let channel = self.state.channel.clone();

        async move {
            if let Some((prev_content, prev_ral)) = prev_pending {
                let ctx = state.build_ctx(prev_ral);
                let intent = ConversationIntent {
                    content: prev_content,
                    is_reasoning: false,
                    usage: None,
                    metadata: None,
                };
                if let Err(e) = channel.send(Intent::Conversation(intent), &ctx).await {
                    eprintln!("[tenex-agent] warn: conversation emit failed: {e}");
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
