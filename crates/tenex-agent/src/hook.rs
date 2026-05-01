use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::emit::EmitState;
use crate::runtime_state::RuntimeStateHandle;
use crate::tools::{TodoItem, TodoStatus};
use parking_lot::Mutex;
use rig::agent::{HookAction, PromptHook, ToolCallHookAction};
use rig::completion::{CompletionModel, Message};
use tenex_protocol::{ConversationIntent, Intent, StreamTextDeltaIntent, ToolUseIntent};
use tenex_supervision::{
    supervisor::Supervisor,
    types::{AgentCategory, TodoEntry, TodoStatus as SupTodoStatus},
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// Maximum time a streaming delta may sit in the buffer before being published.
/// Sentence-terminating punctuation flushes earlier; this caps latency for
/// agents that emit long sentences or no terminators at all.
const FLUSH_INTERVAL: Duration = Duration::from_millis(250);

enum DeltaSignal {
    Delta(String),
    EndTurn,
    /// Terminal signal from `EmitHook::shutdown()`. The buffer task flushes
    /// any pending delta and returns. FIFO ordering of the unbounded channel
    /// guarantees prior `Delta`/`EndTurn` signals are processed first.
    Shutdown,
}

/// Maximum time `shutdown()` waits for the buffer task to drain queued deltas
/// before falling back to abort. Generous enough to absorb a final flush over
/// a real network channel; bounded so a stuck channel cannot block teardown.
const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

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
    /// JoinHandle for the background buffer task, taken out and awaited
    /// by `shutdown()`. Shared across `EmitHook` clones; `shutdown()` is
    /// idempotent — only the first caller observes the handle.
    delta_task: Arc<Mutex<Option<JoinHandle<()>>>>,
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
        let delta_task = tokio::spawn(run_delta_buffer(state.clone(), delta_rx));
        Self {
            state,
            supervisor,
            todos,
            agent_category,
            accumulated_text: Arc::new(Mutex::new(String::new())),
            delta_tx,
            delta_task: Arc::new(Mutex::new(Some(delta_task))),
            pending: Arc::new(Mutex::new(None)),
            runtime_state,
        }
    }

    /// Take the pending final turn content and RAL. Called by main.rs after the
    /// stream ends to emit the last ConversationIntent with usage attached.
    pub fn take_pending(&self) -> Option<(String, u32)> {
        self.pending.lock().take()
    }

    /// Drain queued deltas and stop the background buffer task.
    /// Idempotent across `EmitHook` clones — only the first caller takes
    /// the JoinHandle. Intended to be called once on the natural finish
    /// path of the agent loop.
    ///
    /// Sends a `Shutdown` signal so any prior `Delta`/`EndTurn` signals
    /// queued by streaming hooks are flushed before the task exits, then
    /// awaits the task with a bounded timeout. Only falls back to
    /// `JoinHandle::abort()` if the task fails to exit within the timeout.
    pub async fn shutdown(&self) {
        let handle = self.delta_task.lock().take();
        let Some(handle) = handle else {
            return;
        };

        // Best-effort: if the receiver has already exited (e.g., previous
        // panic), the send fails — the JoinHandle await below still resolves.
        if let Err(e) = self.delta_tx.send(DeltaSignal::Shutdown) {
            tracing::warn!(
                error = %e,
                "delta-buffer channel closed before shutdown signal; task already exited"
            );
        }

        let abort_handle = handle.abort_handle();
        match tokio::time::timeout(SHUTDOWN_DRAIN_TIMEOUT, handle).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if !e.is_cancelled() {
                    tracing::warn!(
                        error = %e,
                        "delta-buffer task exited with error during shutdown"
                    );
                }
            }
            Err(_) => {
                tracing::warn!(
                    timeout_secs = SHUTDOWN_DRAIN_TIMEOUT.as_secs(),
                    "delta-buffer task did not drain within shutdown timeout; aborting"
                );
                abort_handle.abort();
            }
        }
    }
}

