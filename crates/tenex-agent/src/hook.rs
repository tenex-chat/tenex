use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::emit::EmitState;
use crate::runtime_state::RuntimeStateHandle;
use crate::tools::{TodoItem, TodoStatus};
use rig::agent::{HookAction, PromptHook, ToolCallHookAction};
use rig::completion::{CompletionModel, Message};
use tenex_protocol::{ConversationIntent, Intent, StreamTextDeltaIntent, ToolUseIntent};
use tenex_supervision::{
    supervisor::Supervisor,
    types::{AgentCategory, TodoEntry, TodoStatus as SupTodoStatus},
};
use tokio::sync::mpsc;

/// Maximum time a streaming delta may sit in the buffer before being published.
/// Sentence-terminating punctuation flushes earlier; this caps latency for
/// agents that emit long sentences or no terminators at all.
const FLUSH_INTERVAL: Duration = Duration::from_millis(250);

enum DeltaSignal {
    Delta(String),
    EndTurn,
}

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
    /// Sender into the background buffer task that batches deltas into
    /// sentence- or 250ms-bounded chunks before publishing.
    delta_tx: mpsc::UnboundedSender<DeltaSignal>,
    /// Holds the completed text and RAL for the most recent turn, not yet emitted.
    /// Intermediate turns are emitted when the next turn starts; the final turn
    /// is emitted by main.rs (with usage from FinalResponse).
    pending: Arc<Mutex<Option<(String, u32)>>>,
    runtime_state: Option<RuntimeStateHandle>,
}

impl EmitHook {
    pub fn new(
        state: Arc<EmitState>,
        supervisor: Arc<Mutex<Supervisor>>,
        todos: Arc<Mutex<Vec<TodoItem>>>,
        agent_category: Option<AgentCategory>,
        runtime_state: Option<RuntimeStateHandle>,
    ) -> Self {
        let (delta_tx, delta_rx) = mpsc::unbounded_channel();
        tokio::spawn(run_delta_buffer(state.clone(), delta_rx));
        Self {
            state,
            supervisor,
            todos,
            agent_category,
            accumulated_text: Arc::new(Mutex::new(String::new())),
            delta_tx,
            pending: Arc::new(Mutex::new(None)),
            runtime_state,
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
        {
            let mut acc = self.accumulated_text.lock().unwrap();
            acc.push_str(text_delta);
        }
        let _ = self
            .delta_tx
            .send(DeltaSignal::Delta(text_delta.to_string()));
        async { HookAction::cont() }
    }

    fn on_completion_call(
        &self,
        _prompt: &Message,
        _history: &[Message],
    ) -> impl std::future::Future<Output = HookAction> + Send {
        let runtime_state = self.runtime_state.clone();
        async move {
            if let Some(state) = runtime_state {
                state.acquire_driver().await;
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
        let _ = self.delta_tx.send(DeltaSignal::EndTurn);

        let ral = {
            let mut meta = self.state.meta.lock().unwrap();
            meta.ral += 1;
            meta.ral
        };

        // Swap: emit the previous pending turn (intermediate), store this one.
        // The final pending is emitted by main.rs with usage from FinalResponse.
        let prev_pending = std::mem::replace(
            &mut *self.pending.lock().unwrap(),
            if content.is_empty() {
                None
            } else {
                Some((content, ral))
            },
        );

        let state = self.state.clone();
        let channel = self.state.channel.clone();
        let runtime_state = self.runtime_state.clone();

        async move {
            if let Some(state) = runtime_state {
                state.release_driver();
            }
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
        let emits_delayed_tool_use = matches!(tool_name, "delegate" | "delegate_followup");
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
        let runtime_state = self.runtime_state.clone();

        async move {
            if let Some(reason) = block_reason {
                return ToolCallHookAction::skip(reason);
            }
            if let Some(state) = runtime_state {
                state.release_driver();
            }
            if !emits_delayed_tool_use {
                let intent = ToolUseIntent {
                    tool_name: name,
                    content: String::new(),
                    args_json: Some(args_string),
                    referenced_messages: Vec::new(),
                    usage: None,
                    extra_tags: Vec::new(),
                };
                if let Err(e) = channel.send(Intent::ToolUse(intent), &ctx).await {
                    eprintln!("[tenex-agent] warn: failed to emit tool-use event: {e}");
                }
            }
            ToolCallHookAction::cont()
        }
    }
}

/// Background task that batches per-token deltas into sentence- or
/// 250ms-bounded chunks before publishing them as `StreamTextDeltaIntent`
/// events. Owned 1:1 with an `EmitHook`; exits when all hook clones drop.
async fn run_delta_buffer(state: Arc<EmitState>, mut rx: mpsc::UnboundedReceiver<DeltaSignal>) {
    let mut buf = String::new();
    let mut started: Option<Instant> = None;
    let mut sequence: u64 = 0;

    loop {
        let next = match started {
            Some(start) => {
                let remaining = FLUSH_INTERVAL.saturating_sub(start.elapsed());
                match tokio::time::timeout(remaining, rx.recv()).await {
                    Ok(opt) => opt,
                    Err(_) => {
                        sequence += 1;
                        flush_chunk(&mut buf, sequence, &state).await;
                        started = None;
                        continue;
                    }
                }
            }
            None => rx.recv().await,
        };

        match next {
            Some(DeltaSignal::Delta(d)) => {
                if started.is_none() {
                    started = Some(Instant::now());
                }
                let has_terminator = d.chars().any(|c| matches!(c, '.' | '!' | '?' | '\n'));
                buf.push_str(&d);
                if has_terminator {
                    sequence += 1;
                    flush_chunk(&mut buf, sequence, &state).await;
                    started = None;
                }
            }
            Some(DeltaSignal::EndTurn) => {
                if !buf.is_empty() {
                    sequence += 1;
                    flush_chunk(&mut buf, sequence, &state).await;
                }
                started = None;
                sequence = 0;
            }
            None => {
                if !buf.is_empty() {
                    sequence += 1;
                    flush_chunk(&mut buf, sequence, &state).await;
                }
                return;
            }
        }
    }
}

async fn flush_chunk(buf: &mut String, sequence: u64, state: &Arc<EmitState>) {
    let delta = std::mem::take(buf);
    let ctx = {
        let meta = state.meta.lock().unwrap();
        state.build_ctx(meta.ral)
    };
    let intent = StreamTextDeltaIntent { delta, sequence };
    if let Err(e) = state
        .channel
        .send(Intent::StreamTextDelta(intent), &ctx)
        .await
    {
        eprintln!("[tenex-agent] warn: stream delta emit failed: {e}");
    }
}
