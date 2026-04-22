# Rust Migration Implementation Plan and Quality Gates

## Purpose

This plan turns `docs/rust/agent-execution-worker-migration.md` into an
implementation sequence with explicit quality gates. The priority is not only
to make the Rust daemon work, but to prove that existing TENEX clients and
TypeScript workers continue to interoperate throughout the migration.

The migration is successful only if existing clients can keep using the same
TENEX protocol surface:

- Nostr event kinds, tags, threading, authors, and recipient semantics.
- Project discovery and boot behavior.
- Runtime status and operations status behavior.
- Conversation transcripts and metadata layout.
- Agent definition, config update, deletion, lesson, and skill behavior.
- CLI behavior for daemon start, status, stop, foreground/background, and
  supervised restart.
- Telegram and other transport behavior where supported.

## Compatibility Principle

Rust must be wire-compatible before it is feature-complete.

For every milestone, prefer proving compatibility against existing TypeScript
behavior before adding new Rust-only behavior. If Rust cannot produce the same
observable output as the TypeScript daemon for a supported scenario, that
scenario is not enabled in the Rust path yet. The migration should avoid a
long-lived matrix of compatibility flags.

## Interoperability Contracts

### Nostr Wire Contract

The Nostr contract is the most important client compatibility surface. Existing
clients should not need to know whether a backend is TypeScript or Rust.

Contract source of truth:

- `src/nostr/kinds.ts`
- `src/nostr/AgentEventEncoder.ts`
- `src/nostr/AgentPublisher.ts`
- `src/nostr/AgentEventDecoder.ts`
- `src/events/runtime/AgentRuntimePublisher.ts`
- `src/events/runtime/InboundEnvelope.ts`

Events that need compatibility coverage:

| Event | Kind | Signer | Rust role | Compatibility requirement |
| --- | --- | --- | --- | --- |
| project | `31933` | user | observe + route | Same project d-tag extraction, `a` tag references, deletion behavior, membership tags. |
| conversation | `1` | agent | verify + relay-publish (pass-through) | Same threading, project tags, p-tags, reply targets, transport metadata as the agent emits. |
| boot project | `24000` | user | observe + route | Same project boot semantics via `a` tag. |
| project status | `24010` | backend | encode + sign + publish | Ephemeral. Same client-visible project runtime state shape. |
| installed agent list | `24011` | backend | encode + sign + publish | Ephemeral. Same backend inventory semantics. |
| backend heartbeat | `24012` | backend | encode + sign + publish | Ephemeral. Same owner-directed heartbeat semantics. |
| operations status | `24133` | backend | encode + sign + publish | Ephemeral. Same active execution/status semantics or an explicitly documented compatibility subset. |
| stop command | `24134` | user | observe + route | Same stop/kill routing semantics. |
| stream text delta | `24135` | agent | verify + relay-publish (pass-through) | Same stream sequence, tags, and best-effort behavior as the agent emits. |
| agent config update | `24020` | user | observe + route | Same global vs project-scoped update behavior. |
| agent delete | `24030` | user | observe + route | Same global/project delete behavior and project republish side effects. |
| agent lesson | `4129` | agent | verify + relay-publish (pass-through) | Same trust and hydration semantics as the agent emits. |
| agent definition | `4199` | user | observe + route | Same install/discovery metadata. |
| MCP tool | `4200` | user | observe + route | Same MCP tool extraction and install behavior. |

Signer semantics determine what compatibility actually requires of Rust:

- **User-signed** events are encoded and signed by clients. Rust never encodes
  or re-signs them. Rust must correctly verify the schnorr signature where
  trust decisions depend on it, and must correctly extract routing inputs
  (`a`, `p`, `e`, thread, delegation, d-tag, replaceable semantics). No
  cross-language encoder contract applies.
- **Agent-signed** events are encoded and signed by the worker running the
  agent. Rust never encodes or re-signs them either: the worker ships the
  complete signed event in a `publish_request` frame, and Rust publishes the
  exact bytes to relays after verifying the NIP-01 hash and schnorr signature
  against the claimed agent pubkey. No cross-language encoder contract
  applies.
- **Backend-signed** events are encoded and signed by Rust itself once
  publishing authority flips. TypeScript is not running as a parallel encoder
  for the same event: authority for each backend-signed kind transitions from
  TypeScript to Rust atomically. The contract Rust owes clients is therefore
  not "byte-match the TypeScript encoder" but "produce a valid NIP-01 event
  with the client-visible kind, content, tags, and signer identity the
  migration preserves."

Quality gates compare raw event JSON where possible. When an event id differs
because signing time or `created_at` differs, compare normalized events:

- same kind
- same content
- same required tags
- same project `a` tags
- same recipient `p` tags
- same reply/thread tags
- same client-visible metadata
- same signer role

For every event kind Rust itself encodes, additional self-consistency gates
apply:

- Rust's canonical NIP-01 serialization produces an event id equal to
  `sha256(canonical_payload)`.
- Rust's schnorr signature verifies against the canonical payload and the
  backend pubkey.
- Nested JSON `content` serialization is deterministic where clients depend
  on the exact string.
- Tag order matches the order clients rely on, documented per kind.

For every event kind Rust verifies but does not encode (user-signed and
agent-signed sets), Rust's only wire contract is correct schnorr verification
against the claimed pubkey and correct routing-input extraction.

There is no scenario where both Rust and TypeScript encode the same event
kind for the same execution. Cross-language encoder byte parity is therefore
not a quality gate anywhere in this plan.

### Filesystem Contract

Rust and TypeScript share filesystem state. The compatibility contract includes:

- `$TENEX_BASE_DIR/config.json`
- `$TENEX_BASE_DIR/llms.json`
- `$TENEX_BASE_DIR/daemon/tenex.lock`
- `$TENEX_BASE_DIR/daemon/status.json`
- `$TENEX_BASE_DIR/daemon/restart-state.json`
- `$TENEX_BASE_DIR/projects/<project-dTag>/`
- conversation transcript JSON
- conversation catalog path
- agent metadata and home directories
- skill stores
- MCP configuration
- scheduler files

New Rust control-plane state must stay additive under:

```text
$TENEX_BASE_DIR/daemon/routing/
$TENEX_BASE_DIR/daemon/ral/
$TENEX_BASE_DIR/daemon/workers/
```

No milestone may require a one-way migration of existing conversation, agent,
project, or skill state.

Every durable file written by Rust must include:

- `schemaVersion`
- `writer` (`rust-daemon`, `ts-worker`, or a specific adapter id)
- `writerVersion`
- `createdAt` or `updatedAt`

Append-only journal records must also include a per-journal sequence number.
This applies to RAL journals, dispatch queues, active-project snapshots, worker
state, and any future Rust-owned compatibility files.

Conversation transcripts and catalog files remain worker-writable because the
TypeScript execution path owns `ConversationStore` during the first migration.
Before Rust dispatch can run concurrently with TypeScript dispatch for the same
project, the migration must define a conversation write contract:

- a per-conversation lock or generation check
- stale lock recovery
- conflict behavior when two workers attempt to write the same transcript
- fixture coverage for mixed backend or duplicate dispatch races

### CLI Contract

Existing operator workflows must continue to work:

- `tenex daemon --foreground`
- `tenex daemon --boot <pattern>`
- `tenex daemon --supervised`
- `tenex daemon --only`
- `tenex daemon --exclude-agents`
- `tenex daemon --only-agents`
- `tenex daemon status`
- `tenex daemon stop`
- `tenex daemon stop --force`

