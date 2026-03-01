# services/ — Stateful Orchestration (Layer 3)

Services hold state, integrate external infrastructure, and coordinate workflows. Largest domain module.

## Root-Level Services

- `ConfigService.ts` — Centralized config and path management (always use this, never construct paths manually)
- `PubkeyService.ts` — Pubkey caching/lookup
- `LLMOperationsRegistry.ts` — Request throttling
- `CooldownRegistry.ts` — Cooldown tracking
- `OwnerAgentListService.ts` — Owner-agent list management
- `AgentDefinitionMonitor.ts` — Agent definition monitoring

## Subdirectories

- `dispatch/` — Chat routing, delegation handling (`AgentDispatchService`, `AgentRouter`)
- `ral/` — Request-Agent Lifecycle state (`RALRegistry`)
- `rag/` — LanceDB document ingestion and querying
- `mcp/` — MCP server lifecycle management (`MCPManager` is single source of truth)
- `agents/` — NDK agent discovery
- `agents-md/` — AGENTS.md compilation for agent prompts
- `projects/` — Project context management
- `embedding/` — Embedding provider wrappers
- `scheduling/` — Cron-like scheduling
- `status/` — Progress event broadcasting
- `reports/` — Task reports
- `nudge/` — Stalled agent reminders
- `prompt-compiler/` — Lesson + comment synthesis
- `system-reminder/` — System reminder tag utilities
- `compression/` — Conversation compression
- `search/` — Unified search
- `config/` — Config subsystem
- `skill/` — Skill management
- `trust-pubkeys/`, `pubkey-gate/` — Trust and access control
- `nip46/` — NIP-46 remote signing
- `apns/` — Apple Push Notifications
- `image/` — Image processing
- `intervention/` — Human intervention handling
- `event-context/` — Event context resolution
- `heuristics/` — Behavioral heuristics
- `storage/` — Storage abstractions

## Rules

- Create subdirectory when 3+ related files exist, otherwise root-level is fine
- Services suffix with `*Service`. PascalCase filenames matching class name.
- `config.json` and `llms.json` are global only (`~/.tenex/`). Only `mcp.json` is project-level.
