use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct NoResponseError(String);

#[derive(Debug, Deserialize, Serialize)]
pub struct NoResponseArgs {}

#[derive(Debug, Serialize)]
pub struct NoResponseOutput {
    pub success: bool,
    pub mode: &'static str,
    pub message: &'static str,
}

pub struct NoResponseTool {
    suppress: Arc<AtomicBool>,
}

impl NoResponseTool {
    pub fn new(suppress: Arc<AtomicBool>) -> Self {
        Self { suppress }
    }
}

impl Tool for NoResponseTool {
    const NAME: &'static str = "no_response";
    type Error = NoResponseError;
    type Args = NoResponseArgs;
    type Output = NoResponseOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Request a silent completion for this turn. Use ONLY when the latest \
                user message explicitly asks for no reply, including note-to-self or counting-aloud \
                cases where the user does not want acknowledgements or filler. Calling this tool \
                immediately ends the turn with no assistant text."
                .to_string(),
            parameters: json!({ "type": "object", "properties": {}, "required": [] }),
        }
    }

    async fn call(&self, _args: Self::Args) -> Result<Self::Output, Self::Error> {
        self.suppress.store(true, Ordering::Release);
        Ok(NoResponseOutput {
            success: true,
            mode: "silent-complete",
            message: "Silent completion requested. This turn ends immediately with no assistant \
                text, acknowledgement, emoji, or filler.",
        })
    }
}