During migration, the TypeScript CLI may keep temporary developer launch
controls, but the production target is a single Rust daemon path. Status and
stop commands must work against both daemon implementations until the TypeScript
daemon path is removed.

### Worker Protocol Contract

The worker protocol is not a client-facing contract, but it is the boundary that
keeps Rust and TypeScript interoperable. It must be versioned, fixture-tested,
and treated as stable once Rust dispatch is enabled.

Required protocol guarantees:

- length-prefixed JSON frames before production streaming traffic
- bounded frame size
- file references for large payloads
- batched stream deltas
- durable acknowledgements for RAL transitions
- claim-token validation on every RAL transition
- explicit boot errors
- explicit heartbeat and abort timeout behavior
- injection lease/ack semantics
- publish request/result correlation
- enough daemon-side context to derive native delivery records from accepted
  signed runtime events without exposing transport-specific delivery commands
  to the worker

The protocol version is negotiated per worker connection. Warm worker reuse must
be refused when the daemon and worker protocol versions differ. Protocol flags
that change authority must be independent:

- routing authority
- RAL authority
- publishing authority

Each authority flag needs its own rollback and drain behavior.

## Backend Identity and Sharding

TENEX may run multiple backend processes for the same owner, especially with
agent-runtime sharding. Rust must not assume it is the only backend.

Compatibility requirements:

- Rust loads the same backend signer material and publishes heartbeats with the
  same semantics as TypeScript.
- Runtime events must carry enough backend identity for operators and clients to
  attribute ownership when multiple backends are online.
- Rust must respect project/backend or agent-runtime policy before dispatching.
- If a project or agent is assigned to another backend shard, Rust may observe
  and route in shadow mode but must not execute locally.
- If two backends claim the same local execution scope, status must surface the
  conflict instead of racing silently.
- Stop commands must only abort RALs owned by the receiving backend unless the
  command is explicitly global.
- Cross-backend delegation must be either supported through relay-mediated
  wakeups or explicitly disallowed and enforced at dispatch time.

## Milestones

### M0: Compatibility Harness and Fixtures

Goal: make TypeScript behavior executable as a compatibility oracle.

Scope:

- Capture routing fixtures from `DaemonRouter`.
- Capture subscription filter fixtures.
- Capture Nostr event encoding fixtures for all client-visible event kinds.
- Capture NIP-01 canonical serialization bytes for every supported published
  event kind.
- Capture nested JSON `content` body strings exactly as TypeScript emits them.
- Capture signature verification fixtures with known keys.
- Capture daemon file fixtures for lockfile, status, and restart state.
- Capture RAL transition fixtures for claim, stream, tool, delegation, resume,
  silent completion, abort, and crash paths.
- Capture backend identity and sharding fixtures:
  - project assigned to local backend
  - project assigned to another backend
  - shared agent across two backend shards
  - stop command received by multiple backends
  - cross-backend delegation attempt
- Capture full execution lifecycle fixtures with the mock LLM provider.
- Add a normalizer for signed Nostr events so deterministic fields can be
  compared separately from signatures and timestamps.

Quality gates:

- `bun test` passes for existing tests.
- New fixture tests pass against the TypeScript daemon/execution path.
- Golden fixtures cover at least:
  - direct user message to PM
  - project boot via kind `24000`
  - kind `1` boot via project `a` tag
  - delegation and delegation completion
  - p-tag ambiguity with shared agent across active projects
  - no-response completion
  - stop command
  - stream text delta
  - project-scoped config update
  - backend heartbeat and installed agent list
- Fixtures are stored in a stable location and reviewed as protocol artifacts.
- Every compatibility fixture has a classification owner. If Rust later differs
  from TypeScript, the disagreement must be recorded as one of:
  - TypeScript behavior intentionally preserved
  - TypeScript bug intentionally fixed with migration note
  - Rust bug
  - unsupported scenario

Interoperability gate:

- A fixture replay tool can tell whether a candidate Rust implementation routes,
  publishes, and writes files equivalently to TypeScript for the covered cases.
- Canonical serialization and signature fixtures can detect event-ID divergence
  before relay publishing is enabled.

Rollback:

- None needed. This milestone is test-only.

### M1: TypeScript Agent Worker Extraction

Goal: prove the existing agent execution path can run out of process without
starting the full TypeScript daemon runtime.

Scope:

- Add a Bun worker entrypoint for one execution session.
- Extract minimal bootstrap from `ProjectRuntime`.
- Add compatibility publisher that can still publish through current
  TypeScript event encoders.
- Add compatibility RAL bridge around existing `RALRegistry`.
- Add worker harness tests from TypeScript.
- Keep TypeScript daemon authoritative for routing and scheduling.
- Developer-only milestone. The framed protocol harness must be
  guarded so operators cannot accidentally enable it as the production worker
  protocol.

Current implementation status:

- Branch `rust-agent-worker-publishing` currently carries the worker recovery,
  diagnostics, admission-start, and message-flow slices that round out the
  worker supervision stack below the publish-outbox work.
- `crates/tenex-daemon/src/project_status_snapshot.rs` provides an owned
  project-status projection that can turn filesystem- or runtime-derived
  metadata into `ProjectStatusInputs` without a live TypeScript
  `ProjectContext`, while preserving backend encoder tag order in tests.
- `crates/tenex-daemon/src/agent_inventory.rs` scans the TypeScript agent
  storage layout under `$TENEX_BASE_DIR/agents`, skips `index.json` and
  non-JSON entries, defaults missing status to active, and feeds active agents
  into the installed-agent-list encoder by deriving pubkeys from stored
  `nsec` values when present and otherwise falling back to the filename pubkey
  as the disk identity.

- `src/agents/execution/worker/agent-worker.ts` exists and speaks the framed
  worker protocol.
- The entrypoint reports protocol metadata in `ready`, handles `ping`,
  `execute`, and `shutdown`, and exits cleanly after a bounded execution.
- `TENEX_AGENT_WORKER_ENGINE=mock` remains available as the deterministic
  protocol fixture engine.
- `TENEX_AGENT_WORKER_ENGINE=agent` now boots the real `AgentExecutor` path for
  initial RAL executions (`ralNumber: 1`) from filesystem-backed config,
  project metadata, agent storage, conversation state, and mock LLM provider
  config.
- The worker publisher bridge emits `stream_delta`, `publish_request`, terminal
  state, delegation registration, and tool completion protocol messages instead
  of requiring relay publishing from the ephemeral process.
- Shared Rust/TypeScript worker protocol validation now pins
  `publish_result` status/error semantics and `stream_delta` payload semantics:
  failed/timeout results require an error, accepted/published results reject an
  error, and stream deltas require exactly one inline delta or content reference
  with inline payloads capped by the shared byte limit.
- TypeScript child-process smoke coverage drives both the mock engine and the
  real executor engine over stdio, including tool-call persistence through the
  shared filesystem state.
- The Rust daemon crate can build the Bun worker command, spawn it, send a mock
  execution fixture, observe stream and terminal messages, and observe worker
  exit in an ignored integration test.
- The Rust daemon crate can also build a filesystem-backed mock-agent fixture,
  spawn the real TypeScript executor worker, observe tool-call and publish
  request frames, and verify the persisted conversation transcript and agent todo
  state in an ignored integration test.
- `crates/tenex-daemon/src/daemon_worker_runtime.rs` now has a fake runtime
  spine that proves queued dispatch, publish acceptance, and empty-queue
  admission against a fake spawner.
