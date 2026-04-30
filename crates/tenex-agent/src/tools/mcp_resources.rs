use std::collections::HashMap;

use crate::runtime_control;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tenex_protocol::{
    McpControlRequest, McpControlResponse, McpListResourcesRequest, McpReadResourceRequest,
    McpSubscribeRequest, McpSubscriptionStopRequest, RuntimeControlRequest, RuntimeControlResponse,
};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct McpResourceToolError(String);

#[derive(Clone)]
pub struct McpListResourcesTool {
    agent_pubkey: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct McpListResourcesArgs {}

impl McpListResourcesTool {
    pub fn new(agent_pubkey: String) -> Self {
        Self { agent_pubkey }
    }
}

impl Tool for McpListResourcesTool {
    const NAME: &'static str = "mcp_list_resources";
    type Error = McpResourceToolError;
    type Args = McpListResourcesArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List available MCP resources and resource templates from MCP servers you have access to.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {}
            }),
        }
    }

    async fn call(&self, _args: McpListResourcesArgs) -> Result<String, Self::Error> {
        let response = call_mcp(McpControlRequest::ListResources(McpListResourcesRequest {
            agent_pubkey: self.agent_pubkey.clone(),
        }))
        .await?;
        match response {
            McpControlResponse::ListResources(response) => Ok(response.content),
            other => Err(McpResourceToolError(format!(
                "unexpected MCP response: {other:?}"
            ))),
        }
    }
}

#[derive(Clone)]
pub struct McpResourceReadTool {
    agent_pubkey: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct McpResourceReadArgs {
    #[serde(rename = "serverName")]
    pub server_name: String,
    #[serde(rename = "resourceUri")]
    pub resource_uri: String,
    #[serde(default, rename = "templateParams")]
    pub template_params: Option<HashMap<String, String>>,
    pub description: String,
}

impl McpResourceReadTool {
    pub fn new(agent_pubkey: String) -> Self {
        Self { agent_pubkey }
    }
}

impl Tool for McpResourceReadTool {
    const NAME: &'static str = "mcp_resource_read";
    type Error = McpResourceToolError;
    type Args = McpResourceReadArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Read content from an MCP resource. You can only read resources from MCP servers you have access to.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "serverName": {"type": "string", "description": "MCP server name"},
                    "resourceUri": {"type": "string", "description": "Resource URI or URI template to read"},
                    "templateParams": {
                        "type": "object",
                        "additionalProperties": {"type": "string"},
                        "description": "Parameters for URI template expansion"
                    },
                    "description": {"type": "string", "description": "Why you are reading this resource"}
                },
                "required": ["serverName", "resourceUri", "description"]
            }),
        }
    }

    async fn call(&self, args: McpResourceReadArgs) -> Result<String, Self::Error> {
        let resource_uri = expand_uri_template(&args.resource_uri, args.template_params.as_ref())?;
        let response = call_mcp(McpControlRequest::ReadResource(McpReadResourceRequest {
            agent_pubkey: self.agent_pubkey.clone(),
            server_name: args.server_name,
            resource_uri,
        }))
        .await?;
        match response {
            McpControlResponse::ReadResource(response) => Ok(response.content),
            other => Err(McpResourceToolError(format!(
                "unexpected MCP response: {other:?}"
            ))),
        }
    }
}

