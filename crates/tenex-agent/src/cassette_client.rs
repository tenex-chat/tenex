use std::time::Instant;

use futures::StreamExt;
use rig::client::CompletionClient;
use rig::completion::{
    CompletionError, CompletionModel, CompletionRequest, CompletionResponse, GetTokenUsage,
};
use rig::message::AssistantContent;
use rig::streaming::{
    RawStreamingChoice, RawStreamingToolCall, StreamedAssistantContent,
    StreamingCompletionResponse, StreamingResult,
};
use tracing::{field, info_span, Instrument, Span};

use crate::cassette::{CassetteRecorder, CassetteToolCall};
use crate::cassette_request::request_debug;

#[derive(Clone)]
pub struct RecordingClient<C> {
    inner: C,
    recorder: Option<CassetteRecorder>,
    provider: &'static str,
}

#[derive(Clone)]
pub struct RecordingModel<M> {
    inner: M,
    recorder: Option<CassetteRecorder>,
    provider: &'static str,
    model_id: String,
}

impl<C> RecordingClient<C> {
    pub fn new(inner: C, recorder: Option<CassetteRecorder>, provider: &'static str) -> Self {
        Self {
            inner,
            recorder,
            provider,
        }
    }
}

impl<M> RecordingModel<M> {
    pub fn map_inner<N>(self, f: impl FnOnce(M) -> N) -> RecordingModel<N> {
        RecordingModel {
            inner: f(self.inner),
            recorder: self.recorder,
            provider: self.provider,
            model_id: self.model_id,
        }
    }
}

impl<C> CompletionClient for RecordingClient<C>
where
    C: CompletionClient + Clone,
    <C::CompletionModel as CompletionModel>::StreamingResponse: 'static,
{
    type CompletionModel = RecordingModel<C::CompletionModel>;
}

