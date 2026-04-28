# TENEX Rust Adoption Status

_Last updated: 2026-04-28 (fourth pass). Auto-maintained by scheduled debt check._

---

## Overview

The Rust port is underway crate by crate. The TypeScript daemon still owns per-project agent orchestration (`src/boot.ts`); the Rust layer is progressively taking over host-level supervision, daemon services, and the agent runtime. `tenex daemon` is the Rust entry point — it boots everything.

---

## Workspace Layout

| Crate | Kind | Binary | Description |
|-------|------|--------|-------------|
| `tenex` | bin | `tenex` | Main CLI + daemon supervisor + cron TUI + per-project runtime |
| `tenex-agent` | bin | `tenex-agent` | Per-conversation agent runtime (spawned by `tenex runtime`) |
| `tenex-identity` | bin+lib | `tenex-identity` | Host-wide kind:0 identity cache daemon (Unix socket) |
| `tenex-scheduler` | bin | `tenex-scheduler` | Scheduled task daemon — fires kind:1 Nostr events |
| `tenex-intervention` | bin | `tenex-intervention` | Monitors agent completions, requests reviews on user silence |
| `tenex-summarizer` | bin | `tenex-summarizer` | kind:513 conversation metadata daemon |
| `whitelist` | bin+lib | `whitelist` | Pubkey trust daemon — fs-watch on pubkeys.txt |
| `tenex-context` | lib | — | Conversation projection + compaction/decay/reminder strategies |
| `tenex-conversations` | lib | — | Per-project SQLite conversation store |
| `tenex-llm-config` | lib | — | LLM config resolver + NDJSON Unix-socket IPC server |
| `tenex-project` | lib | — | Per-project SQLite state (agents, skills, MCP, allowlists, teams) — legacy JSON migration layer removed |
| `tenex-protocol` | lib | — | Transport-agnostic agent intents + Nostr/stdin channel adapters |
| `tenex-rag` | lib | — | RAG: SQLite vector store + embedding client |
| `tenex-supervision` | lib | — | Post-completion and pre-tool heuristics (todo nudging, re-engagement, delegation gating) |
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
6. Subscribes to Nostr and spawns `tenex runtime <d-tag>` for each project trigger (default; overridable with `--boot-command`)

All companion binaries are looked up next to the `tenex` executable at runtime.

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
Spawned by `tenex runtime` per conversation turn via `tenex-agent <agent.json>` with the triggering Nostr event on stdin. Currently includes:
- All filesystem tools (read, write, edit, glob, grep)
- Shell tool
- Delegate tool (reads project DB, emits delegation intents)
- RAG index + search tools (via `tenex-rag`, optional — disabled if embed not configured)
- Provider dispatch: Anthropic, OpenAI, OpenRouter, Ollama (via `rig-core`)
- Completion event emission over Nostr (stdout NDJSON)
- LLM config resolution from `~/.tenex/llms.json` + `~/.tenex/providers.json`
- Teams support: loads `teams.json`, renders `<teams-context>` fragment, routes delegation by team name
- Agent home directory: per-agent `~/.tenex/home/<pubkey8>/` with `.env` auto-loading and `+filename` injection
- Supervision heuristics: `tenex-supervision` drives post-completion re-engagement, todo nudging, delegation gating by category

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

**`tenex daemon` now defaults to `tenex runtime` as its boot command** — the TypeScript boot layer is no longer the primary path. The Rust runtime is live. Missing pieces before full TS retirement: RAL, conversation persistence, context management (see roadmap).

---

## What Is NOT Yet Wired

| Crate | Status | Notes |
|-------|--------|-------|
| `tenex-context` | Built, not integrated | Projection + compaction/decay strategies exist. Not yet used by `tenex-agent` — agent builds messages ad-hoc. |
| `tenex-system-prompt` | Built, not integrated | Pure system-prompt assembly. `tenex-agent` has its own `prompt.rs`. Should migrate. |
| `tenex-conversations` | **Now wired into `tenex runtime`** | `tenex runtime` opens the conversation store and passes it to the agent runner. `tenex-agent` itself still doesn't persist history (stateless per-invocation). |

---

## Compilation Status

**As of 2026-04-28 (fourth debt check pass): workspace compiles clean — zero errors.**

Resolved this pass (no compilation errors found):
- `tenex-project`: removed `legacy.rs` and `migrations.rs` (JSON-file project format fully gone)
- `tenex` agent_cmd: ported `AgentManager` bulk delete/merge, `AgentProvisioningService` (delete + inventory publish), project membership helpers
- `tenex runtime`: serializes agent dispatch naturally (`.await` in event loop = one agent at a time per project)
- Drift check: no TS↔Rust drift found — identity, summarization, scheduling all correctly delegated

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
    └── tenex runtime <d-tag>  (Rust, per project — DEFAULT)
            └── tenex-agent (Rust, spawned per conversation turn)
```

**TypeScript (`bun run src/boot.ts`) is still available via `--boot-command` but is no longer the default.**

The Rust runtime (`tenex runtime`) currently handles:
- Nostr subscription and event routing (kind:1 #a-tag and #p-tag)
- Agent selection (direct @mention → PM fallback)
- Event dispatch and stdout relay back to relays

Still missing from `tenex runtime` before full TS retirement:
- ~~RAL~~ — runtime serializes naturally: event loop `.await`s each `run_agent` call, so only one agent runs at a time per project. Per-conversation locking can be added later for true concurrency.
- ~~Conversation persistence~~ ✓ `tenex-conversations` wired in
- Context management — `tenex-context` strategies not yet applied

---

## Migration Roadmap (observed direction)

1. ~~**Immediate**: Fix compilation errors in `tenex-agent` and `tenex-summarizer`~~ ✓ Done 2026-04-28
2. ~~**Near-term**: Switch daemon supervisor from `bun run src/boot.ts` to `tenex runtime`~~ ✓ Done 2026-04-28
3. ~~**Now**: Add RAL to `tenex runtime`~~ — natural serialization via event loop `.await` is sufficient for now ✓
4. ~~**Now**: Wire `tenex-conversations` into `tenex runtime`~~ ✓ Done 2026-04-28
5. **Near-term**: Wire `tenex-context` into `tenex-agent` for context window management (compaction/decay)
6. **Near-term**: Wire `tenex-system-prompt` into `tenex-agent` (replace inline `prompt.rs`)
7. **Near-term**: Port remaining agent management commands (`tenex agent manage` interactive TUI)
8. **Longer-term**: Retire `bun run src/boot.ts` and all TypeScript orchestration
