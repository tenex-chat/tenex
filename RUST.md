# TENEX Rust Adoption Status

_Last updated: 2026-04-28. Auto-maintained by scheduled debt check._

---

## Overview

The Rust port is underway crate by crate. The TypeScript daemon still owns per-project agent orchestration (`src/boot.ts`); the Rust layer is progressively taking over host-level supervision, daemon services, and the agent runtime. `tenex daemon` is the Rust entry point — it boots everything.

---

## Workspace Layout

| Crate | Kind | Binary | Description |
|-------|------|--------|-------------|
| `tenex` | bin | `tenex` | Main CLI + daemon supervisor + cron TUI + per-project runtime |
| `tenex-agent` | bin | `tenex-agent` | Per-conversation agent runtime (spawned by TS boot.ts) |
| `tenex-identity` | bin+lib | `tenex-identity` | Host-wide kind:0 identity cache daemon (Unix socket) |
| `tenex-scheduler` | bin | `tenex-scheduler` | Scheduled task daemon — fires kind:1 Nostr events |
| `tenex-intervention` | bin | `tenex-intervention` | Monitors agent completions, requests reviews on user silence |
| `tenex-summarizer` | bin | `tenex-summarizer` | kind:513 conversation metadata daemon |
| `whitelist` | bin+lib | `whitelist` | Pubkey trust daemon — fs-watch on pubkeys.txt |
| `tenex-context` | lib | — | Conversation projection + compaction/decay/reminder strategies |
| `tenex-conversations` | lib | — | Per-project SQLite conversation store |
| `tenex-llm-config` | lib | — | LLM config resolver + NDJSON Unix-socket IPC server |
| `tenex-project` | lib | — | Per-project SQLite state (agents, skills, MCP, allowlists) |
| `tenex-protocol` | lib | — | Transport-agnostic agent intents + Nostr/stdin channel adapters |
| `tenex-rag` | lib | — | RAG: SQLite vector store + embedding client |
| `tenex-system-prompt` | lib | — | Pure system-prompt assembly from identity + project + skills |

---

## What Is Wired Up and Working

### `tenex daemon` — Host Supervisor
The Rust supervisor (`tenex daemon`) is the **sole entry point**. On startup it:
1. Acquires a lockfile
2. Boots `whitelist` daemon (mandatory — PubkeyGate is fail-closed without it)
3. Boots `tenex-identity` daemon (non-fatal fallback if absent)
4. Starts `tenex-llm-config` IPC server (in-process tokio task)
5. Supervises `tenex-summarizer`, `tenex-scheduler`, `tenex-intervention` as child processes (auto-restart with exponential backoff)
6. Subscribes to Nostr and boots per-project `bun run src/boot.ts --boot <d-tag>` on triggers

All six companion binaries are looked up next to the `tenex` executable at runtime.

### `whitelist` daemon
Fully wired. Watches `~/.tenex/whitelist/pubkeys.txt` for changes, exposes a Unix socket that `PubkeyGateService` (TS) queries. The daemon supervisor writes the backend pubkey into the file on start.

### `tenex-identity` daemon
Wired. Resolves Nostr kind:0 profiles with a SQLite cache. TS has `src/services/identity/identityDaemonClient.ts` as its IPC client. Falls back to NDK if daemon isn't running.

### `tenex-llm-config` IPC server
Wired. Reads `~/.tenex/providers.json` + `~/.tenex/llms.json`, serves NDJSON over Unix socket. TS gradually migrating to use this instead of reading config files directly.

### `tenex-scheduler` daemon
Wired and supervised. Fires scheduled kind:1 Nostr events across all projects. Has lockfile, storage, and resolver logic.

### `tenex-intervention` daemon
Wired and supervised. Monitors agent completions; publishes review-request events when users go quiet. Recent change: removed `delegation.rs` module (delegation moved elsewhere).

### `tenex-summarizer` daemon
Wired and supervised. Generates kind:513 metadata events. TS in-process summarization was already removed in favor of this daemon.

### `tenex-agent` binary
Exists and builds. The TS `boot.ts` spawns it per conversation via `tenex-agent <agent.json>` with the triggering event on stdin. Currently includes:
- All filesystem tools (read, write, edit, glob, grep)
- Shell tool
- Delegate tool (reads project DB, emits delegation intents)
- RAG index + search tools (via `tenex-rag`, optional — disabled if embed not configured)
- Provider dispatch: Anthropic, OpenAI, OpenRouter, Ollama (via `rig-core`)
- Completion event emission over Nostr (stdout NDJSON)
- LLM config resolution from `~/.tenex/llms.json` + `~/.tenex/providers.json`

