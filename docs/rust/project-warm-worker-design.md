# Project-warm Bun worker — concurrent executions, inline agent config

Status: commits 1–5 landed; commits 6–8 pending. See "Migration sequence
(commit-by-commit)" below for current per-commit status markers.

This document supersedes the per-`(project, agent)` reuse model described in
`docs/rust/agent-execution-worker-migration.md` §"Worker Lifetime". The new
unit of warmth is the **project**, and the new execution model inside a worker
is **concurrent**, not serialized.

## Problem

The current worker model is one process per `(project, agent)` reuse key with
strict serialization inside the process:

- `src/agents/execution/worker/agent-worker.ts:108` — explicit guard:
  `throw new Error("Agent worker received execute while execution is active")`.
- `src/agents/execution/worker/bootstrap.ts:53` — every `executeAgentWorkerRequest`
  re-runs `config.loadConfig`, `mkdir` of conversations/logs, builds an
  `NDKProject`, instantiates `AgentRegistry`, calls `loadFromProject`, builds a
  fresh `ProjectContext`, instantiates `MCPManager`, and calls
  `mcpManager.initialize`. All of this is project-wide work, redone per execute.
- `bootstrap.ts:172–177` then `mcpManager.shutdown()` and
  `ConversationCatalogService.closeProject()` on every completion.

Concrete cost: when a project has N agents that all need to act on a single
incoming event (parallel delegations, broadcast, or simply 11 agents reacting
to the same conversation update), the daemon spawns N workers. Each pays the
full bootstrap cost. Measured locally at ~6 s per worker for the
modules+MCP+registry path, that is `N × 6 s` of wall time before any LLM call
starts.

Causes of the design:

1. The worker process treats agent identity as a process-level binding (single
   `AgentRegistry.getAgentByPubkey(message.agentPubkey)` lookup at
   `bootstrap.ts:69`). The serialization guard exists because the in-process
   `RALRegistry` (`src/services/ral/RALRegistry.ts:25`) and projectContext are
   reached through global singletons that are not currently scoped per execute.
2. The reuse-compatibility key in
   `crates/tenex-daemon/src/worker_reuse.rs:18–26` requires identity match, so
   different agents inside the same project never share a process.

The migration target docs already anticipate idle-TTL warm reuse but only
within the existing `(project, agent)` cell — that does not eliminate the
multiplicative bootstrap cost when concurrency is across agents.

## Proposal — one warm process per project

A warm Bun worker is now keyed by `project_id` (plus the immutable
project paths). Within that worker:

- All project-wide caches load **once** at first execute and live for the
  process lifetime: `MCPManager`, the multi-project `ConversationRegistry`
  state for this project, prompt-compiler state, modules, and tool registry.
- The agent identity used by an execution is supplied **per-execute** in the
  inbound `execute` payload (system prompt, capabilities, MCP allowances, model
  config). The worker does not need an `AgentRegistry` or `loadFromProject`
  call at all. This removes the disk read entirely from the per-execute path
  and aligns with the existing rule that the Rust daemon owns all agent config
  mutations — the worker becomes a pure consumer of a config snapshot.
- N executions run concurrently inside the same process. Each runs inside its
  own `projectContextStore.run(...)` scope (`src/services/projects/ProjectContextStore.ts`),
  which is already AsyncLocalStorage-based and per-call. The serialization
  guard at `agent-worker.ts:108` is removed.

Wall-time impact for the N-agent fan-out case:

```
Before: N × (Bun start + module load + MCP init + registry load + LLM call)
After : 1 × (Bun start + module load + MCP init) + N × (LLM call)
```

The `N × LLM call` portion remains because each agent still issues its own
provider request; that is the irreducible cost.

## Reuse key change

`crates/tenex-daemon/src/worker_reuse.rs` and the upstream
`worker_dispatch::admission` path key compatibility on:

- protocol config (unchanged)
- project base path (unchanged)
- working directory (unchanged)
- metadata path (unchanged)
- **agent identity** — removed
- **conversation identity** — removed (was already implied by identity)
- ral identity — removed
- worker state must be `Idle` or `Streaming` (new — see "Concurrent reuse"
  below). Currently the reuse path requires `Idle`.

Concrete rust-side changes:

- `worker_reuse.rs:18–26` — `WorkerReusePlanInput` no longer carries
  `required_identity`; remove the field and the `IdentityMismatch` arm of
  `WorkerReuseRecreateReason`. The worker is now project-scoped, and identity
  travels in the execute payload, not in the reuse key.
- `worker_reuse.rs:326` — `worker_state_mismatch` no longer rejects
  `Streaming`. A worker that already has executions in flight can accept an
  additional `execute` as long as it has spare concurrency capacity (configured
  cap, see below).
- `worker_concurrency.rs:80–128` — `check_worker_dispatch_dedup` retains its
  conversation-already-active guard (one execution per `conversation_id` at a
  time is still a correctness invariant — the conversation store is a single
  on-disk file with a writer). It no longer treats different agents in the
  same project as a concurrency conflict.
- `worker_runtime_state.rs` — `ActiveWorkerRuntimeSnapshot` becomes one-to-many
  with respect to dispatches: `dispatch_id` and `identity` move to a per-execute
  list instead of a single field. The snapshot becomes:

  ```rust
  pub struct ActiveWorkerRuntimeSnapshot {
      pub worker_id: String,
      pub pid: u64,
      pub project_id: String,
      pub project_base_path: String,
      pub working_directory: String,
      pub metadata_path: String,
      pub started_at: u64,
      pub last_heartbeat: Option<WorkerHeartbeatSnapshot>,
      pub graceful_signal: Option<WorkerRuntimeGracefulSignal>,
      pub active_executions: Vec<ActiveExecutionSlot>,
  }

  pub struct ActiveExecutionSlot {
      pub dispatch_id: String,
      pub identity: RalJournalIdentity,
      pub claim_token: String,
      pub started_at: u64,
  }
  ```

## Worker process anatomy

What lives in process-shared state (loaded once per worker):

- `MCPManager` instance (`src/services/mcp/MCPManager.ts`) — initialized once
  with the project's `metadataPath` + `projectBasePath`. MCP servers stay up
  for the worker lifetime.
- `ConfigService` load (`config.loadConfig(metadataPath)`).
- `ConversationRegistry` project entry — `ConversationStore.initialize(metadataPath, allProjectAgentPubkeys)`
  is called once on first execute. It is already multi-project capable
  (`src/conversations/ConversationRegistry.ts:11`). The `agentPubkeys` set
  passed to `initialize` is the union of agents the daemon expects to dispatch
  to this project; the daemon supplies that union in the `worker_boot` step
  (see "Worker boot payload" below).
- `ConversationCatalogService.getInstance(projectDTag, metadataPath, agentPubkeys)`
  — same lifetime.
- `ProjectContext` — built once from the project's NDKProject envelope and the
  agent inventory. The `agents` map inside it must contain every agent the
  worker may execute, so it is built from the daemon-provided agent list in the
  boot payload, not from a fresh `AgentRegistry.loadFromProject` call. The
  worker has no business writing agent config to disk anyway (memory:
  `Agent storage: Rust writes, TS reads`).

What is per-execute (lives only inside one
`projectContextStore.run(executionContext, ...)` scope):

- `ExecutionContext` (`src/agents/execution/ExecutionContextFactory.ts`).
- The `AgentInstance` snapshot from the execute payload.
- The `RALRegistry` entries for this `(agentPubkey, conversationId, ralNumber)`.
  The registry is process-global, but it already keys all state by RAL identity
  triple, so concurrent executions cannot collide as long as no two share a
  RAL — which the daemon-side admission already guarantees (one execution per
  `(project, agent, conversation)` is preserved as an invariant).
- The publisher-bridge `executionState` (currently
  `WorkerProtocolPublisherExecutionState` in
  `src/agents/execution/worker/publisher-bridge.ts`). Already per-execute.
