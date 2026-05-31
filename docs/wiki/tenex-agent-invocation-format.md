---
title: TENEX Agent Invocation Format
slug: tenex-agent-invocation-format
summary: When an agent is invoked via tenex-agent, the triggering Nostr event must be single-line NDJSON, not pretty-printed
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-08
updated: 2026-05-08
verified: 2026-05-08
compiled-from: conversation
sources:
  - session:71483f36-b3c2-4ac4-8e7a-de1411f5d58c
---

# TENEX Agent Invocation Format

## Tenex Agent Invocation Format

When an agent is invoked via tenex-agent, the triggering Nostr event must be single-line NDJSON, not pretty-printed. The triggering Nostr event must have a valid cryptographic signature; an empty sig field will cause a parse failure. The TENEX_PROJECT_ID environment variable must be set to the project's d tag value. [^71483-2]

## See Also

