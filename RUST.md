# TENEX Rust Adoption Status

_Last updated: 2026-04-28 (tenth pass). Auto-maintained by scheduled debt check._

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
- **Streaming LLM output**: `stream_prompt` via rig-core, accumulating text deltas; final `ConversationIntent` emitted with real token usage from `FinalResponse`
- **FS tools (permission-gated)**: full-project tools (`fs_read`, `fs_write`, `fs_edit`, `fs_glob`, `fs_grep`) when granted; otherwise home-sandboxed variants (`HomeFsReadTool` etc.) restricted to `~/.tenex/home/<pubkey8>/` with path traversal guard
- Shell tool (`shell`)
- **Delegation tools**: `delegate` (emit delegation intent), `delegate_crossproject` (cross-project delegation), `delegate_followup` (follow up on existing delegation), `self_delegate` (re-queue self with different context)
- **Interaction tools**: `ask` (request clarification from user), `learn` (persist new fact to agent home)
- **Project tools**: `project_list` (enumerate projects from base dir)
- **RAG tools**: `rag_add_documents` (add docs to collection), `rag_search` (vector search), `rag_collection_list`, `rag_collection_delete` — all optional if embed not configured
- **Skills tools**: `skill_list` (discover skills by scope) + `skills_set` (apply/remove per-conversation)
- **Todo tool**: `todo_write` (create/update task list)
- Provider dispatch: Anthropic, OpenAI, OpenRouter, Ollama (via `rig-core`)
- LLM config resolution from `~/.tenex/llms.json` + `~/.tenex/providers.json`
- Teams support: loads `teams.json`, renders `<teams-context>` fragment, routes delegation by team name
- Agent home directory: per-agent `~/.tenex/home/<pubkey8>/` with `.env` auto-loading and `+filename` injection
- Supervision heuristics: `tenex-supervision` drives post-completion re-engagement, todo nudging, delegation gating by category
- **Skills persistence**: loads `self_applied_skills` + todos from conversation store on startup; saves both atomically via `save_context_state` on completion
- **Preloaded skills block**: agent config `default.skills` + conversation-scoped self-applied skills injected into system prompt
- **Conversation history**: `tenex-context::project()` is called before each LLM invocation to project prior turns from the conversation store. History (User + Assistant messages) is passed to `stream_chat`; ToolResult messages excluded until projection captures tool_calls inline. `record_turn()` persists each turn (user + assistant) for future projection.
- **System prompt via `tenex-system-prompt`**: `prompt.rs` replaced by `tenex_system_prompt::build_system_prompt()`. `InjectedFile` type moved to the crate; `home.rs` re-imports it.

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
- **Status events** (`nostr_pub/project_status.rs` + `operations_status.rs`): kind:24010 (project inventory) + kind:24133 (per-conversation active-agent); emitted from `tenex runtime` on 30s heartbeat + pre/post dispatch
- **24011 inventory loop** in `tenex daemon`: spawns 30s heartbeat for installed-agent inventory (was missing)
- **Doctor categorize preview** (`doctor/mod.rs`): scans agents, shows categorised/uncategorised count, surfaces LLM substrate hint
- **Onboard LLM test substrate**: `llm_test_request.rs` (prompt/timeout/spinner constants) + `llm_test_hints.rs` (error→hint mapper, `is_meaningful_ai_message`, `format_stream_error`)
- **Claude Code model aliases** (`onboard/claude_code_models.rs`): three aliases for `claude-code` provider
- **models.dev types** (`store/models_dev.rs`): `CacheData`, `ModelsDevModel`, `is_stale` — pure types; HTTP fetch substrate pending
- **Provider ID constants** (`store/provider_ids.rs`): canonical string IDs for all 7 providers — eliminates magic strings
- **Codex LLM config options** (`store/llm_config_options.rs`): effort/summary/personality/approvalPolicy/sandboxPolicy enums
- **Utils library ports**: `utils/error_formatter.rs` (ToolError + format_tool_error), `utils/parse_dotenv.rs` (strict .env parser), `utils/time.rs` (format_time_ago, format_relative_time_short, format_uptime_ms)
- **Store utilities**: `store/agent_home_env.rs` (agent home .env helpers), `store/agent_home_files.rs` (agent home file listing), `store/event_ids.rs` (event ID types + shortening), `store/path_safety.rs` (path traversal guard), `store/project_ids.rs` (project ID normalization/validation)
- **Utils**: `utils/path_expand.rs` (tilde expansion, $AGENT_HOME resolution)
- **categorizeAgent pure pieces** (`agent_cmd/categorize.rs`): `system_prompt()`, `parse_category()`, `build_user_prompt()` with full test coverage
- **OpenClaw distiller pure pieces** (`agent_cmd/openclaw_distiller.rs`): `build_distillation_prompt()`, `build_user_context_prompt()` with full test coverage

