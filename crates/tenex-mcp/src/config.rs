use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{bail, Context, Result};
use indexmap::IndexMap;
use serde::Deserialize;

pub const PROJECT_MCP_FILE_NAME: &str = ".mcp.json";

#[derive(Debug, Clone, Default)]
pub struct ProjectMcpConfig {
    pub servers: IndexMap<String, ProjectMcpServerConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectMcpServerConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct RawProjectMcpConfig {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: IndexMap<String, RawServerConfig>,
}

#[derive(Debug, Deserialize)]
struct RawServerConfig {
    #[serde(default = "default_stdio", rename = "type")]
    transport: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

fn default_stdio() -> String {
    "stdio".to_string()
}

impl ProjectMcpConfig {
    pub fn load_project(project_dir: &Path) -> Result<Self> {
        let path = project_dir.join(PROJECT_MCP_FILE_NAME);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        let raw: RawProjectMcpConfig = serde_json::from_slice(&bytes)
            .with_context(|| format!("parsing {}", path.display()))?;
        Self::from_raw(raw)
    }

    fn from_raw(raw: RawProjectMcpConfig) -> Result<Self> {
        let mut servers = IndexMap::new();
        for (name, server) in raw.mcp_servers {
            if name.trim().is_empty() {
                bail!("MCP server name cannot be empty");
            }
            if server.transport != "stdio" {
                bail!(
                    "MCP server '{}' uses unsupported transport '{}'; TENEX runtime supports project stdio MCP servers",
                    name,
                    server.transport
                );
            }
            let Some(command) = server.command.filter(|s| !s.trim().is_empty()) else {
                bail!("MCP server '{}' is missing command", name);
            };
            servers.insert(
                name,
                ProjectMcpServerConfig {
                    command,
                    args: server.args,
                    env: server.env,
                },
            );
        }
        Ok(Self { servers })
    }

    pub fn is_empty(&self) -> bool {
        self.servers.is_empty()
    }
}

impl ProjectMcpConfig {
    /// Parse agent-owned MCP servers from the inner-map JSON stored in
    /// `Agent.mcp_servers_json`. That field holds the value of the
    /// `mcpServers` key (e.g. `{"git": {"type":"stdio","command":"..."}}`)
    /// rather than the full `.mcp.json` wrapper object.
    pub fn from_agent_json(json: &str) -> Result<Self> {
        let inner: IndexMap<String, RawServerConfig> =
            serde_json::from_str(json).context("parsing agent mcpServers")?;
        Self::from_raw(RawProjectMcpConfig { mcp_servers: inner })
    }
}

pub fn mcp_access_from_default_json(default_config_json: Option<&str>) -> Result<Vec<String>> {
    let Some(raw) = default_config_json else {
        return Ok(Vec::new());
    };
    let value: serde_json::Value =
        serde_json::from_str(raw).context("parsing agent default config")?;
    let Some(mcp) = value.get("mcp") else {
        return Ok(Vec::new());
    };
    let Some(items) = mcp.as_array() else {
        bail!("agent default.mcp must be an array of MCP server slugs");
    };
    let mut out = Vec::new();
    for item in items {
        let Some(slug) = item.as_str().filter(|s| !s.trim().is_empty()) else {
            bail!("agent default.mcp entries must be non-empty strings");
        };
        if !out.iter().any(|existing| existing == slug) {
            out.push(slug.to_string());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_mcp_access() {
        let slugs =
            mcp_access_from_default_json(Some(r#"{"skills":["shell"],"mcp":["git","git"]}"#))
                .unwrap();

        assert_eq!(slugs, vec!["git"]);
    }

    #[test]
    fn rejects_non_array_agent_mcp_access() {
        assert!(mcp_access_from_default_json(Some(r#"{"mcp":"git"}"#)).is_err());
    }

    #[test]
    fn loads_project_mcp_config() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(PROJECT_MCP_FILE_NAME),
            r#"{"mcpServers":{"git":{"type":"stdio","command":"git-mcp","args":["--stdio"],"env":{"A":"B"}}}}"#,
        )
        .unwrap();

        let config = ProjectMcpConfig::load_project(tmp.path()).unwrap();

        let server = config.servers.get("git").unwrap();
        assert_eq!(server.command, "git-mcp");
        assert_eq!(server.args, vec!["--stdio"]);
        assert_eq!(server.env.get("A").map(String::as_str), Some("B"));
    }

    #[test]
    fn parses_agent_mcp_servers_inner_map() {
        // mcp_servers_json stores the inner map (no mcpServers wrapper).
        let json =
            r#"{"github":{"type":"stdio","command":"gh-mcp","args":["--stdio"],"env":{}}}"#;
        let config = ProjectMcpConfig::from_agent_json(json).unwrap();
        let server = config.servers.get("github").unwrap();
        assert_eq!(server.command, "gh-mcp");
        assert_eq!(server.args, vec!["--stdio"]);
    }

    #[test]
    fn rejects_agent_mcp_servers_with_non_stdio_transport() {
        let json = r#"{"srv":{"type":"http","url":"https://example.com"}}"#;
        assert!(ProjectMcpConfig::from_agent_json(json).is_err());
    }

    #[test]
    fn rejects_agent_mcp_servers_missing_command() {
        let json = r#"{"srv":{"type":"stdio"}}"#;
        assert!(ProjectMcpConfig::from_agent_json(json).is_err());
    }
}