impl<M: CompletionModel> PromptHook<M> for EmitHook {
    fn on_text_delta(
        &self,
        text_delta: &str,
        _aggregated_text: &str,
    ) -> impl std::future::Future<Output = HookAction> + Send {
        {
            let mut acc = self.accumulated_text.lock();
            acc.push_str(text_delta);
        }
        if let Err(e) = self
            .delta_tx
            .send(DeltaSignal::Delta(text_delta.to_string()))
        {
            tracing::warn!(
                signal = "Delta",
                error = %e,
                "delta-buffer channel closed; dropping streaming delta (buffer task likely exited)"
            );
        }
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
                if let Err(e) = state.acquire_driver().await {
                    // Without the driver lease the agent must not enter the
                    // provider call: another execution could re-sync from
                    // persisted state, see no busy driver, and start a second
                    // concurrent run. Terminate the loop instead.
                    let reason = format!("runtime driver lease unavailable: {e:#}");
                    tracing::error!(error = %e, "runtime driver lease unavailable; terminating agent loop");
                    return HookAction::terminate(reason);
                }
            }
            HookAction::cont()
        }
    }

    fn on_stream_completion_response_finish(
        &self,
        _prompt: &Message,
        _response: &<M as CompletionModel>::StreamingResponse,
    ) -> impl std::future::Future<Output = HookAction> + Send {
        let content = std::mem::take(&mut *self.accumulated_text.lock());
        if let Err(e) = self.delta_tx.send(DeltaSignal::EndTurn) {
            tracing::warn!(
                signal = "EndTurn",
                error = %e,
                "delta-buffer channel closed; turn boundary not signaled (buffer task likely exited)"
            );
        }

        let ral = {
            let mut meta = self.state.meta.lock();
            meta.ral += 1;
            meta.ral
        };

        // Swap: emit the previous pending turn (intermediate), store this one.
        // The final pending is emitted by main.rs with usage from FinalResponse.
        let prev_pending = std::mem::replace(
            &mut *self.pending.lock(),
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

        // Snapshot under the locks, then drop both guards before constructing
        // the async future. This keeps the supervisor/todos locks off the
        // await path even if a future maintainer adds an `.await` here.
        let block_reason: Option<String> = self.agent_category.as_ref().and_then(|category| {
            let todos_snapshot = {
                let todos_guard = self.todos.lock();
                let snap = to_supervision_entries(&todos_guard);
                drop(todos_guard);
                snap
            };
            let sup_guard = self.supervisor.lock();
            let reason = sup_guard.check_pre_tool(&name, &todos_snapshot, category);
            drop(sup_guard);
            reason
        });

        if block_reason.is_none() {
            let mut sup_guard = self.supervisor.lock();
            sup_guard.record_tool_call(&name);
            drop(sup_guard);
        }

        let ctx = {
            let meta = self.state.meta.lock();
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
/// events. Owned 1:1 with an `EmitHook`; exits when all hook clones drop
/// or `EmitHook::shutdown()` aborts it.
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
            Some(DeltaSignal::Shutdown) => {
                if !buf.is_empty() {
                    sequence += 1;
                    flush_chunk(&mut buf, sequence, &state).await;
                }
                return;
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
        let meta = state.meta.lock();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emit::{EmitState, EmitStateArgs};
    use crate::runtime_state::RuntimeStateHandle;
    use async_trait::async_trait;
    use nostr::{Keys, PublicKey};
    use rig::completion::CompletionModel;
    use tenex_protocol::{
        Channel, ChannelError, EncodingContext, Intent, MessageRef, PrincipalKind, PrincipalRef,
        ProjectRef,
    };
    use tenex_supervision::heuristics::default_supervisor;

    /// Channel that drops every send. Sufficient for exercising the
    /// background buffer task's lifecycle without observing publishes.
    struct NullChannel {
        identity: PrincipalRef,
    }

    #[async_trait]
    impl Channel for NullChannel {
        fn name(&self) -> &'static str {
            "null"
        }
        fn identity(&self) -> &PrincipalRef {
            &self.identity
        }
        async fn send(
            &self,
            _intent: Intent,
            _ctx: &EncodingContext,
        ) -> Result<Vec<MessageRef>, ChannelError> {
            Ok(Vec::new())
        }
    }

    /// Channel that captures every published intent for assertion. Used to
    /// verify the buffer task drains queued deltas before exiting.
    struct RecordingChannel {
        identity: PrincipalRef,
        intents: Arc<Mutex<Vec<Intent>>>,
    }

    #[async_trait]
    impl Channel for RecordingChannel {
        fn name(&self) -> &'static str {
            "recording"
        }
        fn identity(&self) -> &PrincipalRef {
            &self.identity
        }
        async fn send(
            &self,
            intent: Intent,
            _ctx: &EncodingContext,
        ) -> Result<Vec<MessageRef>, ChannelError> {
            self.intents.lock().push(intent);
            Ok(Vec::new())
        }
    }

    fn agent_pubkey() -> PublicKey {
        Keys::generate().public_key()
    }

    fn make_emit_state(channel: Arc<dyn Channel>, principal: PrincipalRef) -> Arc<EmitState> {
        let project = ProjectRef {
            author: agent_pubkey(),
            d_tag: "test".to_string(),
        };
        Arc::new(EmitState::new(EmitStateArgs {
            channel,
            project,
            triggering_principal: principal,
            triggering_message: None,
            conversation_root: None,
            completion_recipient: None,
            model: "test-model".to_string(),
            team: None,
            current_branch: None,
        }))
    }

    fn make_hook() -> EmitHook {
        let pubkey = agent_pubkey();
        let identity = PrincipalRef::Nostr {
            pubkey,
            kind: PrincipalKind::Agent,
            display_name: None,
        };
        let principal = identity.clone();
        let channel: Arc<dyn Channel> = Arc::new(NullChannel { identity });
        let state = make_emit_state(channel, principal);
        EmitHook::new(
            state,
            Arc::new(Mutex::new(default_supervisor())),
            Arc::new(Mutex::new(Vec::new())),
            None,
            None,
        )
    }

    fn make_hook_with_runtime(runtime_state: RuntimeStateHandle) -> EmitHook {
        let pubkey = agent_pubkey();
        let identity = PrincipalRef::Nostr {
            pubkey,
            kind: PrincipalKind::Agent,
            display_name: None,
        };
        let principal = identity.clone();
        let channel: Arc<dyn Channel> = Arc::new(NullChannel { identity });
        let state = make_emit_state(channel, principal);
        EmitHook::new(
            state,
            Arc::new(Mutex::new(default_supervisor())),
            Arc::new(Mutex::new(Vec::new())),
            None,
            Some(runtime_state),
        )
    }

    /// `shutdown()` runs the JoinHandle to completion (no abort on the
    /// happy path), consumes the slot so a second call is a no-op, and is
    /// safe to invoke repeatedly.
    #[tokio::test]
    async fn shutdown_is_idempotent() {
        let hook = make_hook();
        let task_slot = hook.delta_task.clone();
        assert!(
            task_slot.lock().is_some(),
            "background task handle should be present before shutdown"
        );

        hook.shutdown().await;

        assert!(
            task_slot.lock().is_none(),
            "shutdown should consume the JoinHandle so a second call is a no-op"
        );

        // Calling shutdown again must not panic and must complete instantly.
        hook.shutdown().await;
    }

    /// `shutdown()` must work across `EmitHook` clones — the JoinHandle
    /// lives behind shared storage so the first caller wins and later
    /// callers see an empty slot.
    #[tokio::test]
    async fn shutdown_is_safe_across_hook_clones() {
        let hook = make_hook();
        let clone = hook.clone();

        clone.shutdown().await;

        assert!(
            hook.delta_task.lock().is_none(),
            "shutting down a clone must drain the shared JoinHandle slot"
        );
    }

    /// Deltas queued just before `shutdown()` must be flushed by the buffer
    /// task before it exits. This guards against the prior `abort()` race
    /// where streaming deltas in flight when the agent loop finished could
    /// be cancelled before publishing.
    #[tokio::test]
    async fn shutdown_drains_queued_deltas_before_exit() {
        let pubkey = agent_pubkey();
        let identity = PrincipalRef::Nostr {
            pubkey,
            kind: PrincipalKind::Agent,
            display_name: None,
        };
        let principal = identity.clone();
        let recorded: Arc<Mutex<Vec<Intent>>> = Arc::new(Mutex::new(Vec::new()));
        let channel: Arc<dyn Channel> = Arc::new(RecordingChannel {
            identity,
            intents: recorded.clone(),
        });
        let state = make_emit_state(channel, principal);
        let hook = EmitHook::new(
            state,
            Arc::new(Mutex::new(default_supervisor())),
            Arc::new(Mutex::new(Vec::new())),
            None,
            None,
        );

        // Queue several deltas without any sentence terminator so the
        // 250ms timer would normally be the only flush trigger. Shutdown
        // must drain them before exit.
        hook.delta_tx
            .send(DeltaSignal::Delta("hello ".to_string()))
            .unwrap();
        hook.delta_tx
            .send(DeltaSignal::Delta("world".to_string()))
            .unwrap();

        hook.shutdown().await;

        let intents = recorded.lock();
        let deltas: Vec<&str> = intents
            .iter()
            .filter_map(|i| match i {
                Intent::StreamTextDelta(d) => Some(d.delta.as_str()),
                _ => None,
            })
            .collect();
        let combined = deltas.join("");
        assert_eq!(
            combined, "hello world",
            "shutdown must flush queued deltas; got intents: {intents:?}"
        );
    }

    /// `on_completion_call` must terminate the agent loop when the runtime
    /// driver lease cannot be acquired. Continuing without the lease would
    /// allow a second concurrent execution to start.
    #[tokio::test(start_paused = true)]
    async fn on_completion_call_terminates_when_driver_unavailable() {
        // Build a runtime-state handle whose DB path cannot be opened, so
        // every `try_acquire_driver_once` errors out and `acquire_driver`
        // returns `Err` after exhausting its retry budget. `start_paused`
        // auto-advances the exponential backoff sleeps.
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("not-a-directory");
        std::fs::write(&blocker, b"").unwrap();
        let bad_db = blocker.join("conversation.db");
        let runtime_state = RuntimeStateHandle::new(
            bad_db,
            "conv1".to_string(),
            "agent1".to_string(),
            "exec1".to_string(),
        );

        let hook = make_hook_with_runtime(runtime_state);

        // Use any concrete CompletionModel for the type parameter; the
        // hook body never touches it. Pick one already pulled in by the
        // crate's dependency graph.
        let prompt = Message::user("test");
        let history: Vec<Message> = Vec::new();
        let action =
            <EmitHook as PromptHook<TestModel>>::on_completion_call(&hook, &prompt, &history)
                .await;

        match action {
            HookAction::Terminate { reason } => {
                assert!(
                    reason.contains("runtime driver lease unavailable"),
                    "termination reason should describe the lease failure, got: {reason}"
                );
            }
            HookAction::Continue => {
                panic!("expected Terminate after exhausted retries, got Continue");
            }
        }

        hook.shutdown().await;
    }

    /// Stand-in completion model so the `PromptHook<M>` trait method can
    /// be called. The hook body never invokes any model API, so the stub
    /// errors on every method — none of which the test path reaches.
    #[derive(Clone, serde::Serialize, serde::Deserialize)]
    struct TestModel;

    #[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
    struct TestStreamingResponse;

    impl rig::completion::GetTokenUsage for TestStreamingResponse {
        fn token_usage(&self) -> Option<rig::completion::Usage> {
            None
        }
    }

    impl CompletionModel for TestModel {
        type Response = serde_json::Value;
        type StreamingResponse = TestStreamingResponse;
        type Client = ();

        fn make(_client: &Self::Client, _model: impl Into<String>) -> Self {
            Self
        }

        async fn completion(
            &self,
            _request: rig::completion::CompletionRequest,
        ) -> Result<
            rig::completion::CompletionResponse<Self::Response>,
            rig::completion::CompletionError,
        > {
            Err(rig::completion::CompletionError::ProviderError(
                "test model".to_string(),
            ))
        }

        async fn stream(
            &self,
            _request: rig::completion::CompletionRequest,
        ) -> Result<
            rig::streaming::StreamingCompletionResponse<Self::StreamingResponse>,
            rig::completion::CompletionError,
        > {
            Err(rig::completion::CompletionError::ProviderError(
                "test model".to_string(),
            ))
        }
    }
}