- The worker can seed a non-initial RAL from the execute frame, queue the
  triggering message as a RAL-scoped injection, hand the claim to
  `AgentExecutor`, and persist the continuation message under that RAL.
- The worker reports Telegram `no_response` turns as explicit protocol state:
  `silent_completion_requested`, `tool_call_completed`, and terminal
  `no_response` frames, with TypeScript and ignored Rust process coverage
  driving the real Bun executor over shared filesystem state.
- The worker reconstructs project agent membership from shared filesystem agent
  index state, can run real `delegate` tool calls to sibling agents, and reports
  terminal `waiting_for_delegation` frames containing pending delegation IDs.
- Worker bootstrap has injectable coverage proving MCP manager shutdown runs
  after executor failure, preserving the same `finally` path used for successful
  worker exits.
- `worker_recovery_apply.rs` reconciles durable worker state after partial
  transitions or crashes.
- `worker_diagnostics.rs` builds the worker diagnostics snapshot used for
  operator reads.
- `worker_dispatch_admission_start.rs` bridges worker admission to live spawn
  and started-worker bookkeeping.
- `worker_message_flow.rs` routes worker frames through message handling,
  publish flow, and terminal cleanup.
- `AgentDispatchService` now has a disabled-by-default `TENEX_AGENT_WORKER=1`
  route through `src/agents/execution/worker/dispatch-adapter.ts`. The gate is
  intentionally narrow: only fresh first-turn executions can run in a child
  worker. Active RALs, resumption claims, delegation completions, kill signals,
  and non-initial conversations still fall back to the in-process
  `AgentExecutor`.
- The TypeScript daemon can publish worker `publish_request` frames through
  `src/nostr/WorkerPublishRequestPublisher.ts`. Worker publish frames now carry
  complete agent-signed NIP-01 events. The parent bridge verifies the event
  hash, signature, and target-agent pubkey, then publishes the exact signed
  event without re-signing it.
- The Rust crate now has `crates/tenex-daemon/src/publish_outbox.rs`, which
  durably accepts worker-signed publish requests into
  `publish-outbox/pending/<event-id>.json`, verifies NIP-01 hash/signature and
  expected agent pubkey, and builds correlated
  `publish_result.status=accepted` frames.
- The same module now includes a deterministic drain state machine: accepted
  pending records are handed to a publisher interface as exact signed Nostr
  events and then moved into durable `published` or `failed` outbox directories
  with attempt metadata.
- Retryable failed attempts now include durable `nextAttemptAt` metadata and a
  Rust requeue scan can move due failed records back to `pending` without any
  in-memory retry queue. The requeued record keeps the original signed event and
  full attempt history.
- Outbox event IDs are globally idempotent across `pending`, `published`, and
  `failed`, and filesystem transitions create destination records without
  replacing existing files. Relay duplicate responses count as published;
  permanent relay rejection prefixes do not schedule retry.
- Rust publish-outbox diagnostics now summarize filesystem state without daemon
  memory: pending, published, failed, retryable, due-retry, permanent-failure,
  tmp-file, oldest pending, next retry, and latest failure fields. The
  diagnostic shape is versioned and pinned in the shared Bun/Rust
  publish-outbox compatibility fixture.
- Rust exposes a library-first publish-outbox maintenance pass that inspects
  before state, requeues due failed records, drains pending records through the
  publisher interface, and inspects after state. This is the canonical behavior
  for future startup hooks, periodic maintenance, and operator repair commands;
  its serializable report shape is pinned in the shared compatibility fixture.
- A thin internal `publish-outbox` Rust binary now exposes inspect/maintain JSON
  output over the same library API, with parse errors exiting distinctly from
  runtime errors. `doctor publish-outbox` calls this through an adapter rather
  than duplicating publish-outbox logic in TypeScript.
- `crates/tenex-daemon/src/relay_publisher.rs` provides the first Rust relay
  publisher implementation. It preserves the existing TypeScript default relay
  and `RELAYS` comma-list semantics, sends exact signed `["EVENT", event]`
  frames, parses relay `OK` responses, and is covered by local mock WebSocket
  relay tests.
- `worker_process.rs` now has an opt-in Rust-to-Bun publish interop gate that
  spawns the real Bun worker, accepts worker-signed `publish_request` frames
  into Rust's outbox, drains them through the Rust relay publisher, and verifies
  a local mock relay receives the exact signed events. The gate then feeds those
  same events to a TypeScript probe that verifies NIP-01 hash/signature,
  daemon classification, and `NostrInboundAdapter` normalization.
- The dispatch adapter mirrors `delegation_registered` frames into the parent
  `RALRegistry` and refreshes the parent in-memory `ConversationStore` from disk
  after the worker reaches a terminal frame.
- Focused TypeScript adapter tests now exercise the framed child-process path:
  spawn configuration, `execute` frame construction, parent-side
  `publish_request` handling, `publish_result` replies, terminal cleanup, and
  parent RAL waiting/delegation mirroring.
- Non-terminal worker failures after parent RAL seeding now clear the parent RAL
  and publish failures send a failed `publish_result` frame before the adapter
  surfaces the error.
- Remaining M1 hardening is to broaden the routing gate beyond fresh first-turn
  executions once injection, abort, and RAL resumption are protocol-backed.

Quality gates:

- Worker can execute a mock-provider conversation and exit cleanly.
- Worker can run a tool call and persist conversation state.
- Worker can delegate and report waiting state.
- Worker can handle no-response path and avoid emitting a visible completion.
- Worker shuts down MCP manager resources before exit, including executor
  failure paths.
- Worker publish requests include complete agent-signed NIP-01 events and
  TypeScript smoke coverage verifies both the emitted event IDs and signatures
  against `nostr-tools`.
- Parent-side publish validation rejects missing signed-event identity fields,
  wrong target pubkeys, signed-ID mismatches, and invalid signatures before Rust
  can rely on the bridge as an authoritative relay publisher.
- Parent-side adapter coverage verifies failed publishing reports
  `publish_result.status=failed` and does not orphan the seeded parent RAL.
- Rust publish outbox coverage verifies durable accepted records, idempotent
  duplicate accepts, target-agent mismatch rejection, mutated signed-event
  rejection, valid `publish_result.status=accepted` frames, exact signed-event
  handoff to the drain publisher, pending-to-published movement, and
  pending-to-failed movement.
- Rust relay publisher coverage verifies relay URL parsing/defaults, exact
  signed event WebSocket frames, relay rejection reporting without event
  mutation, and draining an outbox record through a local mock relay.
- The real Bun runtime spine gate is wired through
  `bun run test:rust:daemon:runtime-spine`, with the ignored-test filter kept
  in the quality-gates script so the main agent can rename the Rust test
  without touching the package alias.
- `TENEX_AGENT_WORKER` defaults off, and enabled routing records explicit skip
  reasons before falling back to the current in-process executor.
- Worker does not start project-wide daemon services such as project status
  loops, agent config watchers, or daemon-level monitors.
- Worker protocol version is visible in `ready` and logged by the parent.

Interoperability gate:

- Running the same fixture in-process and through the worker produces equivalent
  conversation records and equivalent Nostr event outputs.

Rollback:

- Disable worker execution flag and return to in-process `AgentExecutor`.

### M2: Stable Worker Protocol

Goal: freeze the Rust/TypeScript worker boundary before Rust dispatch depends
on it.

Scope:

- Define versioned protocol schemas.
- Move production protocol to length-prefixed JSON frames.
- Define batched stream delta behavior.
- Define frame size limits and file-reference behavior for large payloads.
- Define heartbeat, boot timeout, abort timeout, and force-kill behavior.
- Define `publish_request` and `publish_result`.
- Define the minimum transport-agnostic metadata, if any, that a
  `publish_request` needs beyond the signed Nostr event. Rust must derive
  Telegram or future native transport delivery from the accepted event,
  triggering envelope, agent configuration, and daemon-owned runtime state.
- Define publish request timeout behavior when the worker needs an event ID for
  threading.
- Define claim-token validation and idempotent transition semantics.
- Define injection lease/ack protocol.
- Define a reserved high-priority protocol lane or equivalent mechanism for
  terminal/error events so a full stream-delta queue cannot deadlock abort
  reporting.

Quality gates:

- Protocol schemas validate every worker message.
- Mock worker and mock daemon conformance tests pass.
- Backpressure tests prove critical events are never dropped.
- Large payload tests spill to file references instead of oversized frames.
- Duplicate transition messages are idempotent.
- Conflicting duplicate sequences are rejected.
- Publish-result timeout tests define whether execution retries, errors, or
  aborts.
- Backpressure tests prove terminal and error messages can still be delivered
  when low-priority queues are saturated.

Interoperability gate:

- A TypeScript worker built from the protocol can be driven by a mock Rust
  daemon without importing TypeScript daemon internals.

Rollback:

- Keep TypeScript daemon in-process execution as fallback.

### M3: Rust Daemon Skeleton

Goal: introduce Rust as an operator-visible daemon shell without processing
production events.

Scope:

- Implement Rust CLI flags equivalent to current daemon command.
- Implement config path loading compatible with `ConfigService`.
- Implement lockfile, status file, and restart state compatibility.
- Implement foreground/background lifecycle if Rust is launched directly.
- Implement signal handling.
- Implement status and stop interoperability.
- Add schema version and writer stamps to all new Rust-owned files from the
  first implementation.

Quality gates:

- Rust daemon starts and stops cleanly on macOS and Linux.
- `tenex daemon status` can read Rust daemon status.
- `tenex daemon stop` can stop Rust daemon.
- Lockfile prevents two daemon instances.
- Stale lock behavior matches TypeScript semantics.
- Restart state file round-trips with TypeScript.
- Rust refuses to start if it finds a newer unsupported schema version in a
  Rust-owned state file, unless an explicit repair/ignore flag is used.

Interoperability gate:

- Existing operator commands work unchanged or have a documented feature-flagged
  Rust equivalent.

Rollback:

- Launch TypeScript daemon instead of Rust daemon.

### M4: Rust Routing in Shadow Mode

Goal: run Rust event intake and routing beside TypeScript without taking action.

Scope:

- Connect to relays.
- Subscribe to static project/config/lesson events.
- Subscribe to known-project and agent-mention filters.
- Rebuild project and agent indexes.
- Implement active-project routing table.
- Source activation state needed for `shouldTraceEvent` and p-tag routing from
  restart state, additive Rust files, and TypeScript status where available.
- Port `shouldTraceEvent` and `determineTargetProject`.
- Log shadow decisions.
- Compare Rust decisions to TypeScript routing logs.

Quality gates:

- Rust routing fixture tests match TypeScript.
- Shadow mode runs against real relay traffic for a defined soak period.
- No unexplained route/drop disagreement remains in covered event classes.
- p-tag shared-agent ambiguity matches TypeScript.
- Project deletion/update behavior matches TypeScript.
- Any disagreement caused by missing active-project/RAL status is classified
  explicitly and tracked. M4 cannot become authoritative for that event class
  until the missing state source exists.
- Subscription reconnect tests cover `since` behavior so restarts do not lose or
  duplicate relay events unexpectedly.
- Backend sharding fixtures prove Rust observes but does not dispatch for
  projects/agents assigned to another backend.

Interoperability gate:

- Rust can observe real client traffic without publishing, dispatching, or
  changing files outside its additive shadow logs.

Rollback:

- Disable shadow mode.

### M5: Rust Worker Pool With TypeScript Publishing

Goal: Rust routes real events and starts Bun workers, while workers still use
existing TypeScript publishing.

Scope:

- Implement worker spawning and process-group cleanup.
- Implement worker pool and warm reuse.
- Implement dispatch queue with filesystem journal. The library contract stores
  typed records in `daemon/workers/dispatch-queue.jsonl` and replays the latest
  queued/leased/terminal state per dispatch id after sequence validation.
- Plan dispatch queue lifecycle records without side effects: queued records can
  be leased, leased records can complete, and queued or leased records can be
  cancelled. The planner preserves the existing queue schema and does not infer
  worker ownership.
- Assemble worker `execute` messages from leased dispatch queue/RAL data plus
  explicit caller-supplied runtime context. The helper validates the assembled
  message through the shared worker protocol rules, requires
  `triggeringEnvelope.message.nativeId` to match the queued triggering event,
  and does not read filesystem state or infer worker/process authority.
- Keep daemon-to-worker control frames centralized in the worker protocol
  module: `shutdown`, `publish_result`, and `ack` builders must validate their
  output against the shared protocol schema before callers frame or send them.
- Plan the lock-scoped worker launch seam without side effects: verify the
  leased dispatch identity matches the expected RAL identity, derive allocation
  and state lock scopes, and package the validated execute message without
  acquiring locks or spawning a worker process.
- Add the RAL lockfile helper before production wiring. It builds the documented
  `ral/locks/alloc.*.lock` and `ral/locks/state.*.lock` paths, uses the same
  `{ pid, hostname, startedAt }` JSON owner shape as `tenex.lock`, acquires via
  atomic create-new writes, fails closed on corrupt lock JSON, and treats stale
  replacement as an explicit PID-liveness decision rather than an age heuristic.
- Add the PID-liveness adapter as a small boundary above lock policy. Unix uses
  `kill(pid, 0)` semantics compatible with the TypeScript lockfile; unsupported
  platforms return `Unknown` so stale replacement fails closed.
- Compose launch plans with lock acquisition before worker-spawn wiring:
  acquire allocation then state locks for a planned launch, and release the
  allocation lock if the state lock is already held.
- Add a pure dispatch-to-spawn planner before process orchestration. It carries
  the Bun worker command and validated execute message as an immutable intent
  without starting a child process, waiting for readiness, or writing stdin.
- Add a trait-backed execution handoff that validates the planned execute
  message before spawning, then boots a worker and sends the execute frame
  through injected interfaces in unit tests and the real process adapter in
  production wiring.
- Add a worker-result adapter that validates Bun terminal result frames and
  converts them into Rust RAL transition inputs, while keeping worker protocol
  sequence/timestamp metadata separate from daemon journal authority.
- Add heartbeat snapshot/freshness planning. Rust validates heartbeat frames,
  records daemon-observed receipt time, and classifies missed heartbeats from
  that observation time instead of trusting worker clocks.
- Compose lock-scoped dispatch start by acquiring launch locks, starting the
  worker through the trait-backed execution handoff, and releasing locks on any
  validation, spawn, or execute-send failure.
- Add a worker-completion planner that consumes a validated worker result
  transition, uses scheduler state to validate claim/worker ownership, and
  returns the RAL journal record plus optional dispatch completion record
  without writing either file.
