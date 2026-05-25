use std::collections::HashMap;

use rig_core::completion::ToolDefinition;
use rig_core::tool::ToolError;
use tenex_context::ToolDef as ProjectionToolDef;

use super::recording::RecordingTool;

/// Per-turn registry used by the TENEX step loop. It keeps the same recording
/// behavior as the legacy rig tool wrappers while exposing direct dispatch by
/// provider-supplied tool id.
pub(crate) struct TurnToolRegistry {
    tools: Vec<RecordingTool>,
    tool_index: HashMap<String, usize>,
    projection_tool_defs: Vec<ProjectionToolDef>,
}

impl TurnToolRegistry {
    pub(crate) fn new() -> Self {
        Self {
            tools: Vec::new(),
            tool_index: HashMap::new(),
            projection_tool_defs: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, tool: RecordingTool) {
        let name = tool.name();
        self.tool_index.insert(name.clone(), self.tools.len());
        self.projection_tool_defs.push(tool.projection_tool_def());
        self.tools.push(tool);
    }

    pub(crate) fn projection_tool_defs(&self) -> &[ProjectionToolDef] {
        &self.projection_tool_defs
    }

    #[cfg(test)]
    pub(crate) fn tool_names(&self) -> impl Iterator<Item = String> + '_ {
        self.projection_tool_defs
            .iter()
            .map(|definition| definition.name.clone())
    }

    pub(crate) async fn provider_definitions(&self, prompt: String) -> Vec<ToolDefinition> {
        let mut definitions = Vec::with_capacity(self.tools.len());
        for tool in &self.tools {
            definitions.push(tool.provider_definition(prompt.clone()).await);
        }
        definitions
    }

    pub(crate) async fn execute(
        &self,
        tool_name: &str,
        args: serde_json::Value,
        tool_call_id: Option<String>,
        provider_call_id: Option<String>,
    ) -> Result<String, ToolError> {
        let Some(index) = self.tool_index.get(tool_name) else {
            return Err(tool_call_error(UnknownToolError(tool_name.to_string())));
        };
        self.tools[*index]
            .execute_with_ids(args, tool_call_id, provider_call_id)
            .await
    }
}

#[derive(Debug, thiserror::Error)]
#[error("unknown tool: {0}")]
struct UnknownToolError(String);

fn tool_call_error(error: impl std::error::Error + Send + Sync + 'static) -> ToolError {
    ToolError::ToolCallError(Box::new(error))
}
