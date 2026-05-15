use anyhow::{Context, Result};
use futures::StreamExt;
use rig::OneOrMany;
use rig::completion::message::{Reasoning, ReasoningContent};
use rig::completion::{
    CompletionModel, CompletionRequest, GetTokenUsage, Message as RigMessage, Usage,
};
use rig::streaming::{StreamedAssistantContent, ToolCallDeltaContent};

use tenex_context::{CompactionOverride, Message as CtxMessage, ReasoningBlock};

use crate::agent_bootstrap::AgentBootstrap;
use crate::cassette_client::RecordingModel;
use crate::hook::EmitHook;
use crate::progress_monitor::ProgressMonitor;
use crate::tools::TurnToolRegistry;

use super::projection::project_step_messages;
use super::{StepOutput, StepToolCall, ensure_continue};

pub(super) async fn run_provider_step<M>(
    boot: &AgentBootstrap,
    model: RecordingModel<M>,
    emit: &EmitHook,
    progress: &ProgressMonitor<RecordingModel<M>>,
    registry: &TurnToolRegistry,
    provider_tools: &[rig::completion::ToolDefinition],
    turn_prompt: &RigMessage,
    turn_text: &str,
    in_turn_tail: &[CtxMessage],
    compaction_override: Option<CompactionOverride>,
) -> Result<StepOutput>
where
    M: CompletionModel + Send + Sync + 'static,
    M::StreamingResponse: GetTokenUsage + Clone + Send + Sync + Unpin + 'static,
{
    let rig_messages = project_step_messages(
        boot,
        registry,
        turn_prompt,
        turn_text,
        in_turn_tail,
        compaction_override,
    )
    .await?;
    let prompt = rig_messages
        .last()
        .cloned()
        .context("projected request must have at least one message")?;
    let history = rig_messages[..rig_messages.len().saturating_sub(1)].to_vec();
    ensure_continue(progress.on_completion_call(&prompt, &history).await)?;
    ensure_continue(emit.on_completion_call(&prompt, &history).await)?;

    let request = CompletionRequest {
        model: None,
        preamble: None,
        chat_history: OneOrMany::many(rig_messages)?,
        documents: Vec::new(),
        tools: provider_tools.to_vec(),
        temperature: None,
        max_tokens: Some(16_384),
        tool_choice: None,
        additional_params: None,
        output_schema: None,
    };

    let mut stream = match model.stream(request).await {
        Ok(stream) => stream,
        Err(error) => {
            emit.abort_stream();
            return Err(error.into());
        }
    };
    let mut text = String::new();
    let mut reasoning = Vec::new();
    let mut tool_calls = Vec::new();
    let mut usage = Usage::new();
    let mut saw_final = false;

    while let Some(item) = stream.next().await {
        let item = match item {
            Ok(item) => item,
            Err(error) => {
                emit.abort_stream();
                return Err(error.into());
            }
        };
        match item {
            StreamedAssistantContent::Text(delta) => {
                text.push_str(&delta.text);
                ensure_continue(emit.on_text_delta(&delta.text, &text).await)?;
            }
            StreamedAssistantContent::Reasoning(item) => {
                reasoning.extend(reasoning_blocks(item));
            }
            StreamedAssistantContent::ReasoningDelta {
                id,
                reasoning: delta,
            } => {
                if !delta.is_empty() {
                    reasoning.push(ReasoningBlock {
                        id,
                        text: delta,
                        signature: None,
                    });
                }
            }
            StreamedAssistantContent::ToolCallDelta {
                id,
                internal_call_id,
                content,
            } => {
                let (name, delta) = tool_delta_parts(&content);
                ensure_continue(
                    emit.on_tool_call_delta(&id, &internal_call_id, name.as_deref(), &delta)
                        .await,
                )?;
            }
            StreamedAssistantContent::ToolCall {
                tool_call,
                internal_call_id,
            } => tool_calls.push(StepToolCall::new(tool_call, internal_call_id)),
            StreamedAssistantContent::Final(response) => {
                saw_final = true;
                if let Some(step_usage) = response.token_usage() {
                    usage = step_usage;
                }
                ensure_continue(
                    emit.on_stream_completion_response_finish(&prompt, &response)
                        .await,
                )?;
            }
        }
    }
    if !saw_final {
        ensure_continue(emit.on_stream_end_without_response(&prompt).await)?;
    }

    Ok(StepOutput {
        text,
        reasoning,
        tool_calls,
        usage,
    })
}

fn reasoning_blocks(item: Reasoning) -> Vec<ReasoningBlock> {
    let id = item.id;
    item.content
        .into_iter()
        .filter_map(|content| match content {
            ReasoningContent::Text { text, signature } => Some(ReasoningBlock {
                id: id.clone(),
                text,
                signature,
            }),
            ReasoningContent::Summary(text) => Some(ReasoningBlock {
                id: id.clone(),
                text,
                signature: None,
            }),
            ReasoningContent::Redacted { data } => Some(ReasoningBlock {
                id: id.clone(),
                text: data,
                signature: None,
            }),
            ReasoningContent::Encrypted(_) => None,
            _ => None,
        })
        .collect()
}

fn tool_delta_parts(content: &ToolCallDeltaContent) -> (Option<String>, String) {
    match content {
        ToolCallDeltaContent::Name(name) => (Some(name.clone()), name.clone()),
        ToolCallDeltaContent::Delta(delta) => (None, delta.clone()),
    }
}
