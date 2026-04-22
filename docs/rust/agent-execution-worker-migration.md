# Rust Daemon With Ephemeral Bun Agent Workers

## Purpose

This document describes a migration path from the current Bun/TypeScript daemon to
a Rust control plane that starts Bun only when an agent execution actually needs
to run. The target is not a full Rust rewrite of the AI execution stack. The
target is:

```text
Rust daemon
  - always-on control plane
  - Nostr subscriptions and routing
  - project and agent indexes
  - RAL scheduling and worker supervision
  - status, lock, restart, shutdown, and telemetry

Bun agent worker
  - spawned on demand by Rust
  - runs one bounded agent execution session
  - uses existing TypeScript AgentExecutor, tools, providers, skills, and MCP
  - exits after terminal completion or an idle timeout
```

The main operational goal is to remove the full TypeScript agent runtime from
the always-on daemon process while preserving the working execution path.

For the milestone sequence, quality gates, and client interoperability strategy,
see `docs/rust/implementation-milestones-and-quality-gates.md`.

## Current System Boundaries

The current daemon is a single long-lived Bun process. Important current files:

- `src/commands/daemon.ts`: CLI entrypoint, background fork, daemon startup,
  scheduler wiring, and shutdown handler registration.
- `src/daemon/Daemon.ts`: top-level daemon orchestration, config loading,
  lockfile, subscriptions, routing, project discovery, restart state, status,
  agent definition monitoring, and service startup.
- `src/daemon/SubscriptionManager.ts`: Nostr subscription groups and event
  deduplication.
- `src/daemon/routing/DaemonRouter.ts`: pure routing decisions based on event
  kind, project `a` tags, agent `p` tags, known projects, and active runtimes.
- `src/daemon/RuntimeLifecycle.ts`: lazy project runtime startup, shutdown, and
  serialized boot queue.
- `src/daemon/ProjectRuntime.ts`: per-project runtime bootstrap. This currently
  loads agents, initializes project context, starts MCP, initializes
  conversation stores, registers Telegram runtime bindings, starts status
  publishers, and creates `AgentExecutor`.
- `src/agents/execution/AgentExecutor.ts`: main agent execution entrypoint.
- `src/agents/execution/StreamSetup.ts`: pre-stream setup for skills, tools,
  prompt compilation, MCP access, injections, RAL registration, and LLM config.
- `src/agents/execution/StreamExecutionHandler.ts`: LLM stream execution,
  streaming deltas, tool events, stop checks, and cleanup.
- `src/tools/registry.ts`: AI SDK tool assembly and permission filtering.

The migration should preserve behavior by moving orchestration and process
ownership first, then shrinking the TypeScript runtime surface over time.

Branch status: the `rust-agent-worker-publishing` branch currently carries the
worker recovery, diagnostics, admission-start, and message-flow slices in the
Rust daemon crate, extending the worker supervision stack that feeds publish
outbox and launch planning.

## Target Ownership

| Concern | Target owner | Notes |
| --- | --- | --- |
| CLI flags and service process | Rust | Keep existing Bun CLI as a launcher during migration if useful. |
| Lockfile and status file | Rust | Preserve current file paths and JSON shape where possible. |
| Restart state | Rust | Preserve `restart-state.json` semantics. |
| Nostr relay subscriptions | Rust | Replace `SubscriptionManager` with Rust subscription tasks. |
| Event classification and routing | Rust | Port `DaemonRouter` as pure Rust logic with golden tests. |
| Known project index | Rust cache, filesystem snapshot | Built from kind:31933 project events. Durable snapshots are rebuildable caches. |
| Agent pubkey to project index | Rust cache, filesystem snapshot | Updated from project metadata and worker reports. Durable snapshots are rebuildable caches. |
| RAL claim/resume/abort state | Rust scheduler, filesystem state | Transitional adapters may still invoke TS `RALRegistry`, but only one authority may decide scheduling. Durable state lives in shared files. |
| Agent execution | Bun worker | Existing `AgentExecutor` remains the execution implementation. |
| LLM providers | Bun worker | Keep AI SDK provider integrations in TypeScript. |
| Tools and skill tools | Bun worker | Keep existing tool factories and skill loading in TypeScript. |
| MCP used by an agent execution | Bun worker | Start only MCP servers needed by the executing agent. Shut down on worker exit. |
| Long-lived transport gateways | Rust | Telegram cannot live only in ephemeral workers if it must receive updates continuously. The target is a Rust-native Telegram gateway/adapter, with TypeScript retained only as the behavior oracle during migration. |
| Transport-native outbound delivery | Rust transport outbox and Rust adapters | Telegram replies are projections of accepted runtime events. Workers must not own Bot API delivery, retries, dedupe, or native message diagnostics in the target architecture. |
| Runtime event publishing | Rust target, TS compatibility first | Initially TS may publish directly. Target is worker emits signed Nostr runtime publish requests to Rust; Rust derives transport-native delivery from retained ingress context and configuration. |
| Telemetry | Both | Rust owns daemon spans. Worker emits execution spans/events with correlation IDs. |

## Filesystem-First State Model

The Rust daemon should be operationally stateless. It may keep in-memory maps for
speed, but those maps are caches. Durable coordination state belongs in the
shared TENEX filesystem tree so Rust and TypeScript can restart independently
and reconstruct their working view.

Design rules:

- Do not introduce a Rust-owned daemon database for new coordination state.
- Treat Rust memory as disposable. On restart, rebuild from relay events,
  existing TENEX project metadata, and shared daemon files.
- Store new daemon/RAL/worker coordination state as JSON or JSONL files under
  `$TENEX_BASE_DIR/daemon/`.
- Use atomic write patterns for JSON snapshots:
  - write `*.tmp.<pid>`
  - fsync the file when the platform API makes that practical
  - rename into place
  - fsync the parent directory when practical
- Use append-only JSONL journals for high-churn state transitions, then compact
  to JSON snapshots when needed.
- Use per-file or per-directory lockfiles for cross-process writers.
- Keep status and diagnostics reads non-mutating. Repair or maintenance actions
  should be explicit Rust library calls, then exposed through daemon lifecycle
  hooks or operator commands such as `doctor`, not hidden inside status reads.
- Prefer one logical writer per state namespace. If Rust owns RAL scheduling,
  workers should report transitions to Rust or use a Rust-defined file bridge,
  not independently invent scheduling decisions.
- Existing TypeScript stores remain valid. This migration should share and reuse
  their files instead of copying them into Rust-owned storage.

Recommended new daemon state layout:

```text
$TENEX_BASE_DIR/daemon/
  tenex.lock
  status.json
  restart-state.json
  routing/
    known-projects.json
    agent-index.json
    active-projects.json
  ral/
    snapshot.json
    journal.jsonl
    locks/
      alloc.<project-id>.<agent-pubkey>.<conversation-id>.lock
      state.<project-id>.<agent-pubkey>.<conversation-id>.<ral-number>.lock
  workers/
    dispatch-queue.jsonl
    <worker-id>.json
    journal.jsonl
```

All files in `routing/` are rebuildable. They are startup accelerators and
debugging aids, not irreplaceable source of truth. `active-projects.json` is a
rebuildable activation snapshot used to preserve current p-tag routing semantics
across restarts. The RAL journal is the durable coordination source of truth.
The RAL snapshot is only a compaction accelerator and may be discarded if it is
older than the journal.

### Filesystem Durability Policy

For scheduler-critical state, the append-only journal is authoritative:

- RAL transition acknowledgements must not be sent to a worker until the journal
  entry has been written and flushed successfully.
- `snapshot.json` files are best-effort compactions. Losing the last snapshot
  after a crash is acceptable because the journal can replay it.
