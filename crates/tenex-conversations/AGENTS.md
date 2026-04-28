# tenex-conversations

Library crate. Owns all local conversation state for a TENEX project: materialized messages, tool messages, per-agent prompt history, per-agent context-management state, completion records, and the delegation tree. No daemon, no socket, no service in front.

Consumers — bun runtime, Rust agent runner, intervention watcher, future Rust orchestrator — all open the same SQLite file directly.

Canonical spec: `docs/plans/2026-04-28-tenex-conversations-library.md`

## Storage layout

```
~/.tenex/projects/<dTag>/conversation.db
```

Opened via `ConversationStore::open(path)` or `ConversationStore::open_in_memory()` (tests). `Project::open(project_id)` resolves the path from a dTag or NIP-33 coordinate.

## Critical invariants

- **Schema is the contract.** `schema::migrate()` runs at open time. Both bun (TS binding) and Rust open the same file; mismatch on migration version is a startup error.
- **WAL mode + busy-timeout.** Multiple readers are unconstrained. Writers are serialized upstream by RAL.
- **Idempotent writes.** `append_message` is idempotent on `nostr_event_id` (partial unique index) and on `(conversation_id, record_id)`. `append_tool_message` is idempotent on `(conversation_id, tool_call_id)`.
- **`delegations` table is in v1 schema.** The Rust runtime orchestrator does not exist yet, but the table is present because `tenex-intervention` will read it to skip notifications for agents with pending downstream delegations.
- **No lessons.** Lessons are not in this database and must never be added.
- **Forward-only migrations.** Add new migrations; never alter or remove existing ones.

## Public API

`ConversationStore` — the single open handle per project:
- Read: `list_recent`, `get_conversation`, `get_messages`, `get_tool_messages`, `get_prompt_history`, `get_context_state`, `list_completions`
- Write: `ensure_conversation`, `upsert_conversation`, `append_message`, `append_tool_message`, `append_prompt_history_entry`, `upsert_context_state`, `record_completion`

Key types re-exported from `lib.rs`: `MessageRecord`, `NewMessage`, `NewToolMessage`, `NewPromptHistoryEntry`, `FrozenPromptMessage`, `AgentContextState`, `Completion`, `NewCompletion`, `ConversationListFilter`, `MessageQuery`.

## How to approach changes

1. `cargo test -p tenex-conversations` before and after edits.
2. Schema changes go in `src/schema.rs` as a new migration entry — never modify existing SQL.
3. New model fields need a migration; add the column there, not just in the Rust struct.
4. The TypeScript binding targets the same migration version. Confirm TS-side compatibility before landing schema changes.
5. Do not add a service layer, daemon, or abstract storage backend. SQLite is the backend.

## Intentionally absent

- No daemon or socket.
- No ORM.
- No backwards-compatible JSON transcript fallback (migration from JSON is one-shot, run via `tenex doctor migrate`).
- No cross-host replication.
- No lessons, RAG vectors, or skills.
