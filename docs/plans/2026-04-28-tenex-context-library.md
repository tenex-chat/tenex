# `tenex-context` — Product Spec

## Purpose

A Rust crate that turns a conversation identifier into the message-stream half of an LLM request. It owns projection (history → `messages[]`), context management (compaction, decay, reminders), and cache-anchoring decisions for the message stream. The system prompt is an *input*, built upstream by `tenex-system-prompt`.

Sits between `tenex-conversations` (storage) and the Rust agent runner (the LLM loop).

## Companions

| Crate | Concern | Change rate |
|-------|---------|-------------|
| `tenex-conversations` | What happened. Storage primitives, schema, migrations. | Slow. |
| `tenex-system-prompt` | Who the agent is. Identity → stable system-prompt string. | Slow per agent. |
| `tenex-context` | What the model sees right now. Messages, decay, cache. | Fast — this is where iteration happens. |

The cuts are intentional: storage stays stable so context-management can move fast; system-prompt assembly is separated so identity composition and message-stream presentation can iterate independently.

## Scope and parallelism with TypeScript

- **Rust-only.** No TS binding.
- The existing TypeScript context-management stack in `src/agents/execution/` and `src/conversations/` continues to serve the TS agent runner unchanged.
- The two runners do not share projection logic. They do not need to. The Rust runner reads/writes the same `tenex-conversations` SQLite database (read-only is sufficient for the projection path; writes go through `tenex-conversations` directly).
- If the TS runner is eventually retired, the TS context-management code is deleted with it. Until then, the two evolve independently.

## What it owns

- **Projection.** Given conversation history, an agent identity, and an opaque system-prompt string, build the `messages[]` to send to the provider.
- **Frozen prompt-history.** The per-agent replay view: once a message becomes visible to a model, it is recorded as-sent and never rewritten. This is the substrate that makes prompt caching meaningful.
- **Context-management strategies.** Compaction, tool-result decay, reminder overlays. Composable, individually testable, swappable per agent or per model.
- **Cache-anchoring decisions for the message stream.** Where breakpoints go inside `messages[]`, whether reminders are ephemeral or durable, gated on observed cache behavior from prior turns. The system-prompt anchor is implicit (always the start) and not a decision this crate makes.
- **Multimodal preparation at the request boundary.** Provider-aware image normalization (URL → base64 for Ollama, etc.) for images carried in the message stream.

## What it does *not* own

- **System-prompt assembly.** That belongs to `tenex-system-prompt`. The system prompt enters as an opaque `&str` and is treated as stable.
- Storage — calls `tenex-conversations`.
- The LLM call itself — the agent runner hands the projection to `rig` or equivalent.
- Tool *definitions* and tool *execution* — tool defs flow agent → `rig` directly; the run loop is above this crate.
- Skill resolution, agent definitions, instructions — those are inputs the agent runner assembles into the system prompt upstream.
- Streaming, retries, provider auth — those belong to the LLM/transport layer.

## API surface

The crate exposes a small typed API. Two main entrypoints; the rest are strategy plumbing.

### Projection

```
project(
  conversation_id,
  agent_pubkey,
  system_prompt: &str,        // opaque; built upstream by tenex-system-prompt
  model_profile: ModelProfile,
  tool_defs: &[ToolDef],      // for no-decay tagging lookup; not rendered
) -> Projection {
  messages: Vec<Message>,
  cache_breakpoints: Vec<BreakpointHint>,
  telemetry: ProjectionTelemetry,
}
```

`system_prompt` is a `&str` because this crate has no opinion about its structure. The agent runner is responsible for caching and recomputing it.

`ModelProfile` is the load-bearing input. It carries: provider, model id, prompt-cache support, ephemeral-reminder support, image support, max-context window. Today these capability flags are scattered and implicit; making them explicit kills a class of "works on Anthropic, breaks on OpenRouter" bugs.

`tool_defs` is passed in so strategies can look up per-tool flags (notably `preserve_results` — see below). The crate does not render or transmit tool definitions; those flow agent → `rig` directly.

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