- If a journal append or flush fails, Rust must fail closed: stop accepting new
  dispatch for that affected namespace and surface operator-visible status.
- On macOS, normal `fsync` may not guarantee the same persistence properties as
  `F_FULLFSYNC`. The daemon should expose a durability mode:
  - `normal`: use portable fsync/fdatasync where available.
  - `full`: use platform-specific stronger flushes such as `F_FULLFSYNC` on
    Darwin for RAL journals.
- The default can be `normal`, but tests must cover crash recovery from a
  truncated final journal entry.

Workers must not be filesystem writers for daemon-owned state. Rust is the sole
writer for:

- `ral/snapshot.json`
- `ral/journal.jsonl`
- `workers/<worker-id>.json`
- `workers/journal.jsonl`
- `workers/dispatch-queue.jsonl`
- `routing/active-projects.json`

Workers report facts through the protocol. Rust validates them, writes the
filesystem state, then acknowledges when the transition matters for correctness.

`workers/dispatch-queue.jsonl` is a typed append-only Rust contract. Each record
contains `schemaVersion`, `sequence`, `timestamp`, `correlationId`,
`dispatchId`, RAL identity, `triggeringEventId`, `claimToken`, and a
queued/leased/terminal status. Appends flush the file and parent directory.
Replay checks monotonic sequence order, uses the latest record per `dispatchId`,
ignores only EOF-truncated final JSONL records, and fails closed on corrupt or
malformed complete records. The Rust library can plan queue lifecycle records
without writing them: queued dispatches can be leased, leased dispatches can be
completed, and queued or leased dispatches can be cancelled.

`ral/journal.jsonl` is likewise append-only and synced before Rust can
acknowledge scheduler-critical RAL transitions. It records the TS-compatible RAL
identity, pending delegation shape, claim tokens, terminal worker outcomes
including `error`, and replay state consumed by the library scheduler.

## Non-Goals

- Do not rewrite `AgentExecutor` in Rust in the first migration.
- Do not rewrite AI SDK provider adapters in Rust in the first migration.
- Do not rewrite all tools in Rust in the first migration.
- Do not preserve the full `ProjectRuntime` as the worker entrypoint. It has
  long-lived daemon responsibilities that are not appropriate for an ephemeral
  process.
- Do not allow both Rust and TypeScript to independently schedule the same RAL.
  During transition, one side must be authoritative for each scheduling decision.
- Do not add a new SQLite or service database for daemon/RAL coordination as
  part of this migration.

## Target Process Model

### Rust Daemon

The Rust daemon should be a single long-lived async process using Tokio. It
should manage:

- config loading and path resolution
- lock acquisition
- relay connections and subscriptions
- event deduplication
- project discovery and updates
- known agent index
- routing decisions
- RAL scheduling and active worker table
- worker lifecycle, timeouts, and cancellation
- status file updates
- graceful shutdown and supervised restart
- filesystem snapshots and journals for any durable control-plane state

### Bun Agent Worker

The Bun worker should be a small execution entrypoint, not the current daemon.
It should:

- receive one execution request from Rust
- initialize the minimum project context needed for that execution
- load the target agent
- initialize the conversation store for that project
- initialize only the MCP servers needed by the executing agent
- call `AgentExecutor.execute(...)`
- emit normalized execution events to Rust
- clean up MCP, conversation state, and temporary resources
- exit after a terminal state, or after an idle TTL if warm reuse is enabled

Recommended first worker entrypoint:

```text
src/agents/execution/worker/agent-worker.ts
```

Recommended supporting modules:

```text
src/agents/execution/worker/protocol.ts
src/agents/execution/worker/bootstrap.ts
src/agents/execution/worker/publisher-bridge.ts
src/agents/execution/worker/ral-bridge.ts
```

## Worker Lifetime

Start with one worker per execution session:

```text
event routed to agent
  -> Rust claims or creates RAL
  -> Rust spawns Bun worker
  -> worker runs agent execution
  -> worker emits terminal event
  -> Rust marks RAL state
  -> worker exits
```

Then add an idle TTL:

```text
worker completes execution
  -> worker stays alive for 30-120 seconds
  -> if another compatible execution arrives, Rust reuses it
  -> otherwise Rust sends shutdown or worker exits itself
```

Compatibility for reuse should be strict at first:

- same project
- same agent
- same working directory
- no pending shutdown
- no leaked MCP process
- worker protocol version matches daemon

If reuse is uncertain, spawn a fresh worker. Correctness matters more than
avoiding cold starts.

## Project Activation and Routing Semantics

The current TypeScript router uses active runtime state when deciding whether an
event can be traced or routed:

- `shouldTraceEvent` accepts some project-tagged events only when the project is
  known and active, unless the event kind can boot the project.
- p-tag routing is intentionally conservative: when the same agent belongs to
  multiple active projects, the event is dropped unless an explicit project
  `a` tag disambiguates it.

The Rust daemon must preserve this behavior even though `ProjectRuntime` is no
longer a long-lived TypeScript object. Rust therefore owns a project activation
table. A project is active when at least one of these is true:

- the operator explicitly booted it with `--boot`
- the project was restored from restart state
- a boot-capable event started it
- it has an active, waiting, or queued RAL
- it has a warm reusable worker
- a long-lived transport binding has explicitly activated it

Project activation is not the same thing as "a Bun worker process is currently
running." A parent agent may be waiting for delegated work with no worker alive,
but the project remains active for routing purposes.

Rust should persist a rebuildable activation snapshot:

```text
$TENEX_BASE_DIR/daemon/routing/active-projects.json
```

On startup, Rust rebuilds the activation table from:

- restart state
- RAL snapshot and journal
- worker journal
- explicit boot options
- project events discovered from relays

Routing by `p` tag must consult this activation table. If an agent belongs to
two activated projects and the incoming event has no project `a` tag, Rust must
drop the event for ambiguity, matching the current TypeScript guardrail.

## Worker Protocol

Use a versioned frame protocol over stdin/stdout. The Phase 1 TypeScript-only
harness may use newline-delimited JSON for speed of implementation, but the
Rust production worker protocol should use length-prefixed JSON frames before
Phase 5 handles real streaming traffic. Stderr remains reserved for
human-readable logs. Each message must include:

- `version`
- `type`
- `correlationId`
- `sequence`
- `timestamp`

The protocol should not become the durable state transport. Prefer passing IDs,
paths, claim tokens, and the triggering envelope. The worker should load agent,
project, conversation, skill, and prompt state from the shared filesystem using
the same storage layout as the existing TypeScript runtime. Protocol messages
are for coordination, control, and reporting.

Streaming deltas must be batched by the worker. Do not emit one protocol frame
per model token. Initial batching policy:

- flush text deltas every 250 ms
- flush sooner when a batch exceeds 8 KiB
- flush immediately before terminal events
- cap any single protocol frame at 1 MiB
- spill larger payloads to a worker-owned temp file and send a file reference

Backpressure is explicit. The worker writes protocol messages through a bounded
internal queue. If the queue fills:

- progress/status events may be coalesced
- stream deltas may be coalesced
- terminal events, tool events, RAL transitions, and publish requests must not
  be dropped
- if critical events cannot be delivered, the worker must abort the execution
  and report an error if possible

### Daemon to Worker Messages

```json
{
  "version": 1,
  "type": "execute",
  "correlationId": "exec_...",
  "sequence": 1,
  "projectId": "project-d-tag",
  "projectBasePath": "/path/to/project",
  "metadataPath": "/path/to/tenex/project/metadata",
  "agentPubkey": "hex-pubkey",
  "conversationId": "conversation-id",
  "ralNumber": 3,
  "ralClaimToken": "opaque-token",
  "triggeringEnvelope": {},
  "executionFlags": {
    "isDelegationCompletion": false,
    "hasPendingDelegations": false,
    "debug": false
  }
}
```