---

## Architecture Observations (tenth pass drift check)

- **TS `ProjectRuntime.ts` is dead code in the default path**: `tenex daemon` uses `tenex runtime` (Rust) by default. TS ProjectRuntime is only invoked via `--ts` / `--boot-command`. Safe to remove on full TS retirement.
- **No dual-publish**: Since TS ProjectRuntime is not the default, status events (24010/24133) are only published by Rust. No conflict.
- **`PubkeyService.ts`** correctly delegates to `identityDaemonClient` (Rust daemon) — no drift.
- **`LlmConfigClient.ts`** correctly uses the Rust Unix-socket IPC — no drift.
- **`tenex-context` is now wired**: `project()` is called before each `stream_chat` call. History is text-only (User + Assistant) until projection.rs records tool_calls inline on assistant records — ToolResult messages are filtered to prevent provider 400s.

---

## What Is NOT Yet Wired

All previously listed gaps have been closed. Remaining TS-only tools not yet ported to Rust:

| TS Tool | Status | Notes |
|---------|--------|-------|
| `conversation_get` | TS-only | Fetch conversation history by ID. Not applicable in Rust (agent is invoked per-turn with injected history). |
| `conversation_list` | TS-only | List conversations. No Rust equivalent. |
| `conversation_search` | TS-only | Semantic search across conversations. No Rust equivalent. |
| `no_response` | TS-only | Suppress the completion event. Not yet ported. |
| `kill` | TS-only | Terminate a running agent. Not applicable to single-invocation Rust agent. |
| `send_message` | TS-only | Send arbitrary Nostr message. Not yet ported. |
| `mcp_list_resources`, `mcp_resource_read`, `mcp_subscribe`, `mcp_subscription_stop` | TS-only | MCP protocol tools. No Rust equivalent yet. |
| `report_publish` | TS-only | Publish a formatted report event. Not yet ported. |
| `schedule_task` | TS-only | Schedule a future task. Not yet ported (tenex-scheduler handles scheduling externally). |
| `change_model` | TS-only | Switch LLM mid-conversation. Not yet ported. |
| `agents_write` | TS-only | Create/update agent records. Not yet ported. |
| `rag_subscription_*` | TS-only | RAG subscription management. No Rust equivalent. |

---

## Compilation Status

**As of 2026-04-28 (tenth/eleventh debt check pass): workspace compiles clean — zero errors.**

Resolved between ninth and tenth passes:
- **tenex-context wired**: `project()` called before each invocation; User+Assistant history passed to `stream_chat`; `record_turn()` persists each turn to the conversation store
- **tenex-system-prompt wired**: full `prompt.rs` content migrated into the crate; `InjectedFile` moved there; `prompt.rs` deleted from `tenex-agent`
- **stream_chat**: `run_agent!` macro switched from `stream_prompt` to `stream_chat` with history
- **categorizeAgent pure pieces** (`categorize.rs`): `system_prompt()`, `parse_category()`, `build_user_prompt()` with 12 tests — LLM call still gated
- **OpenClaw distiller pure pieces** (`openclaw_distiller.rs`): `build_distillation_prompt()`, `build_user_context_prompt()` with 13 tests — LLM call still gated
- **Doctor migrate fix**: reads `config.version`, reports current/latest (v3), exits non-zero when behind, honest hint for missing substrates
- **CLI description parity**: strip trailing periods to match TS Commander.js rendering; fix three doctor flag-help strings; align orphan purge counter
- **OpenClaw import string fix**: "to import" (not "to consider")
- **LLM editor silent noop**: removed misleading "edit pending" hint — TS falls through silently on config row enter

Resolved between eighth and ninth passes (automated hourly check + committed):
- **New tools**: `ask`, `delegate_crossproject`, `delegate_followup`, `learn`, `project_list`, `self_delegate`
- **RAG refactor**: `rag_index` replaced by `rag_add_documents` + `rag_collection_list` + `rag_collection_delete`
- **Protocol extensions**: new delegation and followup intents in `intent.rs` + `encoder.rs`
- **Store utilities**: agent_home_env, agent_home_files, event_ids, path_safety, project_ids
- **Prompt fix**: removed unavailable `conversation_get` from monitoring guidance (P1 fix)
- **Delegate fix**: returns delegation event ID for use by `delegate_followup` (P2 fix)

