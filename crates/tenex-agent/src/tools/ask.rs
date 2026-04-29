use crate::emit::EmitState;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tenex_protocol::{AskIntent, AskQuestion, Intent, PrincipalKind, PrincipalRef};

#[derive(Debug, Deserialize, Serialize)]
pub struct AskQuestionInput {
    #[serde(rename = "type")]
    pub question_type: String,
    pub title: String,
    pub prompt: String,
    pub options: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AskArgs {
    pub title: String,
    pub context: String,
    pub questions: Vec<AskQuestionInput>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct AskError(String);

#[derive(Clone)]
pub struct AskTool {
    state: Arc<EmitState>,
    owner_pubkey: String,
}

impl AskTool {
    pub fn new(state: Arc<EmitState>, owner_pubkey: String) -> Self {
        Self {
            state,
            owner_pubkey,
        }
    }
}

impl Tool for AskTool {
    const NAME: &'static str = "ask";
    type Error = AskError;
    type Args = AskArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Ask the project owner a structured question and wait for their response. Use when human input is required to proceed. Questions can be single-select (choose one option) or multi-select (choose multiple options). Stop after calling this — the owner will reply in a future turn.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title summarizing what you need to know"
                    },
                    "context": {
                        "type": "string",
                        "description": "Background explaining why you're asking and what will happen with the answer"
                    },
                    "questions": {
                        "type": "array",
                        "description": "One or more structured questions for the owner",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {
                                    "type": "string",
                                    "enum": ["single_select", "multi_select"],
                                    "description": "'single_select' for choose-one, 'multi_select' for choose-many"
                                },
                                "title": {
                                    "type": "string",
                                    "description": "The question label"
                                },
                                "prompt": {
                                    "type": "string",
                                    "description": "Detailed question text"
                                },
                                "options": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "The available choices"
                                }
                            },
                            "required": ["type", "title", "prompt", "options"]
                        }
                    }
                },
                "required": ["title", "context", "questions"]
            }),
        }
    }

    async fn call(&self, args: AskArgs) -> Result<String, AskError> {
        let pubkey = nostr::PublicKey::from_hex(&self.owner_pubkey)
            .map_err(|e| AskError(format!("invalid owner pubkey: {e}")))?;

        let recipient = PrincipalRef::Nostr {
            pubkey,
            kind: PrincipalKind::Human,
            display_name: None,
        };

        let questions = args
            .questions
            .into_iter()
            .map(|q| match q.question_type.as_str() {
                "multi_select" => AskQuestion::MultiSelect {
                    title: q.title,
                    prompt: q.prompt,
                    options: q.options,
                },
                _ => AskQuestion::SingleSelect {
                    title: q.title,
                    prompt: q.prompt,
                    suggestions: q.options,
                },
            })
            .collect();

        let ral = self.state.meta.lock().unwrap().ral;
        let ctx = self.state.build_ctx(ral);

        let intent = AskIntent {
            title: args.title.clone(),
            context: args.context,
            questions,
            recipient,
        };

        self.state
            .channel
            .send(Intent::Ask(intent), &ctx)
            .await
            .map_err(|e| AskError(format!("failed to emit ask: {e}")))?;
        self.state.mark_pending_external_work();

        Ok(format!(
            "Question '{}' sent to project owner. Stop here — wait for their reply.",
            args.title
        ))
    }
}
