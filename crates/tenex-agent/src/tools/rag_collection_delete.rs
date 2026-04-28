use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_rag::RagStore;

#[derive(Debug, Deserialize, Serialize)]
pub struct RagCollectionDeleteArgs {
    pub collection: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct RagCollectionDeleteError(String);

#[derive(Clone)]
pub struct RagCollectionDeleteTool {
    store: Option<Arc<RagStore>>,
}

impl RagCollectionDeleteTool {
    pub fn new(store: Option<Arc<RagStore>>) -> Self {
        Self { store }
    }
}

impl Tool for RagCollectionDeleteTool {
    const NAME: &'static str = "rag_collection_delete";
    type Error = RagCollectionDeleteError;
    type Args = RagCollectionDeleteArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Delete all documents in a RAG collection. This is irreversible — use rag_collection_list first to confirm the collection name.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "collection": {
                        "type": "string",
                        "description": "Name of the collection to delete"
                    }
                },
                "required": ["collection"]
            }),
        }
    }

    async fn call(&self, args: RagCollectionDeleteArgs) -> Result<String, RagCollectionDeleteError> {
        let store = match &self.store {
            Some(s) => s,
            None => return Ok("RAG not configured.".to_string()),
        };

        let n = store
            .delete_collection(&args.collection)
            .await
            .map_err(|e| {
                RagCollectionDeleteError(format!("failed to delete collection: {e}"))
            })?;

        Ok(format!("Deleted {n} document(s) from collection '{}'.", args.collection))
    }
}
