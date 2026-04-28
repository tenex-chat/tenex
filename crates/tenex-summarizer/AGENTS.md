# tenex-summarizer

Standalone Rust daemon (`tenex-summarizer run`). Generates kind:513 conversation metadata events (title, summary, status, categories) for every conversation across every project on the host. Pure read–compute–publish: poll conversation stores, run an LLM, write metadata back, sign and publish to Nostr.

Replaces `ConversationSummarizer` + `MetadataDebounceManager` from the bun project runtime. Single instance per host serves all projects.

Canonical spec: `docs/plans/2026-04-28-tenex-summarizer.md`

## Storage layout

Reads `~/.tenex/projects/` to discover projects. During the bun-runtime interim, it reads per-project JSON transcripts and `conversation-catalog.db`. When `tenex-conversations` lands, `src/source.rs` is replaced wholesale; nothing outside it changes.

Single-instance lockfile at `~/.tenex/summarizer.pid` (`flock`-based). A second instance exits cleanly.

## Critical invariants

- **Polling, not push.** Wake every 5 s. Summarize conversations whose `last_activity_at` is ≥ 10 s old and whose stored metadata is stale. Hard cap: re-summarize at most every 5 min per conversation.
- **`src/source.rs` is the only place that knows the on-disk format.** The `ConversationSource` trait (`list_candidates`, `fetch_content`) keeps JSON-format details out of the polling, LLM, and publish paths. Swap the impl here when `tenex-conversations` lands — nowhere else.
- **Kind:513 only.** No other event kinds, no inbound relay subscriptions.
- **Prompt and response schema are lifted verbatim from the bun `ConversationSummarizer`.** Do not redesign. The schema is the contract; identical kind:513 events for the same input is the success criterion.
- **Single instance.** Do not remove or weaken the `flock` lockfile. A second instance must fail the lock and exit.
- **Reads `~/.tenex/config.json`.** Relay list and backend nsec come from there. `llms.summarization` model key takes precedence over `llms.default`.

## How to approach changes

1. `cargo test -p tenex-summarizer` before and after edits.
2. Changes to what gets summarized or when: edit `src/scheduler.rs` (candidate selection) and `src/state.rs` (debounce/hard-cap state).
3. Storage format change: edit `src/source.rs` only. The `ConversationSource` trait surface stays stable.
4. LLM prompt or response schema change: edit `src/summarize.rs` and mirror the change in the bun `ConversationSummarizer` in the same PR (or confirm it's already deleted).
5. Publishing logic: `src/publish.rs`. Signer swap when NIP-46 lands is local to this file.

## Intentionally absent

- No multi-host support.
- No inbound relay subscriptions.
- No streaming LLM.
- No retry-storm logic (failed summarization is logged; next scan picks it up).
- No web UI, metrics endpoint, or admin socket.
- No lessons.
