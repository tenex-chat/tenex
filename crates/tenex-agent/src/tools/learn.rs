use crate::emit::EmitState;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_protocol::{Intent, LessonIntent};
use tenex_rag::RagStore;

#[derive(Debug, Deserialize, Serialize)]
pub struct LearnArgs {
    pub title: String,
    pub lesson: String,
    pub category: Option<String>,
    pub hashtags: Option<Vec<String>>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct LearnError(String);

#[derive(Clone)]
pub struct LearnTool {
    state: Arc<EmitState>,
    rag_store: Option<Arc<RagStore>>,
}

impl LearnTool {
    pub fn new(state: Arc<EmitState>, rag_store: Option<Arc<RagStore>>) -> Self {
        Self { state, rag_store }
    }
}

impl Tool for LearnTool {
    const NAME: &'static str = "learn";
    type Error = LearnError;
    type Args = LearnArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Persist a lesson learned so it informs future work. Publishes a Nostr lesson event and indexes the content in the 'lessons' RAG collection for retrieval.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title for the lesson"
                    },
                    "lesson": {
                        "type": "string",
                        "description": "The lesson content — what was learned and why it matters"
                    },
                    "category": {
                        "type": "string",
                        "description": "Optional category tag (e.g. 'debugging', 'architecture', 'workflow')"
                    },
                    "hashtags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional hashtags without the # prefix"
                    }
                },
                "required": ["title", "lesson"]
            }),
        }
    }

    async fn call(&self, args: LearnArgs) -> Result<String, LearnError> {
        let ral = self.state.meta.lock().unwrap().ral;
        let ctx = self.state.build_ctx(ral);
        let hashtags = args.hashtags.unwrap_or_default();

        let lesson_intent = LessonIntent {
            title: args.title.clone(),
            lesson: args.lesson.clone(),
            category: args.category.clone(),
            hashtags: hashtags.clone(),
            agent_definition_id: None,
        };

        self.state
            .channel
            .send(Intent::Lesson(lesson_intent), &ctx)
            .await
            .map_err(|e| LearnError(format!("failed to emit lesson: {e}")))?;

        if let Some(store) = &self.rag_store {
            let content = format!("# {}\n\n{}", args.title, args.lesson);
            if let Err(e) = store.index(&content, Some(&args.title), "lessons").await {
                eprintln!("[learn] RAG indexing failed: {e}");
            }
        }

        Ok(format!("Lesson '{}' published and indexed.", args.title))
    }
}