Other daemon-to-worker messages:

- `abort`: request cancellation for an active execution.
- `inject`: deliver an injection to the active RAL.
- `shutdown`: request graceful worker exit.
- `ping`: paired health check; worker must answer with `pong`.
- `publish_result`: result for a previous `publish_request`.
- `ack`: acknowledgement for a worker message that requires daemon durability.

### Worker to Daemon Messages

```json
{
  "version": 1,
  "type": "execution_started",
  "correlationId": "exec_...",
  "sequence": 1,
  "projectId": "project-d-tag",
  "agentPubkey": "hex-pubkey",
  "conversationId": "conversation-id",
  "ralNumber": 3
}
```

Worker event types:

- `ready`: worker booted and protocol is available.
- `boot_error`: worker could not initialize enough runtime to accept work.
- `pong`: response to daemon `ping`.
- `execution_started`: worker accepted an execution.
- `stream_delta`: user-visible assistant text delta.
- `reasoning_delta`: reasoning or diagnostic delta when available and allowed.
- `tool_call_started`: tool execution began.
- `tool_call_completed`: tool execution completed.
- `tool_call_failed`: tool execution failed.
- `delegation_registered`: execution registered delegated work.
- `waiting_for_delegation`: execution is intentionally idle pending children.
- `publish_request`: worker asks Rust to publish a runtime event.
- `published`: worker published directly during compatibility mode.
- `complete`: terminal successful completion.
- `silent_completion_requested`: worker requested explicit silent completion.
- `no_response`: terminal silent completion after that request is accepted.
- `aborted`: terminal abort or kill.
- `error`: terminal or non-terminal error.
- `heartbeat`: liveness signal with current execution state.

Terminal messages must include:

- final RAL state
- whether the worker published a user-visible event
- whether pending delegations remain
- accumulated runtime
- final event IDs when available
- whether Rust should keep the worker warm

Health defaults for the first Rust dispatch implementation:

- worker boot timeout: 30 seconds
- heartbeat interval: 5 seconds during active execution
- missed heartbeat kill threshold: 3 intervals
- graceful abort timeout: 10 seconds
- force-kill timeout after graceful abort: 5 seconds
- default worker idle TTL: 120 seconds

These are initial defaults, not permanent product decisions. They should become
operator-configurable once Phase 5 is stable.

## Publishing Strategy

Use one authority split for publishing:

- agent-authored runtime messages are signed by the executing agent inside the
  Bun worker
- Rust owns durable publish acceptance, relay publishing, retry, and diagnostics
- backend-authored status, config, and control-plane events are signed by Rust
  or a Rust-owned long-lived adapter
- transport-native delivery, such as Telegram replies, is a Rust-owned
  projection of accepted runtime events, not a worker-owned side effect

### Agent-Signed Runtime Events

The worker builds the final NIP-01 event, signs it with the target agent signer,
and sends that complete event in a `publish_request` frame. The frame includes:

- `id`
- `pubkey`
- `created_at`
- `sig`
- `kind`
- `content`
- `tags`

The host side must verify the NIP-01 hash, signature, and expected agent pubkey
before accepting the request. It must publish the exact signed event, not
reconstruct or re-sign it.

The worker should wait for `publish_result` when it needs the event ID for
threading, delegation, or reply references. The result may mean durable
acceptance into a Rust outbox rather than relay completion; relay side effects
can happen shortly after the worker proceeds because external clients cannot see
the event until Rust publishes it.

### Rust-Owned Relay Publishing

The worker does not publish directly to Nostr. It emits signed `publish_request`
messages. Rust persists the request, publishes it to the correct relay set, and
returns correlated `publish_result` frames.

This centralizes routing, relay selection, retry, and operator diagnostics in
the control plane without moving the agent's signing authority out of the agent
execution path.

### Transport-Native Delivery

Nostr is the canonical runtime publication surface, but it is not the only
delivery surface. For Telegram-triggered or Telegram-bound executions, the
worker signs the canonical Nostr runtime event and emits that event to Rust. The
worker must not know whether that accepted event is later projected to Telegram,
Slack, or any other native transport.

The target ownership is:

```text
Bun worker
  -> signs canonical Nostr event
  -> emits publish_request with the signed event

Rust daemon
  -> validates and persists the signed event in the Nostr publish outbox
  -> derives transport delivery records from retained ingress context,
     agent configuration, runtime state, and the accepted Nostr event
  -> persists derived delivery records in a Rust-owned transport outbox
  -> acknowledges durable acceptance to the worker

Rust relay publisher
  -> drains signed Nostr events to relays

Rust Telegram adapter
  -> drains Telegram delivery records to the Bot API
  -> records native message IDs, delivery failures, retries, and dedupe state
```

The Telegram adapter must derive destination chat, thread, reply target, and
delivery policy from the original transport envelope and agent configuration.
The Rust side already receives the triggering envelope in the `execute` request
and owns the execution/RAL context. Any extra metadata attached to
`publish_request` must remain transport-agnostic, such as correlation IDs or a
runtime event classification that cannot be recovered from Nostr kind/tags.
It must not contain Telegram-, Slack-, or transport-specific delivery commands.

Recommended Rust-owned state layout:

```text
$TENEX_BASE_DIR/daemon/
  transport-outbox/
    telegram/
      pending/
      delivered/
      failed/
      tmp/
```

Each delivery record should include the accepted Nostr event ID, correlation ID,
project ID, conversation ID, agent pubkey, delivery reason, rendered or
renderable content, target transport metadata, attempt history, and a stable
dedupe key. Telegram voice-note delivery remains part of the Telegram adapter's
responsibility, using the existing reserved `telegram_voice` marker semantics
until a more structured voice attachment contract replaces it.

## RAL Ownership

The clean target is Rust-owned, filesystem-backed RAL scheduling:

- Rust decides whether an agent/conversation may start.
- Rust assigns `ralNumber`.
- Rust records active, streaming, waiting, completed, killed, and aborted states.
- Rust handles stop signals and worker aborts.
- Rust persists enough state to recover from daemon or worker crashes.
- Rust rebuilds in-memory scheduler state from `ral/snapshot.json` and
  `ral/journal.jsonl` on startup.

RAL identity must match the existing execution model:

```text
projectId + agentPubkey + conversationId + ralNumber
```

Rust mints `ralNumber` monotonically per `(projectId, agentPubkey,
conversationId)` allocation scope. It uses an allocation lock for that triple,
then state locks include the concrete `ralNumber`. A single lock per
`(projectId, agentPubkey, conversationId)` is not enough because legitimate
conversation history may contain multiple RALs for the same agent and
conversation.

During migration, TypeScript execution still expects `RALRegistry`. Use a bridge
instead of letting it schedule independently:

1. Rust sends `ralNumber` and `ralClaimToken` to the worker.
2. Worker seeds/adapts TypeScript `RALRegistry` with that claim.
3. Worker reports every meaningful RAL transition to Rust.
4. Rust appends accepted transitions to the shared filesystem journal.
5. TypeScript must not create a different RAL for the same execution.

Enforcement must be in code, not only in the protocol contract. When a worker is
seeded from Rust, the TypeScript `RALRegistry` compatibility path must refuse to
mint an unseeded RAL for the same execution. Any attempted implicit mint should
throw and report a protocol error.

Long term, replace direct `RALRegistry` calls in the execution path with an
interface that can be backed by Rust:

```typescript
interface ExecutionRalBridge {
    tryAcquireResumptionClaim(input: ResumptionClaimInput): Promise<ResumptionClaimResult>;
    handOffResumptionClaimToStream(input: ClaimHandoffInput): Promise<void>;
    markStreaming(input: MarkStreamingInput): Promise<void>;
    markReasoning(input: ReasoningStateInput): Promise<void>;
    markToolStarted(input: ToolStateInput): Promise<void>;
    markToolCompleted(input: ToolStateInput): Promise<void>;
    registerDelegation(input: DelegationInput): Promise<void>;
    leaseInjections(input: InjectionLeaseInput): Promise<InjectionLease[]>;
    ackInjectionsApplied(input: InjectionAckInput): Promise<void>;
    requestSilentCompletion(input: SilentCompletionInput): Promise<void>;
    checkpointRuntime(input: RuntimeCheckpointInput): Promise<void>;
    recordHeuristicViolation(input: HeuristicViolationInput): Promise<void>;
    finish(input: FinishInput): Promise<void>;
}
```

The bridge can initially call the existing registry, then switch to protocol
messages without changing `AgentExecutor` again. If some detailed state remains
worker-local during compatibility mode, document the consequence explicitly. For
example, Rust cannot publish complete operations status if active tool tracking
stays only inside the worker.

### RAL Filesystem Contract

Use a small event-sourced filesystem model:

```text
ral/
  snapshot.json
  journal.jsonl
  locks/
    alloc.<project-id>.<agent-pubkey>.<conversation-id>.lock
    state.<project-id>.<agent-pubkey>.<conversation-id>.<ral-number>.lock
```

`journal.jsonl` records transitions:

```json
{
  "version": 1,
  "sequence": 42,
  "timestamp": "2026-04-21T12:00:00.000Z",
  "projectId": "project-d-tag",
  "conversationId": "conversation-id",
  "agentPubkey": "hex-pubkey",
  "ralNumber": 3,
  "transition": "streaming_started",
  "workerId": "worker_...",
  "triggeringEventId": "event-id"
}
```

`snapshot.json` is a compacted view of current RAL state. The Rust library can
write and read the versioned cache, but scheduler bootstrap currently treats
the journal as authoritative and ignores the snapshot unless a future recovery
path proves the snapshot is fresh. TypeScript workers should not edit these
files directly unless they use the same lock and append contract. The preferred
path is still worker-to-Rust protocol messages, with Rust performing the
filesystem write.

### Claim Token Lifecycle

`ralClaimToken` is an opaque single-execution capability:

- created by Rust when the RAL is claimed or resumed
- bound to `projectId`, `agentPubkey`, `conversationId`, `ralNumber`, and
  `workerId`
- sent to the worker in the `execute` message
- required on every RAL transition reported by that worker
- handed off from dispatch claim to streaming ownership when the worker reports
  `streaming_started`
- invalidated when the RAL reaches a terminal state or the worker is killed
- rejected if replayed by another worker or after terminal invalidation

Worker retries must reuse the same transition `sequence` and claim token. Rust
must make transition handling idempotent for duplicate messages with the same
sequence and payload, and reject conflicting duplicate sequences.

### Injection Delivery

Injection consumption needs two-phase semantics. A worker crash must not lose an
injection that Rust delivered but the worker never applied.

Use this flow:

1. Worker sends `consume_injections` with the claim token and current prompt
   preparation phase.
2. Rust marks matching injections as `leased` in the RAL journal and responds
   with the leased injections.
3. Worker writes the injections into the conversation store or relocates their
   existing records.
4. Worker sends `injections_applied` with injection IDs.
5. Rust marks those injection IDs as consumed.

If the worker dies before `injections_applied`, Rust releases the lease during
orphan reconciliation so the next worker can receive the injections again.

## Delegation Completion and Parent Wakeups

The migration must preserve the most important multi-agent flow:

```text
parent agent delegates
  -> parent execution reaches waiting-for-delegation
  -> parent worker exits
  -> child agent completes later
  -> Rust routes completion to parent
  -> Rust spawns a new parent worker
  -> parent worker resumes the existing RAL or starts the correct follow-up RAL
  -> parent finishes or delegates again
```

This flow cannot depend on a live TypeScript `ProjectRuntime` or a live parent
worker. Rust needs enough filesystem state to decide:

- which parent agent is waiting
- which child delegation completed
- whether all required child delegations are complete
- whether the parent should resume the same RAL or start a follow-up RAL
- which injections or completion messages must be included in the next prompt

The worker terminal event for delegated waiting must therefore include:

- parent RAL identity
- pending delegation IDs
- child target pubkeys
- delegation event IDs
- whether the current worker has published all required delegation events
- whether the parent is allowed to exit

Rust persists this as RAL journal state. When a child completion event arrives,
Rust updates the delegation state and enqueues a parent execution if the parent
is ready to resume. The new parent worker must be able to reconstruct the prompt
from shared conversation files and leased injections; it must not rely on
in-memory state from the previous parent worker.

## Minimal Worker Bootstrap

The worker should not call `ProjectRuntime.start()`. Instead, extract only the
execution bootstrap it needs.

Required bootstrap steps:

1. Load global config and project metadata paths.
2. Reconstruct the `NDKProject` or project context from daemon-provided project
   event data.
3. Ensure the project repository exists. Prefer Rust owning clone/init in the
   target architecture, with the worker only validating paths.
4. Load `AgentRegistry` for the project.
5. Resolve the target agent by pubkey or slug.
6. Create `ProjectContext`.
7. Initialize prompt compiler only as needed for the target agent.
8. Bootstrap agent home `.env` for the target agent.
9. Initialize `ConversationStore` with project metadata and agent pubkeys.
10. Initialize `ConversationCatalogService` only if the execution path or tools
    require catalog reads.
11. Initialize `MCPManager` and start only servers allowed by the target agent.
12. Create a publisher factory. In compatibility mode this wraps existing TS
    publishers. In target mode this sends `publish_request` messages to Rust.
13. Build `ExecutionContext`.
14. Call `AgentExecutor.execute(...)`.
15. Flush stores and shut down MCP before exit.

Long-lived services currently started by `ProjectRuntime` should not be started
inside an ephemeral worker unless required by execution:

- no project-wide status publisher loop
- no operations status interval
- no agent config watcher
- no daemon-level skill whitelist subscription
- no Telegram gateway registration loop
- no conversation indexing job
- no daemon-level agent definition monitor

If a tool needs one of these services, add a narrow worker-safe facade instead
of starting the full service.

## Cold Start and Cache Strategy

Cold worker startup is a first-class migration risk. The existing in-process
runtime benefits from warm caches and long-lived services:

- prompt compiler registry and compiled lesson state
- skill whitelist and hydrated skill content
- MCP server configuration and sometimes expensive MCP server processes
- trust-pubkey and profile/name caches
- prefix KV store for pubkey lookup
- conversation catalog handles
- provider/model configuration caches

Before Phase 5 is production-capable, measure:

- worker process boot time
- minimal execution bootstrap time
- prompt compilation/cache load time
- MCP startup time per configured MCP server
- time to first model token for a warm worker
- time to first model token for a cold worker
- peak RSS for cold and warm executions

Warm reuse should be treated as mandatory for interactive use unless benchmarks
prove cold execution is acceptable. The default idle TTL starts at 120 seconds.
Workers may be prewarmed for explicitly booted projects, but prewarming must
respect global and per-project worker limits.

Cache ownership should remain filesystem-first:

- prompt compiler results should be loaded from the existing prompt cache files
  where possible
- skill content should be loaded from existing local skill stores
- profile and pubkey caches should be shared through existing cache files or a
  new JSON cache under `$TENEX_BASE_DIR/daemon/cache/`
- MCP process reuse is only allowed inside a warm compatible worker; an
  ephemeral worker must shut down its MCP children before exit

