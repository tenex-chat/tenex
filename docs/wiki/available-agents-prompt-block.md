---
title: Available Agents Prompt Block
slug: available-agents-prompt-block
summary: The `<available-agents>` prompt block lists all project members from the 31933 p-tags, marking remote agents with `[remote-backend]` and leaving local agents un
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-04
updated: 2026-05-04
verified: 2026-05-04
compiled-from: conversation
sources:
  - session:0149dc43-0d5b-44fd-b432-426c3cbf45cf
  - session:d6e1583c-1ca8-42d5-bccd-f5bb51dc1e0f
---

# Available Agents Prompt Block

## Available Agents Prompt Block

The `<available-agents>` prompt block lists all project members from the 31933 p-tags, marking remote agents with `[remote agent running on $backend_name]` using the backend name from their kind:0 event, falling back to `[remote agent]` when the name is unknown, and leaving local agents untagged. The system prompt rendering replaces the generic `[remote-backend]` label with the actual backend name. When at least one remote agent is present, a block-level legend explaining the remote tag appears at the top of the `<available-agents>` block. Remote agents display their slug and use-criteria sourced from the agent's kind:0 event tags (not the content JSON), falling back to an 8-char pubkey prefix when unavailable. (Previously: Remote agents were marked with `[remote-backend]`.)

<!-- citations: [^0149d-3] [^d6e15-4] -->
## See Also