- The `Nip46PublishCoordinator` waiters keyed by `requestId`
  (`src/agents/execution/worker/nip46-bridge.ts:33`). Already safe for
  concurrent waiters.

## Bun worker contract changes (`src/agents/execution/worker/agent-worker.ts`)

1. Drop `agent-worker.ts:107–109` — the `throw new Error("Agent worker received
   execute while execution is active")` guard. The serialization in
   `run()` becomes interleaving: `pendingNext` keeps reading messages while any
   number of `activeExecution` promises run concurrently. Replace the single
   `activeExecution: Promise<boolean>` field with
   `activeExecutions: Set<Promise<{ keepRunning: boolean }>>`. Loop logic:

   - Always race `messages.next()` against `Promise.race(activeExecutions)` if
     non-empty; otherwise just await `messages.next()`.
   - On a new `execute`, push the promise into the set, settle it asynchronously,
     and remove on completion.
   - Shutdown waits for all active executions to settle.
   - Worker exit happens when (a) stdin closes and the active set drains, or
     (b) an explicit `shutdown` arrives and the active set drains, or (c)
     idle-TTL expires while the active set is empty.

2. The boot path inside `agent-worker.ts:50` no longer assumes one execution.
   Move the project-wide bootstrap (loading config, mcpManager.initialize,
   ConversationStore.initialize, building ProjectContext) into a lazy
   `ensureProjectBootstrap(workerBoot)` that runs at most once per worker
   lifetime. The current `executeAgentWorkerRequest` in
   `src/agents/execution/worker/bootstrap.ts:53` is split into:

   - `bootstrapProjectIfNeeded(payload)` — runs once. Returns the shared
     `ProjectScope` (project context + mcp manager + project paths). Idempotent.
   - `runOneExecution(payload, scope)` — runs per-execute. Accepts the inline
     `agentConfig` from the payload, builds the `AgentInstance`, runs
     `projectContextStore.run(scope.projectContext, ...)`, executes, emits
     terminal frame.

3. `installProcessStdoutSuppressor` and `installConsoleSuppressor`
   (`agent-worker.ts:376–399`) stay — they are global. `Nip46WorkerBridge.install`
   is unchanged.

4. The `handleExecute` mock branch (`agent-worker.ts:308`) and the engine
   selection (`agent-worker.ts:236`) are unaffected.

## Rust dispatch contract changes

1. `worker_dispatch::admission` (`crates/tenex-daemon/src/worker_dispatch/admission.rs:80`)
   stops treating same-project, different-agent dispatches as blocked when there
   is a warm worker for that project. The reuse path becomes the primary route;
   the spawn path (`worker_dispatch/spawn.rs`) is taken only when no warm worker
   exists for the project or when the warm worker has hit its concurrency cap.

2. `worker_dispatch::admission` retains the per-conversation guard via
   `check_worker_dispatch_dedup` (`worker_concurrency.rs:80`). Two dispatches on
   the same `(project, agent, conversation)` still serialize at the daemon
   level, regardless of warmth.

3. Concurrency caps. Add a configured cap on simultaneous executions per warm
   worker. Land with a temporary cap of **16** and treat the value itself as
   provisional — measure on the 11-agent fan-out e2e scenario, then revise
   in a follow-up. `worker_concurrency.rs` learns about this limit. When the
   cap is hit, the admission planner falls back to spawning a second warm
   worker for the same project.

4. The reuse compatibility check
   (`worker_reuse::plan_worker_reuse`) drops the identity arm. The reuse
   decision becomes:

   ```text
   protocol matches
   AND project_base_path matches
   AND working_directory matches
   AND metadata_path matches
   AND graceful_signal is None
   AND active_executions.len() < concurrency_cap
   AND idle_ttl not expired (only checked when active_executions is empty)
   -> ReuseAllowed
   ```