Do not introduce a long-lived TypeScript cache daemon unless a benchmark shows
the filesystem-only model cannot meet latency targets. If such a daemon becomes
necessary, document it as a separate transport/cache adapter, not as a return to
the monolithic TypeScript daemon.

## Rust Crate Layout

Suggested initial workspace structure:

```text
crates/
  tenex-daemon/
    Cargo.toml
    src/
      main.rs
      cli.rs
      config.rs
      paths.rs
      lockfile.rs
      status_file.rs
      restart_state.rs
      signals.rs
      telemetry.rs
      nostr/
        mod.rs
        client.rs
        event.rs
        filters.rs
        project.rs
      daemon/
        mod.rs
        state.rs
        daemon.rs
        subscriptions.rs
        router.rs
        runtime_lifecycle.rs
        ral_scheduler.rs
        worker_pool.rs
        worker_protocol.rs
        shutdown.rs
```

Likely Rust dependencies:

- `tokio` for async runtime, process supervision, channels, signals, timers.
- `clap` for CLI flags.
- `serde` and `serde_json` for config, status, restart state, protocol, and
  golden fixtures.
- `tracing` and `tracing-subscriber` for logs.
- `opentelemetry` integration after the basic daemon is stable.
- `nostr-sdk` for relay subscriptions, filters, signing, and event parsing.
- `thiserror` and `anyhow` for typed errors and command-level error handling.
- `fs2` or `fd-lock` for lockfiles.
- `notify` later for file watches.
- `tempfile` for tests.

## Migration Phases

### Phase 0: Baseline and Compatibility Fixtures

Goals:

- Freeze the behavior that Rust must preserve.
- Capture fixtures before moving process boundaries.

Work:

- Add routing golden tests from current `DaemonRouter` behavior.
- Add subscription filter golden tests from `SubscriptionFilterBuilder`.
- Add status file and restart state JSON fixtures.
- Add RAL transition fixtures:
  - claim
  - stream start
  - tool start and completion
  - wait for delegation
  - child completion
  - parent resume
  - silent completion
  - abort
  - crash recovery
- Add execution transcript fixtures for representative paths:
  - direct user request to PM
  - agent delegates to another agent
  - delegation completion routes back to delegator
  - tool call success
  - tool call failure
  - kill during execution
  - no-response Telegram path
  - post-completion supervision re-engagement
- Add a diagnostic command or script that records one full execution lifecycle as
  normalized JSON events.

Exit criteria:

- Current TypeScript daemon behavior is covered by fixtures.
- The team can compare Rust daemon decisions to TypeScript decisions.

### Phase 1: Extract TypeScript Agent Worker

Goals:

- Create the Bun worker while still using the existing TypeScript daemon.
- Prove that `AgentExecutor` can run without starting full `ProjectRuntime`.

Work:

- Add `src/agents/execution/worker/agent-worker.ts`.
- Add protocol types and runtime validation.
- Extract a minimal execution bootstrap from `ProjectRuntime`.
- Add a compatibility publisher factory.
- Add a compatibility RAL bridge that still uses `RALRegistry`.
- Keep Phase 1 RAL persistence unchanged. The worker reports transitions for
  observation, but Rust does not yet own or replay the RAL journal.
- Add a TypeScript test harness that spawns the worker as a child process.
- Keep any TypeScript-daemon worker route as a temporary developer gate until
  Rust owns dispatch. The migration target should remove the parallel
  in-process execution path instead of maintaining it indefinitely.

Exit criteria:

- Existing Bun daemon can route an event and run the agent in a child worker.
- Worker exits cleanly after terminal execution.
- MCP manager resources are cleaned up when the worker exits or executor
  execution fails.
- Conversation state is persisted correctly.

### Phase 2: Define Stable Worker Protocol

Goals:

- Make the process boundary stable enough for Rust to implement.

Work:

- Version every protocol message.
- Define JSON schemas or zod schemas for worker messages.
- Add a protocol conformance test suite.
- Add sequence numbers and correlation IDs.
- Keep protocol payloads state-light. Pass filesystem paths and stable IDs
  instead of embedding mutable project or conversation state.
- Add `boot_error`, `pong`, `ack`, `publish_result`,
  `silent_completion_requested`, `consume_injections`, and
  `injections_applied` messages.
- Define which message types require durable acknowledgement from Rust.
- Define batched stream-delta framing and backpressure behavior.
- Define worker stderr log format.
- Define maximum message size and behavior on malformed messages.
- Add timeout semantics:
  - worker boot timeout
  - execution idle timeout
  - total execution deadline
  - graceful shutdown timeout
  - force-kill timeout

Exit criteria:

- A mock daemon can drive the Bun worker.
- A mock worker can satisfy daemon-side protocol tests.

### Phase 3: Rust Daemon Skeleton

Goals:

- Introduce a Rust daemon that can start, lock, write status, handle signals,
  and shut down without processing production events.

Work:

- Create `crates/tenex-daemon`.
- Implement CLI flags matching the current daemon command:
  - `--foreground`
  - `--boot`
  - `--supervised`
  - `--only`
  - `--exclude-agents`
  - `--only-agents`
  - `--verbose`
- Implement config path resolution compatible with `ConfigService`.
- Implement lockfile compatibility with `tenex.lock`.
- Implement `status.json` compatibility.
- Implement `restart-state.json` compatibility.
- Implement signal handling for `SIGTERM`, `SIGINT`, and `SIGHUP`.
- Add status and stop compatibility tests.

Exit criteria:

- Rust daemon can run in foreground, write status, and stop cleanly.
- Existing `tenex daemon status` and `tenex daemon stop` can inspect/stop it, or
  equivalent Rust commands exist with matching behavior.

### Phase 4: Rust Nostr Subscriptions and Routing

Goals:

- Port the always-on event intake path.

Work:

- Implement relay client setup and backend signing.
- Port static, known-project, agent-mentions, and lesson subscription groups.
- Port event deduplication.
- Port project event parsing and known project index.
- Port routing logic from `DaemonRouter`.
- Add shadow mode:
  - TypeScript daemon remains authoritative.
  - Rust receives the same events.
  - Rust logs what it would route, boot, or drop.
  - Compare decisions against TypeScript logs.

Exit criteria:

- Rust routing decisions match TypeScript fixtures.
- Shadow mode runs against real relays without starting workers.

### Phase 5: Rust Worker Pool and Execution Dispatch

Goals:

- Let Rust route an event and spawn a Bun worker for execution.

Work:

- Implement worker process spawning.
- Implement stdin/stdout protocol framing.
- Implement boot timeout and heartbeat tracking.
- Implement worker kill and process-group cleanup.
- Implement global/project/agent concurrency limits.
- Implement dispatch queue semantics:
  - queue when concurrency is saturated
  - persist queue transitions in `workers/dispatch-queue.jsonl`
  - bound queue length per project and globally
  - publish or surface an operator-visible error on overflow
  - never silently drop a trusted inbound event
- Implement strict worker compatibility checks for warm reuse.
- Implement idle TTL.
- Implement worker event ingestion and status updates.
- Add a mock worker integration test.
- Add a real Bun worker smoke test behind an opt-in test flag.

Exit criteria:

- Rust daemon can start a Bun worker for a routed execution.
- Rust daemon observes terminal completion and cleans up the worker.
- Worker crash is contained and reported.

### Phase 6: RAL Scheduler Authority

Goals:

- Move scheduling authority to Rust without breaking TypeScript execution.

Work:

- Implement Rust RAL scheduler:
  - claim
  - resume
  - mark streaming
  - mark waiting
  - complete
  - abort
  - kill
  - release stale claims
- Persist scheduler state through `ral/journal.jsonl` plus compacted
  `ral/snapshot.json`. The current Rust library can bootstrap scheduler state
  from the journal and persist/read a versioned snapshot cache.