#[derive(Clone)]
pub struct McpSubscribeTool {
    agent_pubkey: String,
    agent_slug: String,
    conversation_id: String,
    project_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct McpSubscribeArgs {
    #[serde(rename = "serverName")]
    pub server_name: String,
    #[serde(rename = "resourceUri")]
    pub resource_uri: String,
    pub description: String,
}

impl McpSubscribeTool {
    pub fn new(
        agent_pubkey: String,
        agent_slug: String,
        conversation_id: String,
        project_id: String,
    ) -> Self {
        Self {
            agent_pubkey,
            agent_slug,
            conversation_id,
            project_id,
        }
    }
}

impl Tool for McpSubscribeTool {
    const NAME: &'static str = "mcp_subscribe";
    type Error = McpResourceToolError;
    type Args = McpSubscribeArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Subscribe to MCP resource update notifications. Updates are delivered to this conversation.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "serverName": {"type": "string", "description": "MCP server name"},
                    "resourceUri": {"type": "string", "description": "Resource URI to subscribe to"},
                    "description": {"type": "string", "description": "What this subscription monitors"}
                },
                "required": ["serverName", "resourceUri", "description"]
            }),
        }
    }

    async fn call(&self, args: McpSubscribeArgs) -> Result<String, Self::Error> {
        let response = call_mcp(McpControlRequest::Subscribe(McpSubscribeRequest {
            agent_pubkey: self.agent_pubkey.clone(),
            agent_slug: self.agent_slug.clone(),
            server_name: args.server_name,
            resource_uri: args.resource_uri,
            conversation_id: self.conversation_id.clone(),
            root_event_id: self.conversation_id.clone(),
            project_id: self.project_id.clone(),
            description: args.description,
        }))
        .await?;
        match response {
            McpControlResponse::Subscribe(response) => Ok(response.content),
            other => Err(McpResourceToolError(format!(
                "unexpected MCP response: {other:?}"
            ))),
        }
    }
}

#[derive(Clone)]
pub struct McpSubscriptionStopTool {
    agent_pubkey: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct McpSubscriptionStopArgs {
    #[serde(rename = "subscriptionId")]
    pub subscription_id: String,
}

impl McpSubscriptionStopTool {
    pub fn new(agent_pubkey: String) -> Self {
        Self { agent_pubkey }
    }
}

impl Tool for McpSubscriptionStopTool {
    const NAME: &'static str = "mcp_subscription_stop";
    type Error = McpResourceToolError;
    type Args = McpSubscriptionStopArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Stop an active MCP resource subscription created by this agent."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "subscriptionId": {
                        "type": "string",
                        "description": "The subscription ID returned by mcp_subscribe"
                    }
                },
                "required": ["subscriptionId"]
            }),
        }
    }

    async fn call(&self, args: McpSubscriptionStopArgs) -> Result<String, Self::Error> {
        let response = call_mcp(McpControlRequest::SubscriptionStop(
            McpSubscriptionStopRequest {
                agent_pubkey: self.agent_pubkey.clone(),
                subscription_id: args.subscription_id,
            },
        ))
        .await?;
        match response {
            McpControlResponse::SubscriptionStop(response) => Ok(response.content),
            other => Err(McpResourceToolError(format!(
                "unexpected MCP response: {other:?}"
            ))),
        }
    }
}

async fn call_mcp(request: McpControlRequest) -> Result<McpControlResponse, McpResourceToolError> {
    let socket = runtime_control::socket_path().ok_or_else(|| {
        McpResourceToolError(
            "MCP resource tools require the Rust runtime control socket.".to_string(),
        )
    })?;
    let response = runtime_control::request(socket, RuntimeControlRequest::Mcp(request))
        .await
        .map_err(|error| McpResourceToolError(format!("runtime MCP request failed: {error}")))?;
    match response {
        RuntimeControlResponse::Mcp(response) => Ok(response),
        RuntimeControlResponse::Error(error) => Err(McpResourceToolError(error.message)),
        other => Err(McpResourceToolError(format!(
            "unexpected runtime response: {other:?}"
        ))),
    }
}

fn expand_uri_template(
    resource_uri: &str,
    params: Option<&HashMap<String, String>>,
) -> Result<String, McpResourceToolError> {
    let mut expanded = resource_uri.to_string();
    if let Some(params) = params {
        for (key, value) in params {
            expanded = expanded.replace(&format!("{{{key}}}"), value);
        }
    }
    if expanded.contains('{') && expanded.contains('}') {
        return Err(McpResourceToolError(format!(
            "Resource URI contains unfilled template parameters: {expanded}"
        )));
    }
    Ok(expanded)
}
