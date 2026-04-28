# `tenex-runtime` — Orchestrator Spec (Forward Plan)

## Status

Forward plan. **Not for v1 build.** This spec captures the role and boundaries of the per-project Rust runtime orchestrator that will eventually replace the bun project runtime, so we make consistent decisions today (schemas, protocols, runner contract) that don't have to be redone when this lands.

## Purpose

A per-project Rust process that owns subscribe-and-orchestrate for a single TENEX project: it reads inbound events from relays, holds dispatch and RAL state, decides which agent runs, manages long-lived `tenex-agent` runner processes, and routes delegation completions through the in-flight tree.

Not the agent. Not the relay-mux. The thing that *coordinates* between them.

## The three roles, kept separate

| Role | Process | State |
|------|---------|-------|
| **Subscribe** | Host-wide relay-multiplexer (roadmap item) | Connection-only |
| **Orchestrate** | `tenex-runtime` (one per active project) | RAL, dispatch, delegations |
| **Execute** | `tenex-agent` (one per active conversation × agent) | LLM loop, tool calls, prompt cache |

The runner does **not** subscribe to relays. The runner does **not** hold dispatch state. Every piece of cross-event state lives in the orchestrator. This separation is what makes the system tractable.

## What it owns

- Per-project relay subscription (today: direct `nostr-sdk`; eventually: a stream from the relay-mux).
- The dispatch decision: incoming event → which agent (or PM fallback).
- The RAL state: conversation × agent × pending delegations × runner handle.
- Runner lifecycle: spawn on first turn, keep alive across turns in a conversation, reap when conversation goes cold.
- Delegation tree management: publish delegation kind:1, wait for completion, route completion frames back to the waiting runner.
- Completion publishing: take the runner's final completion frame, sign with the agent's signer (via `tenex-project`), publish.

## What it does *not* own

- LLM calls, prompt assembly, tool execution. That's the runner.
- Storage primitives. That's `tenex-conversations` and `tenex-project`.
- Project boot. The supervisor daemon spawns this process.
- Other projects' state. One orchestrator per project, period.

## Wire protocol with the runner (NDJSON over Unix socket)

Frames orchestrator → runner:

- `turn` — a new turn trigger with the conversation context and the new user/agent message.
- `delegation_completion` — the result of a previously-emitted `delegate` from this runner.
- `cancel` — kill switch: drop the current turn, exit cleanly.
- `shutdown` — reap; persist nothing transient; exit.

Frames runner → orchestrator:

- `delegate` — a `delegate` tool was called. Carries the target agent slug, the prompt, threading metadata. Orchestrator publishes the kind:1, records a `delegations` row, blocks the runner until the completion frame.
- `intermediate` — an intermediate kind:1 the runner wants published (current `tenex-agent` v1 spec already supports this shape).
- `completion` — final completion event. Orchestrator publishes it (with the agent's signer) and tears down the runner's RAL row.
- `error` — runner hit a fatal error; orchestrator decides whether to retry or surface.

The runner is otherwise a pure async function: receives frames, runs LLM, emits frames, blocks when waiting on an external answer.

## Where state persists

`tenex-conversations` SQLite is the truth.

- `agent_prompt_history` — runner's frozen replay timeline. Rebuild a runner mid-conversation by reading these rows.
- `agent_context_state` — context-management bookkeeping. Same.
- `delegations` — pending and resolved delegation tree. **Specced and added to `tenex-conversations` now**, even though the orchestrator is a future build, because intervention will also consume this table for "skip notification when downstream delegations are still pending."
- `completions` — terminal events.

The orchestrator's in-memory dispatch table is a cache of these rows. On crash:

1. Reload pending delegations and active conversations from SQLite.
2. Decide for each whether to respawn a runner (it'll replay from `agent_prompt_history`) or wait passively for delegation completions to arrive on relay before reanimating.
3. Idempotent — the relay events that arrived during downtime will be redelivered (or were already persisted by the relay-mux).

## Phased build

The orchestrator is the most ambitious extraction in the system. Build it in three steps, each shippable:

### v1 — simple turns, no delegation

- Spawn one `tenex-agent` runner per turn (one-shot mode, current spec).
- Receive triggering event → pipe to runner → publish completion.
- The runner's `delegate` tool returns "delegation not supported in this runtime" — runners that need delegation route through bun.
- Opt-in per project. Bun runtime keeps doing everything for non-opted projects.
- Proves: subscribe + dispatch + execute end-to-end on Rust.

### v2 — long-lived sessions, prompt cache reuse

- Runner becomes long-lived per (conversation, agent). Stays warm across turns.
- Frozen prompt-history is the recovery substrate.
- Still no delegation.
- Proves: session lifecycle, runner reaping, cross-turn cache.

### v3 — delegation

- `delegate` tool now routes through the orchestrator. Frame protocol grows the `delegate` and `delegation_completion` frames.
- `delegations` table is now actively written and read.
- Tree-completion semantics: an agent's `completion` frame is held until its child delegations resolve.
- Proves: parity with bun. At this point bun runtime can retire per-project.

## What this means for *today's* decisions

Three commitments we make now to keep this future viable:

1. **`tenex-conversations` includes the `delegations` table from day one.** Already in the spec; the orchestrator will use it; intervention will use it sooner.
2. **`tenex-agent`'s wire protocol is NDJSON-over-stdin/stdout *and* generalizes to NDJSON-over-Unix-socket.** Same frame format either way. The current `tenex-agent` v1 spec already aligns; protect that property in any future spec edits.
3. **`tenex-project` exposes a `Signer` trait, not raw nsecs.** The orchestrator publishes events signed as the agent; if the abstraction is right, the orchestrator doesn't care whether the signer is a local nsec or a NIP-46 bunker.

## Pragmatic interim — the actionable next step (NOT this spec)

Until v1 of this orchestrator lands, the bun runtime keeps the orchestrator role. The next concrete step in the Rust direction is *runner integration*:

- Make `tenex-agent` long-lived per (conversation, agent), reachable over a Unix socket from the bun runtime.
- Bun's `AgentExecutor` shrinks to "send a `turn` frame, await frames, publish completions."
- Bun keeps RAL, dispatch, supervision, delegation routing.

That work has its own spec slot. This spec is the *target*, not the next step.

## Non-goals

- No multi-project orchestrator. One process per project. Hard rule.
- No actor system, no plugin architecture. Boring code.
- No "swap-in alternative orchestrators." There is exactly one implementation.
- No web UI, no REPL, no admin shell.
- No support for delegation in v1 or v2. v3 only.

## Success criteria (when it lands)

- A project opted into the Rust orchestrator runs simple turns without bun involvement (v1).
- The same project runs multi-turn conversations with cache hits and identical behavior to bun (v2).
- Delegation trees of arbitrary depth work, with crash recovery from SQLite (v3).
- The `tenex-agent` binary is unchanged from its current contract; the orchestrator integrates it via the same NDJSON protocol used in the bun-driven interim.
- Bun's `RALRegistry`, `AgentExecutor`, and per-project NDK subscription are deletable for any project running v3.
