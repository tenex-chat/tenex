# Conversation Indexing

TENEX embeds conversation transcripts so they are searchable by semantic
similarity (RAG). Indexing is performed by a standalone daemon, **`tenex-embedder`**,
backed by the **`tenex-rag`** storage layer.

## How It Works

- **Source of truth is Nostr.** The embedder reads kind:1 events from the
  configured relays, filtered to the projects owned by the host (derived from
  `tenexPrivateKey` plus the project `event.json` files). It does **not** read
  the local `conversation.db`.
- **Standalone daemon, not an in-runtime job.** `tenex-embedder` runs as a host
  companion process and scans on a short interval (every 30 seconds), walking
  bounded windows of relay history from a persisted cursor.
- **Change detection.** Per conversation it tracks the event count and the
  newest `created_at`; an unchanged conversation is skipped. When a conversation
  has advanced, its transcript is re-chunked and only chunks whose content hash
  changed are re-embedded.
- **Full transcript.** It embeds the conversation transcript, not just metadata.
- **Project scoping.** Chunks are tagged with their project id(s) so search can
  filter to a project.

## Storage

- Embeddings live in a global SQLite store at `~/.tenex/embeddings.db`
  (vector-enabled), owned by `tenex-rag`.
- The embedder keeps its own bookkeeping under `~/.tenex/.embedder/`: per-
  conversation state (`state.db`) and the relay-walk cursor (`cursor.db`).

## Chunking

Transcripts are chunked with message-aligned windows: a target size around
6,000 characters (~1,500 tokens for `text-embedding-3-small`), a hard ceiling
above which a single message is truncated, and a few trailing messages of
overlap carried into the next chunk for continuity. Each chunk carries a SHA-256
content hash used for change detection, plus metadata (conversation id, project
id(s), chunk index, sequence range, timestamps).

## CLI

The daemon handles indexing automatically. For manual operations:

```bash
# One-shot backfill of a single project's conversations from the relays
tenex doctor conversations backfill <project> [--since <unix-secs>]

# The embedder's own backfill (bulk pass), with reset / window / dry-run
tenex-embedder backfill [--since <unix-secs>] [--reset] [--dry-run]
```

`--reset` re-embeds even unchanged chunks (use it after changing the embedding
provider or model). `tenex doctor conversations status` and `… reindex` exist as
diagnostics but are limited; the backfill commands above are the wired path.

Configure the embedding provider/model with:

```bash
tenex config embed
```

## Search Tools (agents)

- **`conversation_search`** — semantic search over the shared `conversations`
  collection. Defaults to the current project; pass `project_id: "ALL"` to search
  across all projects. Returns score, content, title, conversation id, and
  project id.
- **`rag_search`** — unified semantic search across the `conversations`
  collection, the project knowledge base (`project_<id>`), and the agent's own
  notes (`agent_<pubkey>`). If a `prompt` is supplied, it additionally runs an
  LLM pass to extract a focused answer from the matches.
- **`rag_add_documents`** — adds documents by audience scope: `self` →
  `agent_<pubkey>`, `project` → `project_<id>`. Agents add documents by scope;
  they do not create, list, or delete collections.

## Troubleshooting

**Nothing appears in search.** Confirm the `tenex-embedder` daemon is running and
that the relays hold the conversation events (the embedder reads from relays, not
local disk). Run a backfill for the project:
`tenex doctor conversations backfill <project>`.

**Results look stale after changing models.** Re-embed everything with
`tenex-embedder backfill --reset`.

**Embedding provider errors.** Check the provider configuration and API keys via
`tenex config embed` / `tenex config providers`, and confirm network access to
the provider.

## Where to look

- `crates/tenex-embedder/` (`scope.rs`, `backfill.rs`, `cursor.rs`, `processor.rs`, `chunking.rs`, `state.rs`, `scheduler.rs`, `tuning.rs`; `lib.rs` documents the relay-source design).
- `crates/tenex-rag/` (`sqlite_store.rs`, `store.rs`, `rag.rs`).
- `crates/tenex-agent/src/tools/conversation_search.rs`, `rag_search.rs`, `rag_add_documents.rs`.
