use std::sync::Arc;

use anyhow::{bail, Context, Result};
use serde_json::json;
use tenex_protocol::{
    McpListResourcesRequest, McpListResourcesResponse, McpReadResourceRequest,
    McpReadResourceResponse,
};

use super::RuntimeShared;

pub(super) async fn list_resources(
    shared: Arc<RuntimeShared>,
    req: McpListResourcesRequest,
) -> Result<McpListResourcesResponse> {
    let allowed = allowed_servers_for_agent(&shared, &req.agent_pubkey)?;
    if allowed.is_empty() {
        return Ok(McpListResourcesResponse {
            content: "You have no MCP server access.".to_string(),
        });
    }

    let configured = shared.mcp_runtime.configured_server_names();
    let running: Vec<String> = allowed
        .into_iter()
        .filter(|server| configured.contains(server))
        .collect();
    if running.is_empty() {
        return Ok(McpListResourcesResponse {
            content: "Your configured MCP servers are not available in this project.".to_string(),
        });
    }

    let mut sections = vec![
        "# Available MCP Resources\n".to_string(),
        format!(
            "Access to {} server{}: {}\n",
            running.len(),
            if running.len() == 1 { "" } else { "s" },
            running.join(", ")
        ),
    ];
    let mut total_resources = 0usize;
    let mut total_templates = 0usize;

    for server in &running {
        match shared.mcp_runtime.list_server_resources(server).await {
            Ok(listing) => {
                if listing.resources.is_empty() && listing.templates.is_empty() {
                    continue;
                }
                sections.push(format!("## Server: {server}\n"));
                if !listing.resources.is_empty() {
                    sections.push("### Direct Resources\n".to_string());
                    for resource in listing.resources {
                        sections.push(format_resource(&resource));
                        sections.push(String::new());
                        total_resources += 1;
                    }
                }
                if !listing.templates.is_empty() {
                    sections
                        .push("### Resource Templates (require parameter expansion)\n".to_string());
                    for template in listing.templates {
                        sections.push(format_template(&template));
                        sections.push(String::new());
                        total_templates += 1;
                    }
                }
                sections.push("---\n".to_string());
            }
            Err(error) => sections.push(format!(
                "## Server: {server}\nUnable to list resources: {error}\n"
            )),
        }
    }

    if total_resources == 0 && total_templates == 0 {
        return Ok(McpListResourcesResponse {
            content: format!(
                "Connected to {} MCP server(s) ({}), but no resources are available.",
                running.len(),
                running.join(", ")
            ),
        });
    }
    sections.push(format!(
        "**Summary:** {} direct resource{}, {} template{} available",
        total_resources,
        if total_resources == 1 { "" } else { "s" },
        total_templates,
        if total_templates == 1 { "" } else { "s" }
    ));

    Ok(McpListResourcesResponse {
        content: sections.join("\n"),
    })
}

pub(super) async fn read_resource(
    shared: Arc<RuntimeShared>,
    req: McpReadResourceRequest,
) -> Result<McpReadResourceResponse> {
    ensure_agent_can_access_server(&shared, &req.agent_pubkey, &req.server_name)?;
    let result = shared
        .mcp_runtime
        .read_resource(&req.server_name, &req.resource_uri)
        .await?;
    let content = resource_read_text(&result);
    let mime_type = result
        .contents
        .first()
        .and_then(|content| content.mime_type.clone());
    Ok(McpReadResourceResponse {
        content: serde_json::to_string_pretty(&json!({
            "success": true,
            "message": format!("Successfully read resource from MCP server '{}'", req.server_name),
            "serverName": req.server_name,
            "resourceUri": req.resource_uri,
            "content": content,
            "mimeType": mime_type,
        }))?,
    })
}

pub(super) fn ensure_agent_can_access_server(
    shared: &RuntimeShared,
    agent_pubkey: &str,
    server_name: &str,
) -> Result<()> {
    let allowed = allowed_servers_for_agent(shared, agent_pubkey)?;
    if !allowed.iter().any(|server| server == server_name) {
        bail!(
            "You do not have access to MCP server '{}'. Your accessible servers: {}",
            server_name,
            if allowed.is_empty() {
                "none".to_string()
            } else {
                allowed.join(", ")
            }
        );
    }
    Ok(())
}

pub(super) fn resource_read_text(result: &tenex_mcp::McpResourceReadResult) -> String {
    let mut chunks = Vec::new();
    for content in &result.contents {
        if let Some(text) = &content.text {
            chunks.push(text.clone());
        } else if let Some(blob) = &content.blob {
            let mime = content
                .mime_type
                .as_deref()
                .unwrap_or("application/octet-stream");
            chunks.push(format!(
                "[Binary content: {} bytes, MIME type: {}]",
                blob.len(),
                mime
            ));
        }
    }
    chunks.join("\n\n")
}

pub(super) fn validate_resource_uri(uri: &str) -> Result<()> {
    let Some(colon) = uri.find(':') else {
        bail!("Invalid resource URI '{uri}'. Resource URIs must have a valid scheme.");
    };
    let scheme = &uri[..colon];
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
        || !scheme
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic())
        || uri[colon + 1..].trim().is_empty()
    {
        bail!("Invalid resource URI '{uri}'. Resource URIs must have a valid scheme.");
    }
    Ok(())
}

pub(super) fn extract_item_id(line: &str) -> String {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| value.get("id").cloned())
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string())
        })
        .unwrap_or_else(|| line.trim().to_string())
}

fn allowed_servers_for_agent(shared: &RuntimeShared, agent_pubkey: &str) -> Result<Vec<String>> {
    let snapshot = shared.agent_snapshot();
    let agent = snapshot
        .agents
        .iter()
        .find(|agent| agent.pubkey == agent_pubkey)
        .with_context(|| format!("agent '{agent_pubkey}' is not in this project"))?;
    tenex_mcp::mcp_access_from_default_json(agent.default_config_json.as_deref())
        .with_context(|| format!("reading MCP access for agent '{}'", agent.slug))
}

fn format_resource(resource: &tenex_mcp::McpResourceEntry) -> String {
    let mut lines = vec![format!("- **{}** (`{}`)", resource.name, resource.uri)];
    if let Some(description) = &resource.description {
        lines.push(format!("  {description}"));
    }
    lines.push(format!("  Server: {}", resource.server));
    if let Some(mime_type) = &resource.mime_type {
        lines.push(format!("  Type: {mime_type}"));
    }
    lines.join("\n")
}

fn format_template(template: &tenex_mcp::McpResourceTemplateEntry) -> String {
    let mut lines = vec![format!(
        "- **{}** (`{}`) *[Template]*",
        template.name, template.uri_template
    )];
    if let Some(description) = &template.description {
        lines.push(format!("  {description}"));
    }
    lines.push(format!("  Server: {}", template.server));
    let params = template_parameters(&template.uri_template);
    if !params.is_empty() {
        lines.push(format!("  **Required parameters:** {}", params.join(", ")));
        lines.push("  **Note:** Expand this template with actual values before using".to_string());
    }
    if let Some(mime_type) = &template.mime_type {
        lines.push(format!("  Type: {mime_type}"));
    }
    lines.join("\n")
}

fn template_parameters(uri_template: &str) -> Vec<String> {
    let mut params = Vec::new();
    let mut rest = uri_template;
    while let Some(start) = rest.find('{') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find('}') else {
            break;
        };
        let name = rest[..end].trim();
        if !name.is_empty() {
            params.push(name.to_string());
        }
        rest = &rest[end + 1..];
    }
    params
}
