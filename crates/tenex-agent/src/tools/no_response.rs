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
                cases where the user does not want acknowledgements or filler. Call this tool \
                EXACTLY ONCE — the turn ends immediately with no assistant text. Do NOT call \
                this tool more than once; the flag is already set after the first call."
                .to_string(),
            parameters: json!({ "type": "object", "properties": {}, "required": [] }),
        }
    }

    async fn call(&self, _args: Self::Args) -> Result<Self::Output, Self::Error> {
        let already_set = self.suppress.swap(true, Ordering::AcqRel);
        if already_set {
            return Ok(NoResponseOutput {
                success: true,
                mode: "silent-complete",
                message: "Silent mode already active. STOP — do not call this tool again. \
                    Produce no text and return immediately.",
            });
        }
        Ok(NoResponseOutput {
            success: true,
            mode: "silent-complete",
            message: "Silent completion granted. STOP — do not call this tool again, do not \
                produce any text, do not acknowledge. Return immediately with no output.",
        })
    }
}
