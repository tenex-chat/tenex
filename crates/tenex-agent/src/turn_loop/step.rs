mod projection;
mod stream;
mod tools;

use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::{Result, anyhow};
use rig_core::agent::HookAction;
use rig_core::completion::message::ToolCall as RigToolCall;
use rig_core::completion::{CompletionModel, GetTokenUsage, Usage};
use tracing::{Instrument, info_span};

use tenex_context::{Message as CtxMessage, ReasoningBlock, ToolCall as CtxToolCall};

use crate::agent_bootstrap::AgentBootstrap;
use crate::hook::EmitHook;
use crate::llm_retry::is_transient_server_error;
use crate::progress_monitor::ProgressMonitor;
use crate::tools::TurnToolRegistry;
use crate::tools::recording::ToolRecorder;

use super::persistence;

pub(super) struct StepLoopResult {
    pub response: String,
    pub usage: Usage,
    /// `messages.id` of the persisted terminal-step assistant row, when a
    /// conversation store is configured. Used by the turn loop to stamp
    /// `nostr_event_id` once the outbound publish returns the event id,
    /// so the runtime's own writeback dedups via the partial unique index.
    pub terminal_assistant_row_id: Option<i64>,
}

pub(super) struct StepOutput {
    text: String,
    reasoning: Vec<ReasoningBlock>,
    tool_calls: Vec<StepToolCall>,
    usage: Usage,
}

#[derive(Clone)]
pub(super) struct StepToolCall {
    tool_call: RigToolCall,
    internal_call_id: String,
    tool_call_id: String,
}

impl StepToolCall {
    fn new(tool_call: RigToolCall, internal_call_id: String) -> Self {
        let tool_call_id = resolve_tool_call_id(&tool_call, &internal_call_id);
        Self {
            tool_call,
            internal_call_id,
            tool_call_id,
        }
    }

    fn provider_tool_call_id(&self) -> String {
        self.tool_call_id.clone()
    }
}

pub(super) async fn run_step_loop<M>(
    boot: &mut AgentBootstrap,
    model: M,
    registry: TurnToolRegistry,
    recorder: std::sync::Arc<ToolRecorder>,
) -> Result<StepLoopResult>
where
    M: CompletionModel + Clone + Send + Sync + 'static,
    M::StreamingResponse: GetTokenUsage + Clone + Send + Sync + Unpin + 'static,
{
    let progress = ProgressMonitor::new(model.clone());
    let provider_tools = registry
        .provider_definitions(boot.original_task.clone())
        .await;
    let mut total_usage = Usage::new();

    for step_index in 1..=crate::progress_monitor::RIG_AGENT_TURN_FUSE {
        let step_span = info_span!("tenex.agent.step", step = step_index as u64);
        let output = match stream::run_provider_step(
            boot,
            model.clone(),
            &boot.hook,
            &progress,
            &registry,
            &provider_tools,
            None,
        )
        .instrument(step_span)
        .await
        {
            Ok(output) => output,
            Err(error) if super::error_classify::is_context_window_exceeded(&error) => {
                tracing::warn!(
                    error = %error,
                    step = step_index,
                    "provider rejected prompt as too long; retrying once with tighter compaction"
                );
                let retry_span = info_span!(
                    "tenex.agent.step_retry",
                    step = step_index as u64,
                    reason = "context_window_exceeded"
                );
                stream::run_provider_step(
                    boot,
                    model.clone(),
                    &boot.hook,
                    &progress,
                    &registry,
                    &provider_tools,
                    Some(tenex_context::CompactionOverride {
                        threshold_ratio: 0.5,
                    }),
                )
                .instrument(retry_span)
                .await?
            }
            Err(error) if is_transient_server_error(&error) => {
                tracing::warn!(
                    error = %error,
                    step = step_index,
                    "transient provider error on first attempt; entering retry loop"
                );
                run_step_with_transient_retry(
                    boot,
                    &boot.hook,
                    model.clone(),
                    &progress,
                    &registry,
                    &provider_tools,
                )
                .await?
            }
            Err(error) => return Err(error),
        };

        add_usage(&mut total_usage, output.usage);

        let assistant_message = assistant_message_from_step(&output);
        let assistant_row_id = if let Some(store) = boot.conv_store.as_ref() {
            Some(persistence::record_step_assistant(
                boot,
                store,
                &assistant_message,
                &output.usage,
            )?)
        } else {
            None
        };

        if output.tool_calls.is_empty() {
            return Ok(StepLoopResult {
                response: output.text,
                usage: total_usage,
                terminal_assistant_row_id: assistant_row_id,
            });
        }

        ensure_continue(boot.hook.flush_pending_text().await)?;

        let tool_results = tools::execute_step_tools(
            &registry,
            &boot.hook,
            &progress,
            &recorder,
            &output.tool_calls,
        )
        .await?;
        if let Some(store) = boot.conv_store.as_ref() {
            let parent_id = assistant_row_id.ok_or_else(|| {
                anyhow!(
                    "record_step_assistant returned no row id for a step that emitted tool calls"
                )
            })?;
            persistence::record_step_tool_messages(
                store,
                &boot.conversation_id,
                &boot.pubkey_hex,
                parent_id,
                &tool_results.records,
            )?;
        }

        // `no_response` sets this flag during tool execution. It is a
        // terminal silent completion: the turn ends here without feeding
        // the tool results back to the model for another provider step.
        if boot.suppress_response.load(Ordering::Acquire) {
            return Ok(StepLoopResult {
                response: output.text,
                usage: total_usage,
                terminal_assistant_row_id: assistant_row_id,
            });
        }
    }

    Err(anyhow!(
        "agent exceeded max provider steps ({})",
        crate::progress_monitor::RIG_AGENT_TURN_FUSE
    ))
}

