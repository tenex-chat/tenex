---
title: OTel Trace Pipeline and Span Architecture
slug: otel-trace-pipeline
summary: Each dispatched Nostr event produces exactly one trace rooted at `tenex.daemon.event_received`, with `tenex.runtime.dispatch` and `tenex.agent.turn` as nested c
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-03
updated: 2026-05-03
verified: 2026-05-03
compiled-from: conversation
sources:
  - session:2335732d-023c-41c6-a0aa-c80a2cb164d5
  - session:4eda1843-29a0-4cd9-9183-04fa8ef0656b
  - session:1b06fb1c-76a7-4640-8f80-f96a117df221
---

# OTel Trace Pipeline and Span Architecture

## Trace Topology

Each dispatched Nostr event produces exactly one trace rooted at `tenex.daemon.event_received`, with `tenex.runtime.dispatch` and `tenex.agent.turn` as nested children. The `tenex.agent.turn` span wraps the entire agent process, created in `main.rs::run` before the turn loop and bootstrap, extracting the env trace carrier once at that level; the per-iteration span inside the turn loop is named `tenex.agent.iteration` and carries an `iteration` counter, inheriting context from the outer turn span rather than extracting the env carrier. The `tenex.agent.process` span is removed; its identity fields are demoted to Resource attributes on the agent's tracer provider. One Nostr event dispatches to at most one agent; the `select_dispatch_target` function returns a single `Agent`, and multi-agent participation arises from separate events sharing a `conversation.id`. All turns of the same conversation share a single `trace_id` via a first-turn-frozen `trace_root` persisted in the conversation store. The `trace_root` is written once per conversation (atomic absent-check under the store mutex) and never overwritten; subsequent turns extract it as the parent of their `event_received` span. Delegated conversations are independent trace families—trace context never crosses the Nostr publish→relay→subscribe boundary. `self_delegate` creates a new `conversation.id` with its own independent trace family, not a continuation of the parent conversation.

The trace hierarchy restructuring (`tenex.runtime.dispatch` -> `tenex.agent.turn` -> `chat_streaming` -> `chat claude-*` with event.id, agent.slug/pubkey, project.id, conversation.id) is implemented as a separate PR independent of the incident instrumentation. [^1b06f-5]

<!-- citations: [^23357-3] [^4eda1-1] -->
## Context Propagation

Trace context propagates per-turn through the `TRACEPARENT`/`TRACESTATE`/`BAGGAGE` env vars at process spawn, not via an IPC channel on a long-lived agent. `DispatchJob` carries a `trace_carrier` field populated at ingress inside the `event_received` span, eliminating the stale ambient-context capture bug. Env injection at child spawn builds `TRACEPARENT`/`TRACESTATE` from `inject_current()` (capturing the active dispatch span context) rather than from the raw `job.trace_carrier`. `inject_current()` reads `Context::current()` (live thread-local with attached baggage) preferentially, falling back to merging baggage into `Span::current().context()`. A `BaggageSpanProcessor` copies baggage entries onto every emitted span as attributes, scoped to IPC only—no global `BaggagePropagator`, and no baggage leaks to external HTTP clients. [^23357-4]

## Conversation Grouping

`conversation.id` is set on the `event_received` root span and inherited via parent context; Jaeger tag search on `conversation.id` returns all turns of a conversation. `add_link_to_span` and the `lastTrace` store path are deleted; conversation grouping uses `conversation.id` tag search instead. [^23357-5]

## LLM and Tool Spans

LLM completion spans use the `gen_ai` semconv naming convention (`chat {model}` with `gen_ai.*` attribute namespace) rather than `llm.completion`. Tool call spans are renamed from `tenex.agent.tool_call` to `execute_tool {name}` with `gen_ai.tool.*` attributes and error recording on `Result::Err`. `gen_ai.input.messages` and `gen_ai.output.messages` are always captured on LLM spans; there is no opt-in config flag. [^23357-6]


TENEX's RecordingClient::stream wrapper tracks ToolCallDeltaContent::Name and Delta, and on stream error records provider span attributes including `gen_ai.stream.error.stage`, `gen_ai.stream.partial_tool.name`, `gen_ai.stream.partial_tool.args_len`, `gen_ai.stream.chunk_count`, and `gen_ai.stream.tool_delta_count`. The wrapper captures Anthropic's `stop_reason` from the `message_delta` SSE event unconditionally on the provider span as `gen_ai.stream.stop_reason`. [^1b06f-1]

On stream parse error in the cassette, the full accumulated tool call args string (capped at 8KB with a truncation flag) is logged rather than just metadata like `args_len` or `args_sha256`. Additionally, `gen_ai.stream.partial_tool.args_context` captures a window of bytes surrounding the serde error column offset (e.g., `args[max(0, col-128)..min(len, col+128)]`), replacing the proposed 2KB `args_tail` which is ineffective for middle-of-string errors. Error-path capture of tool arguments is opt-in at the agent/project level, or requires a scrubbing pass before export, to mitigate PII risk in the observability store. [^1b06f-2]
## Delegation Attributes

Delegation tools record `delegated.conversation.id`, `delegated.agent.pubkey`, and `delegated.event.id` as span attributes; `delegate_followup` records nothing because it stays in the same conversation. [^23357-7]

## Resource Attributes and Identity

Agent process identity fields (`agent.pubkey`, `agent.slug`, `project.id`) are promoted to Resource attributes on the agent tracer provider, removed from `tenex.agent.turn` span attributes. [^23357-8]

## Daemon Lifecycle Spans

Three daemon-lifecycle spans are added: `tenex.daemon.child_spawn`, `tenex.daemon.graceful_shutdown`, and `tenex.daemon.agent_config_update`. [^23357-9]

## Error Handling

A `record_current_error` helper records OTel error status and exception events on `Span::current()` at every `.instrument()` boundary error site. [^23357-10]


Failure classifications like `provider_stream_tool_args_json_error` include a `retryable` flag to gate retry logic, distinguishing between non-retryable max_tokens truncations, retryable network splits, and conditionally retryable model bugs. The cassette error-path records are explicitly designed for either replay (storing raw accumulated delta strings to feed back through the adapter) or diagnosis, not an ambiguous hybrid of both. [^1b06f-3]
## Exporter and Shutdown

The agent exporter switches from gRPC to OTLP/HTTP to tolerate process exit cleanly (connection-per-batch). Agent shutdown uses a bounded 10s timeout with `spawn_blocking` `force_flush` before shutdown, avoiding the opentelemetry-rust <0.28 deadlock. `opentelemetry-rust` is pinned to ≥0.28 to avoid `BatchSpanProcessor` `force_flush` deadlocks. [^23357-11]

## Telemetry Init API

The telemetry crate init API collapses from 4 functions into a single `init(TelemetryInit { service_name, base_dir, kind, extra_resource })`. [^23357-12]

## Context Projection Diagnostics

TENEX omits the proposed context projection diagnostics for the already-fixed duplicate-event bug (original stored message count, projected history count, excluded trigger event id, role counts, tool-result pair counts). It adds token count per message and compaction drop indicators to context projection diagnostics to evaluate the max_tokens truncation hypothesis. [^1b06f-4]
## See Also

