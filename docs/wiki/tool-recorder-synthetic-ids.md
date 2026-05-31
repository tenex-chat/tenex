---
title: Tool Recorder and Synthetic Call IDs
slug: tool-recorder-synthetic-ids
summary: "ToolRecorder mints synthetic call IDs because rig's ToolDyn::call trait only accepts args and does not expose provider tool IDs."
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-14
updated: 2026-05-14
verified: 2026-05-14
compiled-from: conversation
sources:
  - session:686b6ab8-e86d-458d-b463-ce5fa69e24fb
---

# Tool Recorder and Synthetic Call IDs

## Synthetic Call IDs

ToolRecorder mints synthetic call IDs because rig's ToolDyn::call trait only accepts args and does not expose provider tool IDs. [^686b6-10]

## See Also

