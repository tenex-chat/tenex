# TENEX Architecture Guide

TENEX is a multi-agent AI coordination system built on Nostr. It is a **Rust
workspace**: a set of focused crates that decompose the system into libraries,
daemons, and one-shot binaries, plus the `tenex` host CLI/supervisor.

This document is the human-readable orientation. Two companion documents are
authoritative and should be kept in sync with it:

- **`crates/AGENTS.md`** — the modularization philosophy and the non-negotiable
  rules for adding, splitting, or merging crates.
- **`MODULE_INVENTORY.md`** — the canonical map of every crate and its internal
  modules. Consult it before writing code.

Related notes:

- `docs/system-prompt-architecture.md` — how an agent's system prompt is assembled.
- `docs/CONTEXT-MANAGEMENT-AND-REMINDERS.md` — request-time context management, reminders, prompt-history overlays.
- `docs/SUPERVISION.md` — supervision heuristics, post-completion gating, retry semantics.
- `docs/plans/2026-04-28-architecture-map.md` — the migration map and target end state.

---

## Core Principles

### 1. One crate, one thing
Each crate does a single job: a storage layer, a projection, a subsystem of the
host daemon, or a one-shot binary. Not a kitchen sink. New behavior extends the
crate that already owns the concern; it does not accrete into an unrelated one.

### 2. Composition through narrow contracts
Crates compose through explicit contracts, never through inheritance or shared
globals. Two contracts dominate the tree:

- **Storage contract by substrate.** SQLite-backed crates expose a typed Rust
  API over a versioned, forward-only schema. JSON-backed crates expose typed
  APIs over a documented file layout. Multiple processes open the same durable
  state directly — there is no service in front and no IPC layer for storage.
- **NDJSON over Unix sockets** (and over stdio for one-shots) is the canonical
  local IPC. The same frame format applies whether the peer is a subprocess or
  a long-lived daemon. `tenex-agent` already speaks NDJSON over stdio.

Typed APIs within a process; text streams between processes.

### 3. Three roles, kept separate
Anything that touches relays + LLM + tools must keep these apart:

- **Subscribe** — owns the relay connection.
- **Orchestrate** — owns dispatch, RAL state, and the delegation tree.
- **Execute** — owns the LLM loop and tools (`tenex-agent`).

The runner does not open relays. The orchestrator does not call LLMs. The
subscriber does not track delegations. Collapsing these is the single biggest
design failure mode in this codebase.

### 4. Crash and restart are normal
State lives on disk. In-memory caches are caches, not the truth. Every process
must survive being killed and restarted from SQLite or filesystem state.

---

## Workspace Shape

The host CLI/supervisor lives in `tenex/` (package `tenex`). Everything else is
a crate under `crates/`. See `MODULE_INVENTORY.md` for the authoritative list;
the roles below are a summary.

### Library crates (no daemon — just typed APIs)

| Crate | Owns |
|---|---|
| `tenex-conversations` | SQLite conversation store: messages, tool messages, prompt history, completions, delegations, context state, and migration from older disk formats. |
| `tenex-agent-registry` | JSON-backed global installed-agent registry under `<base_dir>/agents`: document normalization, mutation, keys, index maintenance. |
| `tenex-project` | Read-side project view over project event JSON and agent JSON: id normalization, membership projection, teams, signer selection. |
| `tenex-context` | Conversation-history → LLM-message projection: message shaping, token estimates, cache-breakpoint hints, context-management turn recording. |
| `tenex-system-prompt` | Deterministic system-prompt assembly from agent identity, project context, and skill references. |
| `tenex-identity` | `pubkey → IdentityView` resolution via kind:0 plus a host-wide cache. |
| `tenex-llm-config` | Filesystem-backed LLM/provider configuration resolver, including meta/inline model resolution and API-key health. |
| `tenex-mcp` | Project-scoped MCP server lifecycle, tool manifests, and the runtime↔agent Unix-socket bridge. |
| `tenex-rag` | RAG configuration, embeddings, and SQLite-backed vector/document storage. |
| `tenex-protocol` | Transport-agnostic TENEX intent vocabulary and Nostr channel encoding. |
| `tenex-supervision` | Pure supervision heuristics for the agent runner: no I/O, no async. |
| `tenex-whitelist` | Local trust-set reader for whitelisted users and project p-tags. |
| `tenex-telemetry` | Shared OpenTelemetry/`tracing` bootstrap and context propagation. |
| `tenex-accounting` | SQLite-backed LLM accounting/observability store plus an embedded local UI. |

### Daemons (long-lived)

| Daemon | Owns |
|---|---|
| `tenex daemon` (supervisor) | Boots and supervises project runtimes and host companion daemons on inbound events. |
| `tenex-summarizer` | Generates kind:513 conversation metadata across projects. |
| `tenex-embedder` | Reads kind:1 events from the relays for the host's owned projects and embeds the conversation transcripts into the global RAG store (`embeddings.db`). |
| `tenex-scheduler` | Schedule/cron firing for scheduled and one-off tasks. |
| `tenex-intervention` | Human-replica review when an agent completion times out. |
| `tenex-identity` | Resolves and caches kind:0 profile data host-wide. |
| `tenex-telegram` | Telegram integration: bot client, bindings, polling, rendering, event synthesis. |

### One-shot / pure-compute binaries

| Binary | Owns |
|---|---|
| `tenex-agent` | Single-turn agent runner. Reads one Nostr event over stdin, runs the LLM/tool loop, emits signed NDJSON frames over stdout. **Does not open relays.** |
| `tenex whitelist check` | Single trust check from the shell. |
| `tenex doctor` | Diagnostics and one-time migration/repair workflows. |

---

## Library vs Daemon — the decision rule

