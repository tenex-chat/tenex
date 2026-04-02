---
name: MCP Resources
description: Discover, read, and subscribe to MCP server resources
tools:
  - mcp_list_resources
  - mcp_resource_read
  - mcp_subscribe
  - mcp_subscription_stop
---

# MCP Resources

This skill provides tools for discovering MCP server resources, reading them on-demand, and managing persistent subscriptions.

## Workflow

1. **Discover** available resources with `mcp_list_resources` — shows all resources and templates from your MCP servers
2. **Read** a resource on-demand with `mcp_resource_read` — provide `serverName`, `resourceUri`, and optionally `templateParams` to expand URI templates
3. **Subscribe** to resource updates with `mcp_subscribe` — notifications arrive as system messages in the current conversation
4. **Stop** a subscription with `mcp_subscription_stop` when no longer needed
