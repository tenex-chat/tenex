use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::emit::EmitState;
use crate::file_modifications::FileSnapshotWriter;
use crate::runtime_state::RuntimeStateHandle;
use crate::tools::{TodoItem, TodoStatus};
use rig_core::agent::{HookAction, ToolCallHookAction};
use rig_core::completion::Message;
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
    /// Snapshots successful `fs_write` results into the conversation DB so a
    /// later run of this agent can detect external file modifications.
    snapshot_writer: Option<Arc<FileSnapshotWriter>>,
}

impl EmitHook {
    pub fn new(
        state: Arc<EmitState>,
        supervisor: Arc<Mutex<Supervisor>>,
        todos: Arc<Mutex<Vec<TodoItem>>>,
        agent_category: Option<AgentCategory>,
        runtime_state: Option<RuntimeStateHandle>,
        snapshot_writer: Option<Arc<FileSnapshotWriter>>,
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
            snapshot_writer,
        }
    }

    /// Take the pending final turn content and RAL. Called by main.rs after the
    /// stream ends to emit the last ConversationIntent with usage attached.
    pub fn take_pending(&self) -> Option<(String, u32)> {
        self.pending.lock().unwrap().take()
    }

    /// Emit the pending text as a `ConversationIntent` immediately.
    ///
    /// Called before executing tools so the accumulated text is published as
    /// a kind:1 *before* the tool-use event, rather than deferred until the
    /// next stream finishes or the turn ends.
    pub async fn flush_pending_text(&self) -> HookAction {
        let pending = self.pending.lock().unwrap().take();
        if let Some((content, ral)) = pending {
            let mut ctx = self.state.build_ctx(ral);
            ctx.llm_runtime_ms = self.state.take_runtime_delta();
            let intent = ConversationIntent {
                content,
                is_reasoning: false,
                usage: None,
                metadata: None,
            };
            if let Err(e) = self.state.channel.send(Intent::Conversation(intent), &ctx).await {
                eprintln!("[tenex-agent] warn: flush-pending emit failed: {e}");
            }
        }
        HookAction::cont()
    }
}

impl EmitHook {
    pub async fn on_text_delta(&self, text_delta: &str, _aggregated_text: &str) -> HookAction {
        {
            let mut acc = self.accumulated_text.lock().unwrap();
            acc.push_str(text_delta);
        }
        let _ = self
            .delta_tx
            .send(DeltaSignal::Delta(text_delta.to_string()));
        HookAction::cont()
    }

    pub async fn on_completion_call(&self, _prompt: &Message, _history: &[Message]) -> HookAction {
        if let Some(driver) = self.runtime_state.clone() {
            driver.acquire_driver().await;
        }
        // Start the runtime timer only after we hold the driver lock,
        // so cross-agent wait time is not billed as LLM runtime.
        self.state.start_llm_stream();
        HookAction::cont()
    }

    pub async fn on_stream_completion_response_finish<R>(
        &self,
        _prompt: &Message,
        _response: &R,
    ) -> HookAction {
        self.finish_stream().await
    }

    pub async fn on_stream_end_without_response(&self, _prompt: &Message) -> HookAction {
        self.finish_stream().await
    }

    pub fn abort_stream(&self) {
        self.state.end_llm_stream();
        let _ = std::mem::take(&mut *self.accumulated_text.lock().unwrap());
        let _ = self.delta_tx.send(DeltaSignal::EndTurn);
        if let Some(state) = self.runtime_state.clone() {
            state.release_driver();
        }
    }

    /// Publish a synthetic status delta directly to the channel, bypassing
    /// the token buffer. Used to show retry/error status to the conversation.
    pub async fn publish_status(&self, text: &str) {
        let ral = self.state.meta.lock().unwrap().ral;
        let ctx = self.state.build_ctx(ral);
        let intent = StreamTextDeltaIntent {
            delta: text.to_string(),
            sequence: 0,
        };
        if let Err(e) = self
            .state
            .channel
            .send(Intent::StreamTextDelta(intent), &ctx)
            .await
        {
            eprintln!("[tenex-agent] warn: status delta emit failed: {e}");
        }
    }

