---
title: "Conversation Metadata Generation"
date: "2026-04-29"
audience: "llms"
scope: "How the current Rust tenex-summarizer daemon generates title, summary, status, category, and kind:513 metadata for conversations, including the legacy TypeScript behavior it replaced."
status: "investigated"
related_docs:
  - "docs/plans/2026-04-28-tenex-summarizer.md"
  - "docs/CONVERSATION-ID-ARCHITECTURE.md"
  - "docs/CONVERSATION_INDEXING.md"
  - "docs/ARCHITECTURE.md"
related_files:
  - "crates/tenex-summarizer/src/main.rs"
  - "crates/tenex-summarizer/src/scheduler.rs"
  - "crates/tenex-summarizer/src/source.rs"
  - "crates/tenex-summarizer/src/summarize.rs"
  - "crates/tenex-summarizer/src/publish.rs"
  - "crates/tenex-summarizer/src/state.rs"
  - "crates/tenex-summarizer/src/categories.rs"
  - "tenex/src/daemon/mod.rs"
confidence: "high for current Rust source"
---

# Conversation Metadata Generation

## Question

How does TENEX generate conversation metadata such as titles, summaries, status labels, current activity, and category tags, and how does that metadata reach local storage and Nostr?

## Short Answer

The current Rust owner is `crates/tenex-summarizer`, a host-level companion daemon. The Rust `tenex daemon` starts it if a `tenex-summarizer` binary exists beside the `tenex` binary. The summarizer runs once per host, takes a singleton `flock` lock at `$TENEX_BASE_DIR/summarizer.pid`, polls every 5 seconds, and scans every project under `$TENEX_BASE_DIR/projects`.

The source adapter in `crates/tenex-summarizer/src/source.rs` reads and writes the per-project `conversation.db` through the `tenex-conversations` `ConversationStore`. It lists candidate conversations from the `messages` table (by most recent message activity), builds transcripts from the stored messages, and writes generated metadata back through the store's `update_metadata`. It does not read JSON transcripts or any `conversation-catalog.db`.

For each eligible conversation, the scheduler waits until the last message activity is at least 10 seconds quiet and not older than 7 days. It then checks `$TENEX_BASE_DIR/summarizer/state.db` so it only summarizes when activity has advanced, with a 5 minute per-conversation minimum interval. It formats text messages into a speaker-labeled transcript, asks the configured summarization LLM for a structured `Summary`, writes non-empty title/summary/status fields to the conversation's header columns in `conversation.db`, records category counts globally, and publishes an empty-content kind:513 event with `e`, `a`, `title`, `summary`, `status-*`, `t`, and `model` tags.

## System Map

`tenex/src/daemon/mod.rs` and `tenex/src/daemon/supervisor.rs` treat the summarizer as a host companion daemon. The supervisor passes `TENEX_BASE_DIR`, restarts crashed companion processes, and shuts them down with the daemon.

`crates/tenex-summarizer/src/main.rs` is the binary entrypoint. `run` acquires the singleton lock, loads config, opens the summarizer state DB, and enters the scheduler. `status` probes the same lockfile and prints whether another process holds it.

`crates/tenex-summarizer/src/config.rs` reads `$TENEX_BASE_DIR/config.json` directly and delegates LLM/provider resolution to `tenex-llm-config`. The relay list comes from config, defaulting to `wss://relay.tenex.chat` when absent. The backend signing key is `tenexPrivateKey`. The LLM preset is `llms.summarization` if present, otherwise `llms.default`. Supported providers in the reviewed source are Anthropic, OpenRouter, OpenAI, and Ollama.

`crates/tenex-summarizer/src/scheduler.rs` owns process policy: scan cadence, quiet window, maximum age, per-conversation rate limit, error handling, category recording, and success/failure logs.

`crates/tenex-summarizer/src/source.rs` is the only Rust summarizer module that knows the conversation store schema. It discovers projects, loads `event.json` for the project `a` tag, opens `conversation.db` through `tenex-conversations`, lists candidate conversations from the `messages` table, builds transcripts from the stored messages, and writes generated metadata back through `ConversationStore::update_metadata`.

`crates/tenex-summarizer/src/summarize.rs` owns the LLM prompt and output schema. The schema uses snake-case fields at the LLM boundary: `title`, `summary`, `status_label`, `status_current_activity`, and `categories`.

