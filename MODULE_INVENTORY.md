# TENEX Module Inventory

This is the current map of the Rust workspace. Use it to find the owning crate
before adding code, moving behavior, or introducing a new dependency.

## Workspace Shape

| Path | Package | Role |
|---|---|---|
| `tenex/` | `tenex` | Host CLI and supervisor. Owns onboarding, configuration commands, project/runtime process management, doctor commands, TUI prompts, and Nostr publication for host-side operations. |
| `crates/tenex-agent/` | `tenex-agent` | One-shot agent runner binary. Receives one Nostr event over stdin, runs the LLM/tool loop, and emits signed NDJSON frames over stdout. It does not open relays. |
| `crates/tenex-agent-registry/` | `tenex-agent-registry` | JSON-backed global installed-agent registry under `<base_dir>/agents`. Owns agent document normalization, mutation, keys, and index maintenance. |
| `crates/tenex-context/` | `tenex-context` | Conversation-history projection for LLM prompts. Owns message shaping, token estimates, cache-breakpoint hints, and context-management turn recording. |
| `crates/tenex-conversations/` | `tenex-conversations` | SQLite conversation store for project-local messages, tool messages, prompt history, context state, completions, project discovery, and migration from older disk formats. |
| `crates/tenex-embedder/` | `tenex-embedder` | Host daemon + backfill subcommand that embeds conversation transcripts and summaries into per-project RAG stores. Polls `conversation.db`, message-aligned chunking with delegation-marker synthesis, writes to `embeddings.db`. |
| `crates/tenex-identity/` | `tenex-identity` | Host identity cache and daemon for resolving Nostr kind:0 profile data over the configured relays. |
| `crates/tenex-intervention/` | `tenex-intervention` | Intervention daemon and detector logic for identifying conversations that need owner review or follow-up. |
| `crates/tenex-llm-config/` | `tenex-llm-config` | LLM/provider configuration resolver and Unix-socket server. Owns standard and meta model resolution plus API-key health tracking. |
| `crates/tenex-mcp/` | `tenex-mcp` | Project-scoped MCP runtime library. Reads `.mcp.json`, starts configured MCP servers, exposes manifests, and bridges tool calls over Unix sockets. |
| `crates/tenex-project/` | `tenex-project` | Read-side project view over project event JSON and global agent JSON files. Owns project-id normalization, membership projection, teams, and signer selection. |
| `crates/tenex-protocol/` | `tenex-protocol` | Transport-agnostic TENEX intent vocabulary and Nostr channel encoding. Owns event kind/tag construction and message reference types. |
| `crates/tenex-rag/` | `tenex-rag` | RAG configuration, embeddings, and SQLite-backed vector/document storage. Agents add documents by audience scope; they do not manage collections. |
| `crates/tenex-scheduler/` | `tenex-scheduler` | Schedule/cron daemon support: config, cron parsing, lockfile handling, state, storage, resolver, and publication. |
| `crates/tenex-summarizer/` | `tenex-summarizer` | Host daemon that generates kind:513 conversation metadata across projects by reading conversation stores, summarizing with an LLM, and publishing updates. |
| `crates/tenex-supervision/` | `tenex-supervision` | Pure supervision heuristics for the agent runner. No I/O, no async, no workspace dependencies. |
| `crates/tenex-system-prompt/` | `tenex-system-prompt` | Deterministic system-prompt assembly from agent identity, project context, and available skill references. |
| `crates/tenex-telegram/` | `tenex-telegram` | Telegram integration: bot client, bindings, polling, rendering, pending selections, event synthesis, and runtime forwarding. |
| `crates/tenex-telemetry/` | `tenex-telemetry` | OpenTelemetry/tracing initialization and context propagation helpers shared by runtime binaries. |
| `crates/tenex-whitelist/` | `tenex-whitelist` | Local allowlist daemon and CLI for trusted backend/project pubkeys. Owns cache loading, file watching, socket protocol, and daemon lifecycle. |

## Top-Level CLI Modules (`tenex/src`)

