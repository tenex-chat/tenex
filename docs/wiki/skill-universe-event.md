---
title: Skill Universe Event
slug: skill-universe-event
summary: "Shared skills and project-specific skills are published on the kind:24010 event, not the agent's kind:0 event"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-04
updated: 2026-05-05
verified: 2026-05-04
compiled-from: conversation
sources:
  - session:6df2d5d2-9169-4af2-baff-2dc40332cd70
  - session:7a333250-a22a-4b6f-b358-af6a8cd99f74
---

# Skill Universe Event

## Skill Universe Event

The kind:24010 event carries project-scoped skills and MCP servers; kind:24011 carries available agents; kind:0 per-agent events carry backend skills, model capabilities, and assignments. Shared skills and project-specific skills are published on the kind:24010 event, not the agent's kind:0 event. The kind:24010 skill universe unions project-scoped, built-in, and user-global skill sources.

<!-- citations: [^6df2d-4] [^7a333-5] -->
## See Also