`crates/tenex-summarizer/src/publish.rs` signs and publishes kind:513 metadata events through `nostr-sdk` using the backend secret key.

`crates/tenex-summarizer/src/categories.rs` stores a global category tally at `$TENEX_BASE_DIR/data/conversation-categories.json`. The LLM receives the top 10 categories by frequency as canonical suggestions, not an allowlist.

Consuming the published kind:513 events — applying the `title`, `summary`, `status-label`, and `status-current-activity` tags back onto a conversation the runtime already knows — is a separate runtime concern from this publish-only daemon. The TypeScript consumers that previously did this (`NDKEventMetadata`, the event handler, and `ConversationCatalogService`) were removed in the cutover; see the addendum for how that path worked.

Generated metadata is written to the conversation's header columns in `conversation.db` via `ConversationStore::update_metadata`. There is no separate `conversation-catalog.db` in this path; the conversation store is the single substrate the summarizer reads and writes.

## Runtime Flow

1. `tenex daemon` starts, resolves its base directory, and spawns `tenex-summarizer` as a supervised companion when the binary is present beside `tenex`.
2. `tenex-summarizer run` initializes telemetry/logging, acquires `$TENEX_BASE_DIR/summarizer.pid`, loads config, opens `$TENEX_BASE_DIR/summarizer/state.db`, creates a Nostr publisher, and starts a 5 second ticker.
3. Each scan calls `source::discover_projects()` (via `tenex-conversations`). A project is considered only when both its `event.json` and `conversation.db` exist.
4. For each project, `source::load_project_event()` reads `event.json` and extracts the project owner pubkey plus d-tag. This becomes the kind:513 `a` tag value `31933:<pubkey>:<dTag>`.
5. `source::list_candidates()` opens `conversation.db` and selects conversations from the `messages` table, grouped by `conversation_id` by most recent message activity, whose last activity is between `now - 7 days` and `now - 10 seconds`, newest first.
6. `scheduler::should_process()` reads the summarizer state row keyed by `conversation_id`. New conversations process once. Existing rows process only when the last message activity is greater than the last summarized activity and at least 5 minutes have elapsed since the last successful or empty-content handling.
7. `source::fetch_content()` reads the conversation's messages from `conversation.db` via `list_messages`, keeps only messages with `message_type == "text"`, formats each as `speaker: content`, and joins messages with blank lines. Speaker selection uses `system` for system-role messages, then `senderPrincipal.displayName`, then `senderPrincipal.username`, then the first 8 chars of the sender/author pubkey, then `unknown`.
8. `summarize::summarize()` passes the transcript and category suggestion text to a Rig extractor for the configured provider. The system prompt instructs the model to avoid invented outcomes, keep titles to 3-5 words, keep summaries to one dense sentence under 160 characters, choose one of the fixed status labels, and emit 0-3 stable lowercase category nouns.
9. `scheduler::process_inner()` converts non-empty LLM fields into a `MetadataUpdate` and writes `title`, `summary`, `status_label`, and `status_current_activity` through `ConversationStore::update_metadata` into the conversation's header columns in `conversation.db`. Empty fields are ignored rather than deleting old metadata.
10. The publisher emits a kind:513 event with tags for the conversation id, metadata fields, categories, project `a` reference, and model id. The event content is empty.
11. After `process_inner()` succeeds, the scheduler records `(conversation_id, last_activity_summarized, last_summarized_at_ms)` in `state.db`. It then increments category counts for any returned categories and logs `summarized`.

## State And Data

Metadata is stored on the conversation row in `conversation.db`, set via `update_metadata`. The four fields written are:

- `title`
- `summary`
- `status_label`
- `status_current_activity`

Category tags are not written into the conversation metadata by the Rust summarizer. They are published as Nostr `t` tags and counted in the global category tally.

The kind:513 event contract uses tag names rather than JSON content:

```text
["e", "<conversation-id>"]
["title", "<title>"]
["summary", "<summary>"]
["status-label", "<status label>"]
["status-current-activity", "<current activity>"]
["t", "<category>"]
["a", "31933:<project-owner-pubkey>:<project-dtag>"]
["model", "<model-id>"]
```