#[allow(refining_impl_trait)]
impl<M> CompletionModel for RecordingModel<M>
where
    M: CompletionModel,
    M::StreamingResponse: 'static,
{
    type Response = M::Response;
    type StreamingResponse = M::StreamingResponse;
    type Client = RecordingClient<M::Client>;

    fn make(client: &Self::Client, model: impl Into<String>) -> Self {
        let model_id = model.into();
        Self {
            inner: M::make(&client.inner, model_id.clone()),
            recorder: client.recorder.clone(),
            provider: client.provider,
            model_id,
        }
    }

    async fn completion(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse<Self::Response>, CompletionError> {
        let turn = self.recorder.as_ref().map(CassetteRecorder::next_turn);
        let request_debug = request_debug(&request);
        let input_messages = serde_json::to_string(&request.chat_history).unwrap_or_default();
        let span = info_span!(
            "chat",
            otel.name = format!("chat {}", self.model_id),
            otel.kind = "client",
            "gen_ai.provider.name" = self.provider,
            "gen_ai.operation.name" = "chat",
            "gen_ai.request.model" = %self.model_id,
            "gen_ai.input.messages" = %input_messages,
            "gen_ai.output.messages" = field::Empty,
            "gen_ai.response.model" = field::Empty,
            "gen_ai.response.id" = field::Empty,
            "gen_ai.response.finish_reasons" = field::Empty,
            "gen_ai.usage.input_tokens" = field::Empty,
            "gen_ai.usage.output_tokens" = field::Empty,
            "gen_ai.usage.cache_read.input_tokens" = field::Empty,
            "gen_ai.usage.cache_creation.input_tokens" = field::Empty,
        );
        let started = Instant::now();
        let result = self
            .inner
            .completion(request)
            .instrument(span.clone())
            .await;
        match result {
            Ok(response) => {
                span.in_scope(|| record_completion_response(&response));
                if let (Some(recorder), Some(turn)) = (&self.recorder, turn) {
                    let (content, tool_calls) =
                        assistant_items_to_cassette(response.choice.clone());
                    recorder.record_turn(
                        turn,
                        started.elapsed().as_millis() as u64,
                        &request_debug,
                        &content,
                        &tool_calls,
                    );
                }
                Ok(response)
            }
            Err(err) => {
                span.in_scope(|| tenex_telemetry::record_current_error(&err));
                Err(err)
            }
        }
    }

    async fn stream(
        &self,
        request: CompletionRequest,
    ) -> Result<StreamingCompletionResponse<Self::StreamingResponse>, CompletionError> {
        let turn = self.recorder.as_ref().map(CassetteRecorder::next_turn);
        let request_debug = request_debug(&request);
        let input_messages = serde_json::to_string(&request.chat_history).unwrap_or_default();
        let span = info_span!(
            "chat",
            otel.name = format!("chat {}", self.model_id),
            otel.kind = "client",
            "gen_ai.provider.name" = self.provider,
            "gen_ai.operation.name" = "chat",
            "gen_ai.request.model" = %self.model_id,
            "gen_ai.request.stream" = true,
            "gen_ai.input.messages" = %input_messages,
            "gen_ai.output.messages" = field::Empty,
            "gen_ai.response.model" = field::Empty,
            "gen_ai.response.id" = field::Empty,
            "gen_ai.response.finish_reasons" = field::Empty,
            "gen_ai.response.time_to_first_chunk" = field::Empty,
            "gen_ai.usage.input_tokens" = field::Empty,
            "gen_ai.usage.output_tokens" = field::Empty,
            "gen_ai.usage.cache_read.input_tokens" = field::Empty,
            "gen_ai.usage.cache_creation.input_tokens" = field::Empty,
        );
        let started = Instant::now();
        let inner = match self.inner.stream(request).instrument(span.clone()).await {
            Ok(inner) => inner,
            Err(err) => {
                span.in_scope(|| tenex_telemetry::record_current_error(&err));
                return Err(err);
            }
        };
        let state = StreamState {
            inner,
            recorder: self.recorder.clone(),
            turn,
            started,
            request_debug,
            content: String::new(),
            tool_calls: Vec::new(),
            recorded: false,
            first_chunk_recorded: false,
            span,
        };
        let stream = futures::stream::unfold(state, |mut state| async move {
            let next = state.inner.next().instrument(state.span.clone()).await;
            let span = state.span.clone();
            match next {
                Some(Ok(item)) => {
                    if !state.first_chunk_recorded {
                        span.record(
                            "gen_ai.response.time_to_first_chunk",
                            state.started.elapsed().as_millis() as i64,
                        );
                        state.first_chunk_recorded = true;
                    }
                    let raw = streamed_to_raw(item, &mut state.content, &mut state.tool_calls);
                    if let RawStreamingChoice::FinalResponse(response) = &raw {
                        record_streaming_final(&span, response);
                        record_once(
                            &state.recorder,
                            state.turn,
                            state.started,
                            &state.request_debug,
                            &state.content,
                            &state.tool_calls,
                        );
                        state.recorded = true;
                    }
                    Some((Ok(raw), state))
                }
                Some(Err(err)) => {
                    span.in_scope(|| tenex_telemetry::record_current_error(&err));
                    Some((Err(err), state))
                }
                None => {
                    if !state.recorded {
                        record_once(
                            &state.recorder,
                            state.turn,
                            state.started,
                            &state.request_debug,
                            &state.content,
                            &state.tool_calls,
                        );
                    }
                    None
                }
            }
        });
        Ok(StreamingCompletionResponse::stream(
            Box::pin(stream) as StreamingResult<_>
        ))
    }
}

struct StreamState<S> {
    inner: S,
    recorder: Option<CassetteRecorder>,
    turn: Option<usize>,
    started: Instant,
    request_debug: String,
    content: String,
    tool_calls: Vec<CassetteToolCall>,
    recorded: bool,
    first_chunk_recorded: bool,
    span: Span,
}

fn record_completion_response<T>(response: &CompletionResponse<T>) {
    let span = Span::current();
    let output = serde_json::to_string(&response.choice).unwrap_or_default();
    span.record("gen_ai.output.messages", output.as_str());
    if let Some(id) = response.message_id.as_deref() {
        span.record("gen_ai.response.id", id);
    }
    let usage = response.usage;
    span.record("gen_ai.usage.input_tokens", usage.input_tokens as i64);
    span.record("gen_ai.usage.output_tokens", usage.output_tokens as i64);
    span.record(
        "gen_ai.usage.cache_read.input_tokens",
        usage.cached_input_tokens as i64,
    );
    span.record(
        "gen_ai.usage.cache_creation.input_tokens",
        usage.cache_creation_input_tokens as i64,
    );
    span.record("gen_ai.response.finish_reasons", finish_reasons(response));
}

fn record_streaming_final<R>(span: &Span, response: &R)
where
    R: GetTokenUsage,
{
    if let Some(usage) = response.token_usage() {
        span.record("gen_ai.usage.input_tokens", usage.input_tokens as i64);
        span.record("gen_ai.usage.output_tokens", usage.output_tokens as i64);
        span.record(
            "gen_ai.usage.cache_read.input_tokens",
            usage.cached_input_tokens as i64,
        );
        span.record(
            "gen_ai.usage.cache_creation.input_tokens",
            usage.cache_creation_input_tokens as i64,
        );
    }
}

fn finish_reasons<T>(response: &CompletionResponse<T>) -> &'static str {
    let mut had_tool_call = false;
    let mut had_text = false;
    for item in response.choice.iter() {
        match item {
            AssistantContent::ToolCall(_) => had_tool_call = true,
            AssistantContent::Text(_) => had_text = true,
            _ => {}
        }
    }
    if had_tool_call {
        "tool_calls"
    } else if had_text {
        "stop"
    } else {
        "unknown"
    }
}

