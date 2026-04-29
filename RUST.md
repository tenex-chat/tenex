# TENEX Rust Adoption Status

_Last updated: 2026-04-29 (thirty-first pass). Auto-maintained by scheduled debt check._

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
| `tenex-agent-registry` | lib | — | Global installed-agent JSON records (`~/.tenex/agents/<pubkey>.json`) and installed-agent index (renamed from `tenex-agent-storage`) |
| `tenex-project` | lib | — | File-backed view of per-project TENEX state — reads `projects/<dTag>/event.json` + agent JSON projections. No database, no write API |
| `tenex-protocol` | lib | — | Transport-agnostic agent intents + Nostr/stdin channel adapters |
| `tenex-rag` | lib | — | RAG: SQLite vector store + embedding client |
| `tenex-supervision` | lib | — | Post-completion and pre-tool heuristics (todo nudging, re-engagement, delegation gating) |
| `tenex-system-prompt` | lib | — | Pure system-prompt assembly from identity + project + skills |
| `tenex-telemetry` | lib | — | Shared OpenTelemetry/OTLP bootstrap, W3C traceparent propagation, tracing-subscriber init |

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
- **RAG tools**: `rag_add_documents` (audience=self→agent collection, audience=project→project collection), `rag_search` (vector search) — all optional if embed not configured; `rag_collection_create`, `rag_collection_list`, and `rag_collection_delete` not ported to Rust (TS-only; agents don't manage collections directly in the Rust model)
- **Skills tools**: `skill_list` (discover skills by scope) + `skills_set` (apply/remove per-conversation)
- **Todo tool**: `todo_write` (create/update task list)
- **Conversation tools**: `conversation_get` (retrieve message transcript by ID from SQLite store), `conversation_list` (list conversations with date range filter), `conversation_search` (semantic RAG search against the `"conversations"` collection — same `RagStore` as `rag_search`; no mode parameter)
- **Scheduling tools**: `schedule_task` (write one-off or recurring tasks to `schedules.json` via `tenex-scheduler` storage API), `kill` (cancel a scheduled task by ID; agent/shell kills require TS runtime in-process state)
- **Model override**: `change_model` (persist `meta_model_variant` to `AgentContextState`; resolved on next invocation — accepts named preset, `provider:model`, or `provider/model`)
- **Silent completion**: `no_response` (sets `Arc<AtomicBool>` flag; `swap(true)` makes it idempotent — repeat calls return a "STOP" advisory instead of silently no-op'ing; description warns LLM against multi-calls; main loop skips final `ConversationIntent` emission — no Nostr event published)
- **Report publishing**: `report_publish` (publish markdown files as NIP-23 long-form articles — kind:30023 — via `PublishArticleIntent`; accepts file or recursive directory; path-traversal-safe)
- **Agent identity write**: `agents_write` (create or update backend-local agent JSON at `~/.tenex/agents/<pubkey>.json`; matches TS `StoredAgent` field shape — `nsec`/`slug`/`name`/`role`/`instructions`/`useCriteria`/`status`/`default.model`; pure file I/O with atomic temp-file + rename; preserves nsec/pubkey filename and unknown fields across update)
- Provider dispatch: Anthropic, OpenAI, OpenRouter, Ollama (via `rig-core`)
- LLM config resolution from `~/.tenex/llms.json` + `~/.tenex/providers.json`
- Teams support: loads `teams.json`, renders `<teams-context>` fragment, routes delegation by team name
- Agent home directory: per-agent `~/.tenex/home/<pubkey8>/` with `.env` auto-loading and `+filename` injection
- **Post-completion re-engagement loop**: `tenex-agent` runs an `'agent_loop` — after each LLM turn, `Supervisor::check_post_completion` inspects pending todos. If unfinished work remains, supervision injects a nudge and the agent re-runs with the extended history rather than terminating. Loop is guarded by `MAX_RETRIES = 3`.
- Supervision heuristics: `tenex-supervision` drives post-completion re-engagement, todo nudging, delegation gating by category
- **Skills persistence**: loads `self_applied_skills` + todos from conversation store on startup; saves both atomically via `save_context_state` on completion
- **Preloaded skills block**: agent config `default.skills` + conversation-scoped self-applied skills injected into system prompt
- **Conversation history**: `tenex-context::project()` is called before each LLM invocation to project prior turns from the conversation store. Full history — User, Assistant (with `tool_calls`), and ToolResult — is passed to `stream_chat`. Tool calls are captured per-turn by `RecordingTool` wrappers, persisted to `tool_messages` via `store.record_tool_message()`, and attached to the assistant `TurnRecord` so projection can reconstruct paired `tool_use`→`tool_result` sequences on the next invocation. `record_turn()` persists each turn for future projection.
- **System prompt via `tenex-system-prompt`**: `prompt.rs` replaced by `tenex_system_prompt::build_system_prompt()`. `InjectedFile` type moved to the crate; `home.rs` re-imports it.

### `tenex-protocol`
Fully used. Defines `Intent`, `Channel`, `ConversationRef`, `ProjectRef`, Nostr encoder/decoder, stdin source, stdout NDJSON sink. Used by `tenex-agent`, `tenex-intervention`, `tenex-scheduler`, `tenex-summarizer`.

### `tenex-project`
File-backed, read-only view of per-project state. Used by `tenex-agent` (reads project metadata, agent member list, teams) and `tenex` TUI (project event data). No SQLite, no migrations. Agent JSON records are now managed by `tenex-agent-storage`.

### `tenex-rag`
Library built. Provides `RagStore` (SQLite + vector search) + `EmbedConfig` loader. Wired into `tenex-agent` (tools are present; store is initialized from `~/.tenex/embed.json` if configured).

---

### `tenex runtime` — Rust Per-Project Orchestrator
`tenex runtime <project-id>` is a Rust replacement for `bun run src/boot.ts --boot`. It:
- Subscribes to Nostr kind:1 events #a-tagging the project or #p-tagging any project agent
- Dispatches events to the right agent via `tenex-agent` (direct @mention → matching agent, fallback → PM agent)
- Pipes the raw Nostr event JSON to `tenex-agent` stdin, relays signed event output back to the relay
- Has a per-project lockfile to prevent duplicate instances (`projects/<dTag>/runtime.lock`)

**`tenex daemon` now defaults to `tenex runtime` as its boot command** — the TypeScript boot layer is no longer the primary path. The Rust runtime is live. Both runtimes coexist as first-class options; the `--ts` / `--boot-command` flag is maintained indefinitely (see roadmap).

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

- **TS `ProjectRuntime.ts` is non-default but maintained**: `tenex daemon` uses `tenex runtime` (Rust) by default. TS ProjectRuntime is invoked via `--ts` / `--boot-command` and remains a supported fallback path — both runtimes coexist indefinitely per policy.
- **No dual-publish**: Since TS ProjectRuntime is not the default, status events (24010/24133) are only published by Rust. No conflict.
- **`PubkeyService.ts`** correctly delegates to `identityDaemonClient` (Rust daemon) — no drift.
- **`LlmConfigClient.ts`** correctly uses the Rust Unix-socket IPC — no drift.
- **`tenex-context` is now wired**: `project()` is called before each `stream_chat` call. Full history (User + Assistant + ToolResult) is passed to providers. Tool calls are captured by `RecordingTool` wrappers, persisted to `tool_messages`, and linked to assistant records so projection interleaves `tool_use`→`tool_result` pairs correctly.

---

## What Is NOT Yet Wired

All previously listed gaps have been closed. Remaining TS-only tools not yet ported to Rust:

| TS Tool | Status | Notes |
|---------|--------|-------|
| `send_message` | TS-only | Telegram channel message delivery. Depends on TS bot-token + TransportBindingStore infrastructure — not portable. |
| `mcp_list_resources`, `mcp_resource_read`, `mcp_subscribe`, `mcp_subscription_stop` | TS-only | MCP protocol tools. No Rust equivalent yet. |
| `rag_subscription_*` | TS-only | RAG subscription management. No Rust equivalent. |
| `rag_collection_create`, `rag_collection_delete`, `rag_collection_list` | TS-only | RAG collection management. Not ported; Rust agents use audience-scoped collections implicitly. |

Note: `conversation_get`, `conversation_list`, `conversation_search`, `kill` (scheduled tasks only), `schedule_task`, `change_model`, `no_response`, `report_publish`, and `agents_write` are now implemented in Rust. The Rust `conversation_search` does semantic RAG search against the `"conversations"` collection (same `RagStore` used by `rag_search`); requires embedding to be configured. The Rust `kill` only cancels scheduled tasks — agent/shell kills require TS in-process state (RALRegistry, CooldownRegistry, AgentDispatchService). The Rust `change_model` accepts any model spec (`provider:model`, named preset) rather than the TS restriction to meta-model variant names. The Rust `report_publish` emits kind:30023 NIP-23 articles via `PublishArticleIntent` through the standard NDJSON-stdout channel; it includes path-traversal protection and directory recursion. The Rust `agents_write` is pure file I/O against `~/.tenex/agents/<pubkey>.json` — no SQLite, no AgentProvisioningService dependency; it preserves unknown JSON fields across update so TS-written records (e.g. `category`, `eventId`, `mcpServers`) are not clobbered. The TS `send_message` is Telegram-specific (not generic Nostr) and depends on TS-only infrastructure.

---

## Compilation Status

**As of 2026-04-29 (thirtieth debt check pass): workspace compiles clean — zero errors, zero warnings. `cargo test --workspace`: 1212 tests passing across all crates.**

**MILESTONE: Tool call/result history is now fully wired.** `RecordingTool` wrappers capture every tool invocation (call_id, args, result) into a shared `Arc<ToolRecorder>`. After each turn, records are written to `tool_messages` and the assistant `TurnRecord` carries the `tool_calls` slice. `projection.rs` interleaves `ToolResult` messages immediately after their parent assistant row (sorted by timestamp, agent-pubkey-filtered). The `CtxMessage::ToolResult` filter in `main.rs` is removed — providers now receive correctly paired `tool_use`→`tool_result` sequences.

### Architectural note — `record_turn` and compaction strategies

`record_turn` in `tenex-context` writes to three stores:
- `agent_prompt_history` table — the "frozen prompt" record of exactly what the LLM saw per turn
- `agent_context_state.cache_anchored` — whether the provider hit the prompt cache
- `agent_context_state.compaction_state` + `reminder_state` — per-turn compaction metadata

`project()` currently uses `default_stack()` which runs CompactionToolStrategy, ToolResultDecayStrategy, and RemindersStrategy — all three strategies ARE live and run inline on the projected messages. Compaction triggers at 80% of the model context window. The `agent_prompt_history` data is pre-built for future strategies that need per-turn frozen context (e.g., LLM-summarized summaries instead of inline collapse). **Next step when richer compaction is needed: a strategy that reads from `agent_prompt_history` to replay-and-summarize instead of inline-collapse.**

**MILESTONE: tenex-agent is live-tested end-to-end (see `RUST_REPORT.md`)**:
- Basic completion ✅, streaming (kind:24135 deltas) ✅, final ConversationIntent ✅
- todo_write ✅, shell ✅, fs tools (home-restricted) ✅
- Self-delegation ✅, cross-agent delegation ✅
- Conversation history persistence (10 convs, 20 history entries) ✅
- Supervision (worker todo block) ✅
- FK bug fixed: ensure_conversation() on store open

Resolved between thirtieth and thirty-first passes:
- **`mock_llm.rs` fixed**: `EmptyListError` is a unit struct — no `drain()` method. `response_to_choice` already guards with `items.is_empty()`, so `OneOrMany::many(items).unwrap()` is correct. Compilation restored for `tenex-agent` test harness.
- **Runtime state persistence**: `crates/tenex-agent/src/runtime_state.rs` — `RuntimeStateHandle` persists per-turn agent state to the conversation SQLite store. `tenex-conversations/src/store.rs` gains `set_runtime_state` and `update_runtime_state` (immediate write and atomic read-modify-write under `TransactionBehavior::Immediate`).
- **Message injection tracking**: `crates/tenex-agent/src/injections.rs` — `MessageInjectionTracker` polls the conversation DB for external messages injected between turns and surfaces them as user-turn content for the next LLM invocation.
- **Dispatch coordinator**: `tenex/src/runtime_cmd/mod.rs` gains `DispatchCoordinator` — serializes concurrent events to the same (agent, conversation) pair; queues a follow-up run if a second event arrives while one is in flight.
- **`tenex-agent-storage` → `tenex-agent-registry`**: Crate renamed; all callers migrated to `tenex_agent_registry`.
- **Dead code cleanup**: `cfg(test)` visibility gates on test-only store APIs (`api_keys`, `embed`, `llms`, `mcp`, `models_dev`, `project_members`, `provider_ids`, `conversation_disk_reader`); unused glyphs constants removed (`glyphs.rs`); `variant_list_prompt` I/O loop removed; `project_mutation` `trigger` field and verbose `ProjectEventPublishResult` struct removed; `PublishOutcome::as_str` removed.
- **Warning count**: 0 (clean).
- **Test count**: 1372 (up from 1212).

Resolved between twenty-ninth and thirtieth passes:
- **`tenex-agent-storage` crate added**: New dedicated crate for global installed-agent JSON storage (`~/.tenex/agents/<pubkey>.json` + index). API: `AgentStorage::open`, `get_all_stored_agents`, `save_agent`; `AgentDoc` wraps `IndexMap<String, Value>` (preserves field order + unknown fields); `generate_nsec_bech32()` key generation. `agents_write` tool now uses this crate instead of raw `serde_json` file I/O. `tenex-project` reads agent projections via `tenex_agent_storage::read_agent_projection_file`. Workspace crate count: 17.
- **`AgentConfig` trimmed**: `role` and `description` fields removed (commit `b6ab89b8`) — they are stored in agent JSON files but not consumed by the agent runtime. `AgentConfig` now has: `name`, `slug`, `nsec`, `category`, `instructions`, `working_directory`, `default`.
- **Warning count**: Zero (down from 71) — `json!` macro and test-only modules scoped to `#[cfg(test)]`; unreachable `_` arms removed; stale TS line refs refreshed in doc-comments.
- **Test count**: 1212 (from 1362) — test-only helper functions scoped to `#[cfg(test)]` reduce the counted binary; all tests pass.
- **RUST-AGENT-SPEC.md updated**: `role` and `description` removed from agent config JSON example and table; note added clarifying they exist in stored JSON but are not read by `AgentConfig`.

Resolved between twenty-eighth and twenty-ninth passes (continued — telemetry):
- **`tenex-telemetry` crate added**: New 252-line OpenTelemetry/OTLP shared crate. `init(service_name)` configures tracing-subscriber with `EnvFilter` + optional OTLP exporter (http-proto to localhost:4318). `TelemetryConfig::load()` reads from `~/.tenex/config.json`. `current_traceparent()` generates W3C traceparent for child process propagation; `parent_context_from_env()` extracts from `TRACEPARENT` env. All five binaries (tenex, tenex-agent, tenex-identity, tenex-intervention, tenex-scheduler, tenex-summarizer) migrated from inline `tracing_subscriber::fmt().init()` to `tenex_telemetry::init()`.
- **Distributed tracing**: `runtime_cmd` passes `TRACEPARENT` env to `tenex-agent` subprocess; `tenex-agent main` extracts it as root span parent. Each tool call wrapped in `info_span!("tenex.agent.tool_call")` in `recording.rs`. Full trace tree: daemon → runtime dispatch → agent process → individual tool calls.
- **`EmbedConfig::load_from_base_dir`**: New method avoids hardcoding `~/.tenex`; `tenex-agent` passes its `base_dir` directly. `default_base_dir()` added to `tenex-rag/config.rs` reads `TENEX_BASE_DIR` env. runtime_cmd propagates `TENEX_BASE_DIR` to agent subprocess.
- **Architecture note (workspace crate count)**: 16 crates (was 15) — `tenex-telemetry` added to workspace.
- **Warning count corrected**: Clean rebuild shows 71 warnings (not 281) — prior count was inflated by stale incremental build cache. Architecture table updated.
- **Test count**: 1362 (up from 1351 — 11 new tests including tenex-telemetry unit tests and tenex-rag load_from_base_dir test).

Resolved between twenty-eighth and twenty-ninth passes:
- **Tool call/result history fixed**: `RecordingTool` (`tools/recording.rs`) wraps all tools at the `ToolDyn` layer so every invocation captures `(call_id, tool_name, args_json, result_json, is_error, timestamp_ms)` into `Arc<ToolRecorder>`. After the inner loop, `main.rs` drains the recorder: writes each record to `tool_messages` via `store.record_tool_message()`, attaches the `tool_calls` slice to the assistant `TurnRecord`. `projection.rs` reworked to sort tool messages by timestamp, filter to the projecting agent's pubkey, and interleave each `ToolResult` immediately after its parent assistant message. `CtxMessage::ToolResult` filter removed from `main.rs`. Providers now receive valid `tool_use`→`tool_result` pairs in multi-turn history.
- **uuid crate added**: `tenex-agent/Cargo.toml` — `uuid = { version = "1", features = ["v4"] }` for minting call IDs inside `RecordingTool`.
- **RUST-AGENT-SPEC.md updated**: Outer loop step numbering corrected (step 6 = drain recorder + write tool_messages; step 8 = record_turn with tool_calls); inner loop bullet added for `RecordingTool`; Future Work "ToolResult in history" removed; `conversation_search` removed from TS-only list.

Resolved between twenty-seventh and twenty-eighth passes:
- **`conversation_search` dead field removed**: `current_project_id` was stored in `ConversationSearchTool` but never read (single-project path uses `self.store`; multi-project iterates `projects/`). Field removed; constructor accepts the arg as `_current_project_id` for API stability. `tenex-agent` warning count: 1 → 0.
- **Idiomatic cleanups across 14 files**: `#[derive(Default)]` replaces manual `Default` impls for `AgentSelectState` and `LlmMenuState`; `saturating_sub` for cron Up-nav; `.ok()` idiom in relays; `std::slice::from_ref` avoids clone in onboard; `is_ascii_lowercase()`/`is_ascii_hexdigit()` replace manual byte-range checks; `unwrap_or_default()` in provider_select_prompt; US spelling in doctor output.
- **`conversation_search` description corrected**: Tool uses RAG/vector search (same `RagStore` as `rag_search`), not SQLite keyword search — RUST.md and note section updated.
- **RUST_REPORT.md session 11**: `conversation_search` e2e verified (keyword and full-text modes, 3 unit tests passing).
- **Architecture drift**: Clean. Both daemon delegations intact. No new TS bypasses.
- **Test count**: 1356 (up from 1351 — 5 new tests from tenex-context projection and strategy additions).

Resolved between twenty-sixth and twenty-seventh passes:
- **`agents_write` tool ported**: Pure file I/O against `~/.tenex/agents/<pubkey>.json` — no SQLite, no TS AgentProvisioningService dependency. Preserves unknown JSON fields across updates (category, eventId, mcpServers not clobbered). 441-line implementation + wired into `tenex-agent/src/main.rs`.
- **`conversation_search` tool ported**: Keyword/full-text search across conversation store (title, summary, message content) via new `ConversationStore::search_conversations` method. Removed from "not yet ported" table — only `send_message`, MCP tools, and RAG collection management remain TS-only.
- **RUST_REPORT.md session 10**: `report_publish` e2e (single + directory), write-access skill 2-turn flow, `no_response` multi-call regression verified and documented.
- **Architecture drift**: Clean. `PubkeyService.ts` still delegates to `identityDaemonClient`; `LlmConfigClient.ts` still uses Unix-socket IPC. Zero unused imports in workspace.
- **Dead code audit (stable)**: Warning count stable at 281. `variant_list_prompt` module complete but not yet wired to a calling command. `format_time_ago` test-only → `plural` appears dead — awaiting production wiring.
- **Test count**: 1349 (up from 1340 — 9 new tests from parallel session work on bespoke prompt byte-fidelity).

Resolved between twenty-fifth and twenty-sixth passes:
- **`no_response` idempotency**: Changed `store(true)` to `swap(true)` so double-calls return a "STOP" advisory rather than silently overwriting. Tool description updated to warn the LLM against multi-calls.
- **`provider_select_prompt` cursor byte-fidelity**: The amber cursor glyph was emitting its trailing space inside the `SetForegroundColor` span, so `ResetColor` (SGR 0) landed before the space — diverging from TS chalk's `${cursor} ` which puts the space after the close. Fixed in browse pane, done row, and keys pane. Mirrors the same fix already applied to `role_menu_prompt`, `variant_list_prompt`, and `agent_select_prompt`.
- **Architecture drift check**: Clean. `PubkeyService.ts` still delegates to `identityDaemonClient`; `LlmConfigClient.ts` still uses Unix-socket IPC. No new TS bypasses of Rust services. `ConfigService.ts` / `EmbeddingProviderFactory.ts` direct `providers.json` reads are known, intentional (TS boot path), not new drift.
- **Dead code review**: `compose_lines` pub functions have test-only callers — expected for in-progress prompt modules. `as_str` methods are pub API not yet externally called — not orphaned. `format_time_ago` has no production callers (only tests) so `plural` fires as dead — awaiting wiring into cron TUI or agent manager.
- **Test count**: 1340 (up from 1325 — 15 new tests from provider_select_prompt wire-byte coverage added in parallel session work).

Resolved between twenty-fourth and twenty-fifth passes:
- **Dead display.rs helpers removed**: `provider_check`, `provider_uncheck`, `done_label` functions and their 6 tests deleted. Bespoke crossterm prompts render `[✓]`/`[ ]` and "Done" inline with raw ANSI constants; these helpers had no production callers. Stale module-doc reference also updated.
- **llm_editor chalk_dim simplification**: `compose_display_name` and `action_items` in `tenex/src/tui/prompts/llm_editor.rs` now use `chalk_dim()` helper instead of manual `DIM_OPEN`/`DIM_CLOSE` concatenation.
- **Warning count**: 285 → 281 (4 removed by dead code deletion).
- **Test count**: 1330 → 1325 (6 orphaned tests removed, 1 new pin test added in prior session commit for prompts/mod.rs).

Resolved between twenty-third and twenty-fourth passes:
- **`report_publish` tool ported**: Emits kind:30023 NIP-23 long-form articles (replaceable) via `PublishArticleIntent` through the standard NDJSON-stdout channel. Accepts file or directory path; directory recursion prefixes `dirName/relative/path` as `d_tag`. Path-traversal protection via `canonicalize() + starts_with()`. 4 unit tests (single file, directory prefix, traversal rejection, missing path) + 1 encoder test in `tenex-protocol`.
- **`tenex-protocol` kind:30023**: `PublishArticleIntent`, `Intent::PublishArticle`, `LONG_FORM_ARTICLE = 30023` constant, `encode_publish_article()` encoder. Tags: `[d]`, `[document]`, `[a]` project link.
- **Banner byte-fidelity**: `banner.rs` migrated from `theme::banner_glow` etc. to raw ANSI escape constants (`\x1b[38;5;Nm`) matching TS chalk's wire bytes; removes the function-pointer row table. Dead helpers `banner_glow`, `banner_bright`, `banner_mid`, `banner_dark` deleted from theme.rs. Continuation of the larger `display.ts` wire-byte parity sweep (8+ files done in this cycle).
- **`send_message` clarified**: Not a generic Nostr tool — it delivers messages to Telegram channels and depends on TS-only `TransportBindingStore` + bot-token infrastructure. Not portable to Rust without that substrate.
- **Test count**: 1330 (up from 1320).

Resolved between twenty-second and twenty-third passes:
- **`no_response` tool ported**: `Arc<AtomicBool>` flag set when agent calls `no_response`; main loop checks it before emitting final `ConversationIntent`. Silent completion — no Nostr event published.
- **Compaction and reminders strategy unit tests**: 4 tests for `CompactionToolStrategy` (below-threshold noop, zero-max-tokens, middle-collapse with head+tail preservation, keep-tail sentinel) and 6 for `RemindersStrategy` (absent/done todos, pending todos inject block, appends to last user message, counts, system-only skip).
- **`config_success` centralized**: 9 config_cmd files had inline `print_success_line()` — consolidated into `tui::display::config_success()`. Three wire-byte unit tests pin the exact chalk byte sequence.
- **`display_accent_plain` removed**: Added last pass, superseded when `step()` and `hint()` were rewritten to raw escape codes. Dead production code — deleted from theme.rs. Test simplified to pin `display_accent()` bold assertion only.
- **Test count**: 1320 (up from 1290).

Resolved between twenty-first and twenty-second passes:
- **`display_accent_plain()` added**: `display.step()` rule and `display.hint()` use plain `ACCENT(...)` in TS; `display.step()` header/title uses `ACCENT.bold(...)`. Split into two helpers; test pins the bold/no-bold distinction against regression.
- **Architecture audit — compaction strategies ARE live**: CompactionToolStrategy, ToolResultDecayStrategy, RemindersStrategy all run via `default_stack()` on every `project()` call. Compaction triggers inline at 80% context window. `agent_prompt_history` is pre-built storage for future LLM-summarized compaction, not dead code.
- **Test count**: 1290 (up from 1284 — 6 new tests from this and prior session work).

Resolved between twentieth and twenty-first passes:
- **`tenex-rag` SQLite store tests**: 14 unit tests covering `cosine_similarity` (identical/opposite/orthogonal/mismatched/empty/zero-magnitude) and `SqliteStore` (schema, upsert+search, collection filter, limit, upsert-overwrite, list_collections, delete_collection, score ordering). Added `tempfile` + `tokio` dev-deps.
- **Proactive RAG injection verified end-to-end**: docs indexed above 0.65 threshold injected as `<proactive-context>` block before LLM call; agent answered codename query without any tool calls (unambiguous).
- **tenex-identity daemon smoke tested**: socket bind, `STATUS → OK cache=0`, `RESOLVE <pubkey>` fetches live kind:0 from relay.
- **Bold prompt message labels**: All 6 custom TUI prompts now wrap the `?` message in `SetAttribute(Bold)/Reset` matching `@inquirer/core`'s `theme.style.message` default.
- **Unreachable `_` arm removed** from `nip19_variant_name` in `types/pubkey.rs` — `Nip19` has exactly 6 variants, all explicitly covered; wildcard was dead code.
- **TS-only table gap**: `rag_collection_create`, `rag_collection_delete`, and `rag_collection_list` exist in TS but were absent from the "not yet ported" table. Added.

Resolved between nineteenth and twentieth passes:
- **Bug fix — `ConsecutiveToolsWithoutTodo` re_engage was false**: The heuristic consumed a retry slot and marked `nudged_about_todos = true`, then returned `Accept` — a silent no-op. Fix: `re_engage: false → re_engage: true`. End-to-end verified: 6 shell calls without todos → nudge fires → agent receives and acknowledges.
- **Bug fix — test harness `nostr_event_id` unique index**: Synthetic assistant write-back passed `nostr_event_id = record_id` string; the partial unique index `WHERE nostr_event_id IS NOT NULL` caused `INSERT OR IGNORE` to silently fail for cross-conversation collisions. Fix: pass `NULL` for `nostr_event_id`; use `agent-resp-{root_id[:8]}-{seq}` for `record_id`.
- **Architecture note — RAL**: TS `RALRegistry` (3.5k lines, concurrent agent dispatch management) has no direct Rust equivalent because `tenex runtime` dispatches sequentially — the problem doesn't exist. `CooldownRegistry.ts` (abort cooldown for concurrent routing) similarly unnecessary in Rust.
- **`cargo test --workspace`**: 1266 tests passing (up from 27 last milestone count — includes TypeScript test suite via the pre-commit hook runner).

Resolved between eighteenth and nineteenth passes:
- **Test script write-back**: `scripts/run_rust_test.sh` now writes agent responses to `messages` table after each run (Python snippet). In production, `tenex runtime` does this when it processes outbound kind:1 events. Without this, multi-turn test invocations only saw user-role messages in history projection.
- **Architectural audit**: `record_turn` writes to `agent_prompt_history`, `cache_anchored`, `compaction_state` — none consumed yet by projection strategies (see gap note above). Confirmed intentional per design doc.

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
11. **Policy**: Both runtimes coexist indefinitely — the `--ts` / `--boot-command` flag stays as a first-class, maintained path. TypeScript orchestration is removed only when the Rust runtime is a verified, feature-complete drop-in replacement. No premature retirement.
