# tenex-summarizer

Standalone Rust daemon (`tenex-summarizer run`). Generates kind:513 conversation metadata events (title, summary, status, categories) for every conversation across every project on the host. Pure read–compute–publish: poll conversation stores, run an LLM, write metadata back, sign and publish to Nostr.

Single instance per host serves all projects, independent of per-project runtime processes.

Canonical spec: `docs/plans/2026-04-28-tenex-summarizer.md`

## Storage layout

Reads `~/.tenex/projects/` to discover projects and uses each project's canonical `conversation.db` as the only conversation store.

Single-instance lockfile at `~/.tenex/summarizer.pid` (`flock`-based). A second instance exits cleanly.

## Critical invariants

- **Polling, not push.** Wake every 5 s. Summarize conversations whose `last_activity_at` is ≥ 10 s old and whose stored metadata is stale. Hard cap: re-summarize at most every 5 min per conversation.
- **`src/source.rs` is the only place that knows the on-disk format.** It uses `tenex-conversations` to read messages, derive candidate activity, and write generated metadata into `conversation.db`.
- **Kind:513 only.** No other event kinds, no inbound relay subscriptions.
- **PM-owner publishes.** When a project's kind:31933 event is co-served by several backends, only the backend whose local agent projection owns the first listed agent (the project PM) publishes kind:513 for that project. Non-owners still summarize and write to their local `conversation.db` so on-host consumers (agent bootstrap, system-prompt reminders) keep getting title/summary; they just do not emit Nostr events.
- **Prompt and response schema are the contract.** Do not redesign casually. Kind:513 event shape for the same input is the success criterion.
- **Single instance.** Do not remove or weaken the `flock` lockfile. A second instance must fail the lock and exit.
- **Reads `~/.tenex/config.json`.** Relay list and backend nsec come from there. `llms.summarization` model key takes precedence over `llms.default`.

## How to approach changes

1. `cargo test -p tenex-summarizer` before and after edits.
2. Changes to what gets summarized or when: edit `src/scheduler.rs` (candidate selection) and `src/state.rs` (debounce/hard-cap state).
3. Storage format change: edit `src/source.rs` only. Keep scheduler, LLM, and publish code isolated from storage details.
4. LLM prompt or response schema change: edit `src/summarize.rs` and update tests/docs that assert kind:513 behavior.
5. Publishing logic: `src/publish.rs`. Signer swap when NIP-46 lands is local to this file.

## Intentionally absent

- No multi-host support.
- No inbound relay subscriptions.
- No streaming LLM.
- No retry-storm logic (failed summarization is logged; next scan picks it up).
- No web UI, metrics endpoint, or admin socket.
- No lessons.