### `tenex-protocol`
Fully used. Defines `Intent`, `Channel`, `ConversationRef`, `ProjectRef`, Nostr encoder/decoder, stdin source, stdout NDJSON sink. Used by `tenex-agent`, `tenex-intervention`, `tenex-scheduler`, `tenex-summarizer`.

### `tenex-project`
Used by `tenex-agent` (reads agents, metadata from SQLite). Also used by `tenex` TUI (agent storage). Has migrations.

### `tenex-rag`
Library built. Provides `RagStore` (SQLite + vector search) + `EmbedConfig` loader. Wired into `tenex-agent` (tools are present; store is initialized from `~/.tenex/embed.json` if configured).

---

### `tenex runtime` — Rust Per-Project Orchestrator (NEW)
`tenex runtime <project-id>` is a Rust replacement for `bun run src/boot.ts --boot`. It:
- Subscribes to Nostr kind:1 events #a-tagging the project or #p-tagging any project agent
- Dispatches events to the right agent via `tenex-agent` (direct @mention → matching agent, fallback → PM agent)
- Pipes the raw Nostr event JSON to `tenex-agent` stdin, relays signed event output back to the relay
- Has a per-project lockfile to prevent duplicate instances (`projects/<dTag>/runtime.lock`)

This is the key piece that makes a **full Rust-native project runtime possible** — `tenex daemon` could be changed to spawn `tenex runtime` instead of `bun run src/boot.ts --boot` once this is validated.

---

## What Is NOT Yet Wired

| Crate | Status | Notes |
|-------|--------|-------|
| `tenex-context` | Built, not integrated | Projection + compaction/decay strategies exist. Not yet used by `tenex-agent` — agent builds messages ad-hoc. Should replace agent's prompt-building with this library. |
| `tenex-system-prompt` | Built, not integrated | Pure system-prompt assembly. `tenex-agent` currently has its own `prompt.rs` that builds prompts inline. Should migrate to use this crate. |
| `tenex-conversations` | Built, not integrated | Full SQLite conversation store. `tenex-agent` does NOT persist conversation history to it yet — each invocation is stateless. The TS layer owns the conversation DB currently. |

---

## Compilation Status

**As of 2026-04-28 debt check:**

- Most crates: **clean**
- `tenex-agent`: 2 errors being fixed (ProvidersConfig rename, run_agent! macro arg count after RAG tools wired in)
- `tenex-summarizer`: 2 errors auto-fixed by linter hooks (schemars 0.8→1, nostr::types::Kind→nostr::Kind)

---

## Current Architecture Split

```
tenex daemon (Rust)
    └── whitelist (Rust, supervised)
    └── tenex-identity (Rust, supervised)
    └── tenex-llm-config IPC (Rust, in-process)
    └── tenex-summarizer (Rust, supervised)
    └── tenex-scheduler (Rust, supervised)
    └── tenex-intervention (Rust, supervised)
    └── bun run src/boot.ts --boot <d-tag>  (TypeScript, per project)
            └── tenex-agent (Rust, spawned per conversation turn)
```

The TypeScript boot layer still handles:
- Nostr event routing for incoming messages
- RAL (Resource Acquisition Lock) orchestration
- Agent lifecycle within a project session
- Most services: dispatch, prompt-compiler, RAG (TS), embedding

---

## Migration Roadmap (observed direction)

1. ~~**Immediate**: Fix compilation errors in `tenex-agent` and `tenex-summarizer`~~ ✓ Done 2026-04-28
2. **Near-term**: Validate `tenex runtime` and switch daemon supervisor from `bun run src/boot.ts` to `tenex runtime`
3. **Near-term**: Wire `tenex-context` into `tenex-agent` for proper context window management (currently no compaction)
4. **Near-term**: Wire `tenex-system-prompt` into `tenex-agent` (replace inline `prompt.rs`)
5. **Medium-term**: Wire `tenex-conversations` into `tenex-agent` so conversation history persists and context strategies can run
6. **Longer-term**: Retire TypeScript boot layer entirely
