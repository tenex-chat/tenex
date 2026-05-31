---
title: ACP Tool Call Boundary Flush
slug: acp-tool-call-boundary-flush
summary: "ACP agents must flush kind:1 (Intent::Conversation) at every tool-call boundary, matching tenex-agent behavior"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-01
updated: 2026-05-01
verified: 2026-05-01
compiled-from: conversation
sources:
  - session:0f7e06eb-0ea5-481f-98ea-f713e6dfb620
  - session:af62562b-6190-4f03-b35b-ab8a045d9f22
---

# ACP Tool Call Boundary Flush

## Tool-Call Boundary Flush

ACP agents must flush kind:1 content incrementally at tool-call boundaries rather than deferring all output until completion. The AcpUpdates::apply handler must process session/update messages for tool_call events instead of discarding them. AcpUpdate has a ToolCallStarted variant that signals a tool boundary, and the update handler emits Intent::Conversation when a tool boundary arrives, then resets the buffer for continued streaming.

<!-- citations: [^0f7e0-1] [^af625-1] -->
## Two-Buffer Flush Mechanism

Visible text is split into a pending + current two-buffer approach (mirroring hook.rs) so the prior buffer can be emitted when a tool boundary arrives. acp_process apply() handles tool_call updates by taking the current segment and returning it as a flush variant rather than silently dropping it. The final emit uses the residual current_segment buffer to avoid duplicate content. [^0f7e0-2]
## See Also