The summarizer state DB is independent of the conversation store. Its `conversation_summary_state` table stores only the conversation id, the last message-activity value that was handled, and the wall-clock summarize time in milliseconds. This implies the architecture treats Nostr conversation event ids as globally unique enough for host-wide state keys.

The `tenex-conversations` schema has first-class conversation header columns for title, summary, last user message, status label, status current activity, owner pubkey, timestamps, and `metadata_json`. The summarizer writes the title/summary/status fields into those columns via `update_metadata`. (Previously, the now-removed TypeScript `ConversationCatalogService` derived such fields from JSON transcripts and `ConversationStore.save()` upserts — see the addendum.)

## Contracts And Invariants

Only `source.rs` knows the conversation store schema. The rest of the summarizer is intentionally storage-agnostic; the adapter targets the `tenex-conversations` `ConversationStore`.

The summarizer is publish-only. It does not subscribe to relays, route inbound events, execute agents, manage RAL state, or mutate project membership.

The LLM schema is a compatibility contract. The Rust prompt and schema were lifted from the removed TypeScript `ConversationSummarizer`; changing either should be treated as a wire/behavior change, not a local refactor.

There are three distinct representations of the same fields: the conversation store columns (`status_label`, `status_current_activity`), the kind:513 event's kebab-case tag keys (`status-label`, `status-current-activity`), and the snake-case LLM schema fields. Future agents should preserve this mapping unless they update every reader.

The event should include an `e` tag for the conversation id and an `a` tag for the project coordinate. Consumers classify kind:513 as conversation-plane traffic and update only conversations they already know.

The current Rust transcript formatter ignores tool-call, tool-result, and delegation-marker messages. Generated metadata is therefore based only on text conversation entries.

The singleton lock is part of the correctness model. Two host summarizers would race on metadata writes, duplicate kind:513 events, and double-count categories.

## Failure And Recovery

If config is missing, no valid relay remains, no backend secret key exists, or the LLM preset cannot be resolved, startup fails before the scan loop.

If project discovery fails, the scan logs a warning and continues on the next tick. If one project has an unreadable `event.json`, only that project is skipped. If listing candidates fails for one project, the scan continues to the next project.

If a candidate conversation is missing from the store or produces an empty transcript, `process_inner()` returns `Ok(None)`. The scheduler still records the last message-activity value in state, so the same empty candidate is not retried until activity advances.

If the LLM call, metadata write, signing, or publish fails, the scheduler logs `summarize failed` and does not record state. The next scan can retry the same candidate. Because the metadata write happens before publish, a publish failure can leave the stored metadata updated even though the summarizer will retry and potentially publish later.

If category tally recording fails after successful metadata generation and publishing, the scheduler logs a warning but keeps the summarization state. Category tally failure does not retry the conversation.

There is no explicit LLM timeout or parallel worker pool in the reviewed scheduler. A slow LLM call blocks subsequent candidate processing in that daemon process until it returns or fails.

The metadata write goes through `ConversationStore::update_metadata` against `conversation.db`. The singleton summarizer lock prevents summarizer/summarizer races; the store is the same SQLite file other consumers open, so concurrency is mediated by SQLite rather than by file-rename semantics.

## Observability

The daemon emits structured `tracing` logs. Important messages include `tenex-summarizer started`, `scan cycle complete`, `summarized`, `summarize failed`, `discover projects failed`, and per-project candidate warnings.

The `status` subcommand probes the lockfile and prints `running (pid <pid>)` or `not running`.

The current Rust code initializes `tenex_telemetry`, but the summarizer path reviewed here relies on logs rather than a detailed span model. This differs from the old TypeScript path, which created a `tenex.summarize` OpenTelemetry span for each summarization.

`crates/tenex-summarizer/tests/discover_and_read.rs` is the focused Rust test. It builds an isolated `$TENEX_BASE_DIR`, creates a project fixture with `event.json` and a `conversation.db`, then verifies discovery, candidate listing, transcript formatting, state recording, and metadata writeback. It intentionally stops at the LLM boundary.

## Source Guide

Read `crates/tenex-summarizer/AGENTS.md` first for the local invariants: polling, single instance, kind:513 only, prompt/schema parity with TypeScript, and source-adapter isolation.

Read `crates/tenex-summarizer/src/scheduler.rs` for scan timing, candidate policy, state decisions, and retry behavior.

