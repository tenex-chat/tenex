use crate::config::ResolvedModel;
use crate::llm_accounting::{assistant_text, usage_from_rig};
use rig::completion::{Completion, Message};
use rig::providers::{anthropic, ollama, openai, openrouter};
use rig::{client::CompletionClient, completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_accounting::{record_llm_call, RecordLlmCall, RootKind, RootKindOrStr};
use tenex_rag::RagStore;

#[derive(Debug, Deserialize, Serialize)]
pub struct RagSearchArgs {
    pub query: String,
    pub limit: Option<u32>,
    pub prompt: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct RagSearchError(String);

#[derive(Clone)]
pub struct RagSearchTool {
    store: Option<Arc<RagStore>>,
    project_id: String,
    agent_pubkey: String,
    resolved: Arc<ResolvedModel>,
}

impl RagSearchTool {
    pub fn new(
        store: Option<Arc<RagStore>>,
        project_id: String,
        agent_pubkey: String,
        resolved: Arc<ResolvedModel>,
    ) -> Self {
        Self {
            store,
            project_id,
            agent_pubkey,
            resolved,
        }
    }

    async fn call_llm(&self, system: &str, user: String) -> anyhow::Result<String> {
        use rig::client::Nothing;

        let history: Vec<Message> = Vec::new();

        let (text, usage) = match self.resolved.provider.as_str() {
            "openrouter" => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no OpenRouter API key"))?;
                let resp = openrouter::Client::new(key)?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build()
                    .completion(user.clone(), history.clone())
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                (assistant_text(&resp.choice), resp.usage)
            }
            "openai" => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no OpenAI API key"))?;
                let resp = openai::CompletionsClient::builder()
                    .api_key(key)
                    .build()?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build()
                    .completion(user.clone(), history.clone())
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                (assistant_text(&resp.choice), resp.usage)
            }
            "ollama" => {
                let mut builder = ollama::Client::builder().api_key(Nothing);
                if let Some(url) = self.resolved.base_url.as_deref() {
                    builder = builder.base_url(url);
                }
                let resp = builder
                    .build()?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build()
                    .completion(user.clone(), history.clone())
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                (assistant_text(&resp.choice), resp.usage)
            }
            _ => {
                let key = self
                    .resolved
                    .api_key
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("no Anthropic API key"))?;
                let resp = anthropic::Client::new(key)?
                    .agent(&self.resolved.model)
                    .preamble(system)
                    .build()
                    .completion(user.clone(), history.clone())
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                (assistant_text(&resp.choice), resp.usage)
            }
        };

        record_llm_call(RecordLlmCall {
            root_kind: RootKindOrStr::Known(RootKind::RagQuery),
            provider: self.resolved.provider.clone(),
            provider_model_id: self.resolved.model.clone(),
            operation: "rag_search".into(),
            agent_pubkey: Some(self.agent_pubkey.clone()),
            project_id: Some(self.project_id.clone()),
            user_message: Some(user),
            assistant_response: Some(text.clone()),
            usage: usage_from_rig(&usage),
            ..Default::default()
        })
        .await;

        Ok(text)
    }
}

impl Tool for RagSearchTool {
    const NAME: &'static str = "rag_search";
    type Error = RagSearchError;
    type Args = RagSearchArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Search for relevant documents across all available knowledge: \
                past conversations, project knowledge, and your personal notes. \
                Returns the most semantically similar results. Optionally provide a \
                `prompt` to have an LLM synthesize a focused answer from the results \
                instead of returning raw snippets."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language search query"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results to return (default: 10)"
                    },
                    "prompt": {
                        "type": "string",
                        "description": "If provided, an LLM processes the search results through the lens of this prompt and returns a focused extraction instead of raw snippets. Example: 'What decisions were made about the database schema?'"
                    }
                },
                "required": ["query"]
            }),
        }
    }

    async fn call(&self, args: RagSearchArgs) -> Result<String, RagSearchError> {
        let store = match &self.store {
            Some(s) => s,
            None => {
                return Ok(
                    "Error: embedding is not configured. Run `tenex config embed` to set up an embedding provider."
                        .to_string(),
                )
            }
        };

        let limit = args.limit.unwrap_or(10) as usize;
        let collections = [
            "conversations".to_string(),
            format!("project_{}", self.project_id),
            format!("agent_{}", self.agent_pubkey),
        ];
        let collection_refs: Vec<&str> = collections.iter().map(|s| s.as_str()).collect();

        let results = store
            .search(&args.query, &collection_refs, limit)
            .await
            .map_err(|e| RagSearchError(format!("search failed: {e}")))?;

        if results.is_empty() {
            return Ok("No results found.".to_string());
        }

        let output: Vec<serde_json::Value> = results
            .into_iter()
            .map(|r| {
                let mut obj = json!({
                    "id": r.id,
                    "collection": r.collection,
                    "score": (r.score * 100.0).round() / 100.0,
                    "content": r.content,
                });
                if let Some(title) = r.title {
                    obj["title"] = json!(title);
                }
                obj
            })
            .collect();

        let results_json = serde_json::to_string_pretty(&output)
            .map_err(|e| RagSearchError(format!("serialize results: {e}")))?;

        if let Some(p) = args.prompt {
            let system = "You synthesize information from search results to concisely answer the user's question based only on the provided results.";
            let user = format!("<results>\n{results_json}\n</results>\n\n{p}");
            return self
                .call_llm(system, user)
                .await
                .map_err(|e| RagSearchError(format!("LLM call failed: {e}")));
        }

        Ok(results_json)
    }
}
