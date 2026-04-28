use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_rag::RagStore;

#[derive(Debug, Deserialize, Serialize)]
pub struct RagIndexArgs {
    pub content: String,
    /// "self" stores in the agent's personal collection; "project" stores in the shared project collection.
    pub audience: String,
    pub title: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct RagIndexError(String);

#[derive(Clone)]
pub struct RagIndexTool {
    store: Option<Arc<RagStore>>,
    project_id: String,
    agent_pubkey: String,
}

impl RagIndexTool {
    pub fn new(store: Option<Arc<RagStore>>, project_id: String, agent_pubkey: String) -> Self {
        Self { store, project_id, agent_pubkey }
    }

    fn collection_for(&self, audience: &str) -> Result<String, RagIndexError> {
        match audience {
            "self" => Ok(format!("agent_{}", self.agent_pubkey)),
            "project" => Ok(format!("project_{}", self.project_id)),
            other => Err(RagIndexError(format!(
                "invalid audience '{other}'; expected 'self' or 'project'"
            ))),
        }
    }
}

impl Tool for RagIndexTool {
    const NAME: &'static str = "rag_index";
    type Error = RagIndexError;
    type Args = RagIndexArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Embed and store a document for later retrieval. Use 'self' for notes \
                only useful to you (personal knowledge), or 'project' for information useful to \
                all agents working on this project."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The text content to store"
                    },
                    "audience": {
                        "type": "string",
                        "enum": ["self", "project"],
                        "description": "'self' = personal agent knowledge; 'project' = shared project knowledge"
                    },
                    "title": {
                        "type": "string",
                        "description": "Short title for the document (optional)"
                    }
                },
                "required": ["content", "audience"]
            }),
        }
    }

    async fn call(&self, args: RagIndexArgs) -> Result<String, RagIndexError> {
        let store = match &self.store {
            Some(s) => s,
            None => {
                return Ok(
                    "Error: embedding is not configured. Run `tenex config embed` to set up an embedding provider."
                        .to_string(),
                )
            }
        };

        let collection =
            self.collection_for(&args.audience).map_err(|e| RagIndexError(e.to_string()))?;

        let id = store
            .index(&args.content, args.title.as_deref(), &collection)
            .await
            .map_err(|e| RagIndexError(format!("failed to index document: {e}")))?;

        Ok(format!("Stored document '{id}' in collection '{collection}'."))
    }
}
