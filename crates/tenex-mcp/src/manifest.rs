use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolManifest {
    pub tools: Vec<ToolManifestEntry>,
}

impl ToolManifest {
    pub fn empty() -> Self {
        Self { tools: Vec::new() }
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    pub fn tool_names(&self) -> Vec<String> {
        self.tools.iter().map(|tool| tool.name.clone()).collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolManifestEntry {
    pub name: String,
    pub server: String,
    pub tool: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCallRequest {
    pub tool_name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCallResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl McpToolCallResponse {
    pub fn ok(result: String) -> Self {
        Self {
            result: Some(result),
            error: None,
        }
    }

    pub fn error(error: impl Into<String>) -> Self {
        Self {
            result: None,
            error: Some(error.into()),
        }
    }
}
