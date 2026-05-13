use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use serde_json::Value;
use tokio::sync::broadcast;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::config::{ProjectMcpConfig, ProjectMcpServerConfig};
use crate::manifest::{McpResourceReadResult, McpServerResources, ToolManifest};
use crate::stdio::StdioMcpClient;

pub struct ProjectMcpRuntime {
    project_dir: PathBuf,
    config: ProjectMcpConfig,
    servers: Mutex<HashMap<String, Arc<ServerHandle>>>,
}

struct ServerHandle {
    client: Mutex<StdioMcpClient>,
}

impl ProjectMcpRuntime {
    pub fn load(project_dir: impl AsRef<Path>) -> Result<Arc<Self>> {
        let project_dir = project_dir.as_ref().to_path_buf();
        let config = ProjectMcpConfig::load_project(&project_dir)?;
        Ok(Arc::new(Self {
            project_dir,
            config,
            servers: Mutex::new(HashMap::new()),
        }))
    }

    /// Construct from an already-parsed config (used for per-run agent-owned
    /// MCP servers that don't come from the project's `.mcp.json`).
    pub fn from_config(project_dir: impl AsRef<Path>, config: ProjectMcpConfig) -> Arc<Self> {
        Arc::new(Self {
            project_dir: project_dir.as_ref().to_path_buf(),
            config,
            servers: Mutex::new(HashMap::new()),
        })
    }

    pub fn configured_server_names(&self) -> Vec<String> {
        self.config.servers.keys().cloned().collect()
    }

    pub fn has_server(&self, slug: &str) -> bool {
        self.config.servers.contains_key(slug)
    }

    pub async fn prepare_manifest(&self, allowed_slugs: &[String]) -> Result<ToolManifest> {
        if allowed_slugs.is_empty() {
            return Ok(ToolManifest::empty());
        }

        let mut manifest = ToolManifest::empty();
        for slug in allowed_slugs {
            if !self.config.servers.contains_key(slug) {
                warn!(server = %slug, "agent requests unknown project MCP server; skipping");
                continue;
            }
            let handle = match self.ensure_server(slug).await {
                Ok(h) => h,
                Err(e) => {
                    warn!(server = %slug, error = %e, "MCP server failed to start; agent will run without it");
                    continue;
                }
            };
            let mut client = handle.client.lock().await;
            match client.list_tools().await {
                Ok(tools) => manifest.tools.extend(tools),
                Err(e) => {
                    warn!(server = %slug, error = %e, "MCP server failed to list tools; agent will run without it");
                }
            }
        }

        Ok(manifest)
    }

    pub async fn call_tool(&self, namespaced_tool_name: &str, arguments: Value) -> Result<String> {
        let (server_name, tool_name) = parse_namespaced_tool_name(namespaced_tool_name)?;
        let handle = self.ensure_server(&server_name).await?;
        let mut client = handle.client.lock().await;
        client.call_tool(&tool_name, arguments).await
    }

    pub async fn list_server_resources(&self, server_name: &str) -> Result<McpServerResources> {
        if !self.config.servers.contains_key(server_name) {
            bail!("MCP server '{}' is not configured", server_name);
        }
        let handle = self.ensure_server(server_name).await?;
        let mut client = handle.client.lock().await;
        let resources = client.list_resources().await?;
        let templates = client.list_resource_templates().await?;
        Ok(McpServerResources {
            server: server_name.to_string(),
            resources,
            templates,
        })
    }

    pub async fn read_resource(
        &self,
        server_name: &str,
        uri: &str,
    ) -> Result<McpResourceReadResult> {
        if !self.config.servers.contains_key(server_name) {
            bail!("MCP server '{}' is not configured", server_name);
        }
        let handle = self.ensure_server(server_name).await?;
        let mut client = handle.client.lock().await;
        client.read_resource(uri).await
    }

    pub async fn resource_updates(&self, server_name: &str) -> Result<broadcast::Receiver<String>> {
        if !self.config.servers.contains_key(server_name) {
            bail!("MCP server '{}' is not configured", server_name);
        }
        let handle = self.ensure_server(server_name).await?;
        let client = handle.client.lock().await;
        Ok(client.resource_updates())
    }

    pub async fn subscribe_resource(&self, server_name: &str, uri: &str) -> Result<()> {
        if !self.config.servers.contains_key(server_name) {
            bail!("MCP server '{}' is not configured", server_name);
        }
        let handle = self.ensure_server(server_name).await?;
        let mut client = handle.client.lock().await;
        client.subscribe_resource(uri).await
    }

    pub async fn unsubscribe_resource(&self, server_name: &str, uri: &str) -> Result<()> {
        if !self.config.servers.contains_key(server_name) {
            bail!("MCP server '{}' is not configured", server_name);
        }
        let handle = self.ensure_server(server_name).await?;
        let mut client = handle.client.lock().await;
        client.unsubscribe_resource(uri).await
    }

    pub async fn shutdown(&self) {
        let handles: Vec<Arc<ServerHandle>> = {
            let mut servers = self.servers.lock().await;
            servers.drain().map(|(_, handle)| handle).collect()
        };
        for handle in handles {
            let mut client = handle.client.lock().await;
            client.shutdown().await;
        }
    }

    async fn ensure_server(&self, slug: &str) -> Result<Arc<ServerHandle>> {
        let mut servers = self.servers.lock().await;
        if let Some(handle) = servers.get(slug) {
            return Ok(handle.clone());
        }

        let config = self
            .server_config(slug)
            .with_context(|| format!("MCP server '{slug}' is not configured"))?;
        info!(server = slug, "starting project MCP server");
        let client = StdioMcpClient::start(slug.to_string(), config, &self.project_dir).await?;
        let handle = Arc::new(ServerHandle {
            client: Mutex::new(client),
        });
        servers.insert(slug.to_string(), handle.clone());
        Ok(handle)
    }

    fn server_config(&self, slug: &str) -> Option<ProjectMcpServerConfig> {
        self.config.servers.get(slug).cloned()
    }
}

fn parse_namespaced_tool_name(name: &str) -> Result<(String, String)> {
    let Some(rest) = name.strip_prefix("mcp__") else {
        bail!("MCP tool name '{}' must start with mcp__", name);
    };
    let Some((server, tool)) = rest.split_once("__") else {
        bail!("MCP tool name '{}' must be mcp__<server>__<tool>", name);
    };
    if server.is_empty() || tool.is_empty() {
        bail!("MCP tool name '{}' must include server and tool", name);
    }
    Ok((server.to_string(), tool.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_namespaced_tool_names() {
        let (server, tool) = parse_namespaced_tool_name("mcp__github__search_issues").unwrap();

        assert_eq!(server, "github");
        assert_eq!(tool, "search_issues");
    }

    #[test]
    fn preserves_double_underscore_in_upstream_tool_name() {
        let (_, tool) = parse_namespaced_tool_name("mcp__srv__a__b").unwrap();

        assert_eq!(tool, "a__b");
    }
}
