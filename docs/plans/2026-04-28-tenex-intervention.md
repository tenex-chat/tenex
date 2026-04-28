# `tenex-intervention` — Product Spec

## Purpose

A standalone Rust daemon that watches for agent work completions across all TENEX projects, waits for the user to respond, and publishes a human-replica review-request event if the user goes silent past a configurable timeout (default 5 minutes).

Replaces the in-process `InterventionService` that today runs inside the bun project runtime.

## Why extract

- **Event-driven, decoupled, lifecycle-independent.** The intervention loop has no need to share a process with agent execution. It needs to see relay events, run timers, and publish — nothing else.
- **Survives runtime downtime.** Today, if the bun runtime spins down between turns, pending interventions are paused. As a separate daemon, they keep ticking.
- **Failure isolation.** A stuck publish, a slow LLM-backed name resolution, a clock skew — none of it touches agent execution.
- **Single instance per host serves all projects** — N projects × per-project intervention loop becomes 1 daemon.

## What it owns

- Subscription to relays for the events it cares about (whitelisted authors only):
  - Kind:1 from agents that p-tag whitelisted users → completion candidates.
  - Kind:1 from whitelisted users → response candidates.
- Pending intervention timers (default 5min, configurable per `intervention.timeoutSeconds` in global config).
- 24h notified-conversation dedup cache.
- Project-scoped state files at `~/.tenex/intervention_state_<dTag>.json` — same path and schema as today.
- Atomic state writes (write-temp-then-rename, serialized queue) — same pattern as today.
- Slug → pubkey resolution for the configured intervention agent, per project, via the on-disk agent registry.
- Publishing review-request events to the resolved intervention agent.
- Retry with exponential backoff on publish failure, max 5 attempts.

## What it does *not* own

- Project boot orchestration. The intervention event itself triggers a project boot via the existing supervisor path, same as any other kind:1 with a known project `a` tag.
- Conversation storage. Reads delegation state from `tenex-conversations` SQLite when that lands; until then, see "Active delegation check" below.
- Any in-memory call into the bun runtime. No callbacks, no IPC into the project process.

## Trigger model

Event-driven, not polling.

