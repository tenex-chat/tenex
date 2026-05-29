# Conversation ID Architecture

## Overview

A conversation ID is a **full 64-character hex Nostr event id** — the id of the
event that rooted the conversation. TENEX does not mint conversation ids; they
come from Nostr. They are stored and matched canonically, in full.

Conversation ids appear in two forms:

1. **Canonical IDs** (full 64-char hex) — used for all storage, lookup, and
   matching.
2. **Display IDs** (a short prefix) — used only when rendering to humans in tool
   output and logs.

The distinction is a **presentation concern, not a storage concern**. The data
layer always works with full ids; shortening happens at the point of display.

## Storage: a single `ConversationStore`

All conversation state for a project lives in one SQLite database,
`~/.tenex/projects/<dTag>/conversation.db`, owned by the **`tenex-conversations`**
crate. Every consumer — the project runtime, the agent runner, the summarizer,
the intervention watcher, conversation tools — opens that same file through
`ConversationStore`. There is no separate "catalog" database and no read-model
service in front of the store: read methods on `ConversationStore` serve all
consumers directly.

The `conversations.id` column is the full hex id (a `TEXT PRIMARY KEY`). The
store never truncates ids. Returning a shortened id from a read method would
break matching, deduplication, delegation-chain reconstruction, and migration.

> Historical note: the previous TypeScript runtime split this into a canonical
> `ConversationStore` plus a derived `ConversationCatalogService` over a separate
> `conversation-catalog.db`, with a `ConversationPresenter` formatting layer.
> Those types do not exist in the Rust system; the four-store TypeScript layout
> was consolidated into the single `conversation.db` by a one-time migration
> (`tenex-conversations`'s `migration` module).

## Display: shortening at the edge

Shortening is applied by each consumer when it renders ids for humans, never by
the store. The conventions in the current code:

- The **host CLI** (`tenex` binary) has a shared `shorten_event_id` helper
  (`tenex/src/utils/identifiers.rs`) that takes a 10-character prefix of a hex
  event id. Telegram-style ids (prefixed `tg_`) are hashed before truncation so
  they stay opaque and fixed-length.
- The **`conversation_get`** agent tool shortens to a 10-character prefix and
  resolves collisions when several ids share a prefix in the same view.
- The **`conversation_list`** agent tool shortens to an 8-character prefix for
  its line-formatted output.
- The **`conversation_search`** tool returns full ids to its caller; it does not
  shorten.

There is intentionally **no single library-level `shorten_conversation_id`
function**: a conversation id *is* a Nostr event id, so display shortening is the
same operation as event-id shortening, and it lives with the consumer that owns
the rendering (the host binary's helper, or the tool's own formatter).

## Rules

1. **Never shorten at the storage layer.** `ConversationStore` returns full
   canonical ids. Shorten only when producing human-facing output.
2. **Treat a conversation id as a Nostr event id.** Reuse the host's
   `shorten_event_id` helper rather than re-implementing truncation, so special
   cases (e.g. Telegram ids) stay consistent.
3. **Keep the full id reachable.** A view that displays a short id must retain
   the full id for any subsequent lookup.
4. **Document deliberate prefix lengths.** Tools that pick a non-standard prefix
   length (e.g. `conversation_list`'s 8 chars) should say why.

## Related

- `crates/tenex-conversations/AGENTS.md` — store invariants and the single-file contract.
- `docs/internals/conversation-metadata-generation.md` — how metadata is generated for conversations.
- `docs/CONVERSATION_INDEXING.md` — conversation indexing for RAG.
