---
title: Agent Stderr Piping
slug: agent-stderr-piping
summary: Agent stderr is piped and collected concurrently while stdout is drained, with lines still forwarded to the console so nothing is lost.
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-03
updated: 2026-05-19
verified: 2026-05-03
compiled-from: conversation
sources:
  - session:2f8d7bc1-7b78-4167-98eb-7a6f581196d6
  - session:955fe4c3-a894-408f-8896-73c516b64184
  - session:b6a248fc-4fb1-42d7-85e6-bcab91d3e6be
  - session:809fecfb-f84b-4f6b-9ae7-5e04f97173da
---

# Agent Stderr Piping

## Agent Stderr Piping

Agent stderr is piped and collected concurrently while stdout is drained, with lines still forwarded to the console so nothing is lost. The StdioMcpClient pipes the MCP server's stderr through a background task that echoes lines to daemon stderr while accumulating them for error reporting. The StdioMcpClient shutdown method aborts the stderr accumulation background task. The agent dispatch pipeline can experience massive idle gaps within a single iteration, causing a run to appear active without performing meaningful work. Tool-result decay must also run inside rig's multi-turn loop (via RecordingModel's sanitize path), not only at agent bootstrap projection time.

<!-- citations: [^2f8d7-3] [^955fe-2] [^b6a24-1] [^809fe-2] -->
## See Also

