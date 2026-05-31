---
title: LLM Stream Tracing and Observability
slug: llm-stream-tracing-observability
summary: A tracing log event must be emitted before each LLM stream request in cassette_client.rs, recording the message count, message character count, and model ID, so
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-12
updated: 2026-05-14
verified: 2026-05-12
compiled-from: conversation
sources:
  - session:237f2283-8419-4745-b4b4-a4a5925d8099
  - session:686b6ab8-e86d-458d-b463-ce5fa69e24fb
---

# LLM Stream Tracing and Observability

## LLM Stream Tracing & Observability

A tracing log event must be emitted before each LLM stream request in cassette_client.rs, recording the message count, message character count, and model ID, so that the data is exported even if the span never completes. Stream failure classification must capture raw bytes received before a parse error (e.g. via a ring buffer) to distinguish TCP drops from partial error responses. The HTTP status code from Ollama responses must be recorded as a span attribute on stream errors so that a 200-then-drop can be distinguished from a 503/500 error response. Streaming turns that end without FinalResponse (Ollama pure-tool-call turns ending via the None branch) leave gen_ai.usage.* attributes empty because record_streaming_final never runs. The None branch in cassette_client.rs calls record_once for cassette persistence but writes no usage telemetry onto the span, making tool-only turns invisible in traces. #110 should be the first PR, adding a record_streaming_end_without_final helper to the None branch of cassette_client.rs so every later #109 probe shows per-step telemetry. Cassette replay must be re-recorded rather than maintaining backwards-compatible shims.

<!-- citations: [^237f2-3] [^686b6-8] -->
## See Also

