---
title: "Agent Config Kind:0 Migration"
slug: agent-config-kind0-migration
summary: "Agents publish their configuration as kind:0 (NIP-01 Metadata) events instead of kind:34011 events"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-04
updated: 2026-05-04
verified: 2026-05-04
compiled-from: conversation
sources:
  - session:6df2d5d2-9169-4af2-baff-2dc40332cd70
---

# Agent Config Kind:0 Migration

## Agent Configuration Migration

Agents publish their configuration as kind:0 (NIP-01 Metadata) events instead of kind:34011 events. No kind:34011 references remain anywhere in the codebase. The AGENT_CONFIG constant (34011) is removed from the kinds module. [^6df2d-1]


Agent kind:0 events include slug and use-criteria as tags. The event content JSON is populated with name and about fields. Kind:0 events do not include a d tag. [^6df2d-2]

Skill tags in an agent's kind:0 event exclusively show skills the agent has (from the agent's home directory only). [^6df2d-3]
## See Also

