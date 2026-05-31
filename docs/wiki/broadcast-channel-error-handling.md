---
title: Broadcast Channel Error Handling
slug: broadcast-channel-error-handling
summary: When receiving from a broadcast channel, errors must be handled according to their type
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-10
updated: 2026-05-12
verified: 2026-05-10
compiled-from: conversation
sources:
  - session:05804273-f8a8-4eef-8c9d-1e3b748ea09c
  - session:42246ffd-0210-47c4-a8bb-3cd19e34b6ed
---

# Broadcast Channel Error Handling

## Broadcast Channel Recv Error Handling

When receiving from a broadcast channel, errors must be handled according to their type. On `Lagged` errors, warn and continue the loop. On `Closed` errors, break the loop. This applies to both the daemon's nostr notification loop and tenex-protocol's `relay_source`. [^05804-1]


Directed events that target an agent not in the current project should not be recorded as errors. A NotForRuntime error type is used for events not addressed to the current runtime, including wrong project a tags, p tags targeting foreign agents, and untargeted replies with no e tag match. The record_current_error call in dispatch_pipeline.rs is skipped when the error is NotForRuntime, so such spans show outcome persisted_no_target with an INFO log but no exception event. [^42246-1]
## See Also

