use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_rag::RagStore;

#[derive(Debug, Deserialize, Serialize)]
pub struct RagAddDocumentsArgs {
    pub content: String,
    pub collection: String,
    pub title: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct RagAddDocumentsError(String);

#[derive(Clone)]
pub struct RagAddDocumentsTool {
    store: Option<Arc<RagStore>>,
}

impl RagAddDocumentsTool {
    pub fn new(store: Option<Arc<RagStore>>) -> Self {
        Self { store }
    }
}

impl Tool for RagAddDocumentsTool {
    const NAME: &'static str = "rag_add_documents";
    type Error = RagAddDocumentsError;
    type Args = RagAddDocumentsArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Embed and store a document in a named RAG collection for later semantic retrieval. \
                Built-in collections: 'conversations', 'lessons', 'project_<id>', 'agent_<pubkey>'. \
                Custom collection names are also allowed."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The text content to embed and store"
                    },
                    "collection": {
                        "type": "string",
                        "description": "Collection name — use 'lessons' for lessons, 'agent_<pubkey>' for personal notes, 'project_<id>' for project knowledge"
                    },
                    "title": {
                        "type": "string",
                        "description": "Short descriptive title for the document (optional)"
                    }
                },
                "required": ["content", "collection"]
            }),
        }
    }

    async fn call(&self, args: RagAddDocumentsArgs) -> Result<String, RagAddDocumentsError> {
        let store = match &self.store {
            Some(s) => s,
            None => {
                return Ok(
                    "Error: embedding is not configured. Run `tenex config embed` to set up an embedding provider."
                        .to_string(),
                )
            }
        };

        let id = store
            .index(&args.content, args.title.as_deref(), &args.collection)
            .await
            .map_err(|e| RagAddDocumentsError(format!("failed to store document: {e}")))?;

        Ok(format!("Stored as '{}' in collection '{}'.", id, args.collection))
    }
}
