# Concurrent-RAL Lock-Handoff Prototype

Self-contained validation harness for the concurrent-RAL design proposed for TENEX. Does not depend on TENEX runtime — it imports `ai` + `@ai-sdk/openai` directly and routes through OpenRouter to Claude Haiku.

## Problem

In TENEX today, when an agent is mid-tool-execution (e.g., `shell("sleep 300")`), incoming user messages are queued but only drained on the next `prepareStep`. Since `prepareStep` only fires between LLM steps, a user waiting on a 5-minute shell command sees the agent as unresponsive until the shell finishes.

## The design

A per-(agent, conversation) lock with three logical states (`IDLE` / `STREAMING` / `TOOL_PENDING`). When a tool starts executing, the driver slot is **released** so a new user message can spawn a second concurrent RAL. When the original tool eventually returns:
- if the lock has been taken by another RAL: write a "late tool result" entry into the conversation store; if no RAL is currently driving, fire a **wakeup** RAL that surfaces the result.
- if the lock is still free / re-acquireable: continue normally as if nothing interrupted.

Source of truth is the `ConversationStore`. AI-SDK messages are rebuilt every `prepareStep`, with **synthetic tool-results** auto-injected for any pending tool-call lacking a real result, so the SDK's tool-call/result pairing invariant always holds.

## What runs

```bash
bun run scripts/e2e/aisdk-lock-handoff/run-all.ts
# or one at a time:
bun run scripts/e2e/aisdk-lock-handoff/scenarios/s1-basic-handoff.ts
```

Requires `~/.tenex/providers.json` with an `openrouter.apiKey`.

## Files

- `_shared.ts` — model setup + log helpers (Haiku via OpenRouter).
- `_runtime.ts` — the harness: `ConversationStore`, `Lock`, `buildMessages`, `runRAL`, `dispatchUserMessage`, `dispatchWakeupOrDefer`, `makeManualTool`, `makeSleepTool`.
- `scenarios/s1-basic-handoff.ts` — smoke test of the whole pipeline.
- `scenarios/s2-reverse-ordering-preempt.ts` — deterministic preempt path with deferred wakeup.
- `scenarios/s5-ral2-emits-tool.ts` — two RALs holding pending tools simultaneously.
- `scenarios/s6-parallel-tools.ts` — single step with two parallel tool calls + injection during the window.
- `scenarios/s15-lock-race.ts` — pure unit test of the `Lock` state machine.
- `scenarios/s20-complete-while-pending.ts` — late tool resolution after the user cancelled.

## Validated empirically

1. **`experimental_onToolCallStart` / `experimental_onToolCallFinish`** in `ai@6.0.x` are the right boundary for lock release / re-acquire. They fire per-tool-call, **outside** of `tool.execute`, so we don't need to wrap each tool. (Cost: experimental APIs — pin AI-SDK version + smoke test.)
2. **Synthetic tool-results work.** `{ role: "tool", toolCallId: X, output: { type: "text", value: "..." } }` is accepted as a placeholder for any unresolved prior tool-call. Without one, `streamText` throws `AI_MissingToolResultsError` client-side.
3. **`stopWhen` is the only clean way to silently exit a preempted RAL.** Throwing or aborting mid-execute corrupts `result.*` accessors. Returning the real result + flipping a `preempted` flag inside `onStepFinish` lets `stopWhen` end the run cleanly with `result.response.messages` intact.
4. **Late tool result is rendered as a `user`-role message** with a `[late-tool-result toolCallId=… tool=… status=…]` prefix — not `system`. Reason: when a wakeup RAL spawns to surface a late result, the trailing message must be a user-style turn or the model produces empty output. This was discovered empirically in S2.
5. **Parallel tools** (`peakPending = 2` observed): one lock window per step, not per tool. First `onToolCallStart` releases; `onStepFinish` re-evaluates lock state via `lock.finishTool` per stashed result.
6. **Two RALs with concurrent pending tools** is correctly tracked: per-RAL pending counts plus a single global driver slot.
7. **Deferred wakeup** via `lock.onceDriverReleased` correctly delivers the late-result surfacing even when the wakeup attempt collides with an active driver.

## Decisions captured here that weren't in the original sketch

- **Late-result rendering format**: `user`-role with structured prefix, NOT `system` (forced by Anthropic's last-must-be-user requirement for the wakeup case).
- **Synthetic tool-result text**: a single boilerplate string indicating the call is in flight and the real result will arrive later as a system message. Permissive output schema.
- **Lock window for parallel tools**: per-step, not per-call. `onStepFinish` is the single re-acquire decision point.
- **RAL#1 reacquires when possible**: if RAL#2 finished and released the driver before RAL#1's tool returned, RAL#1 simply continues — no late-result write, no wakeup. Saves a round trip when timing favors it.
- **Wakeup deferral**: when a late-result lands while another RAL is driver, the wakeup retries on the next `releaseDriver` via a one-shot listener.

## Not validated here (out of scope for this prototype)

- **Daemon restart durability** — the in-memory store is lost on crash. Pre-existing TENEX concern.
- **User-message coalescing** — existing TENEX queue already handles bursts during a single `prepareStep`.
- **Codex `MessageInjector` interaction** — the live-injection path stays as-is for the `STREAMING` state; lock-handoff only kicks in when `TOOL_PENDING`.
- **Multi-agent same-conversation** (S16 from the brainstormer) — locks are already per-(agent, conv) in TENEX, so the design composes correctly without test coverage here.
- **Real delegation tools** (S8) — they're tools that take time, so equivalent to the manual-tool tests in S2/S5.

## Known caveats

- The wakeup defers ONE listener per late-result. When parallel tools both preempt (e.g., S6), both register listeners, both fire on the next driver release, and the second wakeup spawns an empty RAL because the first one already covered it. This is harmless but slightly wasteful — could be debounced in the future.
- The model occasionally produces empty text after a wakeup — not a design bug; it's the model deciding "I have nothing to say." S20 is the canonical case.