- Add journal replay and snapshot compaction. Snapshot loading must stay
  fail-closed on unsupported schema versions and must not override authoritative
  journal replay until freshness checks are implemented.
- Add a worker terminal transition planner that validates the active claim token,
  verifies the reporting worker id, checks journal sequence order, and returns
  the journal record for completed, waiting-for-delegation, no-response,
  aborted, or error outcomes. Worker crashes remain a reconciliation result, not
  a worker-emitted terminal transition.
- Add a dispatch preparation planner that returns the RAL allocation record,
  claim record, and queued dispatch record as a single side-effect-free bundle.
  The caller supplies the claim token, and the planner validates RAL journal and
  dispatch queue sequence spaces independently.
- Add a Rust worker execute-message assembler that accepts a leased dispatch
  record plus explicit runtime context, validates the result through the shared
  worker protocol contract, and checks that the triggering envelope native id
  matches the queued triggering event id.
- Move daemon-to-worker `shutdown`, `publish_result`, and `ack` assembly behind
  Rust protocol helpers so process supervision and publishing code no longer
  hand-build compatible JSON frames.
- Add a side-effect-free worker launch planner that verifies a leased dispatch
  record against the expected RAL identity, derives allocation/state lock
  scopes, and packages the validated execute message before any lock
  acquisition or process spawn occurs.
- Add lock handling for each `(projectId, agentPubkey, conversationId)` RAL
  scope. The first Rust helper builds the documented allocation/state lock
  paths, writes daemon-compatible `{ pid, hostname, startedAt }` owner JSON,
  acquires with atomic create-new semantics, fails closed on corrupt lock JSON,
  and leaves stale replacement behind an explicit PID-liveness classification.
- Add PID liveness as a separate adapter above lock policy. Unix maps
  `kill(pid, 0)` results like the TypeScript lockfile path, while unsupported
  platforms return `Unknown` and therefore do not auto-reclaim locks.
- Compose launch plans with lock acquisition by taking the allocation lock
  before the state lock and rolling back the allocation lock if state acquisition
  fails. This remains separate from worker spawn so lock behavior is testable on
  its own.
- Add a pure dispatch-to-spawn planner that combines the chosen Bun worker
  command with the validated execute message. The planner is the handoff shape
  for future process orchestration and intentionally performs no spawn,
  readiness wait, or stdin write.
- Add a trait-backed execution handoff that validates the execute message before
  spawning, then boots the worker and sends the execute frame through injected
  spawn/session interfaces. Unit tests use fakes, while production wiring can
  adapt the same path to `AgentWorkerProcess`.
- Add a worker-result adapter that validates worker-to-daemon terminal frames
  and converts `complete`, `waiting_for_delegation`, `no_response`, `aborted`,
  and terminal `error` messages into Rust RAL transition inputs. The adapter
  keeps worker frame sequence/timestamp metadata separate from daemon journal
  sequence/timestamp authority.
- Add heartbeat snapshot/freshness planning. Heartbeat frames are validated
  against the shared worker protocol, stored with daemon-observed receipt time,
  and classified for missed-heartbeat handling from that observation time rather
  than the worker-provided timestamp.
- Compose lock-scoped dispatch start. The Rust handoff acquires RAL launch
  locks, starts the worker through the trait-backed execution path, returns the
  held locks on success, and releases them on validation, spawn, or execute-send
  failure.
- Add a worker-completion planner that consumes a validated worker-result
  transition, asks the scheduler to validate claim/worker ownership, and returns
  the RAL journal record plus an optional dispatch queue completion record. The
  planner remains side-effect-free and keeps both sequence spaces explicit.
- Add a worker-completion apply boundary that appends the planned RAL journal
  and optional dispatch queue records, then releases held launch locks after the
  planned filesystem writes succeed.
- Add worker-message routing so the future dispatch loop can classify validated
  worker-to-daemon frames into heartbeat, terminal result, publish, stream,
  control, or boot-error handling without invoking the downstream handlers yet.
- Add side-effect-free worker concurrency admission planning over explicit
  active worker and dispatch snapshots for global, per-project, and
  per-project-agent limits.
- Add abort/timeout planning that consumes daemon-observed heartbeat freshness
  and process status, returning graceful signal, wait, force-kill, or
  reconciliation actions without killing real processes.
- Add a worker publish acceptor that persists a worker-signed `publish_request`
  into the Rust outbox and builds the accepted `publish_result` frame. Relay
  publication remains the outbox drainer's responsibility.
- Add publish-request runtime handling that combines message routing, durable
  outbox acceptance, accepted-result assembly, and injected worker-session send.
- Add dispatch admission planning that scans queued dispatches in queue order,
  applies explicit concurrency snapshots/limits, and returns the selected
  dispatch plus planned lease record without writing the queue.
- Add terminal-result runtime handling that combines message routing,
  worker-result planning, completion planning, filesystem apply, and lock
  release for terminal worker frames.
- Add an in-memory worker runtime-state snapshot for active workers, latest
  heartbeat, graceful signal markers, and conversion into concurrency and abort
  planning inputs.
- Add orphaned RAL reconciliation planning at daemon startup. The current Rust
  library planner classifies claimed RALs whose worker ids are absent from the
  live worker set and proposes `crashed` journal records, but it does not yet
  write recovery records during daemon startup:
  - active RAL with no worker
  - leased injections with no terminal acknowledgement
  - worker marked active but PID missing
  - parent waiting for children
  - crashed worker during tool execution
- Add transition bridge in TypeScript so execution uses Rust-provided RAL data.
- Ensure worker cannot create a competing RAL.
- Move injection queue ownership to Rust with lease/ack semantics, or create a
  single bridge that implements the same lease/ack contract.
- Move stop-signal ownership to Rust or create a single bridge.
- Define stale lock reclamation using PID, process start time where available,
  and lock heartbeat timestamps.
- Define journal compaction cadence and retention before enabling production
  dispatch.
- Add crash recovery tests:
  - daemon dies while worker runs
  - worker dies while streaming
  - worker dies during tool call
  - restart finds active RAL with no worker
  - duplicate event delivery cannot start duplicate workers

Exit criteria:

- Rust is the only scheduler for executions started by Rust.
- RAL state survives daemon restart using only filesystem state.
- Duplicate dispatch races are covered by tests.
- Kill/abort works across process boundaries.

### Phase 7: Rust-Owned Relay Publishing

Goals:

- Centralize publishing in Rust after execution dispatch is stable.

Work:

- Define `publish_request` protocol messages for:
  - conversation replies
  - completion
  - delegation
  - ask
  - delegate follow-up
  - tool use
  - stream text delta
  - error
  - lesson
- Accept complete worker-signed NIP-01 events for agent-authored runtime
  messages.
- Verify event hash, signature, and expected agent pubkey before durable
  acceptance.
- Persist accepted events in a Rust-owned outbox before returning
  `publish_result.status=accepted`.
- Relay the exact signed event without reconstructing or re-signing it.
- Port or wrap only Rust/backend-authored event encoding needed for status,
  config, delete, heartbeat, and transport-control messages.
- Add signed-event golden tests for worker-authored requests and event encoding
  golden tests for Rust-authored events.
- Ensure Rust preserves relay routing and recipient semantics.

Exit criteria:

- Rust can durably accept worker-signed events into
  `publish-outbox/pending/<event-id>.json` and acknowledge with
  `publish_result.status=accepted`.
- Rust can drain accepted records into durable `published` or `failed` outbox
  records without mutating the signed event payload.
- Rust can publish an outbox record through the initial WebSocket relay
  publisher against a local mock relay and persist the relay result.
