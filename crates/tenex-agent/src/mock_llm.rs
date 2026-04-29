use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rig::OneOrMany;
use rig::client::CompletionClient;
use rig::completion::{
    CompletionError, CompletionModel, CompletionRequest, CompletionResponse, Usage,
};
use rig::message::{AssistantContent, Text, ToolCall, ToolFunction};
use rig::streaming::{
    RawStreamingChoice, RawStreamingToolCall, StreamingCompletionResponse, StreamingResult,
};
use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct MockClient {
    inner: Arc<MockInner>,
}

struct MockInner {
    agent_slug: String,
    scenario: MockScenario,
    turns: Mutex<HashMap<String, usize>>,
}

#[derive(Clone)]
pub struct MockModel {
    inner: Arc<MockInner>,
    model: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MockScenario {
    #[serde(default)]
    responses: Vec<MockResponse>,
    #[serde(default)]
    default_content: Option<String>,
    #[serde(default)]
    default_delay_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MockResponse {
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    turn: Option<usize>,
    #[serde(default)]
    contains: Option<String>,
    #[serde(default)]
    contains_all: Vec<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<MockToolCall>,
    #[serde(default)]
    delay_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct MockToolCall {
    name: String,
    #[serde(default)]
    args: serde_json::Value,
}

struct MockSelection {
    turn: usize,
    matched_index: Option<usize>,
    request_text: String,
    response: MockResponse,
    delay_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MockRequestRecord<'a> {
    agent: &'a str,
    model: &'a str,
    turn: usize,
    matched_index: Option<usize>,
    delay_ms: u64,
    timestamp_ms: u64,
    request_debug: &'a str,
    content: Option<&'a str>,
    tool_calls: Vec<&'a str>,
}

impl MockClient {
    pub fn from_env(agent_slug: &str) -> Result<Self> {
        let scenario = match std::env::var("TENEX_MOCK_LLM_SCENARIO") {
            Ok(raw) if raw.trim_start().starts_with('{') => {
                serde_json::from_str(&raw).context("parse TENEX_MOCK_LLM_SCENARIO JSON")?
            }
            Ok(path) => {
                let bytes = std::fs::read(Path::new(&path))
                    .with_context(|| format!("read TENEX_MOCK_LLM_SCENARIO {path}"))?;
                serde_json::from_slice(&bytes)
                    .with_context(|| format!("parse TENEX_MOCK_LLM_SCENARIO {path}"))?
            }
            Err(_) => MockScenario::default(),
        };

        Ok(Self {
            inner: Arc::new(MockInner {
                agent_slug: agent_slug.to_string(),
                scenario,
                turns: Mutex::new(HashMap::new()),
            }),
        })
    }
}

impl CompletionClient for MockClient {
    type CompletionModel = MockModel;
}

#[allow(refining_impl_trait)]
impl CompletionModel for MockModel {
    type Response = ();
    type StreamingResponse = ();
    type Client = MockClient;

    fn make(client: &Self::Client, model: impl Into<String>) -> Self {
        Self {
            inner: client.inner.clone(),
            model: model.into(),
        }
    }

    async fn completion(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse<Self::Response>, CompletionError> {
        let selection = self.next_response(&request);
        self.record_request(&selection);
        sleep_if_configured(selection.delay_ms).await;

        let choice = response_to_choice(&selection.response);
        Ok(CompletionResponse {
            choice,
            usage: Usage {
                input_tokens: 1,
                output_tokens: 1,
                total_tokens: 2,
                cached_input_tokens: 0,
                cache_creation_input_tokens: 0,
            },
            raw_response: (),
            message_id: Some(format!("mock-{}-{}", self.inner.agent_slug, self.model)),
        })
    }

    async fn stream(
        &self,
        request: CompletionRequest,
    ) -> Result<StreamingCompletionResponse<Self::StreamingResponse>, CompletionError> {
        let selection = self.next_response(&request);
        self.record_request(&selection);
        sleep_if_configured(selection.delay_ms).await;

        let mut items = Vec::new();

        for (idx, tool_call) in selection.response.tool_calls.iter().enumerate() {
            items.push(Ok(RawStreamingChoice::ToolCall(RawStreamingToolCall::new(
                format!("mock-tool-{idx}"),
                tool_call.name.clone(),
                tool_call.args.clone(),
            ))));
        }

        if let Some(content) = selection
            .response
            .content
            .as_ref()
            .filter(|s| !s.is_empty())
        {
            items.push(Ok(RawStreamingChoice::Message(content.clone())));
        }

        items.push(Ok(RawStreamingChoice::FinalResponse(())));
        let stream: StreamingResult<()> = Box::pin(futures::stream::iter(items));
        Ok(StreamingCompletionResponse::stream(stream))
    }
}

impl MockModel {
    fn next_response(&self, request: &CompletionRequest) -> MockSelection {
        let agent = self.inner.agent_slug.clone();
        let turn = {
            let mut turns = self.inner.turns.lock().unwrap();
            let entry = turns.entry(agent.clone()).or_insert(0);
            *entry += 1;
            *entry
        };
        let request_text = format!("{:?}", request);

        if std::env::var("TENEX_MOCK_LLM_DEBUG").ok().as_deref() == Some("true") {
            eprintln!("[tenex-agent mock] agent={agent} turn={turn}");
        }

        let (matched_index, response) = self
            .inner
            .scenario
            .responses
            .iter()
            .enumerate()
            .find(|candidate| {
                let response = candidate.1;
                response
                    .agent
                    .as_ref()
                    .is_none_or(|expected| expected == &agent)
                    && response.turn.is_none_or(|expected| expected == turn)
                    && response
                        .contains
                        .as_ref()
                        .is_none_or(|needle| request_text.contains(needle))
                    && response
                        .contains_all
                        .iter()
                        .all(|needle| request_text.contains(needle))
            })
            .map(|(idx, response)| (Some(idx), response.clone()))
            .unwrap_or_else(|| {
                (
                    None,
                    MockResponse {
                        agent: Some(agent.clone()),
                        turn: Some(turn),
                        contains: None,
                        contains_all: Vec::new(),
                        content: Some(
                            self.inner
                                .scenario
                                .default_content
                                .clone()
                                .unwrap_or_else(|| {
                                    format!("Mock response from {agent} turn {turn}.")
                                }),
                        ),
                        tool_calls: Vec::new(),
                        delay_ms: None,
                    },
                )
            });

        let delay_ms = response
            .delay_ms
            .or(self.inner.scenario.default_delay_ms)
            .unwrap_or(0);

        MockSelection {
            turn,
            matched_index,
            request_text,
            response,
            delay_ms,
        }
    }

    fn record_request(&self, selection: &MockSelection) {
        let Ok(path) = std::env::var("TENEX_MOCK_LLM_RECORD_PATH") else {
            return;
        };

        let tool_calls = selection
            .response
            .tool_calls
            .iter()
            .map(|tool_call| tool_call.name.as_str())
            .collect();
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let record = MockRequestRecord {
            agent: self.inner.agent_slug.as_str(),
            model: self.model.as_str(),
            turn: selection.turn,
            matched_index: selection.matched_index,
            delay_ms: selection.delay_ms,
            timestamp_ms,
            request_debug: selection.request_text.as_str(),
            content: selection.response.content.as_deref(),
            tool_calls,
        };

        let line = match serde_json::to_string(&record) {
            Ok(line) => line,
            Err(err) => {
                eprintln!("[tenex-agent mock] failed to serialize request record: {err}");
                return;
            }
        };
        if let Err(err) = append_request_record(Path::new(&path), &line) {
            eprintln!("[tenex-agent mock] failed to append request record {path}: {err}");
        }
    }
}

async fn sleep_if_configured(delay_ms: u64) {
    if delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }
}

fn append_request_record(path: &Path, line: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{line}")?;
    Ok(())
}

fn response_to_choice(response: &MockResponse) -> OneOrMany<AssistantContent> {
    let mut items = Vec::new();
    for (idx, tool_call) in response.tool_calls.iter().enumerate() {
        items.push(AssistantContent::ToolCall(ToolCall::new(
            format!("mock-tool-{idx}"),
            ToolFunction::new(tool_call.name.clone(), tool_call.args.clone()),
        )));
    }
    if let Some(content) = response.content.as_ref().filter(|s| !s.is_empty()) {
        items.push(AssistantContent::Text(Text {
            text: content.clone(),
        }));
    }

    if items.is_empty() {
        return OneOrMany::one(AssistantContent::Text(Text {
            text: String::new(),
        }));
    }
    OneOrMany::many(items).unwrap()
}