| Module | Responsibility |
|---|---|
| `agent_cmd/` | Agent lifecycle and configuration commands, OpenClaw import/preview flows, provisioning, categorization, and Telegram config mutation. |
| `config_cmd/` | Interactive and command-line configuration for context management, escalation, identity, intervention, logging, relays, summarization, system prompt, Telegram, and telemetry. |
| `cron_cmd/` | Host commands for scheduled TENEX activity. |
| `daemon/` | Host supervisor daemon configuration, lockfile, control socket, Nostr subscription, runtime supervision, and whitelist export. |
| `doctor/` | Diagnostics and migration/repair workflows. |
| `mcp_cmd/` | MCP command surface for host/project configuration inspection and management. |
| `nostr_pub/` | Host-side Nostr publication helpers for backend signing, installed agents, operations status, project mutation, and project status. |
| `onboard/` | First-run and configuration onboarding flows for identity, relays, providers, models, embeddings, roles, and commits. |
| `runtime_cmd/` | Runtime command/control surface, control socket transport, process management, shell integration, and agent config updates. |
| `store/` | Host-side JSON/file storage for config, agents, API keys, LLMs, providers, project metadata, event IDs, and path safety. |
| `tui/` | Terminal UI components, custom prompts, glyphs, display helpers, and prompt themes/validators. |
| `types/` | CLI-facing typed wrappers for pubkeys, relay URLs, and Telegram identifiers. |
| `utils/` | Shared CLI utilities for errors, identifiers, dotenv parsing, path expansion, Telegram identifiers, and time formatting. |

## Crate Internal Modules

### `tenex-agent`

| Module | Responsibility |
|---|---|
| `acp_*` | Agent Client Protocol configuration, main binary entrypoint, MCP adapter/server, and child-process management. |
| `agent_loop_hook.rs` | Runner hook integration for loop progress and supervision. |
| `cassette*` | Deterministic LLM replay/recording support for runtime probes. |
| `compaction.rs` | Prompt/context compaction integration used by the agent loop. |
| `config.rs` | Agent-side model/provider configuration resolution. |
| `context_*` | Context discovery and rig message construction. |
| `emit.rs` | Output frame emission. |
| `escalation.rs` | Escalation policy integration. |
| `home.rs`, `stdio_home.rs` | Agent home discovery and stdio-mode home setup. |
| `hook.rs` | Rig hook implementation. |
| `injections.rs` | System/user prompt injection helpers. |
| `mock_llm.rs` | Mock LLM boundary for tests/probes. |
| `multimodal.rs` | Multimodal input handling. |
| `oauth_client.rs` | OAuth client support used by agent-facing integrations. |
| `progress_monitor.rs` | Progress monitoring and activity tracking. |
| `project_instructions.rs` | Project/root instruction discovery for prompt assembly. |
| `runtime_*` | Runtime control state and JSON serialization. |
| `shell_task_reminder.rs` | Shell-task reminder prompt support. |
| `skills.rs` | Skill discovery/loading support. |
| `tools/` | Agent tool registry and implementations, including project filesystem `AGENTS.md` reminder handling. |

### `tenex-agent-registry`

| Module | Responsibility |
|---|---|
| `atomic.rs` | Atomic JSON file writes. |
| `category.rs` | Agent category parsing/normalization. |
| `doc.rs` | Agent document load/save and mutation model. |
| `index.rs` | Global agent index load, migration, and maintenance. |
| `keys.rs` | Agent key generation and derivation helpers. |
| `paths.rs` | Registry file paths. |
| `projection.rs` | Read projections for consumers such as `tenex-project`. |
| `sanitize.rs` | Agent document sanitation. |
| `serde_util.rs` | JSON serialization helpers. |

### `tenex-context`

| Module | Responsibility |
|---|---|
| `projection.rs` | Core history-to-message projection pipeline. |
| `tokens.rs` | Token-estimation helpers. |
| `turn.rs` | Turn recording inputs and cache observations. |
| `types.rs` | Public projection, message, tool, model, and telemetry types. |

### `tenex-conversations`

| Module | Responsibility |
|---|---|
| `discovery.rs` | Walk `<base_dir>/projects/` and enumerate projects with both `event.json` and `conversation.db`. Shared between summarizer and embedder. |
| `error.rs` | Conversation-store errors. |
| `ids.rs` | Conversation and record ID helpers. |
| `migration.rs` | One-shot migration from older transcript/tool disk formats. |
| `model.rs` | Public row/input models. |
| `paths.rs` | Conversation database path helpers. |
| `project.rs` | Project-to-conversation-store adapter. |
| `schema.rs` | SQLite pragmas and forward-only migrations. |
| `store.rs` | `ConversationStore` read/write API. |

### `tenex-embedder`

