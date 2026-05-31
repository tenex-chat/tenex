---
title: Agent-Owned MCP Servers
slug: agent-owned-mcp-servers
summary: An agent carries its own MCP servers to whatever project it is part of, independent of project-level .mcp.json configuration.
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-05
updated: 2026-05-08
verified: 2026-05-05
compiled-from: conversation
sources:
  - session:1f3072a5-fd41-42f4-9e69-730fe61f93c8
  - session:71483f36-b3c2-4ac4-8e7a-de1411f5d58c
---

# Agent-Owned MCP Servers

## Overview

An agent carries its own MCP servers to whatever project it is part of, independent of project-level .mcp.json configuration. [^1f307-1]


## Runtime Lifecycle

Agent-owned MCP servers (from mcpServers in the agent doc) are started per-run in their own ProjectMcpRuntime alongside the shared project pool. The bridge dispatches tool calls to the correct pool (project or agent) by server slug. When an MCP server name exists in both the agent's owned mcpServers and the project's default.mcp, the agent-owned server always wins and shadows the project-defined server, with no collision error. An agent must not fail to start when a configured MCP server is missing; instead, it must log a warning and skip the missing server, continuing execution without those tools.

<!-- citations: [^1f307-2] [^71483-1] -->
## Storage and CLI Management

AgentStorage provides set_agent_mcp_server and remove_agent_mcp_server mutations for managing agent-owned MCP servers. All mcp CLI subcommands (add, add-json, list, get, remove) accept --agent <slug> and operate on the agent's own mcpServers block when provided. [^1f307-3]

## Event Handling

The kind:0 event includes agent-owned MCP server tags (mcp_server_slugs reads from mcp_servers_json and emits ["mcp", <slug>, "active"] tags). When mcpServers is changed via the CLI, a kind:24020 event should be sent so the running runtime processes it and immediately republishes kind:0. [^1f307-4]
## See Also

