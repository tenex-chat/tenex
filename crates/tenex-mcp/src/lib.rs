pub mod bridge;
pub mod config;
pub mod manifest;
pub mod runtime;
mod stdio;

pub use bridge::{bind_socket, serve_socket, BoundSocketServer, SocketServerConfig};
pub use config::{
    mcp_access_from_default_json, ProjectMcpConfig, ProjectMcpServerConfig, PROJECT_MCP_FILE_NAME,
};
pub use manifest::{McpToolCallRequest, McpToolCallResponse, ToolManifest, ToolManifestEntry};
pub use runtime::ProjectMcpRuntime;
