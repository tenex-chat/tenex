# `tenex-conversations` — Product Spec

## Purpose

A single library, in two language bindings, that owns *all* local conversation state for a TENEX project. One SQLite database per project, schema-as-contract, opened directly by every process that needs it.

It is the cache-and-augmentation layer on top of the canonical Nostr thread: it holds what's on relays plus what only matters locally (tool results, per-agent prompt history, context-management state, completion timestamps).

## What it owns

- **Materialized messages** — every conversation message, whether ingested from Nostr or originated locally, in one table.
- **Tool messages** — tool calls and their results, large bodies included.
- **Per-agent prompt-history** — the frozen prompt-projection rows that drive replay and prompt caching.
- **Per-agent context-management state** — compactions, decay state, reminder overlays.
- **Completion + delegation metadata** — who completed, when, against what root, what's still pending.
- **Conversation catalog rows** — title, preview, participants, last-activity, embedding-index pointers.

## What it does *not* own

- Nostr publishing, signing, relay state — that's the relay-mux + signer.
- Agent definitions, project metadata, user config — those stay in their existing stores.
- RAG vectors, lessons, skills — separate concerns, separate stores.
- Cross-host replication — out of scope. If you need that, publish to Nostr.

## Consumers

| Consumer | Access |
|----------|--------|
| Bun project runtime (orchestrator, dispatch, supervision) | Read-write |
| Agent runner (Rust, long-lived per session) | Read-write during its turn |
| Intervention watcher (Rust daemon) | Read-only |
| Conversation tools (search, lookup, formatters) | Read-only |
| Future Rust orchestrator | Read-write (transparent swap) |

All consumers open the same file. No service in front.

## Storage

- **One SQLite file per project**, at `~/.tenex/projects/<dTag>/conversation.db`.
- **WAL mode** + busy-timeout. Multi-reader / single-writer concurrency is the SQLite default for this configuration; that matches the actual access pattern (RAL already serializes turns).
- **Schema is the contract.** Versioned migrations in one place. Both bindings target the same migration version; mismatch is a startup error.
- **No JSON-transcript fallback.** The DB is canonical. Migration from the current dual-format runs once, idempotent.

## Data model (high-level)

Roughly six tables, all keyed on `conversation_id` (the Nostr root event ID):

- `conversations` — metadata, title, preview, last-activity, owner pubkey.
- `messages` — every message, ordered, with `nostr_event_id` nullable (locally-originated rows have it null until published).
- `tool_messages` — tool call + result pairs, blob-typed body, linked to a parent message.
- `agent_prompt_history` — per-agent frozen prompt rows; the replay timeline.
- `agent_context_state` — per-agent compaction / decay / reminder bookkeeping; one row per agent per conversation.
- `completions` — terminal events with status, recipient, root linkage; drives intervention and delegation.
- `delegations` — pending and resolved delegation tree state. Keyed on `delegation_event_id`. Columns: `conversation_id`, `delegating_agent_pubkey`, `delegated_to_pubkey`, `status` (`pending` | `completed` | `failed` | `cancelled`), `completion_event_id` (nullable), `created_at`, `resolved_at` (nullable). Owned by the future Rust runtime orchestrator; consumed by intervention to skip notifications when an agent has pending downstream delegations.

Foreign keys are on. Cascades are conservative — a conversation delete is rare and explicit.

## API surface

The library exposes a small typed API per binding. Not a sea of methods — each consumer uses a slice:

**Read API** (used by everyone)
- Fetch conversation by ID, by participant, by recency.
- Fetch messages for a conversation, with optional agent-filter and pagination.
- Fetch a per-agent prompt-history slice for replay.
- Query completion state for intervention.

**Write API** (used by orchestrator + agent runner)
- Append a message (idempotent on `nostr_event_id` when present).
- Record a tool call / tool result.
- Write a prompt-history entry, snapshot context-management state.
- Record a completion.

**Maintenance API** (used by `doctor` and migrations)
- Run pending schema migrations.
- Vacuum, integrity-check, export.

The two bindings expose the *same* operations under language-idiomatic names. The schema enforces correctness; the binding is a thin typed wrapper.

## Concurrency model

- WAL gives unlimited concurrent readers + one writer.
- Writers are already serialized by RAL at the orchestration layer — the SQLite write-lock is a backstop, not the primary coordination mechanism.
- Long-running readers (intervention watcher, search tools) never block writers.
- No advisory locking, no leader election, no IPC.

## Migration story

- One migration runner, versioned schema, both bindings link the same SQL.
- One-time data migration from current `ConversationStore` JSON transcripts + `ToolMessageStorage` files + the existing catalog DB into the consolidated DB. Run via `doctor migrate`. Old files archived, not deleted, on first run.
- Forward-only migrations after that. No backwards-compat layer.

## Language bindings

- **Rust crate** (`tenex-conversations`): used by the agent runner, intervention watcher, future orchestrator. Built on `rusqlite` + `serde`.
- **TypeScript binding**: used by the Bun runtime. Built on `bun:sqlite`. Same API shape, same migration version, same schema.
- The schema and migration SQL live in one place (likely the Rust crate), and the TS binding either reads them at build time or vendors a generated copy. Either way: one source of truth.

## Non-goals

- No daemon, no socket, no service in front.
- No cross-host replication.
- No backwards-compatibility with JSON transcripts after migration.
- No "abstract storage interface" with multiple backends. SQLite is the backend.
- No ORM. The schema is the contract; the bindings are typed query wrappers.

## Success criteria

- Bun and Rust agent processes both write to the same file in the same conversation without coordination beyond what RAL already does.
- A new Rust process (intervention watcher, future orchestrator) needs zero new infrastructure to read state — just `open(path)`.
- Migrating from the current four-store layout produces a single file with no data loss, and the four old stores are deleted from the codebase in the same PR that lands the migration.
- The data model is small enough that a contributor can read the schema and understand the system in an afternoon.
