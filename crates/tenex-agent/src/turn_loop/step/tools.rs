use anyhow::{Result, anyhow};
use rig_core::agent::ToolCallHookAction;
use rig_core::completion::CompletionModel;

use crate::hook::EmitHook;
use crate::progress_monitor::ProgressMonitor;
use crate::tools::TurnToolRegistry;
use crate::tools::recording::{ToolCallRecord, ToolRecorder};

use super::{StepToolCall, ensure_continue};

pub(super) struct StepToolResults {
    pub records: Vec<ToolCallRecord>,
}

pub(super) async fn execute_step_tools<M>(
    registry: &TurnToolRegistry,
    emit: &EmitHook,
    progress: &ProgressMonitor<M>,
    recorder: &ToolRecorder,
    tool_calls: &[StepToolCall],
) -> Result<StepToolResults>
where
    M: CompletionModel + Send + Sync + 'static,
{
    let mut records = Vec::with_capacity(tool_calls.len());
    for tool_call in tool_calls {
        let tool_call_id = tool_call.provider_tool_call_id();
        let args = tool_call.function_arguments_string();
        let tool_name = tool_call.tool_call.function.name.clone();
        let provider_call_id = tool_call.tool_call.call_id.clone();
        // `is_error` flows through to projection via the `ToolCallRecord`s
        // emitted by `recorder.take_records()` / `tool_record(...)`. The
        // local result string here is only used to feed the progress
        // monitor and emit hooks (display/telemetry), not persistence.
        let result: String = match emit
            .on_tool_call(
                &tool_name,
                provider_call_id.clone(),
                &tool_call.internal_call_id,
                &args,
            )
            .await
        {
            ToolCallHookAction::Continue => match registry
                .execute(
                    &tool_name,
                    tool_call.tool_call.function.arguments.clone(),
                    Some(tool_call_id.clone()),
                    provider_call_id.clone(),
                )
                .await
            {
                Ok(result) => {
                    records.extend(recorder.take_records());
                    result
                }
                Err(error) => {
                    records.extend(recorder.take_records());
                    error.to_string()
                }
            },
            ToolCallHookAction::Skip { reason } => {
                records.push(tool_record(
                    &tool_call_id,
                    provider_call_id.clone(),
                    &tool_name,
                    tool_call.tool_call.function.arguments.clone(),
                    serde_json::Value::String(reason.clone()),
                    false,
                ));
                reason
            }
            ToolCallHookAction::Terminate { reason } => {
                return Err(anyhow!("agent loop terminated by tool hook: {reason}"));
            }
        };
        ensure_continue(
            progress
                .on_tool_result(
                    &tool_name,
                    provider_call_id.clone(),
                    &tool_call.internal_call_id,
                    &args,
                    &result,
                )
                .await,
        )?;
        ensure_continue(
            emit.on_tool_result(
                &tool_name,
                provider_call_id,
                &tool_call.internal_call_id,
                &args,
                &result,
            )
            .await,
        )?;
        // The tool result row is persisted by the caller via
        // record_step_tool_messages and read back by the next
        // projection — there is no in-memory side-channel.
    }
    Ok(StepToolResults { records })
}

impl StepToolCall {
    fn function_arguments_string(&self) -> String {
        self.tool_call.function.arguments.to_string()
    }
}

fn tool_record(
    call_id: &str,
    provider_call_id: Option<String>,
    tool_name: &str,
    args: serde_json::Value,
    result: serde_json::Value,
    is_error: bool,
) -> ToolCallRecord {
    ToolCallRecord {
        call_id: call_id.to_string(),
        provider_call_id,
        tool_name: tool_name.to_string(),
        args,
        result,
        is_error,
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    }
}
