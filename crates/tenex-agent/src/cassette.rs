use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
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
use serde::Serialize;

#[derive(Clone)]
pub struct CassetteRecorder {
    path: PathBuf,
    agent: String,
    provider: String,
    model: String,
    turns: Arc<Mutex<usize>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CassetteToolCall {
    pub name: String,
    pub args: serde_json::Value,
}

#[derive(Clone)]
pub struct RecordingClient<C> {
    inner: C,
    recorder: Option<CassetteRecorder>,
}

#[derive(Clone)]
pub struct RecordingModel<M> {
    inner: M,
    recorder: Option<CassetteRecorder>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CassetteTurnRecord<'a> {
    version: u32,
    agent: &'a str,
    provider: &'a str,
    model: &'a str,
    turn: usize,
    duration_ms: u64,
    timestamp_ms: u64,
    request_debug: &'a str,
    content: &'a str,
    tool_calls: &'a [CassetteToolCall],
}

impl CassetteRecorder {
    pub fn from_env(agent: &str, provider: &str, model: &str) -> Option<Self> {
        let path = std::env::var("TENEX_LLM_CASSETTE_RECORD_PATH")
            .ok()
            .filter(|value| !value.trim().is_empty())?;
        Some(Self {
            path: PathBuf::from(path),
            agent: agent.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            turns: Arc::new(Mutex::new(0)),
        })
    }

    fn next_turn(&self) -> usize {
        let mut turns = self.turns.lock().unwrap();
        *turns += 1;
        *turns
    }

    fn record_turn(
        &self,
        turn: usize,
        duration_ms: u64,
        request_debug: &str,
        content: &str,
        tool_calls: &[CassetteToolCall],
    ) {
        if let Err(err) =
            self.try_record_turn(turn, duration_ms, request_debug, content, tool_calls)
        {
            eprintln!(
                "[tenex-agent cassette] failed to append LLM cassette {}: {err}",
                self.path.display()
            );
        }
    }

    fn try_record_turn(
        &self,
        turn: usize,
        duration_ms: u64,
        request_debug: &str,
        content: &str,
        tool_calls: &[CassetteToolCall],
    ) -> Result<()> {
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let record = CassetteTurnRecord {
            version: 1,
            agent: &self.agent,
            provider: &self.provider,
            model: &self.model,
            turn,
            duration_ms,
            timestamp_ms,
            request_debug,
            content,
            tool_calls,
        };
        let line = serde_json::to_string(&record).context("serialize cassette turn")?;
        append_jsonl(&self.path, &line).context("append cassette turn")
    }
}

impl<C> RecordingClient<C> {
    pub fn new(inner: C, recorder: Option<CassetteRecorder>) -> Self {
        Self { inner, recorder }
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
        let model = model.into();
        Self {
            inner: M::make(&client.inner, model),
            recorder: client.recorder.clone(),
        }
    }

    async fn completion(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse<Self::Response>, CompletionError> {
        let turn = self.recorder.as_ref().map(CassetteRecorder::next_turn);
        let request_debug = format!("{:?}", request);
        let started = Instant::now();
        let result = self.inner.completion(request).await;
        if let (Some(recorder), Some(turn), Ok(response)) = (&self.recorder, turn, &result) {
            let (content, tool_calls) = assistant_items_to_cassette(response.choice.clone());
            recorder.record_turn(
                turn,
                started.elapsed().as_millis() as u64,
                &request_debug,
                &content,
                &tool_calls,
            );
        }
        result
    }

    async fn stream(
        &self,
        request: CompletionRequest,
    ) -> Result<StreamingCompletionResponse<Self::StreamingResponse>, CompletionError> {
        let turn = self.recorder.as_ref().map(CassetteRecorder::next_turn);
        let request_debug = format!("{:?}", request);
        let started = Instant::now();
        let inner = self.inner.stream(request).await?;
        let state = (
            inner,
            self.recorder.clone(),
            turn,
            started,
            request_debug,
            String::new(),
            Vec::<CassetteToolCall>::new(),
            false,
        );
        let stream = futures::stream::unfold(
            state,
            |(
                mut inner,
                recorder,
                turn,
                started,
                request_debug,
                mut content,
                mut tool_calls,
                mut recorded,
            )| async move {
                match inner.next().await {
                    Some(Ok(item)) => {
                        let raw = streamed_to_raw(item, &mut content, &mut tool_calls);
                        if matches!(raw, RawStreamingChoice::FinalResponse(_)) {
                            if let (Some(recorder), Some(turn)) = (&recorder, turn) {
                                recorder.record_turn(
                                    turn,
                                    started.elapsed().as_millis() as u64,
                                    &request_debug,
                                    &content,
                                    &tool_calls,
                                );
                            }
                            recorded = true;
                        }
                        Some((
                            Ok(raw),
                            (
                                inner,
                                recorder,
                                turn,
                                started,
                                request_debug,
                                content,
                                tool_calls,
                                recorded,
                            ),
                        ))
                    }
                    Some(Err(err)) => Some((
                        Err(err),
                        (
                            inner,
                            recorder,
                            turn,
                            started,
                            request_debug,
                            content,
                            tool_calls,
                            recorded,
                        ),
                    )),
                    None => {
                        if !recorded {
                            if let (Some(recorder), Some(turn)) = (&recorder, turn) {
                                recorder.record_turn(
                                    turn,
                                    started.elapsed().as_millis() as u64,
                                    &request_debug,
                                    &content,
                                    &tool_calls,
                                );
                            }
                        }
                        None
                    }
                }
            },
        );
        Ok(StreamingCompletionResponse::stream(
            Box::pin(stream) as StreamingResult<_>
        ))
    }
}

fn append_jsonl(path: &Path, line: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create cassette directory {}", parent.display()))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open cassette {}", path.display()))?;
    writeln!(file, "{line}").context("write cassette line")
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
            let content =
                reasoning
                    .content
                    .into_iter()
                    .next()
                    .unwrap_or(rig::message::ReasoningContent::Text {
                        text: String::new(),
                        signature: None,
                    });
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