- Add a worker-completion apply boundary that appends the planned RAL journal
  and optional dispatch terminal records, then releases held launch locks after
  the planned filesystem side effects succeed.
- Add worker-message routing that validates worker-to-daemon frames and
  classifies them into heartbeat, terminal result, publish, stream, control, or
  boot-error handling actions without invoking downstream effects.
- Implement concurrency limits as side-effect-free admission planning over
  explicit active worker and dispatch snapshots.
- Implement worker heartbeat and abort behavior as planning layers first:
  heartbeat snapshots/freshness are daemon-observed, and abort planning returns
  graceful signal, wait, force-kill, or reconciliation actions without killing
  real processes.
- Add a worker publish acceptor that durably accepts a worker-signed
  `publish_request` into the Rust outbox and builds the accepted
  `publish_result` frame without relay publishing.
- Add publish-request runtime handling that routes a worker frame, accepts the
  signed event into the outbox, and sends the accepted `publish_result` through
  an injected worker session.
- Add dispatch admission planning that chooses the oldest queued dispatch that
  passes concurrency limits and returns the planned lease record without writing
  it.
- Add terminal-result runtime handling that routes terminal frames, plans the
  RAL transition and dispatch completion, appends the planned filesystem
  records, and releases held launch locks.
- Add an in-memory worker runtime-state snapshot for active workers, heartbeat
  updates, graceful signal markers, and conversion into concurrency and abort
  planning inputs.
- Keep TypeScript worker publishing directly for compatibility.
- Rust observes published event IDs and terminal state.
- Add JSONL truncation/replay tests for the dispatch queue immediately. The
  dispatch queue replay ignores only EOF-truncated final records and rejects
  corrupt non-final records, malformed complete final records, and
  non-increasing sequences instead of silently continuing.

Quality gates:

- Rust dispatches a mock-provider execution through Bun worker.
- Worker crash is contained and reported.
- Dispatch queue survives daemon restart.
- Queue overflow is operator-visible and never silently drops trusted events.
- Warm worker reuse passes compatibility checks.
- Cold and warm startup benchmarks are recorded.
- Cold and warm startup benchmarks are compared against pre-canary thresholds.
- Memory is reclaimed after worker exit.
- The Rust daemon can run with routing authority enabled while RAL and
  publishing authority remain disabled.

Interoperability gate:

- Existing web/iOS/Nostr clients see the same published events as they would
  from the TypeScript daemon for the enabled scenarios.

Rollback:

- Disable Rust dispatch and return to TypeScript daemon dispatch.

### M6: Filesystem-Backed Rust RAL Authority

Goal: make Rust the scheduler for executions it dispatches.

Scope:

- Implement RAL journal and snapshot.
- Implement RAL number allocation.
- Implement claim tokens.
- Derive scheduler state from RAL journal replay before wiring production
  dispatch. The library scheduler rejects duplicate active triggering events,
  validates active claim tokens, and treats completed/no-response/error/aborted/
  crashed RAL states as terminal.
- Plan worker terminal transition records only after validating the active claim
  token, active worker id, and journal sequence. The supported worker-emitted
  outcomes are completed, waiting-for-delegation, no-response, aborted, and
  error; crashed remains a reconciliation outcome.
- Bootstrap scheduler state from the on-disk journal and persist a versioned
  `ral/snapshot.json` compaction cache without letting a stale snapshot override
  journal replay.
- Plan dispatch preparation bundles without side effects: a RAL allocation
  journal record, a matching claim journal record with caller-supplied claim
  token, and a queued dispatch record. RAL journal and dispatch queue sequence
  spaces remain independent and are validated separately; this bundle does not
  grant worker execution authority until the dispatch is leased.
- Implement orphan reconciliation planning and recovery classification. The
  current Rust library planner is transient: it proposes `crashed` journal
  records for claimed RALs whose worker ids are absent from the live worker set,
  while leaving waiting and terminal RALs untouched.
- Implement injection lease/ack.
- Implement kill/abort/stop ownership.
- Teach TypeScript worker to refuse unseeded RAL creation in Rust-seeded mode.
- Rebuild parent wakeup indexes from filesystem state.
- Define rollback handoff: either Rust drains active RALs to terminal/waiting
  before returning authority to TypeScript, or TypeScript can read and honor the
  Rust RAL journal.

Quality gates:

- RAL state survives daemon restart.
- Duplicate event delivery cannot start duplicate workers.
- Parent wait and child completion wakeup works without live parent worker.
- Worker crash during stream is reconciled deterministically.
- Worker crash after injection lease does not lose injections.
- Stop command aborts the correct active worker/RAL.
- Multi-RAL conversations do not collide.
- Journal corruption tests fail closed or recover from truncated final record.
- Rollback tests cover in-flight state:
  - active streaming RAL
  - waiting-for-delegation RAL
  - leased but unapplied injection
  - queued dispatch entry
- ConversationStore concurrency tests cover two workers attempting to update the
  same transcript.
- Cross-backend delegation is either supported with relay-mediated wakeup tests
  or blocked with a clear dispatch error.

Interoperability gate:

- Conversation transcripts and runtime events produced under Rust RAL authority
  remain compatible with TypeScript readers and clients.

Rollback:

- Disable Rust RAL authority and return to TypeScript RAL compatibility mode.
  Rust must refuse to reuse partially corrupted RAL journal state without an
  explicit repair or rollback command.

### M7: Rust-Owned Relay Publishing

Goal: move relay publishing, durable acceptance, retry, and diagnostics to Rust
while preserving agent-side signing for agent-authored runtime events. This
milestone owns canonical Nostr relay publishing. Native transport delivery, such
as Telegram Bot API sends, is derived by Rust from accepted signed events and
drained by M8's Rust-native transport adapters.

Landed slices:

- `crates/tenex-daemon/src/backend_events/heartbeat.rs` — Rust encoder and
  schnorr signer for kind `24012` backend heartbeat, with NIP-01 self-conformance
  tests (event id equals `sha256(canonical_payload)`, signature verifies against
  the claimed xonly pubkey, ordered `p` tags, empty content, no self p-tag).
  Library-only; no daemon wiring.
- `crates/tenex-daemon/src/backend_heartbeat_latch.rs` — pure planner that
  replays owner-authored kind `14199` ProjectAgentSnapshot events and latches
  backend heartbeating off once the backend pubkey appears in any owner `p`
  tag. Library-only; no relay subscriptions or publish side effects.
- `crates/tenex-daemon/src/backend_events/project_status.rs` — Rust encoder and
  signer for kind `24010` project status, preserving the TypeScript-compatible
  client-visible content and tag ordering. Library-only; no daemon wiring.
- `crates/tenex-daemon/src/backend_events/installed_agent_list.rs` — Rust
  encoder and signer for kind `24011` installed-agent-list, preserving owner
  `p` tags and deterministic agent tags. Library-only; no daemon wiring.
- `crates/tenex-daemon/src/backend_events/operations_status.rs` — Rust encoder
  and signer for kind `24133` operations status, preserving TypeScript tag
  ordering (`e`, human `P`, active-agent `p`, project `a`) and cleanup events
  with no active-agent tags. Library-only; no daemon wiring.
- `crates/tenex-daemon/src/publish_outbox.rs` — filesystem-backed acceptance,
  idempotency, retry, diagnostics, maintenance, and relay-drain primitives for
  exact signed Nostr events, including worker-signed publish requests and
  backend-signed events with expected-publisher validation.
