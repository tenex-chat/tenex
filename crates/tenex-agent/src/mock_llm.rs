use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rig::client::CompletionClient;
use rig::completion::{
    CompletionError, CompletionModel, CompletionRequest, CompletionResponse, Usage,
};
use rig::message::{AssistantContent, Text, ToolCall, ToolFunction};
use rig::streaming::{
    RawStreamingChoice, RawStreamingToolCall, StreamingCompletionResponse, StreamingResult,
};
use rig::OneOrMany;
use serde::Deserialize;

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
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<MockToolCall>,
}

#[derive(Debug, Clone, Deserialize)]
struct MockToolCall {
    name: String,
    #[serde(default)]
    args: serde_json::Value,
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
        let response = self.next_response(&request);
        let choice = response_to_choice(&response);
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
        let response = self.next_response(&request);
        let mut items = Vec::new();

        for (idx, tool_call) in response.tool_calls.iter().enumerate() {
            items.push(Ok(RawStreamingChoice::ToolCall(RawStreamingToolCall::new(
                format!("mock-tool-{idx}"),
                tool_call.name.clone(),
                tool_call.args.clone(),
            ))));
        }

        if let Some(content) = response.content.as_ref().filter(|s| !s.is_empty()) {
            items.push(Ok(RawStreamingChoice::Message(content.clone())));
        }

        items.push(Ok(RawStreamingChoice::FinalResponse(())));
        let stream: StreamingResult<()> = Box::pin(futures::stream::iter(items));
        Ok(StreamingCompletionResponse::stream(stream))
    }
}

impl MockModel {
    fn next_response(&self, request: &CompletionRequest) -> MockResponse {
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

        self.inner
            .scenario
            .responses
            .iter()
            .find(|candidate| {
                candidate
                    .agent
                    .as_ref()
                    .is_none_or(|expected| expected == &agent)
                    && candidate.turn.is_none_or(|expected| expected == turn)
                    && candidate
                        .contains
                        .as_ref()
                        .is_none_or(|needle| request_text.contains(needle))
            })
            .cloned()
            .unwrap_or_else(|| MockResponse {
                agent: Some(agent.clone()),
                turn: Some(turn),
                contains: None,
                content: Some(
                    self.inner
                        .scenario
                        .default_content
                        .clone()
                        .unwrap_or_else(|| format!("Mock response from {agent} turn {turn}.")),
                ),
                tool_calls: Vec::new(),
            })
    }
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