- Worker never publishes directly to Nostr during agent execution.
- Rust publishes the exact worker-signed runtime events.
- Event IDs, signatures, and tags match golden expectations.

### Phase 8: Long-Lived Services and Transports

Goals:

- Remove remaining assumptions that `ProjectRuntime` is always alive.

Work:

- Replace project status publishing with Rust-owned status publishing.
- Move operations status to Rust or convert it to worker event summaries.
- Account for project-wide MCP subscriptions. Either port
  `McpSubscriptionService` semantics, or make MCP notifications explicit wakeup
  events handled by a dedicated adapter.
- Account for trust-pubkey cache, prefix KV store, and profile/name cache.
  These should be rebuilt from filesystem/relay state or moved behind
  filesystem-backed cache files.
- Decide Telegram architecture:
  - port Telegram gateway to Rust, or
  - run a dedicated long-lived transport adapter process, separate from agent
    execution workers.
- Move scheduler wakeups into Rust.
- Move agent definition monitoring into Rust or a dedicated service.
- Move skill whitelist hydration into Rust or a dedicated local cache updater.
- Ensure no ephemeral worker is responsible for receiving external events while
  it is not running.

Exit criteria:

- TypeScript `ProjectRuntime` is no longer needed for daemon behavior.
- External events can wake agents without any Bun daemon process alive.

### Phase 9: Clean Cutover: Delete the TypeScript Daemon

Goals:

- Delete all TypeScript daemon code that is no longer needed.
- Rust is the only control plane. No fallback, no compatibility shims.

Work:

- Delete `src/commands/daemon.ts`, `src/daemon/Daemon.ts`,
  `src/daemon/RuntimeLifecycle.ts`, `src/daemon/ProjectRuntime.ts`, and all
  remaining TypeScript daemon infrastructure unreachable from execution workers.
- Remove `dispatch-adapter.ts` and the in-process `AgentExecutor` dispatch
  route it guarded.
- Remove the compatibility RAL bridge (`ral-bridge.ts`) and all remaining
  `RALRegistry` call sites kept only for transition.
- Remove the compatibility publisher factory and `WorkerPublishRequestPublisher`
  TypeScript path.
- Delete dead TypeScript daemon services: `SubscriptionManager`, `DaemonRouter`,
  `RuntimeLifecycle`, status publisher loops, operations status interval, agent
  config watcher, skill whitelist subscription, conversation indexing job,
  daemon-level agent definition monitor.
- Remove all temporary migration env flags: `TENEX_RUST_DAEMON`,
  `TENEX_AGENT_WORKER`, and all related overrides from both TypeScript and Rust.
- Update `MODULE_INVENTORY.md` and architecture docs to reflect the new
  boundary: Rust is the daemon, Bun is execution-only.

Exit criteria:

- TypeScript daemon code is gone, not deprecated or feature-flagged.
- `bun test` passes with only the worker execution path.
- Bun is started only for agent execution workers or transport adapters.
- No migration shim, adapter, or compatibility wrapper remains in the codebase.

## Operational Controls

Temporary development controls while the migration is incomplete:

- `TENEX_RUST_DAEMON=1`: launch Rust daemon from existing CLI.
- `TENEX_AGENT_WORKER=1`: use Bun worker execution from the TypeScript daemon.
- `TENEX_AGENT_WORKER_BUN_BIN`: override the Bun binary used by the
  TypeScript-daemon worker bridge.
- `TENEX_AGENT_WORKER_ENTRYPOINT`: override the TypeScript worker entrypoint
  used by the bridge.
- `TENEX_AGENT_WORKER_CWD`: override the working directory used when spawning
  the worker.
- `TENEX_WORKER_IDLE_TTL_MS`: worker warm reuse timeout.
- `TENEX_WORKER_MAX_GLOBAL`: global worker concurrency.
- `TENEX_WORKER_MAX_PER_PROJECT`: per-project concurrency.
- `TENEX_WORKER_QUEUE_MAX_GLOBAL`: global queued execution limit.
- `TENEX_WORKER_QUEUE_MAX_PER_PROJECT`: per-project queued execution limit.
- `TENEX_WORKER_BOOT_TIMEOUT_MS`: boot timeout.
- `TENEX_WORKER_EXECUTION_TIMEOUT_MS`: execution deadline.
- `TENEX_WORKER_HEARTBEAT_INTERVAL_MS`: heartbeat interval.
- `TENEX_WORKER_ABORT_TIMEOUT_MS`: graceful abort timeout.
- `TENEX_DURABLE_FSYNC`: `normal` or `full` journal flush mode.
- `TENEX_RUST_SHADOW=1`: Rust observes and logs routing decisions but does not
  dispatch workers.

Prefer explicit flags over implicit auto-detection during the migration.

Initial defaults:

| Control | Default |
| --- | --- |
| `TENEX_WORKER_IDLE_TTL_MS` | `120000` |
| `TENEX_WORKER_MAX_GLOBAL` | `4` |
| `TENEX_WORKER_MAX_PER_PROJECT` | `2` |
| `TENEX_WORKER_QUEUE_MAX_GLOBAL` | `100` |
| `TENEX_WORKER_QUEUE_MAX_PER_PROJECT` | `25` |
| `TENEX_WORKER_BOOT_TIMEOUT_MS` | `30000` |
| `TENEX_WORKER_HEARTBEAT_INTERVAL_MS` | `5000` |
| `TENEX_WORKER_ABORT_TIMEOUT_MS` | `10000` |
| `TENEX_DURABLE_FSYNC` | `normal` |

## Failure Handling

### Worker Boot Failure

- Mark execution as failed before claiming streaming state if possible.
- Release RAL claim or mark it retryable.
- Emit status event.
- Do not retry indefinitely. Use bounded retry with backoff.

### Worker Crash During Stream

- Mark worker dead.
- Mark RAL as crashed or retryable depending on terminal evidence.
- Publish an error event if safe and not already published.
- Preserve worker stderr and last protocol messages for diagnostics.
- Release leased injections that were not acknowledged as applied.
- Requeue resumable executions only when the RAL journal proves the prior
  worker did not reach a terminal state.

### Orphaned RAL Reconciliation Planning At Daemon Startup

Rust must compute a reconciliation plan for RAL state before accepting new
dispatch:

- If a RAL is `streaming` or `tool_active` but its worker PID is gone, mark it
  `crashed` and decide whether it is retryable.
- If a RAL is `waiting_for_delegation`, keep it waiting and rebuild delegation
  wakeup indexes.
- If a RAL has leased but unapplied injections, release those leases.
- If a RAL has an expired claim token and no worker heartbeat, invalidate the
  token.
- If journal replay finds a truncated or corrupt final record, ignore that final
  record only if all previous records are valid; otherwise fail closed and
  require repair.

### Daemon Shutdown With Active Workers

- Send `shutdown` to idle workers.
- Send `abort` to active workers unless supervised restart is draining.
- Wait for graceful deadline.
- Kill process group after deadline.
- Persist active RAL state before exit.

### Supervised Restart

- Stop accepting new executions.
- Wait for active RALs to reach terminal or waiting states.
- Persist booted projects and active scheduler state.
- Exit with code 0 so the supervisor restarts the daemon.

### Duplicate Event Delivery

- Deduplicate by event ID at subscription intake.
- Also guard dispatch by `(projectId, agentPubkey, conversationId, triggeringEventId)`.
- RAL scheduler must reject duplicate active claims.

## Data Compatibility

Preserve these paths and formats during migration unless there is a deliberate
schema migration:

- daemon lockfile under `$TENEX_BASE_DIR/daemon/tenex.lock`
- daemon status under `$TENEX_BASE_DIR/daemon/status.json`
- restart state under `$TENEX_BASE_DIR/daemon/restart-state.json`
- project metadata under `$TENEX_BASE_DIR/projects/<project-dTag>/`
- conversation transcripts and catalog paths
- agent storage paths
- skill storage paths

New Rust daemon coordination state should stay under `$TENEX_BASE_DIR/daemon/`
as plain files:

```text
$TENEX_BASE_DIR/daemon/routing/known-projects.json
$TENEX_BASE_DIR/daemon/routing/agent-index.json
$TENEX_BASE_DIR/daemon/routing/active-projects.json
$TENEX_BASE_DIR/daemon/ral/snapshot.json
$TENEX_BASE_DIR/daemon/ral/journal.jsonl
$TENEX_BASE_DIR/daemon/workers/dispatch-queue.jsonl
$TENEX_BASE_DIR/daemon/workers/<worker-id>.json
```

Do not replace existing conversation storage as part of the first migration. Do
not add a new database for daemon/RAL coordination state.

## Testing Plan

### Unit Tests

- routing decisions
- project d-tag extraction
- NIP-33 `a` tag parsing
- p-tag routing ambiguity
- active-project routing semantics
- subscription filter construction
- status file read/write
- restart state read/write
- atomic JSON snapshot writes
- JSONL journal append and replay
- lock acquisition and stale lock handling
- worker protocol decode/encode
- stream delta batching and frame size limits
- protocol backpressure behavior
- claim token validation and idempotency
- injection lease/ack transitions
- RAL scheduler transitions

### Integration Tests

- Rust daemon with fake Nostr client and mock worker
- duplicate event delivery starts one worker
- worker crash does not crash daemon
- shutdown kills process group
- idle TTL exits worker
- warm reuse only reuses compatible workers
- kill signal aborts active worker
- restart state restores pending projects
- RAL journal restores active/waiting/crashed state after daemon restart
- child completion wakes parent without a live parent worker
- dispatch queue survives daemon restart
- orphaned RAL reconciliation releases unapplied injection leases

### End-to-End Tests

- real Bun worker executes a simple mock-provider conversation
- delegation registers child work and parent worker exits terminal waiting state
- delegation completion wakes parent
- tool call events round-trip through protocol
- post-completion supervision can trigger a follow-up execution
- no-response path remains silent and terminal

### Shadow Tests

- Run TypeScript daemon and Rust daemon in shadow mode against the same relay
  traffic.
- Compare:
  - route/drop decisions
  - target project
  - target agent
  - boot decisions
  - event classifications

## Rollback Strategy

Before M10 (clean cutover), each phase should have a repair path. Rollback
means fixing or disabling the Rust feature, not reverting to TypeScript code.
There is no TypeScript daemon fallback after M10; fix blockers in M9 before
cutting over.

- If worker execution fails during M1–M4, fix the worker or disable the
  out-of-process route; the in-process executor remains until M5 is ready.
- If Rust daemon shadow mode disagrees, treat it as a Rust bug to fix before
  enabling routing authority.
- If Rust dispatch or RAL state fails pre-M10, fix the specific failure; do not
  re-enable TypeScript daemon code that has already been removed.
- If filesystem journal recovery fails, Rust must refuse new dispatch until the
  operator repairs or rolls back state.
- If Rust publishing fails, stop accepting new publish requests, drain or repair
  the Rust outbox, and rerun affected executions after the fault is corrected.
  Do not fall back to direct worker relay publishing for the same execution.

The migration should avoid one-way data migrations until the Rust daemon has run
successfully in production-like use.

## Key Risks

### Cold Start Latency

Spawning Bun per execution may add noticeable latency. Mitigations:

- idle TTL worker reuse
- prewarm on explicit boot
- cache static project metadata in Rust
- keep worker bootstrap minimal

### Split-Brain RAL State

If Rust and TypeScript both believe they own scheduling, duplicate executions or
lost injections can occur. Mitigations:

- Rust sends explicit RAL claim tokens.
- TypeScript worker accepts scheduler decisions from Rust.
- Rust mints `ralNumber` and TypeScript refuses unseeded RAL creation in
  Rust-seeded worker mode.
- Add race tests before enabling Rust scheduling broadly.

### RAL Identity Drift

The existing model supports multiple RALs per `(agentPubkey, conversationId)`.
If filesystem locks or journals collapse that to a single conversation-level
state, legitimate resumed or parallel RALs can collide. Mitigations:

- Rust RAL identity includes `projectId`, `agentPubkey`, `conversationId`, and
  `ralNumber`.
- allocation locks and state locks are separate.
- Phase 0 fixtures include multi-RAL conversations.

### Active Routing Drift

The TypeScript router uses active runtime state to avoid cross-project routing
for agents that belong to multiple projects. If Rust treats the agent index as
enough information, it can route incorrectly. Mitigations:

- Rust owns a project activation table.
- p-tag routing consults active projects, not only known projects.
- shadow mode must include multi-project shared-agent fixtures.

### Filesystem Journal Corruption

Filesystem-first state makes restart behavior inspectable, but journal writes
can still be truncated or corrupted by process or machine failure. Mitigations:

- append records with sequence numbers and checksums if needed.
- ignore only a truncated final record when all earlier records validate.
- fail closed on ambiguous corruption.
- test replay from truncated and partially written files.

### Hidden ProjectRuntime Dependencies

Some execution code may assume `ProjectRuntime` started long-lived services.
Mitigations:

- extract bootstrap behind explicit interfaces
- fail fast when a required service is missing
- add worker e2e tests for each major execution path

### Transport Wakeups

Telegram and future non-Nostr transports need long-lived listeners. They cannot
depend on ephemeral agent workers. Mitigations:

- port the Telegram gateway to Rust as the target runtime path.
- require future transport integrations to declare whether they are Rust-native
  gateways or Rust-owned adapters that forward normalized inbound envelopes to
  Rust.

### Publishing Divergence

If the worker ever relays directly while Rust also relays signed requests,
duplicate events can appear. Mitigations:

- mark each execution mode clearly
- in the target architecture, the worker signs and requests publication; it does
  not publish directly
- Rust rejects unsigned or invalidly signed worker publish requests
- never allow both direct worker relay publishing and Rust relay publishing for
  the same event type in the same execution

## Implementation Order Summary

1. Add behavior fixtures for current daemon and execution.
2. Extract a minimal TypeScript agent worker.
3. Stabilize the worker protocol.
4. Benchmark cold and warm worker startup before production dispatch.
5. Build Rust daemon skeleton with lock/status/restart/signal behavior.
6. Port Nostr subscriptions and routing in shadow mode, including active-project
   routing.
7. Add Rust worker pool and dispatch to Bun worker.
8. Move filesystem-backed RAL scheduling authority to Rust.
9. Move publishing authority to Rust.
10. Move or separate long-lived transport and daemon services.
11. Cut over Rust daemon as default and remove compatibility paths later.

## Open Decisions

- Should RAL state use one global journal, one journal per project, or one
  journal per conversation?
- What compaction cadence should `ral/snapshot.json` use?
- Should RAL journal records include checksums from the first implementation?
- What stale-lock timeout is acceptable for RAL files after heartbeat loss?
- What durability level should Rust require before returning
  `publish_result.status=accepted` to a worker?
- Should Telegram be ported to Rust or isolated as a dedicated TypeScript
  transport adapter?
- Are the initial worker TTL and concurrency defaults acceptable after
  benchmarking?
- How much of `ProjectContext` should be reconstructed in Rust versus passed to
  the worker as raw project event data?
- Which event encoders must be ported before Rust-owned publishing can be
  enabled?
- Should prompt compiler and profile caches remain pure filesystem caches, or is
  a dedicated cache adapter justified by benchmark data?