- `crates/tenex-daemon/src/publish_runtime.rs` — runtime-facing inspect,
  maintain, and backend-event enqueue wrappers over the publish outbox so
  backend-authored status/heartbeat encoders can enter the same durable publish
  path as worker-authored events.
- `crates/tenex-daemon/src/backend_event_publish.rs` — library-first
  orchestration helpers that encode backend-authored heartbeat, project
  status, installed-agent-list, and operations-status events, derive the
  backend publisher pubkey from the signer, and enqueue the signed events
  through the existing publish runtime without publishing to relays directly.
- `crates/tenex-daemon/src/backend_signer.rs` — reusable Rust implementation
  of the backend signer contract for the same raw 64-hex `tenexPrivateKey`
  value that TypeScript stores in global config, with private-key redaction in
  debug output.
- `crates/tenex-daemon/src/backend_config.rs` — filesystem-backed reader for
  `$TENEX_BASE_DIR/config.json`, exposing Rust-owned backend publishing inputs
  such as owner pubkeys, relay URLs with TypeScript-compatible defaults,
  backend profile metadata, project base, and a redacted signer constructor for
  `tenexPrivateKey`.
- `crates/tenex-daemon/src/backend_status_runtime.rs` — filesystem-backed
  orchestration slice that reads global config and installed-agent inventory,
  signs backend heartbeat and installed-agent-list events, and enqueues them
  into the durable Rust publish outbox without publishing directly to relays.
- `daemon-control backend-events-plan` — read-only diagnostics over publish
  outbox state plus backend status publisher readiness, including config,
  signer, relay, and installed-agent inventory availability without mutating
  outbox or relay state.
- `crates/tenex-daemon/src/operations_status_runtime.rs` — pure runtime
  projection from active worker heartbeat state into kind `24133`
  operations-status drafts, including transition-aware cleanup drafts with no
  active-agent `p` tags. Library-only; no periodic status publisher wiring.

Scope:

- Implement durable publish request/result handling in Rust.
- Persist accepted signed events before acknowledging the worker.
- Use filesystem records under `publish-outbox/pending/<event-id>.json` as the
  durable boundary between worker execution and relay publishing.
- Drain pending records through a publisher interface and move them to
  `publish-outbox/published/` or `publish-outbox/failed/` with attempt metadata.
- Record retry schedules on retryable failures and requeue due failed records
  from the filesystem on daemon startup or periodic maintenance.
- Use the same Rust maintenance API for daemon startup, periodic maintenance,
  and any future `doctor` repair command. Keep status/diagnostic reads
  read-only; `doctor publish-outbox` inspect/status commands are separate from
  mutating repair/drain commands.
- Keep the internal Rust binary a thin process boundary over the same library
  calls and JSON structs; compatibility fixtures remain the output contract.
- `doctor publish-outbox inspect/status` shells through the Rust adapter, emits
  only parsed JSON on success, and does not mutate `publish-outbox/` files.
- `doctor publish-outbox repair/drain` maps to Rust `maintain`, preserves Rust
  usage/runtime exit codes, and does not implement independent TypeScript
  publish-outbox state transitions.
- Preserve one global owner for each outbox event ID across pending, published,
  and failed states so duplicate worker publish requests cannot bypass retry
  timing or cause duplicate relay side effects.
- Publish exact worker-signed Nostr events without reconstructing or re-signing
  them.
- Add an initial Rust WebSocket relay publisher that can satisfy the outbox
  publisher interface.
- Verify NIP-01 hash, signature, and expected agent pubkey for every
  worker-signed event.
- Keep agent-authored runtime publisher methods encoded and signed by the
  worker unless a later milestone deliberately moves that specific signer:
  - complete
  - conversation
  - delegate
  - ask
  - delegate follow-up
  - error
  - lesson
  - tool use
  - stream text delta
- Port only Rust/backend-authored publish paths, such as project status,
  operations status, backend heartbeats, and any transport-specific
  control-plane events that cannot live in an ephemeral worker. Agent config
  update (kind `24020`) and agent delete (kind `24030`) are user-signed and
  are not backend-authored; Rust receives them but does not encode them. Kind
  `24001` is not part of this plan's compatibility surface.
- Add NIP-01 self-conformance tests for every event kind Rust encodes: the
  event id equals `sha256(canonical_payload)`, and the schnorr signature
  verifies against the canonical payload and backend pubkey.
- Add signer identity tests for backend-signed events.
- Add schnorr verification tests for worker-signed agent events and
  user-signed client events that Rust accepts into its publish path or uses
  for trust decisions.
- Add relay round-trip tests: publish with Rust, fetch and decode with the
  TypeScript subscriber path, and assert the decoded semantic shape matches
  the emitted event.
- Persist enough daemon-side publish context that enabling M8 does not require
  rerunning completed worker executions to derive transport delivery records.

Quality gates:

- Worker-signed agent events retain their original event ID and signature
  after Rust acceptance and relay publishing.
- Rust-encoded backend events are valid NIP-01: event id equals
  `sha256(canonical_payload)` and the schnorr signature verifies against the
  backend pubkey and canonical payload.
- Rust-encoded backend events carry the same client-visible kind, content
  shape, recipient `p` tags, and project `a` tags that clients observed from
  the TypeScript backend before the authority flip.
- Worker can block for publish result when it needs event IDs for threading, and
  Rust can return durable `accepted` before relay publication finishes.
- Stream text deltas preserve sequence behavior.
- Publish retries are bounded and idempotent where possible.
- Publish diagnostics can be rebuilt from the filesystem after restart and
  distinguish retryable failures, due retries, permanent failures, and orphaned
  temp files while exposing only compact request/event references.
- A maintenance pass can requeue due failed records and publish them in the same
  run, leave future retries untouched without calling the publisher, and remove
  stale duplicate failed records when the same event is already published.
- Maintenance report JSON remains stable across Bun and Rust compatibility
  tests before an operator CLI consumes it.
- No scenario publishes both a direct worker relay event and a Rust-relayed copy
  of the same event.
- Relay round-trip tests pass for every Rust-published event kind in scope.

Interoperability gate:

- Existing clients accept Rust-published events without code changes.
- A mixed environment with TypeScript and Rust backends does not duplicate
  events for the same execution.
- Run `TENEX_RUN_RUST_WORKER_INTEROP=1 bun run test:rust:daemon` to execute the
  worker interop gate after the standard fmt, test, and clippy checks.
- Run `TENEX_RUN_RUST_PUBLISH_INTEROP=1 bun run test:rust:daemon` to execute
  the publish interop gate after the standard fmt, test, and clippy checks.
- Run `TENEX_RUN_RUST_ALL_INTEROP=1 bun run test:rust:daemon` to execute both
  interop gates after the standard fmt, test, and clippy checks.
- `TENEX_RUN_RUST_INTEROP=1` remains a legacy alias for the publish interop
  gate.
- `TENEX_RUN_RUST_DAEMON_RUNTIME_SPINE=1` runs the real Bun daemon-worker
  runtime spine gate, and `bun run test:rust:daemon:runtime-spine` exposes the
  same invocation as a package script.
- The package script aliases `bun run test:rust:daemon:worker-interop`,
  `bun run test:rust:daemon:runtime-spine`,
  `bun run test:rust:daemon:publish-interop`, and
  `bun run test:rust:daemon:all-interop` set the corresponding env flags for
  convenience.

Rollback:

- Stop accepting new Rust publish requests, drain or repair the durable outbox,
  and rerun the execution after the publishing fault is corrected. Do not fall
  back to direct worker relay publishing for the same execution.