- Subscribe to relays via `nostr-sdk` with two filters scoped to whitelisted authors.
- Apply the existing detection logic:
  - **Completion**: kind:1, author is an agent (= author is in any project's agent registry, not in the user whitelist), event p-tags a whitelisted user, and that user authored the conversation root.
  - **Response**: kind:1, author is a whitelisted user, in a conversation with a pending intervention, with `created_at` strictly after `pending.completedAt` and strictly before `pending.completedAt + timeoutMs`.
- Detection logic is ported from `InterventionService.onAgentCompletion` and `onUserResponse`. Don't redesign it; it's load-bearing and well-tested.

## Active delegation check

Today, the service skips firing if the agent has active outgoing delegations (work isn't really done). That check today is an in-memory query into `RALRegistry`.

The clean path: once `tenex-conversations` lands, delegation state is a SQL row. The daemon queries `delegations WHERE conversation_id = ? AND status = 'pending'`. Single SQLite read per timer expiry.

Until `tenex-conversations` lands, the interim adapter punts on this check and treats "no info" as "no active delegations." This produces a small number of false-positive interventions when agents complete-while-delegating, which is no worse than the bun runtime being offline at completion time.

The check goes behind a `DelegationChecker` trait with a stub implementation today and a real one when `tenex-conversations` is ready. One-method trait, one swap when the DB is available — not over-engineered.

## Single-instance enforcement

`flock` on `~/.tenex/intervention.pid`. Same pattern as `whitelist/`, `tenex-summarizer`, `tenex-scheduler`. A second instance starting on the same host fails the lock and exits cleanly.

## Storage

- Per-project state: `~/.tenex/intervention_state_<dTag>.json`. Schema unchanged (`pending: PendingIntervention[]`, `notified: NotifiedEntry[]`).
- Atomic writes via temp-then-rename.
- Serialized writes per project via an in-memory queue — same pattern as today.
- On startup: load all project state files, rebuild timers via `setupCatchUpTimers`. Timers whose deadlines have already passed fire immediately; that's the correct catch-up behavior.

The legacy fallback path (loading from `intervention_state_<projectId>.json` when `intervention_state_<dTag>.json` is absent) ports as-is. It's the only piece of "backwards compatibility" the daemon carries — and only because real on-disk state from the TS version may exist on user machines at cutover. The daemon writes back to the canonical dTag-scoped path on first save.

## Signing and publishing

- Backend signer: read backend nsec from `~/.tenex/config.json`. The intervention agent's pubkey is resolved per-project from the on-disk agent registry.
- Publishes via `nostr-sdk` directly. Same swap points as the other daemons (relay-mux, NIP-46) when those land.

## Layering

```
tenex-intervention  (Rust daemon)
     ↓
nostr-sdk (subscribe + sign + publish)
tenex-conversations (delegation state; interim: stub DelegationChecker)
filesystem (~/.tenex/intervention_state_*.json, ~/.tenex/agents/*/, ~/.tenex/config.json)
```

No imports from the bun codebase.

## Configuration

`~/.tenex/config.json` (existing fields, no new schema):

- `intervention.enabled` — daemon refuses to start if false.
- `intervention.agent` — agent slug to publish review requests to.
- `intervention.timeoutSeconds` — default 300.
- `whitelistedPubkeys` — used to identify "users" for completion/response detection.
- Relay list and backend nsec — same as the other daemons.

The daemon does NOT consult the whitelist socket; it reads `whitelistedPubkeys` from config directly. Reason: it needs the *reason* (human vs. agent) to gate completion detection. The whitelist socket collapses all trust sources into one YES/NO and discards that distinction. Same justification as the existing TS code.

## CLI surface

```
tenex-intervention run         # daemon mode; logs to stderr
tenex-intervention status      # print pending/notified counts if running
```

No `add`/`rm` — interventions are entirely event-driven; nothing to manage by hand.

## Observability

- Structured logs via `tracing`.
- Per completion detected: `conversation_id`, `agent_pubkey`, `user_pubkey`, `project_id`, scheduled-trigger time.
- Per response cancellation: `conversation_id`, `user_pubkey`, response delay.
- Per trigger: `conversation_id`, `intervention_agent_pubkey`, retry count, success/failure.
- One periodic line: pending count, notified count.

## What this deletes from the bun runtime

When this ships and is wired in:

- `src/services/intervention/` (entire directory: `InterventionService.ts`, tests, `index.ts`).
- `src/nostr/InterventionPublisher.ts` (its sole consumer is the service; the daemon publishes directly via `nostr-sdk`).
- The intervention init/shutdown wiring in the daemon layer.
- The `setAgentResolver` and `setActiveDelegationChecker` callback injection sites.
- The completion/response detection callsites in the event-handler that today feed the in-process service.

Net code reduction in the bun runtime; no replacement responsibility added.

## Non-goals

- No multi-host. One daemon per host.
- No retry-on-publish beyond the existing 5-attempt exponential-backoff. Past that, the intervention is dropped.
- No web UI, no metrics endpoint. Logs are the interface.
- No new event kinds. The review-request event format is unchanged.
- No coalescing across projects. Each project's interventions are independent.
- No detection logic redesign. The existing rules (whitelisted user, root authorship, post-completion timestamp, no active delegations, no feedback loop with the intervention agent itself) are ported verbatim.

## Success criteria

- Identical review-request events fire under identical conditions to today's TS path.
- Killing the bun project runtime mid-pending-intervention does not lose the timer; it fires when the daemon's timer expires.
- A daemon restart loads all project state files and resumes timers correctly, including immediate-fire of timers whose deadlines have passed.
- The five pieces of code listed under "What this deletes" are removed in the cutover PR; no parallel paths.
- The interim `DelegationChecker` stub is replaced with a `tenex-conversations`-backed implementation in the same PR that lands `tenex-conversations`.
