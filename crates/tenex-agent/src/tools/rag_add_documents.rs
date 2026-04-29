use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_rag::RagStore;

#[derive(Debug, Deserialize, Serialize)]
pub struct RagAddDocumentsArgs {
    pub content: String,
    pub audience: String,
    pub title: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct RagAddDocumentsError(String);

#[derive(Clone)]
pub struct RagAddDocumentsTool {
    store: Option<Arc<RagStore>>,
    project_id: String,
    agent_pubkey: String,
}

impl RagAddDocumentsTool {
    pub fn new(store: Option<Arc<RagStore>>, project_id: String, agent_pubkey: String) -> Self {
        Self {
            store,
            project_id,
            agent_pubkey,
        }
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
            description: "Embed and store a document for later semantic retrieval. \
                Use audience='self' to store in your personal knowledge base, \
                or audience='project' to share with the whole project."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The text content to embed and store"
                    },
                    "audience": {
                        "type": "string",
                        "enum": ["self", "project"],
                        "description": "'self' stores in your personal agent collection; 'project' stores in the shared project collection"
                    },
                    "title": {
                        "type": "string",
                        "description": "Short descriptive title for the document (optional)"
                    }
                },
                "required": ["content", "audience"]
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

        let collection = match args.audience.as_str() {
            "self" => format!("agent_{}", self.agent_pubkey),
            "project" => format!("project_{}", self.project_id),
            other => {
                return Err(RagAddDocumentsError(format!(
                    "Invalid audience '{}'. Use 'self' or 'project'.",
                    other
                )));
            }
        };

        let id = store
            .index(&args.content, args.title.as_deref(), &collection)
            .await
            .map_err(|e| RagAddDocumentsError(format!("failed to store document: {e}")))?;

        Ok(format!(
            "Stored as '{}' in {} collection.",
            id, args.audience
        ))
    }
}