### M8: Long-Lived Services and Transport Adapters

Goal: remove reliance on TypeScript `ProjectRuntime` for always-on behavior.
Telegram's target implementation is Rust-native: Rust owns inbound gateway
lifecycle, outbound Bot API delivery, retries, native message diagnostics, and
transport delivery outbox state. TypeScript Telegram services remain useful as a
compatibility oracle while the Rust adapter reaches parity, but they are not the
target runtime path.

Landed slices:

- `crates/tenex-daemon/src/telegram_outbox.rs` — Rust-owned Telegram transport
  outbox with pending / delivered / failed / tmp states, deterministic record
  IDs, retryable-vs-permanent failure classification, requeue scan, diagnostics,
  and maintenance pass. Library-only; no Bot API HTTP client, no daemon wiring.
- `crates/tenex-daemon/src/caches/` — filesystem-backed caches for trust
  pubkeys, prefix lookups, and profile names under
  `$TENEX_BASE_DIR/daemon/caches/`, with atomic writes, schema-version and
  writer stamps, fail-closed reads on corruption or version mismatch, and
  per-cache diagnostics. Library-only; no daemon wiring.
- `daemon-control caches` — read-only JSON diagnostics over the filesystem
  caches: trust pubkeys, prefix lookup, and profile names.
- `crates/tenex-daemon/src/scheduler_wakeups.rs` — filesystem-backed scheduler
  wakeup records with pending/fired/failed/tmp states, retry classification,
  due-listing, cancellation, requeue scans, diagnostics, and maintenance
  reports. Library-only dispatch substrate; no long-lived wakeup service wiring.
- `daemon-control scheduler-wakeups` and `daemon-control
  scheduler-wakeups-maintain` — read-only diagnostics and maintenance report
  JSON over the scheduler wakeup filesystem state.
- `crates/tenex-daemon/src/skill_whitelist.rs` — filesystem-backed durable
  state for kind `4202` AgentSkill whitelist entries. Atomic snapshot write,
  fail-closed reads on schema mismatch / truncation, diagnostics. Adapter
  persistence only; no relay subscription or debounce loop.
- `crates/tenex-daemon/src/agent_definition_watcher.rs` — filesystem-backed
  durable state for observed kind `4199` agent-definition metadata (slug,
  tools, skills, mcp servers, created_at, last_observed_at). Atomic
  snapshot write, fail-closed reads, diagnostics. Observer state only; the
  orchestrator builds snapshots from verified signed events.
- `crates/tenex-daemon/src/periodic_tick.rs` — in-memory periodic scheduler
  primitive for the upcoming daemon main loop. `register_task` / `take_due`
  / `next_deadline_in`, catch-up collapsed so a single overdue task fires
  once with the next deadline anchored to `now`. No async runtime, no
  timers: callers pass `now` in seconds and sleep themselves. Targets the
  heartbeat / project-status / installed-agent-list / publish-outbox-drain
  / scheduler-wakeups tick loops.

Scope:

- Move project status publishing to Rust or a dedicated adapter. If M7 is
  enabled before this, M7 must provide an interim Rust-compatible status
  publisher so clients do not lose status.
- Move operations status to Rust or derive it from worker/RAL journal state. If
  only a compatibility subset is available, feature-gate it and document the
  exact missing fields.
- Implement the Rust-native Telegram gateway/adapter.
- Add a Rust-owned Telegram transport outbox under
  `$TENEX_BASE_DIR/daemon/transport-outbox/telegram/`, with pending, delivered,
  failed, and tmp states.
- Drain Telegram delivery records derived from accepted runtime events,
  preserving Nostr as the canonical event identity while recording Telegram
  native message IDs and delivery attempts.
- Preserve Telegram routing inputs from the transport-neutral inbound envelope:
  chat ID, message ID, thread/topic ID, sender identity, channel binding, and
  project binding.
- Port Telegram delivery semantics currently owned by TypeScript, including
  final replies, allowed conversation/reasoning mirroring, ask/error delivery,
  allowlisted tool publication mirroring, HTML/plain-text retry behavior, and
  reserved `telegram_voice` handling.
- Implement Telegram inbound update handling inside the Rust-native Telegram
  adapter, normalizing updates into the same `InboundEnvelope` contract before
  Rust dispatch.
- Decide and implement MCP notification strategy.
- Move scheduler wakeups to Rust.
- Move agent definition monitoring or isolate it as an adapter.
- Move skill whitelist hydration or isolate it as an adapter.
- Define filesystem-backed caches for trust pubkeys, prefix lookups, and
  profile names.

Quality gates:

- No always-on Bun daemon is required for Nostr project wakeups.
- Telegram behavior is supported by the Rust-native adapter for the enabled
  matrix or explicitly blocked before dispatch for unsupported Telegram
  scenarios.
- Telegram outbound delivery is durable and idempotent across daemon restarts.
- Telegram tests cover text replies, thread/topic replies, ask/error delivery,
  allowlisted tool publication mirroring, HTML fallback, voice-note delivery,
  delivery retry/failure states, and dedupe after replay.
- Telegram inbound tests cover DM, group, topic, project binding selection,
  allowlist rejection, backlog skipping, and normalized envelope construction.
- Scheduled tasks can wake projects and agents through Rust.
- Project status events remain client-compatible.
- Operations status is accurate enough for existing clients or the compatibility
  difference is explicitly documented and feature-gated.

Interoperability gate:

- Existing clients can discover projects, observe backend availability, send
  messages, receive replies, and observe status without a TypeScript daemon.

Rollback:

- Keep TypeScript daemon or specific TypeScript adapters for unsupported
  long-lived services.

### M9: Client Compatibility Canary

Goal: prove Rust mode with real clients before default cutover.

Scope:

- Run Rust daemon in a canary environment with existing web/iOS/Nostr clients.
- Use a test relay or controlled project set first.
- Enable increasingly broad scenarios:
  - project discovery
  - boot
  - direct PM reply
  - delegation
  - tools
  - stop command
  - scheduled task
  - restart during idle
  - restart during waiting delegation
- Record client-visible event streams.

Quality gates:

- No client code changes required.
- No unexplained missing replies.
- No duplicate completions.
- No duplicate stream deltas beyond current best-effort tolerance.
- No project status regressions.
- No stuck active RALs after canary restarts.
- Operator rollback tested at least once.
- Rollback is tested from non-idle states:
  - active streaming
  - waiting for delegation
  - leased injection
  - queued dispatch
- Cold/warm time-to-first-token is within the agreed threshold for:
  - no MCP
  - common MCP
  - expensive MCP marked as supported
- Cross-backend or sharded scenarios in the supported matrix pass canary checks.

Interoperability gate:

- The same clients can switch between TypeScript daemon and Rust daemon on the
  same filesystem state after clean shutdown.

Rollback:

- Stop Rust daemon, start TypeScript daemon, and verify clients recover without
  state repair.

### M10: Default Cutover

Goal: make Rust daemon the default control plane.

Scope:

- Make launch path default to Rust.
- Keep TypeScript daemon fallback for one release cycle.
- Update `MODULE_INVENTORY.md`, `docs/ARCHITECTURE.md`, README, and operator
  docs.
- Document unsupported features, if any.
- Add repair tools for RAL journal and worker state.
- Add release checklist for protocol fixtures.

Quality gates:

- All previous milestone gates remain green.
- Full test suite passes.
- Rust daemon has completed a canary soak without compatibility blockers.
- Rollback has been tested from the release candidate.
- Docs describe both default and fallback paths.

Interoperability gate:

- Rust daemon can participate in the same relay/project ecosystem as existing
  TENEX clients and any remaining TypeScript backends.

Rollback:

- Feature flag or command path starts TypeScript daemon fallback.

## Global Quality Gates

These gates apply to every milestone after M0.

### Contract Tests

- Nostr event golden tests pass for routing and decoding on every kind Rust
  observes.
- NIP-01 self-conformance tests pass for every kind Rust encodes: canonical
  payload, event id, and schnorr signature are internally consistent.
- Schnorr signature verification tests pass on worker-signed and user-signed
  events Rust accepts.
- Nested JSON `content` ordering tests pass for event kinds that use JSON
  content bodies and where clients depend on a specific ordering.
- Filesystem compatibility tests pass.
- Worker protocol schema tests pass.
- CLI compatibility tests pass for touched commands.

### Shadow and Replay

- New routing or publishing logic must run in shadow/replay mode before
  becoming authoritative.
- Any shadow mismatch must be classified:
  - TypeScript bug preserved intentionally
  - Rust bug to fix
  - deliberate behavior change requiring migration note
- Every mismatch classification must be recorded in the fixture metadata or a
  migration decision log, with an owner.

### Crash and Restart

- Every milestone that adds durable state must include crash/restart tests.
- Truncated final JSONL journal records must be tested.
- Stale lock recovery must be tested.

### Rollback

- Every authority handoff must have a tested repair or rollback path before it
  becomes the only production path.
- Rust must not write irreversible state before the corresponding rollback path
  exists.
- Routing, RAL, publishing, and status ownership can be repaired or rolled back
  separately while the migration is still pre-cutover.
- Rollback tests must include in-flight state, not only idle daemon state.

### Observability

- Every Rust-dispatched execution needs a correlation ID present in:
  - Rust logs
  - worker protocol messages
  - RAL journal entries
  - worker state files
  - relevant telemetry spans
- Operator-visible status must distinguish:
  - idle
  - queued
  - worker booting
  - streaming
  - tool active
  - waiting for delegation
  - aborting
  - crashed
  - journal failure
  - backend ownership conflict

### Backend Ownership

- Rust must not dispatch work outside its configured backend shard.
- Stop commands must only affect RALs owned by the local backend unless
  explicitly global.
- Mixed Rust/TypeScript backend canaries must cover delegated work across the
  supported backend boundary.
- If cross-backend delegation is unsupported, dispatch must reject it before any
  child work is published.

## Client Compatibility Strategy

### Golden Event Fixture Suite

Create a fixture suite that supplies realistic samples of every event kind
Rust observes so its routing, decoding, and verification paths are exercised
against stable inputs. For the subset of kinds Rust itself encodes, the same
suite additionally exercises Rust's encoder for NIP-01 self-consistency. The
suite is not a cross-language encoder parity contract: user-signed and
agent-signed kinds are encoded outside Rust entirely, and backend-signed
kinds are encoded by Rust alone once authority flips.

Fixture categories:

- project lifecycle
- conversation reply
- delegation
- delegation completion
- ask/escalation
- tool use
- stream text delta
- completion
- no-response completion
- error
- status
- stop command
- config update
- lesson

The normalized comparator should ignore:

- event ID
- signature
- created_at when not semantically fixed
- tag ordering only where clients do not rely on order

It must not ignore:

- kind
- content
- required tags
- p-tag recipients
- a-tag project binding
- e-tag/thread references
- delegation tags
- stream sequence
- transport metadata tags

Additional gates for kinds Rust encodes:

- canonical NIP-01 self-consistency: event id equals `sha256(canonical_payload)`
- signature validity against the backend pubkey
- backend signer identity preserved across the authority flip
- relay publish/fetch/decode round trip with TypeScript subscribers

### Client Replay Harness

Build a replay harness that can feed captured relay events into:

- TypeScript daemon
- Rust daemon in shadow mode
- Rust daemon in authoritative mode with mock workers

The harness should compare:

- routed project
- target agent
- boot decision
- published event sequence
- status file changes
- RAL journal changes
- conversation transcript changes
- backend owner/shard decision
- canonical event bytes for Rust-published events

### Real Client Canary

Before default cutover, run at least one canary with existing TENEX clients:

- web client
- iOS client if available
- CLI/operator flows
- Telegram if enabled in Rust mode or adapter mode

Canary success criteria:

- clients discover the Rust backend normally
- clients can boot a project
- clients can send a message and receive completion
- clients can observe streaming/status without schema changes
- clients can stop active work
- clients recover after daemon restart

### Mixed Backend Compatibility

Rust and TypeScript backends may coexist during rollout. The compatibility plan
must prevent duplicate handling:

- backend identity and heartbeat behavior must remain clear
- project activation and owner whitelist semantics must match
- only one backend should claim a local execution for the same RAL
- direct worker relay publishing must not coexist with Rust relay publishing for
  the same event type in the same execution
- cross-backend delegation must be in the supported matrix before it is allowed
- stop commands must be scoped so one backend does not kill another backend's
  local execution accidentally

## Deferred Scope

The following surfaces are explicitly **out of scope** for M0–M10. They are
tracked as follow-up work to begin only after the Rust daemon has reached
default cutover and the M0–M10 gates are green. Until then, these capabilities
remain TypeScript-owned and are not part of any compatibility, fixture, or
rollback gate in this plan. Adding them earlier is a scope change that requires
re-opening the milestone plan.

- **Encrypted config update — kind `25000` (NIP-44 v2).** Rust does not decrypt,
  route, re-emit, or store kind `25000` payloads. No NIP-44 v2 decryption
  vector is required by any milestone in this plan. If Rust observes a kind
  `25000` event in shadow or authoritative mode, it must treat the event as
  pass-through and leave handling to the TypeScript path.
- **Push notification transports (APNs, FCM, or equivalent).** No Rust-owned
  push delivery, push outbox, or device-token state is in scope. Any existing
  TypeScript push integration continues to run unchanged during the migration
  and is not considered part of the Rust compatibility surface.

Follow-up work, when opened, should reuse the same contract-and-fixture
discipline this plan uses for Nostr event kinds and transport outboxes:
canonical payload fixtures, decryption/delivery vectors, durable outbox
records, and rollback paths before authority transfers.

## Release Criteria

Rust daemon can become the default only when:

- all M0-M9 quality gates are green for the supported feature set
- no client-visible schema change is required
- rollback to TypeScript daemon has been tested on the same filesystem state
- rollback has been tested with active/waiting/queued execution state
- RAL journal repair or fail-closed tooling exists
- operator docs describe startup, status, stop, rollback, and known limitations
- unsupported transports or services are feature-gated and visible to operators
- NIP-01 self-conformance, schnorr signature, relay round-trip, and signer
  identity gates pass for every event kind Rust publishes (encoded or
  pass-through)

## First Implementation Slice

The first practical slice should be small and compatibility-heavy:

1. Add M0 fixtures and event normalizer.
2. Add canonical serialization, signature, signer identity, and backend
   sharding fixtures.
3. Extract the TypeScript worker and run it from the TypeScript daemon.
4. Define the worker protocol and conformance tests.
5. Build the Rust daemon skeleton for lock/status/stop only.
6. Add Rust routing shadow mode.

Do not start by dispatching real Rust-owned executions. The first objective is
to make equivalence measurable.
