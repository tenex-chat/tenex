---
title: Agent Error Reply Event
slug: agent-error-reply-event
summary: "The error reply event extracts the most informative error line from stderr, preferring lines starting with 'Error:'."
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-03
updated: 2026-05-06
verified: 2026-05-03
compiled-from: conversation
sources:
  - session:2f8d7bc1-7b78-4167-98eb-7a6f581196d6
  - session:955fe4c3-a894-408f-8896-73c516b64184
---

# Agent Error Reply Event

## Error Reply Event

Agent errors must be surfaced to the user in a useful way to avoid leaving the user unaware of what happened. The error reply event extracts the most informative error line from stderr, preferring lines starting with 'Error:'. When an agent run fails before spawn, the system publishes an error message to the user via Nostr rather than silently discarding it. When an MCP server fails to initialize, StdioMcpClient captures the server's stderr output and appends it as context to the error message.

<!-- citations: [^2f8d7-2] [^955fe-1] -->
## See Also