5. Worker selection when multiple warm workers exist for the same project: pick
   the one with the lowest `active_executions.len()`; tie-break by oldest
   `started_at`. Plain enough; document it in `worker_reuse` so it stays
   testable.

## Protocol changes (`src/events/runtime/AgentWorkerProtocol.ts`)

The `execute` message gains an inline agent config block. The worker must not
need to read agent state from disk to satisfy an execute. Add to
`executeMessageSchema` (currently at `AgentWorkerProtocol.ts:210`):

```ts
agent: z.object({
    pubkey: hexPubkeySchema,
    slug: z.string().min(1),
    name: z.string().min(1),
    role: z.enum(["pm", "agent", "user"]),
    isPM: z.boolean().optional(),
    pmOverrides: z.record(z.string(), z.boolean()).optional(),
    signingPrivateKey: z.string().min(1),  // hex nsec, scoped per-execute
    systemPrompt: z.string(),
    instructions: z.array(z.string()).optional(),
    capabilities: z.array(z.string()),
    skills: z.array(z.object({
        slug: z.string().min(1),
        version: z.string().min(1),
    })),
    mcpServers: z.array(z.string().min(1)),  // server names this agent may use
    model: z.object({
        provider: z.string().min(1),
        modelId: z.string().min(1),
        temperature: z.number().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
    }),
}).passthrough(),
projectAgentInventory: z.array(z.object({
    pubkey: hexPubkeySchema,
    slug: z.string().min(1),
    name: z.string().min(1),
    isPM: z.boolean().optional(),
})),
```

The `projectAgentInventory` is the daemon's authoritative view of all agents
in the project at dispatch time. The worker reconciles `ProjectContext.agents`
against it on every execute (see "Inventory reconciliation"). The full config
is only passed in the `agent` field for the **executing** agent; other agents
in the inventory carry only discovery metadata.

The `agent.signingPrivateKey` is the current source of "Rust writes signed
events" — workers already need to sign per-agent today; today the worker pulls
it from disk via `AgentRegistry`. Moving it inline is a strict simplification:
no key reads from `~/.tenex/agents/*.json` happen inside the worker process.

The `worker_boot` payload (currently the implicit env-var passthrough at
`agent-worker.ts:51` for `TENEX_AGENT_WORKER_ID`) gains a one-shot project
boot block delivered as the first message after `ready` — call it `project_boot`
(daemon → worker, frameSchema):

```ts
project_boot: {
    projectId, projectBasePath, metadataPath,
    projectEvent: { /* enough to construct NDKProject */ ... },
}
```

`project_boot` does **not** carry the agent inventory. The current inventory
is delivered with every `execute` via `projectAgentInventory` and reconciled
into `ProjectContext.agents` per execute (see "Inventory reconciliation"
below).

The worker performs `bootstrapProjectIfNeeded` upon receiving `project_boot`,
emits a `project_ready` ack, and then is eligible for `execute` traffic. The
daemon must hold `execute` dispatches for that worker until `project_ready`
arrives. This keeps the boot timing observable to the daemon and allows the
daemon to record a `project_warm_at` timestamp per worker.

## Inventory reconciliation

Each `execute` carries `projectAgentInventory` as the daemon's authoritative
view of which agents belong to the project at dispatch time. The worker
reconciles `ProjectContext.agents` against this inventory before
`runOneExecution` runs:

- Add: any pubkey in the inventory but not in `ProjectContext.agents` is
  inserted as a discovery-only placeholder `AgentInstance` (slug, name,
  isPM). The full executing-agent record continues to come from
  `execute.agent` and is merged in for the duration of the execution scope.
- Remove: any pubkey in `ProjectContext.agents` but not in the inventory is
  evicted. (This handles agent deletion by Rust.)
- Update: changes to discovery metadata (name, isPM) overwrite the placeholder.

Reconciliation is idempotent and cheap (set-difference against the existing
`Map<pubkey, AgentInstance>`). It runs synchronously before the
`projectContextStore.run(...)` scope is entered, so concurrent executes do
not race on partial inventory state — each one observes the inventory it
was dispatched with.

