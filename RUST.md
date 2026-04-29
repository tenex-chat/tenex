# TENEX Rust Adoption Status

_Last updated: 2026-04-29 (eighteenth pass). Auto-maintained by scheduled debt check._

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
- **Streaming LLM output**: `stream_chat` via rig-core with full history; final `ConversationIntent` emitted with real token usage from `FinalResponse`
- **FS tools (permission-gated)**: full-project tools (`fs_read`, `fs_write`, `fs_edit`, `fs_glob`, `fs_grep`) when granted; otherwise home-sandboxed variants (`HomeFsReadTool` etc.) restricted to `~/.tenex/home/<pubkey8>/` with path traversal guard
- Shell tool (`shell`)
- **Delegation tools**: `delegate` (emit delegation intent), `delegate_crossproject` (cross-project delegation), `delegate_followup` (follow up on existing delegation), `self_delegate` (re-queue self with different context)
- **Interaction tools**: `ask` (request clarification from user), `learn` (persist new fact to agent home)
- **Project tools**: `project_list` (enumerate projects from base dir)
- **RAG tools**: `rag_add_documents` (audience=self→agent collection, audience=project→project collection), `rag_search` (vector search) — all optional if embed not configured; `rag_collection_list` and `rag_collection_delete` removed (agents don't manage collections directly)
- **Skills tools**: `skill_list` (discover skills by scope) + `skills_set` (apply/remove per-conversation)
- **Todo tool**: `todo_write` (create/update task list)
- **Conversation tools**: `conversation_get` (retrieve message transcript by ID from SQLite store), `conversation_list` (list conversations with date range filter)
- **Scheduling tools**: `schedule_task` (write one-off or recurring tasks to `schedules.json` via `tenex-scheduler` storage API), `kill` (cancel a scheduled task by ID; agent/shell kills require TS runtime in-process state)
- **Model override**: `change_model` (persist `meta_model_variant` to `AgentContextState`; resolved on next invocation — accepts named preset, `provider:model`, or `provider/model`)
- Provider dispatch: Anthropic, OpenAI, OpenRouter, Ollama (via `rig-core`)
- LLM config resolution from `~/.tenex/llms.json` + `~/.tenex/providers.json`
- Teams support: loads `teams.json`, renders `<teams-context>` fragment, routes delegation by team name
- Agent home directory: per-agent `~/.tenex/home/<pubkey8>/` with `.env` auto-loading and `+filename` injection
- **Post-completion re-engagement loop**: `tenex-agent` runs an `'agent_loop` — after each LLM turn, `Supervisor::check_post_completion` inspects pending todos. If unfinished work remains, supervision injects a nudge and the agent re-runs with the extended history rather than terminating. Loop is guarded by `MAX_RETRIES = 3`.
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
- **models.dev full library** (`store/models_dev.rs`): `CacheData`, `ModelsDevModel`, `is_stale`, `resolve_model_data`, `get_model_info`, `get_provider_models`, `context_window`, `load_from_disk`, `cache_file_path`, `picker_label_segments`, `default_model_for_provider` — pure data, HTTP fetch still pending
- **Role auto-select with real model data**: `ModelsDevSource` + `OwnedModelsDevSource` adapters; `load_or_empty()` reads on-disk cache (populated by TS or future Rust refresh); wired into both `tenex onboard` step 5 and `tenex config roles`
- **Codex model listing** (`onboard/codex_models.rs`): `CodexModelOption`, `format_codex_model` — Codex CLI substrate still pending
- **Provider ID constants** (`store/provider_ids.rs`): canonical string IDs for all 7 providers — eliminates magic strings
- **Codex LLM config options** (`store/llm_config_options.rs`): effort/summary/personality/approvalPolicy/sandboxPolicy enums
- **`tenex config <name>` direct subcommands**: 15 canonical variants matching TS Commander.js registration — `tenex config telegram`, `tenex config relays`, etc. all directly callable, bare `tenex config` keeps interactive menu
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
| `conversation_search` | TS-only | Semantic search across conversations. No Rust equivalent. |
| `no_response` | TS-only | Suppress the completion event. Not yet ported. |
| `send_message` | TS-only | Send arbitrary Nostr message. Not yet ported. |
| `mcp_list_resources`, `mcp_resource_read`, `mcp_subscribe`, `mcp_subscription_stop` | TS-only | MCP protocol tools. No Rust equivalent yet. |
| `report_publish` | TS-only | Publish a formatted report event. Not yet ported. |
| `agents_write` | TS-only | Create/update agent records. Not yet ported. |
| `rag_subscription_*` | TS-only | RAG subscription management. No Rust equivalent. |

Note: `conversation_get`, `conversation_list`, `kill` (scheduled tasks only), `schedule_task`, and `change_model` are now implemented in Rust. The Rust `kill` only cancels scheduled tasks — agent/shell kills require TS in-process state (RALRegistry, CooldownRegistry, AgentDispatchService). The Rust `change_model` accepts any model spec (`provider:model`, named preset) rather than the TS restriction to meta-model variant names.

---

## Compilation Status

**As of 2026-04-29 (eighteenth debt check pass): workspace compiles clean — zero errors, zero `unreachable!`/`todo!`/`unimplemented!` macros. ~290 dead-code warnings from porting-in-progress code (TUI glyphs, onboard LLM test substrate, Codex config enums); all waiting for caller wiring, none orphaned.**

**MILESTONE: Every tool in `tenex-agent` is now verified end-to-end (see `RUST_REPORT.md`).** RAG (real embedding API), skills_set, delegate_crossproject, multi-turn context projection — all passing. `cargo test --workspace` clean: 27 tests across 4 crates.

**MILESTONE: tenex-agent is live-tested end-to-end (see `RUST_REPORT.md`)**:
- Basic completion ✅, streaming (kind:24135 deltas) ✅, final ConversationIntent ✅
- todo_write ✅, shell ✅, fs tools (home-restricted) ✅
- Self-delegation ✅, cross-agent delegation ✅
- Conversation history persistence (10 convs, 20 history entries) ✅
- Supervision (worker todo block) ✅
- FK bug fixed: ensure_conversation() on store open

Resolved between seventeenth and eighteenth passes:
- **All tools verified end-to-end**: RAG add_documents + search (real OpenRouter embedding API, SQLite store, cosine similarity), skills_set, delegate_crossproject, multi-turn context projection all confirmed passing. Open items cleared.
- **`cargo test --workspace` clean**: 27 tests across tenex-context (5), tenex-system-prompt (4), tenex-supervision (13), tenex-identity (5) — 0 failures.
- **Leftover `.bak` file removed**: `src/tools/implementations/agents_write.ts.bak` deleted (gitignored working copy from agents_write refactor).
- **No orphaned code found**: All ~290 dead-code warnings are porting-in-progress items with clear landing paths.

Resolved between sixteenth and seventeenth passes:
- **Architecture fix — `tenex daemon` default**: Previously required `--rust` or `--ts` flag (clap `required(true)` ArgGroup with no default). Since Rust is the canonical path, removed the required ArgGroup and made Rust the default; `--ts <CMD>` remains as the escape hatch. Removes the `unreachable!()` fallback.

Resolved between fifteenth and sixteenth passes:
- **Ollama model ID parsing bug**: `config.rs` now checks `provider/model` slash format before `provider:model` colon format; `ollama/mistral:latest` was previously mis-split at the colon into provider=`ollama/mistral`, model=`latest`
- **Cron TUI title display bug**: `{title:<title$}` format string shadowed the local `title` variable with the named arg `title = COL_TITLE`, showing the column-width integer instead of task title text; fixed by renaming width arg to `title_w`
- **Dead import removed**: `use crate::tui::display` removed from `telegram.rs`
- **9 more tools verified end-to-end** (RUST_REPORT.md session 3): kill, self-delegate, conversation_list/get, change_model, project_list, ask, skill_list, delegate_followup
- **chalk.gray ANSI parity**: `theme::chalk_gray()` helper added (`\x1b[90m` bright-black) distinct from `muted_gray()` (`\x1b[38;5;244m`); wired into openclaw preview output

Resolved between fourteenth and fifteenth passes:
- **Post-completion re-engagement loop**: `'agent_loop` in `tenex-agent/src/main.rs`; `Supervisor::check_post_completion` called after each LLM turn; `PostCompletionOutcome::ReEngage` pushes the prior exchange into history and loops with a supervision nudge; `Accept` breaks the loop; `MAX_RETRIES = 3` prevents runaway re-engagement
- **Supervision heuristic unit tests**: 13 tests across `consecutive_tools_without_todo.rs`, `pending_todos.rs`, and `worker_todo.rs` — threshold/below-threshold, done/skipped/delegation suppression, category bypass, tool allow-list

Resolved between thirteenth and fourteenth passes:
- **New tools**: conversation_get, conversation_list, change_model, kill (scheduled tasks), schedule_task
- **learn refactored**: LLM-maintained +INDEX.md in agent home (intentional divergence from TS RAG)
- **RAG collection tools removed**: agents don't manage collections; rag_add_documents maps scope internally
- **ExtraToolsInput struct**: cleaner tool construction across all provider branches
- **BuildSystemPromptInput struct**: consolidates 11 positional args into named struct
- **Cross-crate cleanup**: tenex-context, tenex-conversations, tenex-scheduler, tenex-protocol, whitelist
- **Multi-agent rules**: CLAUDE.md + AGENTS.md updated with design decisions and parallel-agent safety
- **Test harness**: scripts/run_rust_test.sh for local end-to-end testing

Resolved between twelfth and thirteenth passes:
- **`conversation_get`**: reads message transcript from SQLite conversation store by ID
- **`conversation_list`**: lists conversations with optional date range filter
- **`kill`**: cancels scheduled tasks via `tenex-scheduler::storage::remove_task`; scoped to scheduled tasks only (agent/shell kills are stateful and require the TS runtime)
- **`schedule_task`**: writes one-off (relative delay) or recurring (cron) tasks via `tenex-scheduler::storage::add_task`; uses canonical `ScheduledTask` / `TaskType` from `tenex-scheduler::model`
- **`change_model`**: persists `meta_model_variant` to `AgentContextState`; main.rs reads it before model resolution on the next invocation
- **Scheduler storage format fixed**: both `schedule_task` and `kill` previously wrote/read a raw flat JSON array; now use the canonical `SchedulesFile { tasks: [...] }` wrapper via the scheduler's storage module
- **conv_db_path sentinel eliminated**: tools now derive the DB path directly from `project_meta.d_tag` (always present), removing the `:none:` fallback
- **Context compaction and decay confirmed wired**: `default_stack()` in `tenex-context` runs all three strategies (compaction → decay → reminders); previously documented as reminders-only

Resolved between eleventh and twelfth passes:
- **models.dev full library**: `resolve_model_data`, `get_model_info`, `get_provider_models`, `context_window`, `load_from_disk`, `cache_file_path`, `picker_label_segments`, `default_model_for_provider` (17+7+8 new tests)
- **Role auto-select wired with real data**: `ModelsDevSource`, `OwnedModelsDevSource`, `load_or_empty()` — onboard step 5 + config roles now use on-disk cache when available
- **Codex model listing**: `CodexModelOption`, `format_codex_model` (5 new tests)
- **15 `tenex config <name>` subcommands**: direct dispatch matching TS Commander.js

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
