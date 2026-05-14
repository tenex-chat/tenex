mod projection;
mod stream;
mod tools;

use anyhow::{Result, anyhow};
use rig::agent::HookAction;
use rig::completion::message::ToolCall as RigToolCall;
use rig::completion::{CompletionModel, GetTokenUsage, Message as RigMessage, Usage};
use tracing::{Instrument, info_span};

use tenex_context::{Message as CtxMessage, ReasoningBlock, ToolCall as CtxToolCall};

use crate::agent_bootstrap::AgentBootstrap;
use crate::cassette_client::RecordingModel;
use crate::progress_monitor::ProgressMonitor;
use crate::tools::TurnToolRegistry;
use crate::tools::recording::ToolRecorder;

use super::persistence;

pub(super) struct StepLoopResult {
    pub response: String,
    pub usage: Usage,
    pub tail: Vec<CtxMessage>,
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
    model: RecordingModel<M>,
    turn_prompt: RigMessage,
    turn_text: &str,
    prefix_tail: &[CtxMessage],
    registry: TurnToolRegistry,
    recorder: std::sync::Arc<ToolRecorder>,
) -> Result<StepLoopResult>
where
    M: CompletionModel + Send + Sync + 'static,
    M::StreamingResponse: GetTokenUsage + Clone + Send + Sync + Unpin + 'static,
{
    let progress = ProgressMonitor::new(model.clone());
    let provider_tools = registry.provider_definitions(turn_text.to_string()).await;
    let mut in_turn_tail = prefix_tail.to_vec();
    in_turn_tail.push(CtxMessage::User {
        content: turn_text.to_string(),
    });
    let mut total_usage = Usage::new();

    if let Some(store) = boot.conv_store.as_ref() {
        persistence::record_step_user(store, &boot.conversation_id, &boot.pubkey_hex, turn_text);
    }

    for step_index in 1..=crate::progress_monitor::RIG_AGENT_TURN_FUSE {
        let step_span = info_span!("tenex.agent.step", step = step_index as u64);
        let output = match stream::run_provider_step(
            boot,
            model.clone(),
            &boot.hook,
            &progress,
            &registry,
            &provider_tools,
            &turn_prompt,
            turn_text,
            &in_turn_tail,
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
                    &turn_prompt,
                    turn_text,
                    &in_turn_tail,
                    Some(tenex_context::CompactionOverride {
                        threshold_ratio: 0.5,
                    }),
                )
                .instrument(retry_span)
                .await?
            }
            Err(error) => return Err(error),
        };

        add_usage(&mut total_usage, output.usage);

        let assistant_message = assistant_message_from_step(&output);
        if let Some(store) = boot.conv_store.as_ref() {
            persistence::record_step_assistant(
                boot,
                store,
                assistant_message.clone(),
                &output.usage,
            );
        }
        in_turn_tail.push(assistant_message);

        if output.tool_calls.is_empty() {
            return Ok(StepLoopResult {
                response: output.text,
                usage: total_usage,
                tail: in_turn_tail,
            });
        }

        let tool_results = tools::execute_step_tools(
            &registry,
            &boot.hook,
            &progress,
            &recorder,
            &output.tool_calls,
        )
        .await?;
        if let Some(store) = boot.conv_store.as_ref() {
            persistence::record_step_tool_messages(
                store,
                &boot.conversation_id,
                &boot.pubkey_hex,
                &tool_results.records,
            );
        }
        in_turn_tail.extend(tool_results.messages);
    }

    Err(anyhow!(
        "agent exceeded max provider steps ({})",
        crate::progress_monitor::RIG_AGENT_TURN_FUSE
    ))
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
