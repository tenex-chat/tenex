---
title: Agent Transient Error Retry
slug: agent-transient-error-retry
summary: On transient server errors (502/503/504, overloaded, temporarily unavailable), the agent retries up to 5 times with exponential backoff (10s, 20s, 40s, 80s, 80s
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-19
updated: 2026-05-19
verified: 2026-05-19
compiled-from: conversation
sources:
  - session:fe63628b-e936-4017-ad5d-db007827b9a2
  - session:8a07f7c6-4ca8-4f99-bd95-ac2f70324de2
---

# Agent Transient Error Retry

## Transient Server Error Retry

On transient server errors (502/503/504, overloaded, temporarily unavailable), the agent retries up to 5 times with exponential backoff (10s, 20s, 40s, 80s, 80s) before giving up.

During transient error retries, a streaming status message (kind:24135) is published to the conversation showing the retry attempt number and delay, bypassing the token buffer so it appears immediately.

On terminal error (retries exhausted or non-transient failure), an ErrorIntent (kind:1, tags ['error','system'], ['status','completed'], with p-tag) is published before returning, giving control back to the caller with the error message.

The `is_transient_server_error` classifier matches 502/503/504, 'service unavailable', 'overloaded', 'bad gateway', 'gateway timeout', and 'temporarily unavailable' but does NOT match 401 or 500.

5xx errors do NOT trigger key rotation (only transient retry), because a different key won't fix a provider outage.

When a provider drops an SSE stream mid-JSON, TENEX classifies the error as retryable=unknown and exits non-zero without retrying.

<!-- citations: [^fe636-1] [^fe636-2] [^fe636-3] [^fe636-4] [^fe636-5] [^8a07f-1] -->
## See Also