### No-decay tool tagging

Tool definitions carry a `preserve_results: bool` flag. When set, the decay strategy excludes results of that tool from eviction. The flag is a property of the tool definition, declared by the tool author — it is not a runtime decision.

Two tools must set this flag from day one:

- **`load_skill`** — the skill body returned in the tool result is load-bearing context for the rest of the conversation. Evicting it would force a re-load and silently degrade behavior in between.
- **`delegate`** — the delegated work product is the substrate for the rest of the agent's reasoning.

Other tools (file reads, shell commands, search results) remain decay-eligible by default. The flag is opt-in, so the typical case stays cheap.

The decay strategy resolves a tool result against the `tool_defs` input to find the originating tool's flag. Tool results recorded for tools no longer present in the current `tool_defs` (e.g., a built-in skill that was deactivated) default to decay-eligible.

## Layering

```
tenex-agent (run loop, LLM calls, tool execution)
   ↓
tenex-system-prompt    tenex-context
       (identity → text)    (history → messages[])
                              ↓
                     tenex-conversations (storage)
```

`tenex-system-prompt` and `tenex-context` are siblings; neither imports the other. The agent runner calls `tenex-system-prompt::build(...)` once when its inputs are known, caches the result, and passes it as `&str` to `tenex-context::project(...)` every turn.

`tenex-conversations` never knows what an LLM is. `tenex-context` never opens a socket. The agent runner never builds a `messages[]` array by hand and never builds a system prompt by hand.

## Testing model

Projection is a pure function modulo the storage read. The natural test rig:

- Fixture: a conversation snapshot (rows in a temp SQLite DB), an agent identity, a model profile, a tool set, and a fixed system-prompt string.
- Assertion: the resulting `Projection` matches a golden expected value.

The fixed system-prompt string in the fixture is what makes these tests independent of `tenex-system-prompt` — `tenex-context` tests do not exercise identity composition.

This makes context-management strategies cheap to iterate. New compaction idea? Add a strategy, add a fixture, compare projections. No agent loop, no LLM, no relay.

No-decay tagging gets its own coverage: a fixture with a long stream of mixed `load_skill` / `delegate` / file-read results, asserting that decay drops the file reads and keeps the others.

`record_turn` tests are similar: feed a `TurnRecord`, assert the storage delta.

## Concurrency

Stateless from the consumer's perspective. The crate holds no long-lived state; per-call it reads what it needs from `tenex-conversations` and writes back through it. Multi-process safety is inherited from `tenex-conversations`'s SQLite WAL model.

## Migration story

There is nothing to migrate at the data layer — context-management state already lives in `tenex-conversations` (per the consolidated schema). This crate's introduction is purely additive on the Rust side.

## Non-goals

- No system-prompt assembly. That belongs to `tenex-system-prompt`.
- No tool rendering or tool transmission. Tool defs flow agent → `rig` directly.
- No TS binding. Won't be built; if it's needed it's a sign the TS runner should be retired instead.
- No abstract "LLM client" shim. That's the agent runner's job.
- No streaming/partial-projection API in v1. Add when needed.
- No automatic strategy selection ("pick the best compaction"). The agent runner configures the stack explicitly.
- No persistence outside `tenex-conversations`. Every durable bit goes through that crate.

## Success criteria

- The Rust agent runner builds zero `messages[]` arrays itself. Every projection goes through `tenex-context`.
- Adding a new context-management strategy is one file in `tenex-context` plus a fixture; no changes elsewhere.
- A model-profile capability change (e.g., a provider that suddenly supports prompt cache) is a one-line `ModelProfile` flip and the projection adapts; no callsite changes.
- A tool author can add a new no-decay tool by setting `preserve_results: true` on its definition; no `tenex-context` change required.
- Cache observations from one turn measurably shape the next turn's projection in tests.
- This crate does not import `tenex-system-prompt`. The system prompt crosses the boundary as `&str`.
- The TS context-management code is untouched by this crate's introduction. The two systems are entirely independent until the day the TS runner is retired.
