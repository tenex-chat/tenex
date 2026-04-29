use std::path::PathBuf;
use std::sync::Arc;

use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tenex_rag::{EmbedConfig, RagStore};

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
    /// Current project's RAG store (None if embedding not configured).
    store: Option<Arc<RagStore>>,
    /// Needed to open other projects' stores when project_id == "ALL".
    embed_config: Option<EmbedConfig>,
    /// `~/.tenex` base directory.
    base_dir: PathBuf,
    current_project_id: String,
}

impl ConversationSearchTool {
    pub fn new(
        store: Option<Arc<RagStore>>,
        embed_config: Option<EmbedConfig>,
        base_dir: PathBuf,
        current_project_id: String,
    ) -> Self {
        Self { store, embed_config, base_dir, current_project_id }
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
        let scope = args.project_id.as_deref().unwrap_or("");
        let search_all = scope.eq_ignore_ascii_case("ALL");

        if search_all {
            let embed_config = match &self.embed_config {
                Some(c) => c,
                None => return Ok(no_embed_msg.to_string()),
            };

            let projects_dir = self.base_dir.join("projects");
            let entries = std::fs::read_dir(&projects_dir)
                .map_err(|e| ConversationSearchError(format!("cannot read projects dir: {e}")))?;

            let mut all_results: Vec<ConvSearchResult> = Vec::new();

            for entry in entries.flatten() {
                let db_path = entry.path().join("embeddings.db");
                if !db_path.exists() {
                    continue;
                }
                let project_id = entry.file_name().to_string_lossy().into_owned();
                let store = match RagStore::open(&db_path, embed_config) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let results = match store.search(&args.query, &["conversations"], limit).await {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                for r in results {
                    all_results.push(ConvSearchResult {
                        score: (r.score * 100.0).round() / 100.0,
                        content: r.content,
                        title: r.title,
                        id: r.id,
                        project_id: Some(project_id.clone()),
                    });
                }
            }

            if all_results.is_empty() {
                return Ok(format!("No conversations found matching '{}'.", args.query));
            }

            all_results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
            all_results.truncate(limit);

            return serde_json::to_string_pretty(&all_results)
                .map_err(|e| ConversationSearchError(format!("serialize results: {e}")));
        }

        // Single-project search (current project or explicit match).
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