| Module | Responsibility |
|---|---|
| `backfill.rs` | One-shot bulk pass with `--reset`/`--since`/`--project`/`--rate`/`--dry-run`. Uses `IndicatifReporter` for stdout progress. |
| `chunking.rs` | Message-aligned token-budgeted windowing with overlap. Emits `Chunk` records with stable content hashes. |
| `config.rs` | Optional `~/.tenex/embedder.json` overrides for tuning constants. |
| `lockfile.rs` | `flock`-based singleton lock at `~/.tenex/embedder.pid`. |
| `pacing.rs` | Token-bucket-style rate limiter with exponential backoff on 429/5xx. |
| `paths.rs` | Embedder file paths (`state.db`, `pid`, `embeddings.db`). |
| `processor.rs` | Per-conversation orchestration: chunk diff, marker synthesis, summary embedding, state cursors. |
| `progress.rs` | `ProgressReporter` trait + `LogReporter` (daemon) and `IndicatifReporter` (backfill). |
| `scheduler.rs` | Daemon polling loop. Discovers projects per scan, processes per project. |
| `source.rs` | Read side over `conversation.db`: headers, messages, child→parent delegation map and fingerprints. |
| `state.rs` | `~/.tenex/embedder/state.db` — three-cursor per-conversation embed state plus `child_set_hash` and `summary_hash` fingerprints. |
| `target.rs` | Write side: stable chunk IDs, `RagStore::put` / `delete_by_source` / `delete_by_id` wrappers. |
| `transcript.rs` | Speaker rendering, `AgentDirectory` name resolution chain (project agent → pubkey hex), merged stream construction. |
| `tuning.rs` | Tuning constants (scan interval, debounce, target/ceiling chunk size, overlap, embedding rate). |

### `tenex-project`

| Module | Responsibility |
|---|---|
| `error.rs` | Project-view errors. |
| `id.rs` | Project d-tag and NIP-33 coordinate normalization. |
| `identity.rs` | Optional read-only identity lookup for unavailable members. |
| `models.rs` | Project, agent, and membership models. |
| `paths.rs` | Project and agent file paths. |
| `project.rs` | Project metadata and membership projection. |
| `signer.rs` | Signer trait and `nsec:` signer implementation. |
| `teams.rs` | Global/project team loading and prompt rendering. |

### Other Library/Daemon Crates

| Crate | Main modules |
|---|---|
| `tenex-identity` | `cache`, `client`, `daemonize`, `fetch`, `model`, `paths`, `protocol`, `resolve`, `schema`, `server`. |
| `tenex-intervention` | `config`, `daemon`, `detector`, `lockfile`, `model`, `paths`, `publish`, `resolver`, `state`. |
| `tenex-llm-config` | `key_health`, `protocol`, `resolver`, `server`. |
| `tenex-mcp` | `bridge`, `config`, `manifest`, `runtime`, `stdio`. |
| `tenex-protocol` | `channel`, `context`, `intent`, `refs`, `runtime_control`, `sink`. |
| `tenex-rag` | `config`, `embed`, `rag`, `schema`, `sqlite_store`, `store`. |
| `tenex-scheduler` | `config`, `cron`, `daemon`, `lockfile`, `model`, `paths`, `publish`, `resolver`, `storage`. |
| `tenex-summarizer` | `categories`, `config`, `lockfile`, `paths`, `publish`, `scheduler`, `source`, `state`, `summarize`. |
| `tenex-supervision` | `heuristic`, `supervisor`, `types`. |
| `tenex-system-prompt` | `guidance`, `home`, `reminders`, `schedule`, `telegram`. |
| `tenex-telegram` | `binding`, `chat_context`, `client`, `config`, `daemon_client`, `discovery`, `event_synth`, `forward`, `pending_selection_store`, `poller`, `render`, `runtime_client`, `selection`, `session`, `tool_publications`, `types`. |
| `tenex-telemetry` | `propagation` plus tracing/OpenTelemetry setup in `lib.rs`. |
| `tenex-whitelist` | `cache`, `client`, `daemonize`, `paths`, `protocol`, `server`, `watch`. |

## Ownership Rules

- Project identifiers should be normalized at public API boundaries with the
  owning project/conversation crate, not repeatedly at call sites.
- SQLite schema changes belong only in the crate that owns the database.
- JSON file-layout changes belong only in the crate that owns that directory.
- Agent execution code belongs in `tenex-agent`; relay subscription and runtime
  orchestration belong outside the agent runner.
- Prompt assembly belongs in `tenex-system-prompt`; message-stream projection
  belongs in `tenex-context`.
- MCP server discovery/runtime belongs in `tenex-mcp`, not in `tenex-project`
  or `tenex-agent-registry`.
- RAG agents add documents by audience scope. Do not add collection-management
  tools back into the agent surface.
