use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_rag::RagStore;

#[derive(Debug, Deserialize, Serialize)]
pub struct RagSearchArgs {
    pub query: String,
    pub limit: Option<u32>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct RagSearchError(String);

#[derive(Clone)]
pub struct RagSearchTool {
    store: Option<Arc<RagStore>>,
    project_id: String,
    agent_pubkey: String,
}

impl RagSearchTool {
    pub fn new(store: Option<Arc<RagStore>>, project_id: String, agent_pubkey: String) -> Self {
        Self { store, project_id, agent_pubkey }
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
                Returns the most semantically similar results."
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

        serde_json::to_string_pretty(&output)
            .map_err(|e| RagSearchError(format!("serialize results: {e}")))
    }
}
