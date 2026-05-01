//! Tool-call recorder.
//!
//! Wraps a `Box<dyn ToolDyn>` so every invocation rig makes during the
//! agent's inner loop is captured (call id + args + result) into a shared
//! [`ToolRecorder`]. After the turn ends the agent persists those records
//! into `tool_messages`, and writes the matching `tool_calls` slice on the
//! assistant's `prompt_history` row so projection can reproduce the
//! call→result pairing on the next turn.
//!
//! Recording lives at the `ToolDyn` layer (rather than `Tool`) because rig
//! already serialises args/output to/from `String` at that boundary —
//! recording at `Tool` would force a `Serialize` bound on every tool's
//! `Args` type for no extra information.

use std::sync::{Arc, Mutex};

use rig::completion::ToolDefinition;
use rig::tool::{ToolDyn, ToolError};
use rig::wasm_compat::WasmBoxedFuture;
use tracing::{info_span, Instrument};

use crate::injections::MessageInjectionTracker;
use crate::runtime_state::RuntimeStateHandle;

/// One captured tool invocation for a single agent turn.
#[derive(Debug, Clone)]
pub struct ToolCallRecord {
    /// Synthetic call id minted at recording time. Rig's `ToolDyn::call`
    /// signature does not surface the provider's tool_use id, so the agent
    /// links call ↔ result via this minted id end-to-end (assistant
    /// `tool_calls[].id` and `tool_messages.tool_call_id`).
    pub call_id: String,
    pub tool_name: String,
    pub args: serde_json::Value,
    pub result: serde_json::Value,
    pub is_error: bool,
    pub timestamp_ms: i64,
}

/// Shared per-turn recorder. Cloned across every wrapped tool; drained by
/// the agent runner after the inner loop returns.
#[derive(Default)]
pub struct ToolRecorder {
    records: Mutex<Vec<ToolCallRecord>>,
}

impl ToolRecorder {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn take_records(&self) -> Vec<ToolCallRecord> {
        std::mem::take(&mut *self.records.lock().unwrap())
    }

    fn push(&self, record: ToolCallRecord) {
        self.records.lock().unwrap().push(record);
    }
}

/// `ToolDyn` wrapper that captures every call into a shared [`ToolRecorder`].
pub(crate) struct RecordingTool {
    inner: Box<dyn ToolDyn>,
    recorder: Arc<ToolRecorder>,
    runtime_state: Option<RuntimeStateHandle>,
    message_injections: Option<Arc<Mutex<MessageInjectionTracker>>>,
}

impl RecordingTool {
    /// Wrap an erased tool so its calls are captured into `recorder`.
    pub(crate) fn wrap_dyn(
        tool: Box<dyn ToolDyn>,
        recorder: Arc<ToolRecorder>,
        runtime_state: Option<RuntimeStateHandle>,
        message_injections: Option<Arc<Mutex<MessageInjectionTracker>>>,
    ) -> Box<dyn ToolDyn> {
        Box::new(Self {
            inner: tool,
            recorder,
            runtime_state,
            message_injections,
        })
    }
}

impl ToolDyn for RecordingTool {
    fn name(&self) -> String {
        self.inner.name()
    }

    fn definition<'a>(&'a self, prompt: String) -> WasmBoxedFuture<'a, ToolDefinition> {
        self.inner.definition(prompt)
    }

    fn call<'a>(&'a self, args: String) -> WasmBoxedFuture<'a, Result<String, ToolError>> {
        Box::pin(async move {
            let call_id = uuid::Uuid::new_v4().to_string();
            let tool_name = self.inner.name();
            let args_json: serde_json::Value = serde_json::from_str(&args)
                .unwrap_or_else(|_| serde_json::Value::String(args.clone()));
            let timestamp_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);

            if let Some(state) = &self.runtime_state {
                state.start_tool(&call_id, &tool_name, &args_json);
            }

            let mut result = self
                .inner
                .call(args)
                .instrument(info_span!("tenex.agent.tool_call", tool.name = %tool_name))
                .await;

            if let Some(state) = &self.runtime_state {
                state.finish_tool(&call_id);
                if let Ok(output) = &mut result {
                    if let Some(reminder) = state.render_active_tools_reminder() {
                        append_tool_result_reminder(output, &reminder);
                    }
                }
            }
            if let Some(injections) = &self.message_injections {
                if let Ok(output) = &mut result {
                    let reminder = injections.lock().unwrap().take_new_messages();
                    if let Some(reminder) = reminder {
                        append_tool_result_reminder(output, &reminder);
                    }
                }
            }

            let (result_json, is_error) = match &result {
                Ok(s) => {
                    let v = serde_json::from_str::<serde_json::Value>(s)
                        .unwrap_or_else(|_| serde_json::Value::String(s.clone()));
                    (v, false)
                }
                Err(e) => (serde_json::Value::String(e.to_string()), true),
            };

            self.recorder.push(ToolCallRecord {
                call_id,
                tool_name,
                args: args_json,
                result: result_json,
                is_error,
                timestamp_ms,
            });

            result
        })
    }
}

fn append_tool_result_reminder(output: &mut String, reminder: &str) {
    if !output.is_empty() {
        output.push_str("\n\n");
    }
    output.push_str(reminder);
}
