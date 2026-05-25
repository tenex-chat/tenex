use std::time::Instant;

use futures::StreamExt;
use rig_core::client::CompletionClient;
use rig_core::completion::{
    CompletionError, CompletionModel, CompletionRequest, CompletionResponse, GetTokenUsage,
};
use rig_core::message::AssistantContent;
use rig_core::streaming::{
    RawStreamingChoice, RawStreamingToolCall, StreamedAssistantContent,
    StreamingCompletionResponse, StreamingResult, ToolCallDeltaContent,
};
use sha2::{Digest, Sha256};
use tracing::{field, info_span, Instrument, Span};

use crate::cassette::{
    CassettePartialToolCall, CassetteRecorder, CassetteStreamError, CassetteToolCall,
};
use crate::cassette_request::request_debug;

const TRACE_TOOL_ARGS_ENV: &str = "TENEX_TRACE_STREAM_TOOL_ARGS";
const TRACE_ARGS_CONTEXT_CHARS: usize = 128;
const CASSETTE_TOOL_ARGS_MAX_CHARS: usize = 8 * 1024;
const STREAM_STOP_UNAVAILABLE_FROM_RIG: &str = "unavailable_from_rig";
const STREAM_STOP_ENDED_WITHOUT_FINAL: &str = "stream_ended_without_final";

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
        let request = crate::provider_request_sanitizer::sanitize_completion_request(request);
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
        let request = crate::provider_request_sanitizer::sanitize_completion_request(request);
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
            "gen_ai.stream.chunk_count" = field::Empty,
            "gen_ai.stream.tool_delta_count" = field::Empty,
            "gen_ai.stream.stop_reason" = field::Empty,
            "gen_ai.stream.error.class" = field::Empty,
            "gen_ai.stream.error.stage" = field::Empty,
            "gen_ai.stream.error.retryable" = field::Empty,
            "gen_ai.stream.error.parse_column" = field::Empty,
            "gen_ai.stream.partial_tool.name" = field::Empty,
            "gen_ai.stream.partial_tool.args_len" = field::Empty,
            "gen_ai.stream.partial_tool.args_sha256" = field::Empty,
            "gen_ai.stream.partial_tool.args_capture" = field::Empty,
            "gen_ai.stream.partial_tool.args_context" = field::Empty,
            "gen_ai.stream.partial_tool.args_context_truncated" = field::Empty,
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
            diagnostics: StreamDiagnostics::new(trace_tool_args_enabled()),
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
                    state.diagnostics.chunk_count += 1;
                    let raw = streamed_to_raw(
                        item,
                        &mut state.content,
                        &mut state.tool_calls,
                        &mut state.diagnostics,
                    );
                    if let RawStreamingChoice::FinalResponse(response) = &raw {
                        record_streaming_final(
                            &span,
                            response,
                            &state.content,
                            &state.tool_calls,
                            &state.diagnostics,
                        );
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
                    let failure = StreamFailure::classify(&err, &state.diagnostics);
                    record_streaming_error(&span, &err, &failure, &state.diagnostics);
                    span.in_scope(|| tenex_telemetry::record_current_error(&err));
                    record_error_once(&state, &err, &failure);
                    state.recorded = true;
                    Some((Err(failure.wrap_completion_error(err)), state))
                }
                None => {
                    if !state.recorded {
                        record_streaming_end_without_final(
                            &span,
                            &state.content,
                            &state.tool_calls,
                            &state.diagnostics,
                        );
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
    diagnostics: StreamDiagnostics,
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

fn record_streaming_final<R>(
    span: &Span,
    response: &R,
    content: &str,
    tool_calls: &[CassetteToolCall],
    diagnostics: &StreamDiagnostics,
) where
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
    let attrs = terminal_stream_attrs(
        content,
        tool_calls,
        diagnostics,
        STREAM_STOP_UNAVAILABLE_FROM_RIG,
    );
    span.record("gen_ai.stream.chunk_count", attrs.chunk_count as i64);
    span.record(
        "gen_ai.stream.tool_delta_count",
        attrs.tool_delta_count as i64,
    );
    span.record("gen_ai.response.finish_reasons", attrs.finish_reason);
    // Rig 0.35 does not expose Anthropic's message_delta.stop_reason through
    // its provider-neutral streaming response, so record the availability gap
    // explicitly instead of leaving future trace readers guessing.
    span.record("gen_ai.stream.stop_reason", attrs.stop_reason);
}

fn record_streaming_end_without_final(
    span: &Span,
    content: &str,
    tool_calls: &[CassetteToolCall],
    diagnostics: &StreamDiagnostics,
) {
    let attrs = terminal_stream_attrs(
        content,
        tool_calls,
        diagnostics,
        STREAM_STOP_ENDED_WITHOUT_FINAL,
    );
    span.record("gen_ai.stream.chunk_count", attrs.chunk_count as i64);
    span.record(
        "gen_ai.stream.tool_delta_count",
        attrs.tool_delta_count as i64,
    );
    span.record("gen_ai.response.finish_reasons", attrs.finish_reason);
    span.record("gen_ai.stream.stop_reason", attrs.stop_reason);
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

fn record_error_once<S>(state: &StreamState<S>, err: &CompletionError, failure: &StreamFailure) {
    if let (Some(recorder), Some(turn)) = (&state.recorder, state.turn) {
        let stream_error = CassetteStreamError {
            class: failure.class.to_string(),
            message: err.to_string(),
            retryable: failure.retryable.to_string(),
            failed_at_ms: state.started.elapsed().as_millis() as u64,
            partial_content: truncate_chars(&state.content, CASSETTE_TOOL_ARGS_MAX_CHARS).0,
            partial_tool_calls: state.diagnostics.partial_tool_calls_for_cassette(),
        };
        recorder.record_stream_error(
            turn,
            state.started.elapsed().as_millis() as u64,
            &state.request_debug,
            &state.content,
            &state.tool_calls,
            &stream_error,
        );
    }
}

fn record_streaming_error(
    span: &Span,
    err: &CompletionError,
    failure: &StreamFailure,
    diagnostics: &StreamDiagnostics,
) {
    span.record("gen_ai.stream.error.class", failure.class);
    span.record("gen_ai.stream.error.stage", failure.stage);
    span.record("gen_ai.stream.error.retryable", failure.retryable);
    span.record("gen_ai.stream.chunk_count", diagnostics.chunk_count as i64);
    span.record(
        "gen_ai.stream.tool_delta_count",
        diagnostics.tool_delta_count as i64,
    );
    span.record(
        "gen_ai.stream.stop_reason",
        STREAM_STOP_UNAVAILABLE_FROM_RIG,
    );

    if let Some(column) = failure.parse_column {
        span.record("gen_ai.stream.error.parse_column", column as i64);
    }

    if let Some(tool_call) = diagnostics.latest_partial_tool_call() {
        if let Some(name) = tool_call.name.as_deref() {
            span.record("gen_ai.stream.partial_tool.name", name);
        }
        span.record(
            "gen_ai.stream.partial_tool.args_len",
            tool_call.args.chars().count() as i64,
        );
        span.record(
            "gen_ai.stream.partial_tool.args_sha256",
            sha256_hex(&tool_call.args).as_str(),
        );

        if diagnostics.trace_tool_args {
            let column = failure
                .parse_column
                .unwrap_or_else(|| tool_call.args.chars().count());
            let context =
                args_context_around_column(&tool_call.args, column, TRACE_ARGS_CONTEXT_CHARS);
            span.record("gen_ai.stream.partial_tool.args_capture", "enabled");
            span.record("gen_ai.stream.partial_tool.args_context", context.as_str());
            span.record(
                "gen_ai.stream.partial_tool.args_context_truncated",
                context.chars().count() < tool_call.args.chars().count(),
            );
        } else {
            span.record("gen_ai.stream.partial_tool.args_capture", "disabled");
        }
    }

    tracing::warn!(
        error = %err,
        class = failure.class,
        retryable = failure.retryable,
        stage = failure.stage,
        "streaming completion failed"
    );
}

fn assistant_items_to_cassette(
    choice: rig_core::OneOrMany<AssistantContent>,
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
    diagnostics: &mut StreamDiagnostics,
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
            diagnostics.finish_tool_call(&internal_call_id);
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
        } => {
            diagnostics.observe_tool_call_delta(&id, &internal_call_id, &content);
            RawStreamingChoice::ToolCallDelta {
                id,
                internal_call_id,
                content,
            }
        }
        StreamedAssistantContent::Reasoning(reasoning) => {
            let id = reasoning.id;
            let content = reasoning.content.into_iter().next().unwrap_or(
                rig_core::message::ReasoningContent::Text {
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

#[derive(Default)]
struct StreamDiagnostics {
    chunk_count: usize,
    tool_delta_count: usize,
    trace_tool_args: bool,
    partial_tool_calls: Vec<PartialToolCall>,
}

impl StreamDiagnostics {
    fn new(trace_tool_args: bool) -> Self {
        Self {
            trace_tool_args,
            ..Default::default()
        }
    }

    fn observe_tool_call_delta(
        &mut self,
        id: &str,
        internal_call_id: &str,
        content: &ToolCallDeltaContent,
    ) {
        self.tool_delta_count += 1;
        let tool_call = self.tool_call_mut(id, internal_call_id);
        match content {
            ToolCallDeltaContent::Name(name) => tool_call.name = Some(name.clone()),
            ToolCallDeltaContent::Delta(delta) => tool_call.args.push_str(delta),
        }
    }

    fn finish_tool_call(&mut self, internal_call_id: &str) {
        self.partial_tool_calls
            .retain(|tool_call| tool_call.internal_call_id != internal_call_id);
    }

    fn latest_partial_tool_call(&self) -> Option<&PartialToolCall> {
        self.partial_tool_calls
            .iter()
            .filter(|tool_call| !tool_call.args.is_empty() || tool_call.name.is_some())
            .next_back()
    }

    fn partial_tool_calls_for_cassette(&self) -> Vec<CassettePartialToolCall> {
        self.partial_tool_calls
            .iter()
            .filter(|tool_call| !tool_call.args.is_empty() || tool_call.name.is_some())
            .map(|tool_call| {
                let (args, args_truncated) =
                    truncate_chars(&tool_call.args, CASSETTE_TOOL_ARGS_MAX_CHARS);
                CassettePartialToolCall {
                    name: tool_call.name.clone(),
                    args,
                    args_truncated,
                }
            })
            .collect()
    }

    fn tool_call_mut(&mut self, id: &str, internal_call_id: &str) -> &mut PartialToolCall {
        if let Some(index) = self
            .partial_tool_calls
            .iter()
            .position(|tool_call| tool_call.internal_call_id == internal_call_id)
        {
            return &mut self.partial_tool_calls[index];
        }
        self.partial_tool_calls.push(PartialToolCall {
            id: id.to_string(),
            internal_call_id: internal_call_id.to_string(),
            name: None,
            args: String::new(),
        });
        self.partial_tool_calls
            .last_mut()
            .expect("partial tool call was just pushed")
    }
}

struct PartialToolCall {
    #[allow(dead_code)]
    id: String,
    internal_call_id: String,
    name: Option<String>,
    args: String,
}

struct StreamFailure {
    class: &'static str,
    stage: &'static str,
    retryable: &'static str,
    parse_column: Option<usize>,
}

impl StreamFailure {
    fn classify(err: &CompletionError, diagnostics: &StreamDiagnostics) -> Self {
        let message = err.to_string();
        let parse_column = json_error_column(&message);
        if message.contains("JsonError") && diagnostics.latest_partial_tool_call().is_some() {
            return Self {
                class: "provider_stream_tool_args_json_error",
                stage: "tool_args_json_parse",
                retryable: "unknown",
                parse_column,
            };
        }
        if message.contains("JsonError") {
            return Self {
                class: "provider_stream_json_decode_error",
                stage: "provider_stream_decode",
                retryable: "unknown",
                parse_column,
            };
        }
        if message.contains("HttpError") || message.contains("SSE Error") {
            return Self {
                class: "provider_stream_transport_error",
                stage: "transport",
                retryable: "true",
                parse_column: None,
            };
        }
        Self {
            class: "provider_stream_error",
            stage: "unknown",
            retryable: "unknown",
            parse_column: None,
        }
    }

    fn wrap_completion_error(&self, err: CompletionError) -> CompletionError {
        CompletionError::ResponseError(format!(
            "{} retryable={}: {}",
            self.class, self.retryable, err
        ))
    }
}

fn inferred_finish_reason(content: &str, tool_calls: &[CassetteToolCall]) -> &'static str {
    if !tool_calls.is_empty() {
        "tool_calls"
    } else if !content.is_empty() {
        "stop"
    } else {
        "unknown"
    }
}

#[derive(Debug, PartialEq, Eq)]
struct TerminalStreamAttrs {
    chunk_count: usize,
    tool_delta_count: usize,
    finish_reason: &'static str,
    stop_reason: &'static str,
}

fn terminal_stream_attrs(
    content: &str,
    tool_calls: &[CassetteToolCall],
    diagnostics: &StreamDiagnostics,
    stop_reason: &'static str,
) -> TerminalStreamAttrs {
    TerminalStreamAttrs {
        chunk_count: diagnostics.chunk_count,
        tool_delta_count: diagnostics.tool_delta_count,
        finish_reason: inferred_finish_reason(content, tool_calls),
        stop_reason,
    }
}

fn trace_tool_args_enabled() -> bool {
    std::env::var(TRACE_TOOL_ARGS_ENV)
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

fn json_error_column(message: &str) -> Option<usize> {
    let (_, after_column) = message.rsplit_once("column ")?;
    let digits: String = after_column
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn args_context_around_column(args: &str, column: usize, radius: usize) -> String {
    if args.is_empty() {
        return String::new();
    }
    let center = column.saturating_sub(1);
    let start = center.saturating_sub(radius);
    let end = center.saturating_add(radius + 1);
    args.chars()
        .enumerate()
        .filter_map(|(idx, ch)| (idx >= start && idx < end).then_some(ch))
        .collect()
}

fn truncate_chars(value: &str, max_chars: usize) -> (String, bool) {
    let mut iter = value.chars();
    let truncated: String = iter.by_ref().take(max_chars).collect();
    let was_truncated = iter.next().is_some();
    (truncated, was_truncated)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_json_error_column_from_completion_message() {
        let message = "JsonError: expected value at line 1 column 510";
        assert_eq!(json_error_column(message), Some(510));
    }

    #[test]
    fn args_context_centers_on_reported_column() {
        let args = "0123456789abcdef";
        assert_eq!(args_context_around_column(args, 10, 3), "6789abc");
    }

    #[test]
    fn stream_diagnostics_tracks_partial_tool_args() {
        let mut diagnostics = StreamDiagnostics::new(false);
        diagnostics.observe_tool_call_delta(
            "toolu_1",
            "internal_1",
            &ToolCallDeltaContent::Name("delegate".to_string()),
        );
        diagnostics.observe_tool_call_delta(
            "toolu_1",
            "internal_1",
            &ToolCallDeltaContent::Delta("{\"message\":\"hello".to_string()),
        );

        let partial = diagnostics
            .latest_partial_tool_call()
            .expect("partial tool call should be tracked");
        assert_eq!(partial.name.as_deref(), Some("delegate"));
        assert_eq!(partial.args, "{\"message\":\"hello");

        let failure = StreamFailure::classify(
            &CompletionError::JsonError(serde_json::from_str::<serde_json::Value>("").unwrap_err()),
            &diagnostics,
        );
        assert_eq!(failure.class, "provider_stream_tool_args_json_error");
        assert_eq!(failure.stage, "tool_args_json_parse");
    }

    #[test]
    fn cassette_partial_tool_args_are_capped() {
        let mut diagnostics = StreamDiagnostics::new(false);
        diagnostics.observe_tool_call_delta(
            "toolu_1",
            "internal_1",
            &ToolCallDeltaContent::Name("delegate".to_string()),
        );
        diagnostics.observe_tool_call_delta(
            "toolu_1",
            "internal_1",
            &ToolCallDeltaContent::Delta("x".repeat(CASSETTE_TOOL_ARGS_MAX_CHARS + 1)),
        );

        let partials = diagnostics.partial_tool_calls_for_cassette();
        assert_eq!(partials.len(), 1);
        assert_eq!(
            partials[0].args.chars().count(),
            CASSETTE_TOOL_ARGS_MAX_CHARS
        );
        assert!(partials[0].args_truncated);
    }

    #[test]
    fn terminal_attrs_for_stream_without_final_include_explicit_gap() {
        let mut diagnostics = StreamDiagnostics::new(false);
        diagnostics.chunk_count = 4;
        diagnostics.observe_tool_call_delta(
            "toolu_1",
            "internal_1",
            &ToolCallDeltaContent::Name("describe_ui".to_string()),
        );
        diagnostics.observe_tool_call_delta(
            "toolu_1",
            "internal_1",
            &ToolCallDeltaContent::Delta("{\"screen\":\"main\"}".to_string()),
        );

        let tool_calls = vec![CassetteToolCall {
            name: "describe_ui".to_string(),
            args: serde_json::json!({"screen": "main"}),
        }];
        let attrs = terminal_stream_attrs(
            "",
            &tool_calls,
            &diagnostics,
            STREAM_STOP_ENDED_WITHOUT_FINAL,
        );

        assert_eq!(
            attrs,
            TerminalStreamAttrs {
                chunk_count: 4,
                tool_delta_count: 2,
                finish_reason: "tool_calls",
                stop_reason: STREAM_STOP_ENDED_WITHOUT_FINAL,
            }
        );
    }
}