Read `crates/tenex-summarizer/src/source.rs` for the conversation-store adapter, transcript formatter, project event loading, candidate SQL, and the `update_metadata` write.

Read `crates/tenex-summarizer/src/summarize.rs` for the exact LLM prompt, structured output schema, provider support, and category suggestion injection.

Read `crates/tenex-summarizer/src/publish.rs` for the kind:513 Nostr tag contract.

Read `crates/tenex-summarizer/src/config.rs`, `state.rs`, `categories.rs`, and `lockfile.rs` for host configuration, durable debounce state, global category counts, and singleton enforcement.

Read `tenex/src/daemon/mod.rs` and `tenex/src/daemon/supervisor.rs` to understand how the daemon is launched and restarted.

Read `crates/tenex-conversations/src/schema.rs`, `model.rs`, `store.rs`, and `migration.rs` for the conversation store schema the summarizer reads and writes.

## Open Questions

The summarizer writes conversation header metadata but does not update embedding index state. RAG indexing is a separate concern owned by `tenex-embedder`.

The Rust transcript formatter does not use `tenex-identity` for pubkey display-name resolution. It falls back to sender-principal fields or short pubkeys, which may produce lower-fidelity speaker labels than the old TypeScript `IdentityService` path.

The state DB is keyed only by conversation id. This is coherent if conversation ids are globally unique Nostr event ids, but future non-Nostr conversation ids should preserve host-wide uniqueness or add project scoping to summarizer state.

## Addendum: Differences From The TypeScript Implementation

TypeScript comparison reference: local git object `2855d63d93dee6a708800d6d9b8f4cfef2941cc0`, the parent of cutover commit `6a1bbdfae0ccfad5f059b41e3e0a9fbf90a4689a` from 2026-04-28. The files were inspected with `git show`, without changing the active worktree.

In TypeScript, `ConversationSummarizer` and `MetadataDebounceManager` lived inside the project runtime. `AgentDispatchService` invoked them on new conversations, after normal agent dispatch, and after delegation response handling. The cutover commit deleted those services and callsites so the Rust daemon owns kind:513 generation.

The trigger model changed. TypeScript generated initial metadata immediately for a new non-internal conversation, then used in-memory per-conversation debounce timers: agent start cleared pending timers, subsequent completions waited 10 seconds, and a 5 minute max deadline forced publication. Rust polls message activity instead. It waits for at least 10 seconds of quiet time, processes on the next 5 second scan, and hard-caps re-summarization to once every 5 minutes after a successful or empty-content handling.

The failure boundary changed. In TypeScript, a hung or crashing summarization call shared a process with agent dispatch. In Rust, summarization is a supervised host daemon; crashes can be restarted without taking down agent execution, and pending work is rediscovered from disk.

The debounce state changed from volatile timers to durable SQLite state. TypeScript lost pending timers on runtime shutdown. Rust records last summarized activity in `$TENEX_BASE_DIR/summarizer/state.db`, so restart does not resummarize the whole host.

The data access path changed. TypeScript summarized a live in-memory `ConversationStore`, saved through `ConversationStore.save()`, updated `ConversationCatalogService`, and triggered indexing hooks. Rust reads and writes the SQLite `conversation.db` directly through `source.rs` (via the `tenex-conversations` `ConversationStore`), with no separate catalog or index-hook step.

The LLM prompt and schema are intentionally the same. TypeScript used `llmServiceFactory.generateObject()` with a Zod schema. Rust uses Rig extractors with a serde/schemars `Summary` struct. The field names and prompt text are parity-sensitive.

The participant naming path changed. TypeScript asked `IdentityService.getDisplayName()` with principal id, linked pubkey, display name, username, kind, and system fallback. Rust uses only fields already present in the JSON message and short-pubkey fallback.

Publishing behavior differs on partial failure. TypeScript saved local metadata, then caught and logged kind:513 publish failures without throwing out of `summarizeAndPublish()`. Rust writes local metadata, then treats publish failure as a processing error and does not record summarizer state, so it will retry later.

Observability changed. TypeScript created `tenex.summarize` spans and dispatch span events such as `reply.initial_metadata_scheduled` and `dispatch.summarization_scheduled`. Rust currently exposes scan and per-conversation structured logs plus the lockfile-based `status` command.