Process boundaries cost something. Take one only when you get at least one of:
concurrency isolation, security isolation, language choice, independent restart,
or hot-swap. Otherwise it is a library, not a daemon.

| Want | Make it a… |
|---|---|
| Typed state shared across processes | Library + SQLite (`tenex-conversations`) |
| Global installed-agent JSON shared across processes | Library + JSON files (`tenex-agent-registry`) |
| Read-side project metadata and membership | Library + JSON files (`tenex-project`) |
| LLM-bound or stateful work that should survive runtime restarts | Daemon (`tenex-summarizer`, `tenex-scheduler`, `tenex-intervention`) |
| Pure compute reachable over a frame protocol | One-shot or long-lived binary (`tenex-agent`) |

A daemon's public surface is a Unix socket speaking NDJSON. A library's public
surface is a typed Rust API over its substrate. Pick one; never both.

---

## Cross-Cutting Contracts

These hold across every crate. Violations are bugs.

- **Project IDs accept either form.** Public APIs that take a project identifier
  accept the full NIP-33 coordinate (`31933:<pubkey>:<dTag>`) or the bare dTag.
  Normalize once at the boundary, with the owning crate (`tenex-project` /
  `tenex-conversations`) — not repeatedly at call sites.
- **Schema or file layout is the contract.** SQLite migrations are forward-only
  and versioned, and belong only to the crate that owns the database. JSON
  file-layout changes belong only to the crate that owns that directory.
- **Signing is behind the `Signer` trait.** One implementation today (`nsec:`),
  one tomorrow (`bunker:` / NIP-46). A single swap when the bunker lands.
- **MCP is project-scoped.** Server definitions live in the project working
  directory's `.mcp.json`; agent JSON grants access. There is no host-global
  MCP server registry, and MCP discovery/runtime belongs in `tenex-mcp`.
- **Agent execution belongs in `tenex-agent`.** Relay subscription and runtime
  orchestration belong outside the agent runner.
- **Prompt assembly belongs in `tenex-system-prompt`; message-stream projection
  belongs in `tenex-context`.**
- **RAG: agents add documents by audience scope only.** Do not add
  collection-management tools back into the agent surface.
- **Lessons are not in the storage crates.** They are out of scope for
  `tenex-project`, `tenex-agent-registry`, and `tenex-conversations`.

---

## Naming Conventions

| Thing | Convention | Example |
|---|---|---|
| Crates | `tenex-<area>`, kebab-case | `tenex-conversations` |
| Crate package name | matches the directory | `tenex-conversations` |
| Modules / files | snake_case `.rs` | `schema.rs`, `store.rs` |
| Types | `CamelCase` | `ConversationStore`, `IdentityView` |
| Functions / fields | snake_case | `list_candidates`, `last_activity` |
| Tests | `#[cfg(test)]` modules or `tests/*.rs` | `tests/discover_and_read.rs` |

Each crate carries an `AGENTS.md` describing its local invariants. Read it
before changing that crate.

---

## Dependencies

- Crate dependencies are declared in each crate's `Cargo.toml` and the workspace
  `Cargo.toml`. Keep the dependency graph acyclic and minimal.
- The whole tree is **Rust-only**. There are no `bun`/TypeScript imports.
  Cross-language state sharing, where it still exists during migration, happens
  only through the shared SQLite schemas or JSON file layouts on disk — never
  through code imports.
- Pure, no-I/O logic (e.g. supervision heuristics in `tenex-supervision`) stays
  free of async and workspace dependencies so it can be unit-tested in isolation.

---

## Before Writing Code

Three questions, in order (from `crates/AGENTS.md`):

1. **Does an existing crate already own this concern?** If yes, extend it.
2. **Is this a new role in the fleet, or a new instance of an existing role?**
   New role → new crate. New instance → the existing home for that role.
3. **Library or daemon?** Apply the decision rule above. If undecided, it is a
   library.

If all three point to "yes, new crate," update both
`docs/plans/2026-04-28-architecture-map.md` and the workspace `Cargo.toml` in
the same change, and add the crate's `AGENTS.md`.

---

## Anti-Patterns to Reject

- **Collapsing the three roles.** A runner that opens relays, or an orchestrator
  that calls an LLM, breaks the fleet model.
- **A daemon that also exposes a typed storage API**, or a library that also
  runs a socket. Pick one public surface.
- **Re-normalizing project IDs at every call site** instead of once at the
  owning crate's boundary.
- **Sentinel values that mask failure.** `"unknown"`, `String::new()`, `0`, or
  `unwrap_or(None)` on a `Result<Option<T>>` silently convert errors into
  "not found". Represent absence with `Option`; propagate or log-and-bail on
  failure.
- **Backwards-compatibility shims past a single bounded cutover.** No `_unused`
  prefixes, no commented-out blocks, no "temporary" code.

---

## Discipline

- **Simplicity over complexity, every time.** An abstraction earns its place by
  serving two or more concrete consumers — never one, never speculative.
- **Repetition is a hard boundary.** Three similar lines is fine; the third copy
  of a real pattern is a refactor, not optional.
- **Zero accumulation of technical debt.** If the right fix is hard, do the hard
  thing. Speed is not a value here; coherence is.
- **Boy Scout Rule.** Leave every file better than you found it — fix the stale
  comment or off-pattern name nearby, without widening scope into a refactor PR.

---

## See Also
- [crates/AGENTS.md](../crates/AGENTS.md) — modularization philosophy and rules.
- [MODULE_INVENTORY.md](../MODULE_INVENTORY.md) — canonical crate and module map.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — development workflow.
- [docs/plans/2026-04-28-architecture-map.md](./plans/2026-04-28-architecture-map.md) — migration map and target end state.