fn record_once(
    recorder: &Option<CassetteRecorder>,
    turn: Option<usize>,
    started: Instant,
    request_debug: &str,
    content: &str,
    tool_calls: &[CassetteToolCall],
) {
    if let (Some(recorder), Some(turn)) = (recorder, turn) {
        recorder.record_turn(
            turn,
            started.elapsed().as_millis() as u64,
            request_debug,
            content,
            tool_calls,
        );
    }
}

fn assistant_items_to_cassette(
    choice: rig::OneOrMany<AssistantContent>,
) -> (String, Vec<CassetteToolCall>) {
    let mut content = String::new();
    let mut tool_calls = Vec::new();
    for item in choice {
        collect_assistant_item(&item, &mut content, &mut tool_calls);
    }
    (content, tool_calls)
}

fn streamed_to_raw<R>(
    item: StreamedAssistantContent<R>,
    content: &mut String,
    tool_calls: &mut Vec<CassetteToolCall>,
) -> RawStreamingChoice<R>
where
    R: Clone + Unpin + GetTokenUsage,
{
    match item {
        StreamedAssistantContent::Text(text) => {
            content.push_str(&text.text);
            RawStreamingChoice::Message(text.text)
        }
        StreamedAssistantContent::ToolCall {
            tool_call,
            internal_call_id,
        } => {
            let name = tool_call.function.name;
            let arguments = tool_call.function.arguments;
            tool_calls.push(CassetteToolCall {
                name: name.clone(),
                args: arguments.clone(),
            });
            RawStreamingChoice::ToolCall(RawStreamingToolCall {
                id: tool_call.id,
                internal_call_id,
                call_id: tool_call.call_id,
                name,
                arguments,
                signature: tool_call.signature,
                additional_params: tool_call.additional_params,
            })
        }
        StreamedAssistantContent::ToolCallDelta {
            id,
            internal_call_id,
            content,
        } => RawStreamingChoice::ToolCallDelta {
            id,
            internal_call_id,
            content,
        },
        StreamedAssistantContent::Reasoning(reasoning) => {
            let id = reasoning.id;
            let content = reasoning.content.into_iter().next().unwrap_or(
                rig::message::ReasoningContent::Text {
                    text: String::new(),
                    signature: None,
                },
            );
            RawStreamingChoice::Reasoning { id, content }
        }
        StreamedAssistantContent::ReasoningDelta { id, reasoning } => {
            RawStreamingChoice::ReasoningDelta { id, reasoning }
        }
        StreamedAssistantContent::Final(response) => RawStreamingChoice::FinalResponse(response),
    }
}

fn collect_assistant_item(
    item: &AssistantContent,
    content: &mut String,
    tool_calls: &mut Vec<CassetteToolCall>,
) {
    match item {
        AssistantContent::Text(text) => content.push_str(&text.text),
        AssistantContent::ToolCall(tool_call) => tool_calls.push(CassetteToolCall {
            name: tool_call.function.name.clone(),
            args: tool_call.function.arguments.clone(),
        }),
        _ => {}
    }
}
