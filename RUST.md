# TENEX Rust Adoption Status

_Last updated: 2026-04-28 (sixth pass). Auto-maintained by scheduled debt check._

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
- **Skills tools**: `skill_list` (discover skills by scope) + `skills_set` (apply/remove per-conversation)
- Provider dispatch: Anthropic, OpenAI, OpenRouter, Ollama (via `rig-core`)
- Completion event emission over Nostr (stdout NDJSON)
- LLM config resolution from `~/.tenex/llms.json` + `~/.tenex/providers.json`
- Teams support: loads `teams.json`, renders `<teams-context>` fragment, routes delegation by team name
- Agent home directory: per-agent `~/.tenex/home/<pubkey8>/` with `.env` auto-loading and `+filename` injection
- Supervision heuristics: `tenex-supervision` drives post-completion re-engagement, todo nudging, delegation gating by category
- **Skills persistence**: loads `self_applied_skills` + todos from conversation store on startup; saves both atomically via `save_context_state` on completion
- **Preloaded skills block**: agent config `default.skills` + conversation-scoped self-applied skills injected into system prompt

### `tenex-protocol`
Fully used. Defines `Intent`, `Channel`, `ConversationRef`, `ProjectRef`, Nostr encoder/decoder, stdin source, stdout NDJSON sink. Used by `tenex-agent`, `tenex-intervention`, `tenex-scheduler`, `tenex-summarizer`.

### `tenex-project`
Used by `tenex-agent` (reads agents, metadata from SQLite). Also used by `tenex` TUI (agent storage). Has migrations.

### `tenex-rag`
Library built. Provides `RagStore` (SQLite + vector search) + `EmbedConfig` loader. Wired into `tenex-agent` (tools are present; store is initialized from `~/.tenex/embed.json` if configured).

---

### `tenex runtime` — Rust Per-Project Orchestrator
`tenex runtime <project-id>` is a Rust replacement for `bun run src/boot.ts --boot`. It:
- Subscribes to Nostr kind:1 events #a-tagging the project or #p-tagging any project agent
- Dispatches events to the right agent via `tenex-agent` (direct @mention → matching agent, fallback → PM agent)
- Pipes the raw Nostr event JSON to `tenex-agent` stdin, relays signed event output back to the relay
- Has a per-project lockfile to prevent duplicate instances (`projects/<dTag>/runtime.lock`)

**`tenex daemon` now defaults to `tenex runtime` as its boot command** — the TypeScript boot layer is no longer the primary path. The Rust runtime is live. Missing pieces before full TS retirement: context management (see roadmap).

---

### `tenex-conversations`
Wired into both `tenex runtime` and `tenex-agent`. `tenex-agent` opens the store directly: loads persisted todo state + self-applied skills on startup, saves updated state on completion in a single atomic read-modify-write.

---

### `tenex` CLI — Ported Commands and Utilities
The `tenex` binary now includes:

- **`tenex agent manage`**: fully interactive TUI — agent listing, detail view, bulk delete/merge, assign to projects
- **`tenex agent import openclaw`**: wired — detects OpenClaw state dir, filters agents, surfaces LLM distillation gate (substrate pending)
- **Agent category backfill** (`categorize.rs` + `role_categories.rs`): ports `backfillAgentCategories.ts`
- **OpenClaw home/preview/reader**: ports `openclaw.ts` + `agent-home.ts` (symlink + copy modes)
- **`tenex config telegram`**: per-agent telegram bot configuration fully wired via `telegram_config.rs` helpers
- **Telegram identifiers**: `utils/telegram_identifiers.rs` — channel/native message ID encode/decode
- **Conversation disk reader** (`store/conversation_disk_reader.rs`): pure file-based conversation walker for `tenex doctor`
- **Identifier utils** (`utils/identifiers.rs`): `shorten_event_id`, `shorten_pubkey` — mirrors `conversation-id.ts`
- **Owner signer** (`nostr_pub/owner_signer.rs`): resolves nsec from env → config → interactive prompt
- **Project mutation publisher** (`nostr_pub/project_mutation.rs`): ports `ProjectEventPublishService.publishMutation`

---

## What Is NOT Yet Wired

| Crate | Status | Notes |
|-------|--------|-------|
| `tenex-context` | Built, not integrated | Projection + compaction/decay strategies exist. Not yet used by `tenex-agent` — agent builds messages ad-hoc. |
| `tenex-system-prompt` | Built, not integrated | Pure system-prompt assembly. `tenex-agent` has its own `prompt.rs`. Interface differs (skill refs vs full prompt fragments). Should migrate once aligned. |

---

## Compilation Status

**As of 2026-04-28 (sixth debt check pass): workspace compiles clean — zero errors.**

Resolved this pass (no compilation errors, all new work committed):
- Skills system (`skills.rs`, `tools/skill_list.rs`, `tools/skills_set.rs`) — discover + apply per-conversation skills
- Skills persistence: `save_context_state` unified write for todos + self-applied skills
- Telegram config helpers (`telegram_config.rs`) + full `tenex config telegram` wiring
- Telegram identifiers utils (`utils/telegram_identifiers.rs`)
- Conversation disk reader (`store/conversation_disk_reader.rs`) for `tenex doctor`
- Identifier utils (`utils/identifiers.rs`) — `shorten_event_id` extracted from inline code
- OpenClaw import dispatch wired in `agent_cmd/mod.rs` (was a stub)
- `manager_actions.rs` lazy owner-signer fix in `show_agent_detail`

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
                    └── skills system (built-in + agent + project + shared scopes)
                    └── RAG tools (optional)
                    └── delegate tool
```

**TypeScript (`bun run src/boot.ts`) is still available via `--boot-command` but is no longer the default.**

---

## Migration Roadmap (observed direction)

1. ~~**Immediate**: Fix compilation errors in `tenex-agent` and `tenex-summarizer`~~ ✓ Done 2026-04-28
2. ~~**Near-term**: Switch daemon supervisor from `bun run src/boot.ts` to `tenex runtime`~~ ✓ Done 2026-04-28
3. ~~**Now**: Add RAL to `tenex runtime`~~ — natural serialization via event loop `.await` is sufficient for now ✓
4. ~~**Now**: Wire `tenex-conversations` into `tenex runtime`~~ ✓ Done 2026-04-28
5. **Near-term**: Wire `tenex-context` into `tenex-agent` for context window management (compaction/decay)
6. **Near-term**: Align `tenex-system-prompt` interface with `prompt.rs` and migrate
7. ~~**Near-term**: Port `tenex agent manage` interactive TUI~~ ✓ Done 2026-04-28
8. ~~**Near-term**: Port OpenClaw, categorize, telegram config, identifier utils~~ ✓ Done 2026-04-28
9. **Near-term**: Delete TS originals for fully-ported flows (OpenClaw, categorize, telegram-identifiers, conversation-id utils)
10. **Near-term**: Load conversation history into `tenex-agent` invocations (currently stateless from LLM perspective)
11. **Longer-term**: Retire `bun run src/boot.ts` and all TypeScript orchestration
