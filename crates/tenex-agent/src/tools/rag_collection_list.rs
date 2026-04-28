use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_rag::RagStore;

#[derive(Debug, Deserialize, Serialize)]
pub struct RagCollectionListArgs {}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct RagCollectionListError(String);

#[derive(Clone)]
pub struct RagCollectionListTool {
    store: Option<Arc<RagStore>>,
}

impl RagCollectionListTool {
    pub fn new(store: Option<Arc<RagStore>>) -> Self {
        Self { store }
    }
}

impl Tool for RagCollectionListTool {
    const NAME: &'static str = "rag_collection_list";
    type Error = RagCollectionListError;
    type Args = RagCollectionListArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List all RAG collections in the current project's knowledge base. Use this to discover what knowledge is available before searching.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        }
    }

    async fn call(&self, _args: RagCollectionListArgs) -> Result<String, RagCollectionListError> {
        let store = match &self.store {
            Some(s) => s,
            None => return Ok("RAG not configured.".to_string()),
        };

        let collections = store
            .list_collections()
            .await
            .map_err(|e| RagCollectionListError(format!("failed to list collections: {e}")))?;

        if collections.is_empty() {
            return Ok("No collections found.".to_string());
        }
        Ok(collections.join("\n"))
    }
}
