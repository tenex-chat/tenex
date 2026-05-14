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
use tenex_context::ToolDef as ProjectionToolDef;
use tracing::{field, info_span, Instrument, Span};

use crate::injections::MessageInjectionTracker;
use crate::runtime_state::RuntimeStateHandle;

/// One captured tool invocation for a single agent turn.
#[derive(Debug, Clone)]
pub struct ToolCallRecord {
    /// Internal call id used to link assistant tool calls to tool results.
    /// The TENEX step loop supplies the provider tool id here; the legacy rig
    /// `ToolDyn` path still mints one because `ToolDyn::call` has no id input.
    pub call_id: String,
    /// Provider-native call id when the API carries a second id field.
    pub provider_call_id: Option<String>,
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
    pub(crate) fn new(
        tool: Box<dyn ToolDyn>,
        recorder: Arc<ToolRecorder>,
        runtime_state: Option<RuntimeStateHandle>,
        message_injections: Option<Arc<Mutex<MessageInjectionTracker>>>,
    ) -> Self {
        Self {
            inner: tool,
            recorder,
            runtime_state,
            message_injections,
        }
    }

    pub(crate) fn name(&self) -> String {
        self.inner.name()
    }

    pub(crate) async fn provider_definition(&self, prompt: String) -> ToolDefinition {
        self.inner.definition(prompt).await
    }

    pub(crate) fn projection_tool_def(&self) -> ProjectionToolDef {
        let name = self.name();
        ProjectionToolDef {
            preserve_results: preserve_results_for_tool(&name),
            name,
        }
    }

    pub(crate) async fn execute_with_ids(
        &self,
        args: serde_json::Value,
        tool_call_id: Option<String>,
        provider_call_id: Option<String>,
    ) -> Result<String, ToolError> {
        let tool_name = self.name();
        self.execute_json_string(
            args.to_string(),
            tool_call_id,
            provider_call_id,
            &tool_name,
            "turn_tool_registry",
        )
        .await
    }

    async fn execute_json_string(
        &self,
        args: String,
        tool_call_id: Option<String>,
        provider_call_id: Option<String>,
        tool_name: &str,
        source: &str,
    ) -> Result<String, ToolError> {
        let call_id = resolve_tool_call_id(tool_name, tool_call_id, source);
        let (result, record) = self
            .call_recorded(call_id, clean_provider_call_id(provider_call_id), args)
            .await;
        self.recorder.push(record);
        result
    }

    async fn call_recorded(
        &self,
        call_id: String,
        provider_call_id: Option<String>,
        args: String,
    ) -> (Result<String, ToolError>, ToolCallRecord) {
        let tool_name = self.inner.name();
        let args_json: serde_json::Value =
            serde_json::from_str(&args).unwrap_or_else(|_| serde_json::Value::String(args.clone()));
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        if let Some(state) = &self.runtime_state {
            state.start_tool(&call_id, &tool_name, &args_json);
        }

        let span = info_span!(
            "execute_tool",
            otel.name = format!("execute_tool {}", tool_name),
            otel.kind = "internal",
            "gen_ai.tool.name" = %tool_name,
            "gen_ai.tool.call.id" = %call_id,
            "gen_ai.tool.provider_call.id" = provider_call_id.as_deref().unwrap_or(""),
            "gen_ai.tool.type" = "function",
            "gen_ai.tool.call.arguments" = %args_json,
            "gen_ai.tool.call.result" = field::Empty,
            "gen_ai.tool.is_error" = field::Empty,
            "error.type" = field::Empty,
            "delegated.conversation.id" = field::Empty,
            "delegated.agent.pubkey" = field::Empty,
            "delegated.event.id" = field::Empty,
        );

        let mut result = self.inner.call(args).instrument(span.clone()).await;

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

        record_tool_outcome(&span, &result_json, &result);

        let record = ToolCallRecord {
            call_id,
            provider_call_id,
            tool_name,
            args: args_json,
            result: result_json,
            is_error,
            timestamp_ms,
        };

        (result, record)
    }
}

fn preserve_results_for_tool(name: &str) -> bool {
    matches!(
        name,
        "delegate"
            | "delegate_crossproject"
            | "delegate_followup"
            | "self_delegate"
            | "load_skill"
            | "skills_set"
    )
}

impl ToolDyn for RecordingTool {
    fn name(&self) -> String {
        self.inner.name()
    }

    fn definition<'a>(&'a self, prompt: String) -> WasmBoxedFuture<'a, ToolDefinition> {
        Box::pin(self.provider_definition(prompt))
    }

    fn call<'a>(&'a self, args: String) -> WasmBoxedFuture<'a, Result<String, ToolError>> {
        Box::pin(async move {
            let tool_name = self.inner.name();
            self.execute_json_string(args, None, None, &tool_name, "rig_tool_dyn")
                .await
        })
    }
}

fn resolve_tool_call_id(tool_name: &str, tool_call_id: Option<String>, source: &str) -> String {
    if let Some(id) = tool_call_id.filter(|id| !id.is_empty()) {
        return id;
    }
    let synthetic = uuid::Uuid::new_v4().to_string();
    tracing::debug!(
        tool_name,
        source,
        synthetic_call_id = %synthetic,
        "minted synthetic tool call id"
    );
    synthetic
}

fn clean_provider_call_id(provider_call_id: Option<String>) -> Option<String> {
    provider_call_id.filter(|id| !id.is_empty())
}

fn record_tool_outcome(
    span: &Span,
    result_json: &serde_json::Value,
    result: &Result<String, ToolError>,
) {
    span.record(
        "gen_ai.tool.call.result",
        serde_json::to_string(result_json)
            .unwrap_or_default()
            .as_str(),
    );
    if let Err(err) = result {
        span.record("gen_ai.tool.is_error", true);
        span.record("error.type", std::any::type_name_of_val(err));
        span.in_scope(|| tenex_telemetry::record_current_error(err));
    }
}

fn append_tool_result_reminder(output: &mut String, reminder: &str) {
    if !output.is_empty() {
        output.push_str("\n\n");
    }
    output.push_str(reminder);
}