If the daemon ever needs to dispatch to an agent that was added on disk but
not yet seen in any `execute`, that first `execute` carries the agent in its
`projectAgentInventory` and the reconciliation picks it up. There is no
separate inventory-push channel.

## Failure isolation

A crash inside one execution's async chain takes down the worker process (Bun
runs all executions on one event loop). This is acceptable because:

- The Rust daemon's worker_lifecycle path already treats unexpected exit as a
  failure and re-routes pending dispatches.
- The cost is N executions retried instead of 1, where N is the in-flight
  count. With a concurrency cap of 16, worst case is 16 retries — bounded.
- The alternative (sandboxing each execute in a child process or worker_thread)
  reintroduces the bootstrap cost we are trying to delete.

Hard rule: thrown errors inside `runOneExecution` are caught at the
`runOneExecution` boundary and converted to terminal `error` frames
(matching today's `agent-worker.ts:279–294` path). Only truly unrecoverable
errors (`OutOfMemory`, signal handlers) are allowed to bubble and crash the
process.

## Migration sequence (commit-by-commit)

Each commit must be independently revertable.

### Commit status (2026-04-25)

| # | Title | Status | Evidence |
| --- | --- | --- | --- |
| 1 | TS: split bootstrap into project-scope vs per-execute | landed | `bootstrap.ts` exports `bootstrapProjectScope` + `runOneExecution`; `executeAgentWorkerRequest` is the wrapper |
| 2 | TS: drop serialization guard, support concurrent executions | landed | `agent-worker.ts:run()` uses `Set<Promise>` for `activeExecutions`; serialization throw removed |
| 3 | Protocol: add `agent`, `projectAgentInventory`, `project_boot`, `project_ready` | landed | `AgentWorkerProtocol.ts:298,305` defines the new frames; `worker_protocol.rs` mirrors |
| 4 | TS: consume inline `agent` config; remove `AgentRegistry` from worker boot | mostly landed | Executing agent materialized via `materializeAgent` from inline payload; `AgentRegistry` still constructed as a placeholder receiver in `bootstrap.ts:88` (no `loadFromProject` call) |
| 5 | Rust: extend reuse and runtime state to many-per-worker | landed | `ActiveWorkerRuntimeSnapshot.executions: Vec<ActiveExecutionSlot>`; `select_warm_worker_for_dispatch` defined; `worker_concurrency` updated |
| 6 | Rust: dispatch routing prefers warm same-project workers | **pending** | `select_warm_worker_for_dispatch` exists in `worker_reuse.rs:224` but **no production code path calls it**; admission still spawns a fresh worker per dispatch |
| 7 | Rust: emit `project_boot` after `ready`; record `project_warm_at` | **pending** | `project_boot`/`project_ready` defined in protocol but never sent; depends on commit 6 |
| 8 | Delete dead code | **pending** | `AgentRegistry` import in `bootstrap.ts:3` still required by the placeholder construction; deletion gated on commit 6 actually wiring inventory-only `ProjectContext.agents` |

### Pending work — commit 6 (warm-reuse session multiplexing)

This is the architectural payoff. Foundation is laid but the wire-up is the
remaining work:

- `crates/tenex-daemon/src/warm_worker_runtime.rs` defines `WarmWorkerRegistry`,
  `OwnedWarmWorkerCommand`, `WarmWorkerHandle`. None are referenced from
  production code paths today.
- The session loop (`crates/tenex-daemon/src/worker_session/session_loop.rs`)
  exits after the first terminal frame. To support multiplexing it must:
  1. Replace `terminal: Option<WorkerMessageTerminalContext>` with a
     `HashMap<correlation_id, WorkerMessageTerminalContext>`.
  2. Select between worker-frame reads and `OwnedWarmWorkerCommand` channel
     receives. On `NewExecute`, send the execute frame and register the
     terminal context. On `Shutdown`, drain in-flight, exit.
  3. On a terminal frame, look up the correlation_id's terminal context,
     complete it, and *continue* reading instead of returning.
- The daemon admission tick
  (`crates/tenex-daemon/src/daemon_loop.rs:425` — `admit_one_worker_dispatch_from_filesystem`)
  must, before spawning, consult `WarmWorkerRegistry` via
  `select_warm_worker_for_dispatch`. If a warm worker is selected, push
  `NewExecute` on its channel; if not, spawn a fresh long-lived session task
  that registers itself in the registry.
- The TS worker already supports multi-execute (`agent-worker.ts:44`,
  `activeExecutions`). It currently emits `keepWorkerWarm: false`
  (`bootstrap.ts:227`); flip to `true` when the daemon signals warm intent.

### Pending work — commit 7 (project_boot handshake)

Depends on commit 6. The first message after a warm-worker spawn becomes
`project_boot`; admission is gated on `project_ready`. This makes the warm
state observable to the daemon for diagnostics and reuse decisions.

### Original commit list

1. **TS: split bootstrap into project-scope vs per-execute.**
   - `bootstrap.ts` gains `bootstrapProjectScope(payload): Promise<ProjectScope>`
     and `runOneExecution(payload, scope): Promise<AgentWorkerExecutionResult>`.
   - `executeAgentWorkerRequest` becomes a thin wrapper that calls both in
     sequence — behavior unchanged for the single-execute case.
   - Tests: existing bootstrap + executor integration tests must still pass.

2. **TS: drop the serialization guard, support concurrent executions.**
   - `agent-worker.ts:run()` rewritten around `Set<Promise<...>>` for
     `activeExecutions`. `pendingNext` reads continue while executions run.
   - The mock-engine test (`scripts/e2e/scenarios/04_parallel_sessions.sh`,
     currently being staged) becomes the gate: dispatch 3 concurrent
     executes to one worker, assert all three terminal frames arrive, assert
     execute-frame interleaving in the captured stdout.
   - `RALRegistry` cache keys are reviewed and asserted to be safe under
     concurrent writes from different RAL triples (read code at
     `src/services/ral/RALRegistry.ts:25` — confirm).

3. **Protocol: add `agent` and `projectAgentInventory` to `execute`, add
   `project_boot` and `project_ready` frames.**
   - Update `AgentWorkerProtocol.ts` schema, regenerate the
     `AgentWorkerProtocolFixture` matrix, add invalid-message cases for
     missing/extra fields.
   - Rust `worker_protocol.rs` mirror updates.
   - At this commit, the `agent` block is **passed but not consumed** by the
     TS worker — `bootstrap.ts` still calls `AgentRegistry.loadFromProject`.
     This is a wire-protocol-only change; behavior unchanged.

4. **TS: consume inline `agent` config; remove `AgentRegistry` from worker
   boot.**
   - `bootstrapProjectScope` no longer constructs `AgentRegistry` and no
     longer calls `loadFromProject`. It builds `ProjectContext.agents` from
     `projectAgentInventory`, with a single materialized `AgentInstance` for
     each entry that has only the discovery metadata.
   - `runOneExecution` materializes the executing `AgentInstance` from the
     `execute` payload's `agent` block, replacing the inventory placeholder.
   - Delete the worker-side dependency on `~/.tenex/agents/*.json` reads.
   - This commit lands the architectural promise: worker is stateless w.r.t.
     agent config.

5. **Rust: extend reuse and runtime state to many-per-worker.**
   - `ActiveWorkerRuntimeSnapshot` carries `Vec<ActiveExecutionSlot>`.
   - `worker_reuse::plan_worker_reuse` drops the identity arm; gains a
     concurrency-cap arm.
   - `worker_concurrency::check_worker_dispatch_dedup` lets different-agent
     same-project dispatches through.
   - All `worker_reuse` and `worker_concurrency` unit tests rewritten to
     express the new policy.

6. **Rust: dispatch routing prefers warm same-project workers.**
   - `worker_dispatch::admission` chooses an existing warm worker for the
     project before considering spawn. Spawn is taken only when none exists or
     all are at the concurrency cap.
   - Worker selection rule: lowest `active_executions.len()`, tie-break oldest.

7. **Rust: emit `project_boot` as the first daemon→worker message after
   `ready`; record `project_warm_at`.**
   - The boot payload is constructed from the same project metadata Rust
     already loads (project event, agent inventory by pubkey).
   - Diagnostics gain a `project_warm_workers` counter and per-worker
     `active_executions` gauge.

8. **Delete dead code.**
   - The `AgentRegistry` import in
     `src/agents/execution/worker/bootstrap.ts:3` and any code paths in
     `AgentRegistry` that exist only to support worker boot.
   - The `IdentityMismatch` recreate reason and any test scaffolding around it.
   - The single-execute-only assumptions in worker telemetry events
     (`execution_started`, etc. — these already carry the execution identity
     in the frame, so they are concurrency-safe; double-check for any place
     that assumes `process.execution.activeId` semantics).

## Test gates

- **e2e scenario 04 (parallel sessions)** — already staged
  (`scripts/e2e/scenarios/04_parallel_sessions.sh`,
  `scripts/e2e/fixtures/mock-llm/04_parallel_sessions.json`). Becomes the
  gate for commit 2 (concurrency in TS) and commit 6 (Rust routing).
- **New e2e scenario: 11-agent fan-out within one project.** Mirrors the
  motivating workload. Asserts: only one Bun process spawned for the project
  for the duration of the burst; all 11 terminal frames arrive; total wall
  time is `~MCP_init + max(LLM_call) + epsilon`, not `11 × MCP_init`.
- **Rust: `worker_reuse` tests** rewritten to express project-only key.
- **Rust: `worker_concurrency::check_worker_dispatch_dedup` tests** assert
  same-project-different-agent passes; same-conversation still blocks.
- **TS: `bootstrap` test for `bootstrapProjectScope` idempotency** — calling
  twice returns the same `ProjectScope`; second call performs zero filesystem
  reads.
- **TS: `runOneExecution` agent isolation test** — two parallel calls with
  different agent payloads each see their own `projectContextStore.getStore()`
  agent and do not observe each other's signing key.

## Resolved decisions

1. **Boot timing: eager `project_boot` / `project_ready` handshake.** The
   daemon sends `project_boot` immediately after `ready`; admission of
   `execute` for that worker is gated on `project_ready`. The daemon records
   warm-time on `project_ready` for diagnostics and reuse decisions.
2. **Inventory drift: carry full inventory in every execute payload.** No
   separate `inventory_update` frame. Each `execute` includes the current
   `projectAgentInventory`; the worker reconciles `ProjectContext.agents`
   on each execute (add/remove/update placeholders to match). The
   `project_boot` payload therefore does **not** carry the inventory — only
   the project event and paths. See "Inventory reconciliation" below.
3. **Concurrency cap: ship with 16, measure, then pick a real value.** Land
   the architecture with a temporary cap of 16. After the 11-agent fan-out
   scenario lands as an e2e gate, profile per-worker memory and crash
   blast-radius behavior, then revise. Tracked separately from this design.
4. **Crash isolation: accept process-level blast radius.** All thrown errors
   are caught at the `runOneExecution` boundary and converted to terminal
   `error` frames. Only truly unrecoverable errors (OOM, fatal signals) take
   down the process; the daemon retries the in-flight set per existing worker
   exit policy. No `worker_threads` isolation.

## Out of scope

- **Cross-project warm workers.** One project per process is the target. A
  second project for the same agent pubkey is a separate process.

## Non-goals

- Sharing a worker across projects.
- Sharing MCP servers across projects (existing isolation in
  `MCPManager-isolation.test.ts` continues to apply).
- Removing the conversation-level serialization invariant. The on-disk
  `ConversationStore` per-conversation file remains a single-writer resource.