    async fn finish_stream(&self) -> HookAction {
        self.state.end_llm_stream();
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

        if let Some(state) = self.runtime_state.clone() {
            state.release_driver();
        }
        if let Some((prev_content, prev_ral)) = prev_pending {
            let mut ctx = self.state.build_ctx(prev_ral);
            ctx.llm_runtime_ms = self.state.take_runtime_delta();
            let intent = ConversationIntent {
                content: prev_content,
                is_reasoning: false,
                usage: None,
                metadata: None,
            };
            if let Err(e) = self
                .state
                .channel
                .send(Intent::Conversation(intent), &ctx)
                .await
            {
                eprintln!("[tenex-agent] warn: conversation emit failed: {e}");
            }
        }
        HookAction::cont()
    }

    pub async fn on_tool_result(
        &self,
        tool_name: &str,
        _tool_call_id: Option<String>,
        _internal_call_id: &str,
        args: &str,
        result: &str,
    ) -> HookAction {
        // Snapshot successful `fs_write` results so a later run of this agent
        // can detect external modifications. `capture` self-gates on the write
        // success prefix, so blocked/failed writes are ignored.
        if tool_name == "fs_write" {
            if let Some(writer) = &self.snapshot_writer {
                writer.capture(args, result);
            }
        }

        let is_mcp_error = tool_name.starts_with("mcp__") && result.starts_with("Error: ");
        if !is_mcp_error {
            return HookAction::cont();
        }
        let ral = self.state.meta.lock().unwrap().ral;
        let ctx = self.state.build_ctx(ral);
        let intent = ToolUseIntent {
            tool_name: tool_name.to_string(),
            content: result.to_string(),
            args_json: None,
            referenced_messages: Vec::new(),
            usage: None,
            extra_tags: vec![vec!["tool-error".to_string(), "true".to_string()]],
        };
        if let Err(e) = self.state.channel.send(Intent::ToolUse(intent), &ctx).await {
            eprintln!("[tenex-agent] warn: failed to emit MCP tool error event: {e}");
        }
        HookAction::cont()
    }

    pub async fn on_tool_call(
        &self,
        tool_name: &str,
        _tool_call_id: Option<String>,
        _internal_call_id: &str,
        args: &str,
    ) -> ToolCallHookAction {
        let emits_delayed_tool_use = matches!(
            tool_name,
            "delegate"
                | "delegate_followup"
                | "self_delegate"
                | "delegate_crossproject"
                | "ask"
        );
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

        // Stop the LLM stream timer at the tool handoff: time spent
        // executing the tool is not LLM runtime. `end_llm_stream` is
        // idempotent so the later `on_stream_completion_response_finish`
        // hook is a safe no-op when timing was already stopped here.
        self.state.end_llm_stream();

        if let Some(reason) = block_reason {
            // Skip path: leave the runtime delta unconsumed. The
            // supervisor-blocked tool emits no ToolUse here, and a
            // subsequent event (the next stream chunk, conversation
            // emit, or the next tool call) will claim the delta.
            return ToolCallHookAction::skip(reason);
        }
        if let Some(rs) = self.runtime_state.clone() {
            rs.release_driver();
        }
        if !emits_delayed_tool_use {
            // Only consume the runtime delta when we are actually
            // sending the generic ToolUse event. Delayed-emit tools
            // (delegate, delegate_followup, self_delegate,
            // delegate_crossproject) emit their own events later and
            // consume the delta themselves; consuming it here would
            // silently drop it.
            let ral = self.state.meta.lock().unwrap().ral;
            let mut ctx = self.state.build_ctx(ral);
            ctx.llm_runtime_ms = self.state.take_runtime_delta();
            let intent = ToolUseIntent {
                tool_name: name,
                content: String::new(),
                args_json: Some(args_string),
                referenced_messages: Vec::new(),
                usage: None,
                extra_tags: Vec::new(),
            };
            if let Err(e) = self.state.channel.send(Intent::ToolUse(intent), &ctx).await {
                eprintln!("[tenex-agent] warn: failed to emit tool-use event: {e}");
            }
        }
        ToolCallHookAction::cont()
    }

    pub async fn on_tool_call_delta(
        &self,
        _tool_call_id: &str,
        _internal_call_id: &str,
        _tool_name: Option<&str>,
        _tool_call_delta: &str,
    ) -> HookAction {
        HookAction::cont()
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
    let ral = state.meta.lock().unwrap().ral;
    let mut ctx = state.build_ctx(ral);
    ctx.llm_runtime_ms = state.take_runtime_delta();
    let intent = StreamTextDeltaIntent { delta, sequence };
    if let Err(e) = state
        .channel
        .send(Intent::StreamTextDelta(intent), &ctx)
        .await
    {
        eprintln!("[tenex-agent] warn: stream delta emit failed: {e}");
    }
}
