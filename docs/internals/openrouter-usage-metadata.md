---
title: "OpenRouter Usage Metadata"
date: "2026-04-30"
audience: "llms"
scope: "How Rust TENEX can recover OpenRouter generation, model, usage, and cost metadata while the agent runtime uses streaming rig calls."
status: "investigated"
---

# OpenRouter Usage Metadata

## Question

Can the Rust agent recover OpenRouter cost and model metadata through rig while keeping the agent's streaming execution path?

## Short Answer

Not with rig 0.35's current public streaming abstraction. OpenRouter returns the required metadata in the final streaming SSE chunk, but rig's OpenRouter provider maps that provider chunk into `rig::completion::Usage` and discards the OpenRouter-specific fields before `tenex-agent` sees the final response.

The viable Rust implementation choices are:

1. Patch or upstream rig so `providers::openrouter::streaming::StreamingCompletionResponse` carries `id`, `model`, and the full OpenRouter `usage` object, including `cost`, cache details, BYOK details, and cost breakdown.
2. Replace only the OpenRouter runtime path with a TENEX-owned streaming adapter that emits rig-compatible stream items while preserving OpenRouter metadata.
3. Use a non-streaming fallback only if losing streaming for OpenRouter turns is acceptable. Non-streaming rig already exposes `raw_response.id`, `raw_response.model`, and `raw_response.usage.cost`.

The `/generation` endpoint should not be the primary source for the runtime path. In the live probe, OpenRouter returned the same `gen-*` id in the `X-Generation-Id` header and final SSE chunk, but `GET /api/v1/generation?id=<id>` returned 404 for that fresh generation. The final SSE chunk already contained the needed accounting data.

## System Map

- `crates/tenex-agent/src/main.rs` runs all normal agent turns through `run_agent!`, which calls `agent.stream_chat(...)` and receives a rig `FinalResponse`.
- `rig-core 0.35.0` provides the OpenRouter provider implementation used by TENEX.
- `rig::providers::openrouter::streaming` deserializes OpenRouter streaming chunks with `id`, `model`, `choices`, `usage`, and `error`.
- That same rig streaming module stores only `Usage { prompt_tokens, completion_tokens, total_tokens }` in its provider streaming final response.
- Rig's generic streaming mapper then collapses provider streaming finals into `FinalCompletionResponse { usage: Option<rig::completion::Usage> }`.
- `tenex-agent` publishes `LlmUsage` from `final_response.usage()`, so only input, output, total, cached input, and cache creation token counters are available.

## Runtime Flow

For current Rust streaming:

1. `tenex-agent` resolves an OpenRouter model and key.
2. It constructs `openrouter::Client::new(&key)` and passes it into `run_agent!`.
3. Rig sends `/chat/completions` with `"stream": true`.
4. OpenRouter sends normal SSE chunks, then a final chunk with an empty choices array and a full `usage` object.
5. Rig records only token counts from that final chunk.
6. TENEX receives rig's final response and emits Nostr completion/conversation events with token usage but no OpenRouter generation id, resolved model, cost, BYOK flag, cache detail, or cost detail.

For rig non-streaming:

1. Rig sends `/chat/completions` without streaming.
2. The returned `CompletionResponse` keeps the OpenRouter raw response.
3. `raw_response.id`, `raw_response.model`, and `raw_response.usage.cost` are accessible.
4. This does not fit the current agent path because normal agent execution depends on streaming for deltas and tool-call flow.

## Probe Evidence

The local probe is `crates/tenex-agent/src/bin/openrouter_usage_probe.rs`.

Run:

```bash
cargo run -q -p tenex-agent --bin openrouter_usage_probe
```

It uses `openai/gpt-4o-mini` and compares:

- rig non-streaming
- rig streaming
- direct OpenRouter streaming over `reqwest`

Observed on 2026-04-30:

- rig non-streaming exposed `response_id`, `response_model`, core token usage, and `raw_usage_cost`.
- rig streaming exposed only `Usage { prompt_tokens, completion_tokens, total_tokens }`.
- direct streaming exposed `x-generation-id`, final SSE `id`, final SSE `model`, and full final SSE `usage`, including `cost`, `is_byok`, `prompt_tokens_details`, `completion_tokens_details`, and `cost_details`.
- `/generation` lookup with the final SSE id returned 404 in this environment, even after retrying.

## Contracts And Invariants

- OpenRouter's final streaming chunk is the best runtime source of truth for cost and detailed usage because it arrives before stream completion and belongs to the same response.
- TENEX should keep publishing core token fields through `tenex_protocol::LlmUsage`, but OpenRouter-specific metadata needs either protocol metadata support or telemetry-only attributes.
- If rig is patched, the provider-specific response must survive both the provider stream and rig's generic `FinalCompletionResponse` mapping. Patching only OpenRouter's internal deserializer is insufficient if the generic mapper still erases the fields.
- A TENEX-owned OpenRouter adapter must preserve rig's stream item semantics for text deltas, reasoning deltas, tool-call deltas, completed tool calls, and final response.

## Failure And Recovery

- If the final SSE chunk lacks `usage`, TENEX can still emit zero or partial token usage, matching current behavior.
- If `/generation` returns 404, the runtime should not fail a completed agent turn. The probe treats this lookup as diagnostic only.
- If rig's OpenRouter parser ignores final chunks with empty `choices`, usage can be lost. Rig 0.35's OpenRouter parser currently records `data.usage` only after requiring a first choice, which means usage-only final chunks are structurally at risk. The live direct stream showed the final usage chunk can have empty choices.

## Source Guide

- `crates/tenex-agent/src/main.rs` - current streaming-only agent execution path and `LlmUsage` publication.
- `crates/tenex-agent/src/bin/openrouter_usage_probe.rs` - executable probe comparing rig and direct OpenRouter paths.
- `~/.cargo/registry/src/.../rig-core-0.35.0/src/providers/openrouter/streaming.rs` - rig OpenRouter streaming parser and metadata loss point.
- `~/.cargo/registry/src/.../rig-core-0.35.0/src/streaming.rs` - generic mapper that collapses provider finals into `FinalCompletionResponse`.
- `~/.cargo/registry/src/.../rig-core-0.35.0/src/providers/openrouter/completion.rs` - non-streaming raw response keeps `id`, `model`, and `usage`.
- `crates/tenex-protocol/src/intent.rs` - current `LlmUsage` and `LlmMetadata` event payload limits.

## Addendum: Differences From The TypeScript Implementation

The TypeScript reference at `/home/pablo/Work/tenex-typescript-ref` used `@openrouter/ai-sdk-provider` through `OpenRouterProvider`. Its stream finish path read `providerMetadata.openrouter`, extracted the generation id for trace correlation, and preferred `providerMetadata.openrouter.usage` for cost, token counts, cached input tokens, and reasoning tokens.

Relevant TypeScript files:

- `src/llm/providers/standard/OpenRouterProvider.ts` - `extractUsageMetadata` reads `providerMetadata.openrouter.usage.cost` and token details; `extractGenerationId` reads `providerMetadata.openrouter.id`.
- `src/llm/FinishHandler.ts` - records `openrouter.generation_id` on the active span and emits provider-specific usage on completion.
- `src/llm/utils/usage.ts` - reads OpenRouter provider metadata for current-step usage before tool events.

Rust has equivalent event-level token publication, but it currently lacks an equivalent provider metadata channel because rig erases the OpenRouter metadata before TENEX receives the streaming final response.