/// Retry `run_provider_step` on transient server errors with exponential
/// backoff. Publishes a `StreamTextDeltaIntent` status message between
/// each attempt so the user can see what is happening. If all retries are
/// exhausted the last transient error is returned.
async fn run_step_with_transient_retry<M>(
    boot: &AgentBootstrap,
    hook: &EmitHook,
    model: M,
    progress: &ProgressMonitor<M>,
    registry: &TurnToolRegistry,
    provider_tools: &[rig_core::completion::ToolDefinition],
) -> Result<StepOutput>
where
    M: CompletionModel + Clone + Send + Sync + 'static,
    M::StreamingResponse: GetTokenUsage + Clone + Send + Sync + Unpin + 'static,
{
    const DELAYS_SECS: &[u64] = &[10, 20, 40, 80, 80];
    let max = DELAYS_SECS.len();
    let mut last_err: Option<anyhow::Error> = None;

    for (attempt, &delay_secs) in DELAYS_SECS.iter().enumerate() {
        let attempt_num = attempt + 1;
        let status = format!(
            "\u{26a0}\u{fe0f} Model temporarily unavailable, retrying in {delay_secs}s \
             (attempt {attempt_num}/{max})\u{2026}"
        );
        hook.publish_status(&status).await;
        tracing::warn!(
            delay_secs,
            attempt = attempt_num,
            max_attempts = max,
            "transient provider error; retrying after backoff"
        );
        tokio::time::sleep(Duration::from_secs(delay_secs)).await;

        match stream::run_provider_step(boot, model.clone(), hook, progress, registry, provider_tools, None).await
        {
            Ok(output) => return Ok(output),
            Err(e) if attempt_num < max && is_transient_server_error(&e) => {
                tracing::warn!(error = %e, attempt = attempt_num, "transient error persists");
                last_err = Some(e);
            }
            Err(e) => return Err(e),
        }
    }

    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("transient error retry exhausted")))
}

fn assistant_message_from_step(output: &StepOutput) -> CtxMessage {
    CtxMessage::Assistant {
        content: output.text.clone(),
        reasoning: output.reasoning.clone(),
        tool_calls: output
            .tool_calls
            .iter()
            .map(|tool_call| CtxToolCall {
                id: tool_call.provider_tool_call_id(),
                provider_call_id: tool_call.tool_call.call_id.clone(),
                name: tool_call.tool_call.function.name.clone(),
                arguments: tool_call.tool_call.function.arguments.clone(),
            })
            .collect(),
    }
}

pub(super) fn ensure_continue(action: HookAction) -> Result<()> {
    match action {
        HookAction::Continue => Ok(()),
        HookAction::Terminate { reason } => Err(anyhow!("agent loop terminated by hook: {reason}")),
    }
}

fn add_usage(total: &mut Usage, step: Usage) {
    total.input_tokens += step.input_tokens;
    total.output_tokens += step.output_tokens;
    total.total_tokens += step.total_tokens;
    total.cached_input_tokens += step.cached_input_tokens;
    total.cache_creation_input_tokens += step.cache_creation_input_tokens;
}

fn resolve_tool_call_id(tool_call: &RigToolCall, internal_call_id: &str) -> String {
    if !tool_call.id.is_empty() {
        return tool_call.id.clone();
    }
    tracing::debug!(
        internal_call_id,
        tool_name = %tool_call.function.name,
        "provider omitted tool call id; using rig internal call id"
    );
    internal_call_id.to_string()
}