Resolved in eighth pass:
- **Streaming LLM responses**: `stream_prompt` + `StreamExt` loop in `run_agent!` macro; real token usage from `FinalResponse`
- **Home-sandboxed FS tools**: five `HomeFsXxxTool` variants with path traversal guard; `build_fs_tools()` dispatches per `granted_tools`
- **Skills bug fixes**: char-boundary truncation, atomic snapshot/restore on remove+add failure
- Provider ID constants and Codex LLM config option enums ported
- Utils library: error_formatter, parse_dotenv, time — mirrors src/lib/

Resolved in seventh pass:
- Status events: kind:24010 project inventory + kind:24133 per-conversation active-agent wired into `tenex runtime`
- 24011 inventory heartbeat loop added to `tenex daemon` (was missing)
- Doctor categorize preview wired (scans agents, surfaces LLM gate)
- Telegram agent config flow fully wired (was a stub)
- Onboard LLM test substrate: request constants + error-hint mapper
- Claude Code model aliases ported
- models.dev pure types ported (HTTP fetch substrate still pending)

Resolved in sixth pass:
- Skills system (`skills.rs`, `tools/skill_list.rs`, `tools/skills_set.rs`) — discover + apply per-conversation skills
- Skills persistence: `save_context_state` unified write for todos + self-applied skills
- Telegram config helpers (`telegram_config.rs`) + full `tenex config telegram` wiring
- Conversation disk reader (`store/conversation_disk_reader.rs`) for `tenex doctor`
- Identifier utils (`utils/identifiers.rs`) — `shorten_event_id` extracted from inline code
- OpenClaw import dispatch wired in `agent_cmd/mod.rs` (was a stub)

---

## Current Architecture Split

```
tenex daemon (Rust)
    ├── whitelist (Rust, supervised)
    ├── tenex-identity (Rust, supervised)
    ├── tenex-llm-config IPC (Rust, in-process)
    ├── tenex-summarizer (Rust, supervised)
    ├── tenex-scheduler (Rust, supervised)
    ├── tenex-intervention (Rust, supervised)
    ├── 24011 installed-agent inventory heartbeat (30s loop, in-process)
    └── tenex runtime <d-tag>  (Rust, per project — DEFAULT)
            ├── 24010 project status heartbeat (30s loop, in-process)
            └── tenex-agent (Rust, spawned per conversation turn)
                    ├── 24133 operations status (pre/post dispatch)
                    ├── conversation history (tenex-context projection, record_turn write-back)
                    ├── system prompt (tenex-system-prompt::build_system_prompt)
                    ├── skills system (built-in + agent + project + shared scopes)
                    ├── full tool suite (fs, shell, delegate, rag, ask, learn, project_list, ...)
                    └── RAG tools (optional, if embed configured)
```

**TypeScript (`bun run src/boot.ts`) is still available via `--boot-command` but is no longer the default.**

---

## Migration Roadmap (observed direction)

1. ~~**Immediate**: Fix compilation errors in `tenex-agent` and `tenex-summarizer`~~ ✓ Done 2026-04-28
2. ~~**Near-term**: Switch daemon supervisor from `bun run src/boot.ts` to `tenex runtime`~~ ✓ Done 2026-04-28
3. ~~**Now**: Add RAL to `tenex runtime`~~ — natural serialization via event loop `.await` is sufficient for now ✓
4. ~~**Now**: Wire `tenex-conversations` into `tenex runtime`~~ ✓ Done 2026-04-28
5. ~~**Near-term**: Wire `tenex-context` into `tenex-agent` for context window management~~ ✓ Done 2026-04-28
6. ~~**Near-term**: Align `tenex-system-prompt` interface with `prompt.rs` and migrate~~ ✓ Done 2026-04-28
7. ~~**Near-term**: Port `tenex agent manage` interactive TUI~~ ✓ Done 2026-04-28
8. ~~**Near-term**: Port OpenClaw, categorize, telegram config, identifier utils~~ ✓ Done 2026-04-28
9. **Near-term**: Delete TS originals for fully-ported flows (OpenClaw, categorize, telegram-identifiers, conversation-id utils)
10. ~~**Near-term**: Load conversation history into `tenex-agent` invocations~~ ✓ Done 2026-04-28
11. **Longer-term**: Retire `bun run src/boot.ts` and all TypeScript orchestration
