# tenex-mcp

Library crate. Owns project-scoped MCP runtime support for the Rust fleet.
It reads `.mcp.json` from a project working directory, starts configured MCP
servers in that directory, exposes tool manifests to `tenex-agent`, and serves
tool calls over a per-run Unix socket.

## Boundaries

- No global MCP config. Do not read or write `<base_dir>/mcp.json`.
- No agent JSON mutation. Agent access is read from the caller-provided
  `default.mcp` projection; installed-agent writes belong to
  `tenex-agent-registry`.
- No LLM dependencies. `tenex-agent` adapts manifests into `rig::ToolDyn`.
- No relay connections or Nostr publishing.

## Project Contract

Project MCP server definitions live in `.mcp.json` under the project working
directory using the `mcpServers` shape. Agent access is a list of server slugs
at `default.mcp` in `<base_dir>/agents/<pubkey>.json`.
