use std::sync::Arc;

use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tenex_rag::RagStore;

#[derive(Debug, Deserialize, Serialize)]
pub struct ConversationSearchArgs {
    pub query: String,
    /// Omit (or pass current project ID) to search the current project only.
    /// Pass "ALL" to search across every project that has a conversations index.
    pub project_id: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConversationSearchError(String);

#[derive(Clone)]
pub struct ConversationSearchTool {
    /// Shared global RAG store (None if embedding not configured).
    store: Option<Arc<RagStore>>,
}

impl ConversationSearchTool {
    pub fn new(store: Option<Arc<RagStore>>) -> Self {
        Self { store }
    }
}

#[derive(Debug, Serialize)]
struct ConvSearchResult {
    score: f32,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
}

impl Tool for ConversationSearchTool {
    const NAME: &'static str = "conversation_search";
    type Error = ConversationSearchError;
    type Args = ConversationSearchArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Search past conversations using semantic similarity. \
                Defaults to the current project. Pass project_id='ALL' to search \
                across all projects (results include which project matched)."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language search query"
                    },
                    "project_id": {
                        "type": "string",
                        "description": "Project ID to search, or 'ALL' for all projects. Defaults to current project."
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

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let no_embed_msg = "Error: embedding is not configured. \
            Run `tenex config embed` to set up an embedding provider.";

        let limit = args.limit.unwrap_or(10) as usize;

        // The embedder now writes to a single global ~/.tenex/embeddings.db.
        // The legacy per-project routing (and the explicit `ALL` mode) is
        // collapsed here — the store is shared. The `project_id` arg is
        // accepted for back-compat but ignored; future work may filter by
        // project via chunk meta_json.
        let store = match &self.store {
            Some(s) => s,
            None => return Ok(no_embed_msg.to_string()),
        };

        let results = store
            .search(&args.query, &["conversations"], limit)
            .await
            .map_err(|e| ConversationSearchError(format!("search failed: {e}")))?;

        if results.is_empty() {
            return Ok(format!("No conversations found matching '{}'.", args.query));
        }

        let output: Vec<ConvSearchResult> = results
            .into_iter()
            .map(|r| ConvSearchResult {
                score: (r.score * 100.0).round() / 100.0,
                content: r.content,
                title: r.title,
                id: r.id,
                project_id: None,
            })
            .collect();

        serde_json::to_string_pretty(&output)
            .map_err(|e| ConversationSearchError(format!("serialize results: {e}")))
    }
}
