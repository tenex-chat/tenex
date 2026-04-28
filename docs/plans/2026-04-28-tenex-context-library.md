# `tenex-context` — Product Spec

## Purpose

A Rust crate that turns a conversation identifier into a ready-to-send LLM request shape. It owns projection (history → `messages[]`), context management (compaction, decay, reminders), and cache-anchoring decisions. It is the only place in the Rust stack that holds opinions about how to talk to a model.

Sits between `tenex-conversations` (storage) and the Rust agent runner (the LLM loop).

## Companion to `tenex-conversations`

| Crate | Concern | Change rate |
|-------|---------|-------------|
| `tenex-conversations` | What happened. Storage primitives, schema, migrations. | Slow. |
| `tenex-context` | How to present it to the model right now. Strategies, heuristics, cache decisions. | Fast — this is where iteration happens. |

The cut is intentional: storage stays stable so context-management can move fast without risk of schema churn or coupling.

## Scope and parallelism with TypeScript

- **Rust-only.** No TS binding.
- The existing TypeScript context-management stack in `src/agents/execution/` and `src/conversations/` continues to serve the TS agent runner unchanged.
- The two runners do not share projection logic. They do not need to. The Rust runner reads/writes the same `tenex-conversations` SQLite database (read-only is sufficient for the projection path; writes go through `tenex-conversations` directly).
- If the TS runner is eventually retired, the TS context-management code is deleted with it. Until then, the two evolve independently.

## What it owns

- **Projection.** Given conversation history and an agent identity, build the `{ system, messages, tools }` triple to send to the provider.
- **Frozen prompt-history.** The per-agent replay view: once a message becomes visible to a model, it is recorded as-sent and never rewritten. This is the substrate that makes prompt caching meaningful.
- **Context-management strategies.** Compaction, tool-result decay, reminder overlays. Composable, individually testable, swappable per agent or per model.
- **Cache-anchoring decisions.** Where breakpoints go, whether reminders are ephemeral or durable, gated on observed cache behavior from prior turns.
- **Multimodal preparation at the request boundary.** Provider-aware image normalization (URL → base64 for Ollama, etc.). It's a projection concern, not an LLM-call concern.

## What it does *not* own

- Storage — calls `tenex-conversations`.
- The LLM call itself — the agent runner hands the projection to `rig` or equivalent.
- Tool *execution* — tool *definitions* are an input; the run loop is above this crate.
- Skill resolution, agent definitions, instructions — those are *inputs* the agent runner assembles.
- Streaming, retries, provider auth — those belong to the LLM/transport layer.

## API surface

The crate exposes a small typed API. Two main entrypoints; the rest are strategy plumbing.

### Projection

```
project(
  conversation_id,
  agent: { pubkey, name, instructions, category, ... },
  model_profile: ModelProfile,
  tool_set: [ToolDef],
  active_skills: [SkillRef],
) -> Projection {
  system: SystemPrompt,
  messages: Vec<Message>,
  tools: Vec<ToolDef>,
  cache_breakpoints: Vec<BreakpointHint>,
  telemetry: ProjectionTelemetry,
}
```

`ModelProfile` is the load-bearing input. It carries: provider, model id, prompt-cache support, ephemeral-reminder support, image support, max-context window. Today these capability flags are scattered and implicit; making them explicit kills a class of "works on Anthropic, breaks on OpenRouter" bugs.

### Turn write-back

```
record_turn(
  conversation_id,
  agent_pubkey,
  turn: TurnRecord {
    messages_visible: ...,
    reminders_applied: ...,
    compaction_decisions: ...,
    cache_observed: CacheObservation,
  },
) -> ()
```

After a turn, the runner reports what was sent and what the provider did with the cache. The crate updates frozen prompt-history and context-management state via `tenex-conversations`. This closes the loop: cache observations from this turn shape projection for the next.

### Strategy registration (internal)

Compaction, decay, reminders are pluggable strategies behind a small trait. The default stack mirrors today's TS pipeline: `CompactionToolStrategy` → `ToolResultDecayStrategy` → `RemindersStrategy`. New strategies become a single file with a test fixture; no other code moves.

## Layering

```
tenex-agent (run loop, LLM calls, tool execution)
     ↓
tenex-context (projection + context management)
     ↓
tenex-conversations (storage)
```

`tenex-conversations` never knows what an LLM is. `tenex-context` never opens a socket. The agent runner never builds a `messages[]` array by hand.

## Testing model

Projection is a pure function modulo the storage read. The natural test rig:

- Fixture: a conversation snapshot (rows in a temp SQLite DB), an agent identity, a model profile, a tool set.
- Assertion: the resulting `Projection` matches a golden expected value.

This makes context-management strategies cheap to iterate. New compaction idea? Add a strategy, add a fixture, compare projections. No agent loop, no LLM, no relay.

`record_turn` tests are similar: feed a `TurnRecord`, assert the storage delta.

## Concurrency

Stateless from the consumer's perspective. The crate holds no long-lived state; per-call it reads what it needs from `tenex-conversations` and writes back through it. Multi-process safety is inherited from `tenex-conversations`'s SQLite WAL model.

## Migration story

There is nothing to migrate at the data layer — context-management state already lives in `tenex-conversations` (per the consolidated schema). This crate's introduction is purely additive on the Rust side.

## Non-goals

- No TS binding. Won't be built; if it's needed it's a sign the TS runner should be retired instead.
- No abstract "LLM client" shim. That's the agent runner's job.
- No streaming/partial-projection API in v1. Add when needed.
- No automatic strategy selection ("pick the best compaction"). The agent runner configures the stack explicitly.
- No persistence outside `tenex-conversations`. Every durable bit goes through that crate.

## Success criteria

- The Rust agent runner builds zero `messages[]` arrays itself. Every projection goes through `tenex-context`.
- Adding a new context-management strategy is one file in `tenex-context` plus a fixture; no changes elsewhere.
- A model-profile capability change (e.g., a provider that suddenly supports prompt cache) is a one-line `ModelProfile` flip and the projection adapts; no callsite changes.
- Cache observations from one turn measurably shape the next turn's projection in tests.
- The TS context-management code is untouched by this crate's introduction. The two systems are entirely independent until the day the TS runner is retired.
