# `tenex-summarizer` — Product Spec

## Purpose

A standalone Rust daemon that generates kind:513 conversation metadata events (title, summary, status, categories) for every conversation across every project on the host. Pure read–compute–publish: poll the conversation store for activity, run an LLM, write metadata back, sign and publish to Nostr.

Replaces the in-process `ConversationSummarizer` + `MetadataDebounceManager` that today live inside the bun project runtime.

## Why extract

- **LLM-bound async work** that has no business sharing a process with agent execution. Today a hanging summarization call lives in the same process as live agent turns.
- **No shared state with the agent loop.** Inputs are conversation rows; outputs are a metadata write and a Nostr publish.
- **Already conceptually decoupled.** The existing `MetadataDebounceManager` is a hand-rolled in-process scheduler that wants to be a daemon.
- **Failure isolation.** A summarizer crash, OOM, or stuck LLM call cannot affect agent runtimes.
- **Single instance per host serves all projects** — N projects × per-project summarizer becomes 1 daemon.

## What it owns

- Polling loop that scans every project's conversation store for activity.
- Debounce/policy: which conversations need (re-)summarizing right now.
- LLM call: title, 1-sentence summary, status label, status activity, 0–3 category tags. Same schema and prompt as today's `ConversationSummarizer`.
- Per-project category list (canonical-first, semantic) maintained on disk.
- Metadata writeback to the conversation store.
- Signing + publishing kind:513 events.

## What it does *not* own

- Storage primitives — uses `tenex-conversations` (or current JSON+catalog stores until that lands; see "Storage interim" below).
- Agent execution, dispatch, or any in-loop concerns.
- Other derived event kinds (kind 0 republishing, status updates, agent config). Out of scope; if they prove similar later they become siblings or fold in, but no premature abstraction.
- Relay subscriptions for *inbound* events. The daemon only publishes.

## Trigger model

**Polling, not push.**

- Wake every N seconds (default 5s).
- For each project, query: conversations whose `last_activity_at` is at least 10s old AND whose stored metadata is stale relative to that activity.
- Process matching conversations sequentially (LLM call, write back, publish).
- Hard cap: re-summarize at most every 5 minutes per conversation regardless of activity.

This mirrors the existing TS debounce policy (`DEBOUNCE_MS = 10s`, `MAX_DELAY_MS = 5min`) without an in-process scheduler.

## Single-instance enforcement

`flock`-based lockfile at `~/.tenex/summarizer.pid`. Same pattern as `whitelist/`. A second instance starting on the same host fails the lock and exits cleanly.

## Storage interim

`tenex-conversations` is the long-term storage layer. Until it lands:

- Storage access goes through one trait (`ConversationSource`) with two methods: list candidates needing summarization, fetch conversation content + current metadata.
- One implementation today: reads the current per-project JSON transcripts + the existing `conversation-catalog.db` SQLite for activity timestamps.
- When `tenex-conversations` lands, a second implementation replaces it; the old one is deleted in the same PR.

The trait keeps the interim adapter localized to one file. No JSON-format leakage into the polling, LLM, or publish paths.

## LLM

- Uses the same provider abstraction approach as `tenex-agent`: read provider + model id from config and credentials from `providers.json`.
- Prompt and response schema (zod → serde-equivalent) lifted verbatim from the existing TS `ConversationSummarizer`. The schema is the contract; do not redesign.
- One-shot per conversation; no streaming, no tool use, no multi-turn.

## Signing and publishing

- Backend signer: today the bun runtime resolves a backend nsec via `config.getBackendSigner()`. The daemon reads the same key from the same config path.
- When the NIP-46 signer daemon (roadmap item) lands, the summarizer asks it to sign instead. Behind a small trait so the swap is local.
- Publishes via `nostr-sdk` directly to the project's relays. When the relay-mux (roadmap item) lands, publishes go through it instead.

## Layering

```
tenex-summarizer  (Rust binary)
     ↓
tenex-conversations (storage; interim: direct JSON+catalog reads)
nostr-sdk (signing + publish)
provider HTTP (LLM)
```

The summarizer never imports anything from the bun codebase.

## Configuration

Reads from `~/.tenex/config.json` (existing global config):

- Relay list.
- Backend nsec (or NIP-46 connection string when that exists).
- LLM provider config — uses `llms.summarization` if set, else `llms.default`. Same precedence as today.

Per-project category lists live where they live today: `~/.tenex/data/categories/<dTag>.json` (or the existing `CategoryManager` path).

## CLI surface

```
tenex-summarizer run         # foreground, logs to stderr; default
tenex-summarizer status      # print daemon stats if running
```

No `start`/`stop` subcommands; lifecycle is up to whatever launches it (systemd, the supervisor daemon, manual). Single-instance lock makes accidental duplicates safe.

## Observability

- Structured logs to stderr via `tracing`.
- One log line per processed conversation: `conversation_id`, `model`, latency, success/failure.
- One log line per scan cycle: candidates found, processed, skipped.

OTel spans are not in v1; the daemon is small enough that logs suffice.

## What this deletes from the bun runtime

When this ships and is wired in:

- `src/conversations/services/MetadataDebounceManager.ts` — gone.
- `src/conversations/services/ConversationSummarizer.ts` — gone.
- The summarization callsite in `AgentDispatchService` — gone.
- The `getBackendSigner()` consumers for kind:513 publishing — gone.

Net code reduction in the bun runtime; no new responsibility added in exchange.

## Non-goals

- No multi-host. One daemon per host.
- No other event kinds. Kind 513 only.
- No streaming LLM. Synchronous request/response.
- No relay subscriptions. Outbound publishing only.
- No web UI, no metrics endpoint, no admin socket. Logs are the interface.
- No retry-storm logic. A failed summarization is logged; the next scan picks it up if the conversation is still stale.

## Success criteria

- A running `tenex-summarizer` produces identical kind:513 events to today's TS path for the same conversations, against the same LLM and prompt.
- Killing the bun project runtime mid-conversation does not lose pending summarizations — the daemon picks them up on its next scan.
- Stopping the daemon does not affect agent execution.
- Adding a project (creating its conversation store) is detected automatically on the next scan; no daemon restart required.
- The four pieces of code listed under "What this deletes" are removed in the cutover PR; no parallel/duplicate paths.
