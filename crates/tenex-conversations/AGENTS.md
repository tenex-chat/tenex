# tenex-conversations

Library crate. Owns all local conversation state for a TENEX project: materialized messages, tool messages, per-agent prompt history, per-agent context-management state, completion records, and the delegation tree. No daemon, no socket, no service in front.

Consumers — the Rust project runtime, agent runner, summarizer, and intervention watcher — all open the same SQLite file directly.

Canonical spec: `docs/plans/2026-04-28-tenex-conversations-library.md`

## Storage layout

```
~/.tenex/projects/<dTag>/conversation.db
```

Opened via `ConversationStore::open(path)` or `ConversationStore::open_in_memory()` (tests). `Project::open(project_id)` resolves the path from a dTag or NIP-33 coordinate.

## Critical invariants

- **Schema is the contract.** `schema::migrate()` runs at open time. All Rust consumers open the same file; mismatch on migration version is a startup error.
- **WAL mode + busy-timeout.** Multiple readers are unconstrained. Writers are serialized upstream by RAL.
- **Idempotent writes.** `append_message` is idempotent on `nostr_event_id` (partial unique index) and on `(conversation_id, record_id)`. `append_tool_message` is idempotent on `(conversation_id, tool_call_id)`.
- **`delegations` table is in v1 schema.** The runtime and intervention watcher use it to represent downstream delegation ownership and skip notifications while delegated work is still in flight.
- **No lessons.** Lessons are not in this database and must never be added.
- **Forward-only migrations.** Add new migrations; never alter or remove existing ones.

## Public API

`ConversationStore` — the single open handle per project:
- Read: `list_recent`, `get_conversation`, `root_author_pubkey`, `get_messages`, `get_tool_messages`, `get_prompt_history`, `get_context_state`, `list_completions`, `get_file_snapshots_for_agent`
- Write: `ensure_conversation`, `upsert_conversation`, `update_metadata`, `append_message`, `append_tool_message`, `append_prompt_history_entry`, `upsert_context_state`, `record_completion`, `record_file_snapshot`

`record_file_snapshot` upserts on `(conversation_id, agent_pubkey, file_path)` (last write wins): the `agent_file_snapshots` table (v3) captures the content of files an agent wrote via `fs_write`, so a later run of the same agent in the same conversation can diff against the current on-disk state. `file_path` is stored exactly as passed to `fs_write` (relative to the working dir); the reader re-resolves it the same way.

Key types re-exported from `lib.rs`: `MessageRecord`, `NewMessage`, `NewToolMessage`, `NewPromptHistoryEntry`, `FrozenPromptMessage`, `AgentContextState`, `Completion`, `NewCompletion`, `FileSnapshot`, `NewFileSnapshot`, `ConversationListFilter`, `MessageQuery`.

## How to approach changes

1. `cargo test -p tenex-conversations` before and after edits.
2. Schema changes go in `src/schema.rs` as a new migration entry — never modify existing SQL.
3. New model fields need a migration; add the column there, not just in the Rust struct.
4. Confirm every Rust consumer that opens `conversation.db` can tolerate the new migration before landing schema changes.
5. Do not add a service layer, daemon, or abstract storage backend. SQLite is the backend.

## Intentionally absent

- No daemon or socket.
- No ORM.
- No backwards-compatible JSON transcript fallback (migration from JSON is one-shot, run via `tenex doctor migrate`).
- No cross-host replication.
- No lessons, RAG vectors, or skills.
