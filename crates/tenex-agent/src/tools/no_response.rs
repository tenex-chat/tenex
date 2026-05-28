use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use rig_core::{completion::ToolDefinition, tool::Tool};
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
            description: "End this turn silently. Use ONLY when the latest user message explicitly \
                asks for no reply, including note-to-self or counting-aloud cases where the user \
                does not want acknowledgements or filler. Do not emit any text alongside this \
                call. Calling this tool ends the turn immediately — the agent loop stops and you \
                are not invoked again."
                .to_string(),
            parameters: json!({ "type": "object", "properties": {}, "required": [] }),
        }
    }

    async fn call(&self, _args: Self::Args) -> Result<Self::Output, Self::Error> {
        self.suppress.store(true, Ordering::Release);
        Ok(NoResponseOutput {
            success: true,
            mode: "silent-complete",
        })
    }
}
