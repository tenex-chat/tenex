---
title: MCP Server Configuration and Access
slug: mcp-server-configuration-and-access
summary: "The kind:24010 event announces available MCP servers as `[\\\\\\\\\\"mcp\\\\\\\\\\", <name>]` tags, sorted alphabetically"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-05
updated: 2026-05-05
verified: 2026-05-05
compiled-from: conversation
sources:
  - session:7a333250-a22a-4b6f-b358-af6a8cd99f74
  - session:81229adc-0b24-40de-b1a6-260ee4303b1b
---

# MCP Server Configuration and Access

## Server Discovery

The ProjectMcpRuntime loads .mcp.json once at startup and keeps that config in memory, with no file watcher for changes. The kind:24010 event is published immediately on startup, every 30 seconds on a ticker loop, and on-demand during agent config reloads. The kind:24010 event builder re-reads .mcp.json from disk fresh every time it fires, picking up new MCP servers within approximately 30 seconds automatically. The event announces available MCP servers as `["mcp", <name>]` tags, sorted alphabetically. If `.mcp.json` is missing or empty, the kind:24010 event gracefully emits no MCP tags.

<!-- citations: [^7a333-1] [^81229-1] -->
## Agent Access

Agent access to MCP servers is granted via kind:24020 events containing `["mcp", <server-name>]` tags. At spawn time, `mcp_access_from_default_json` reads MCP slugs from the agent's `default_config_json` and `prepare_manifest` validates them against `.mcp.json`. If an agent requests an MCP server slug not defined in the project's `.mcp.json`, the agent spawn fails with an unknown server error. [^7a333-2]

## Limitations

The `mcp_servers_json` field on the Agent model exists but is unimplemented dead data — agents cannot currently define their own private MCP servers. Agents can only use a newly added MCP server after the runtime restarts to reload ProjectMcpRuntime; a runtime restart is required to actually start and run the new MCP processes.

<!-- citations: [^7a333-3] [^81229-2] -->
## See Also

