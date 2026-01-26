# TENEX Module Inventory

## Purpose & Stewardship
This file is the canonical architecture reference for TENEX. Update it the moment a component is added, moved, or re-scoped. While reviewing PRs, block structural changes that do not adjust this inventory. Capture all open questions (ambiguities, overlap, refactor debt) so we can drive them to resolution rather than guess.

## How to Use this Inventory
- **Before coding** – Identify which module owns the concern; follow the placement and dependency notes below.
- **During reviews** – Confirm touched modules still match their definition. If a folder now has extra responsibilities, update this file and describe the deviation.
- **When reorganizing** – Document the rationale, expected dependencies, and follow-up actions in the “Mixed Patterns & Action Items” section so future contributors understand the plan.

## Architectural Map

### Entrypoints & CLI Skeleton
- **`src/tenex.ts`, `src/cli.ts`, `src/index.ts`**: Wire telemetry, Commander commands, and `tenex` binary exports. They must stay dependency-light and only delegate to `commands/*`. Any new runtime flags belong here, not inside domain modules.

### Command Layer (`src/commands`)
- **`agent/`**: User-facing subcommands for listing/removing/operating agents. Orchestrates `agents/` runtimes, `services/ConfigService`, and `nostr` publishers; no business logic should remain inside command handlers.
- **`daemon.ts` + `daemon/`**: Starts the long-running orchestrator and UI loop by delegating to `src/daemon`.
- **`mcp/`**: MCP server management commands. `serve.ts` spawns stdio-based MCP servers that expose TENEX tools to external providers (like Codex CLI). Server loads tool registry, converts Zod schemas to JSON Schema, and handles stdio transport via `@modelcontextprotocol/sdk`. Launched by `CodexCliProvider` with context via environment variables.
- **`setup/`**: Guided onboarding flows for LLM and embed providers (ties into `ConfigService`, `llm/LLMServiceFactory`, and `services/mcp`).
- **`vcr/`**: CLI for the VCR tooling (record, list, clean, extract) used in testing workflows.

### Agents Runtime (`src/agents`)
- **Registry & Storage**: `AgentRegistry`, `AgentStorage`, and `constants` describe built-in agent definitions, dynamic injection, and on-disk metadata.
- **Execution (`execution/*`)**: `AgentExecutor` and related utilities orchestrate prompt construction, tool execution, tracking, and session lifecycle. They depend on `llm/`, `prompts/`, `tools/registry`, `conversations/ConversationStore`, `nostr/AgentPublisher`, and `services/ral` for delegation state.
  - `MessageCompiler` assembles provider-aware `messages[]` payloads (full vs delta) and appends dynamic execution context (todos, response routing).
- **Utilities & Types**: Provide normalization, context building, shared typings, and shared tool-name parsing/categorization (see `src/agents/tool-names.ts`) for consumers such as `event-handler`.
- **Guideline**: Agents should never import `commands/*`. For configuration, import `{ config }` from `@/services` and use `config.getConfigPath(subdir)` for paths or `config.loadConfig()` for configuration data; pass loaded config through constructors when needed.

### Conversations (`src/conversations`)
- **Persistence & Stores**: `ConversationStore` persists conversation state and tool messages to the filesystem; `persistence/ToolMessageStorage` manages tool-call/result storage.
- **Services**: `ConversationResolver`, `ConversationSummarizer`, and `MetadataDebounceManager` coordinate resolution, summarization, and metadata updates.
- **Formatting**: `formatters/*` and `formatters/utils/*` produce human-readable outputs for UI/debug tooling.
- **Responsibility**: This is the single source of truth for conversation context; other modules must request data via these services rather than reading persistence files directly.

### Event Handling & Workflow Orchestration
- **`src/events`**: Typed schemas, utils, and constants for every event TENEX produces or consumes (Nostr kinds, internal telemetry events). Treat as a contract; modifications require updates to this file.
- **`src/event-handler`**: Domain orchestrators triggered by incoming Nostr events. `newConversation` and `reply` decode events using `nostr/AgentEventDecoder`, resolve participants via `agents/` + `conversations/services`, then delegate routing/execution to `services/dispatch`.

### Nostr Integration (`src/nostr`)
- **Core Clients**: `ndkClient` bootstraps NDK, while `AgentPublisher`, `AgentEventEncoder/Decoder`, and `kinds.ts` encapsulate event creation.
- **Utilities & Types**: Provide helper functions for relays, batching, and metadata so higher layers never manipulate `NDKEvent` directly.
- **Guideline**: Any code that needs to publish Nostr events uses `AgentPublisher` or helper APIs; do not access NDK objects outside this module (tests can mock as needed).

### LLM Layer (`src/llm`)
- **Services & Factories**: `LLMServiceFactory`, `service.ts`, and `LLMConfigEditor` manage provider initialization, request pipelines, and CLI editing tasks.
- **Selection & Middleware**: `utils/ModelSelector`, `middleware/flight-recorder`, and `chunk-validators` coordinate model choice and response validation.
- **Providers**: `providers/base`, `providers/standard`, `providers/agent`, and `providers/registry` house adapters for Claude, OpenRouter, Ollama, Codex CLI, Gemini CLI, and mock providers. Agent providers (Claude Code, Codex CLI) use specialized adapters:
  - **`ClaudeCodeToolsAdapter.ts`**: Converts TENEX tools to SDK MCP format for Claude Code (in-process, via `createSdkMcpServer`).
  - **`TenexStdioMcpServer.ts`**: Generates stdio MCP server config for Codex CLI. Creates subprocess launch config with tool list and execution context (projectId, agentId, conversationId, workingDirectory, currentBranch) passed via environment variables. Spawned by `CodexCliProvider` to expose TENEX tools.
- **Guideline**: Agents and services never talk to provider SDKs directly—use this module to ensure credentials, retries, and middleware are consistent.

### Prompts (`src/prompts`)
- **`core/` + `fragments/` + `utils/`**: Compose reusable prompt pieces, compile structured system prompts, and host helper utilities. Execution modules should only import builders from here, never inline long prompt strings.

### Tools System (`src/tools`)
- **Implementations**: `implementations/*.ts` are the concrete actions agents can call (delegation, RAG management, scheduling, MCP discovery, file access, shell, etc.). They should delegate to `services/*` when stateful operations are required.
- **Registry & Runtime**: `registry.ts`, `utils.ts`, and executor/tests coordinate tool metadata, zod schemas, result marshalling, and permission enforcement.
- **Dynamic Tools**: User-defined tool factories are loaded by `services/DynamicToolService` from `~/.tenex/tools` and surfaced through the tool registry. Tests live under `tools/__tests__`.
- **Guideline**: Keep external I/O localized; when a tool needs long-lived resources (RAG DB, scheduler), call the relevant service rather than re-implementing logic.

### Services Catalog (`src/services`)
Use this section to understand each service’s scope and dependencies:

| Service | Location | Responsibility & Key Dependencies |
| --- | --- | --- |
| `ConfigService` (+ `config/`) | `src/services/ConfigService.ts` | **Centralized configuration service** - Loads, validates, and caches config files from `~/.tenex/` (global only: `config.json`, `llms.json`; project-level: `mcp.json` only). Exports `config` instance (no singleton pattern). Provides `getConfigPath(subdir?)` and `getProjectsBase()` for centralized path construction. Initializes providers via `llm/LLMServiceFactory`. All modules must import `{ config }` from `@/services/ConfigService` - never construct `~/.tenex` paths manually. |
| `AgentDispatchService` (+ `dispatch/`) | `src/services/dispatch/AgentDispatchService.ts` | Orchestrates chat message routing, delegation completion handling, injection strategy, and agent execution. Hosts `AgentRouter` + `DelegationCompletionHandler` for routing and completion bookkeeping. |
| `RALRegistry` | `src/services/ral/RALRegistry.ts` | Tracks active RALs, pending/completed delegations, queued injections, and stop-signal aborts. Used by `AgentExecutor`, `services/dispatch/DelegationCompletionHandler`, and delegation tools. |
| `DynamicToolService` | `src/services/DynamicToolService.ts` | Watches `~/.tenex/tools`, compiles TS tool factories, and exposes them to the tool registry. Uses Bun file APIs and `agents/execution` contexts. |
| `EmbeddingProvider` | `src/services/embedding/` | High-level wrapper over embedding vendors for RAG. Works with `services/rag/*.ts`. |
| `LLMOperationsRegistry` | `src/services/LLMOperationsRegistry.ts` | Tracks active LLM requests per project for throttling and telemetry; referenced by scheduler/status publishers. |
| `NDKAgentDiscovery` + agent metadata | `src/services/agents/` | Subscribes to relays to discover external agents, resolves agent metadata, and caches pubkey lookups via `PubkeyService`. |
| `NudgeService` | `src/services/nudge/` | Emits reminders/prompts to stalled agents or phases; depends on scheduler + conversations. |
| `OperationsStatusService` & `status/` | `src/services/status/` | Broadcasts progress events to daemon/status consumers. Depends on scheduler and Nostr publisher provided by daemon. |
| `ProjectContext` + `ProjectContextStore` | `src/services/projects/` | Maintains view of open projects, current working dirs, and runtime metadata used by CLI + daemon. |
| `PubkeyService` | `src/services/PubkeyService.ts` | Provides caching and lookup for pubkey display names from Nostr. |
| `TrustPubkeyService` | `src/services/trust-pubkeys/` | Determines if a pubkey should be trusted (heeded or ignored). A pubkey is trusted if it's whitelisted in config, the backend's own pubkey, or a registered agent. Enforces precedence: whitelisted > backend > agent. Provides both async (`isTrusted`) and sync (`isTrustedSync`) checks with backend pubkey caching. |
| `RAG*` services | `src/services/rag/` | Manage LanceDB collections, document ingestion, query APIs, subscriptions, and embedding integration (`EmbeddingProviderFactory`, `RagSubscriptionService`). Tools in `src/tools/implementations/rag_*` should call these. |
| `ReportService` | `src/services/reports/` | Creates, lists, updates task reports; used by reporting tools. |
| `SchedulerService` | `src/services/scheduling/` | Cron-like scheduling for follow-ups/nudges/tasks with persistence via `services/status`. |
| `MCP` services | `src/services/mcp/` | Install/manage MCP servers, expose them to dynamic tools and CLI setup flows. |
| `PromptCompilerService` | `src/services/prompt-compiler/` | Compiles agent lessons with user comments into Effective Agent Instructions (TIN-10). Takes Base Agent Instructions (from `agent.instructions` in Kind 4199 event) and synthesizes them with Lessons + NIP-22 comments to produce the final instructions the agent uses. Disk caching at `~/.tenex/agents/prompts/`. One instance per agent, registered during `ProjectRuntime.start()`. Handles subscription to kind 1111 comment events filtered by `#K: [4129]`. |

**Guideline**: Place orchestrators that maintain state or integrate external infrastructure here. Pure helper logic should live in `src/lib` or inside the domain folder that uses it.

### Daemon Runtime (`src/daemon`)
- **Core Runtime**: `Daemon`, `ProjectRuntime`, and `SubscriptionManager` run background loops that subscribe to relays and process events.
- **Guideline**: Keep daemon modules dependent on services + stores, never the other way around.

### Telemetry & Logging
- **`src/telemetry`**: OpenTelemetry initialization, exporters, span helpers. Modules needing tracing should import helpers rather than reconfiguring OTel.

### Utilities & Shared Libraries
- **`src/lib`**: Platform-level primitives such as file-system helpers (`lib/fs/*`) and pure utilities (`string.ts`, `error-formatter.ts`, `time.ts`, `json-parser.ts`). **Critical rule**: `lib/` must have ZERO imports from TENEX modules (`utils/`, `services/`, etc.). Use `console.error` instead of TENEX logger.
- **`src/utils`**: Higher-level utilities tied to TENEX behavior (agent fetchers, Nostr parsing, phase helpers, Git helpers including worktree management, logger configuration). Can import from `lib/` and infrastructure, but not from `services/` or higher layers.

### Tools for Tests & Scripts
- **`src/test-utils`**: Mock LLM providers, nostr fixtures, and scenario harnesses shared by unit tests. Any new reusable fixture belongs here to avoid duplicating test helpers.
- **`scripts/` (root)**: Build scripts, telemetry helpers, and CLI-adjacent automation. Place supporting tooling under `tools/` when needed, and document additions here when they influence runtime organization.

## Organization Guidelines

**For detailed architectural guidance, see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**

1. **Strict layered architecture**: Dependencies flow downward only:
   ```
   commands/daemon/event-handler
     ↓
   services/agents/conversations/tools
     ↓
   llm/nostr/prompts/events
     ↓
   utils
     ↓
   lib (NO TENEX imports!)
   ```

2. **Domain-first placement**: Always prefer enhancing an existing module (agents, conversations, nostr, llm, tools, services, daemon) before creating new top-level directories. New folders require documenting their scope here.

3. **Pure utilities in lib/**: Framework-agnostic code with zero TENEX dependencies. Use `console.error`, never TENEX logger.

4. **TENEX helpers in utils/**: Domain-specific utilities that can import from `lib/` but not from `services/` or higher.

5. **Stateful logic lives in services**: If code needs to persist data, hold onto sockets, or coordinate workflows over time, it belongs under `src/services/<domain>`. Prefer "Service" suffix for consistency.

6. **Import patterns**: Use `@/` alias. Import services directly from subdirectories: `@/services/rag` not `@/services`.

7. **Events as contracts**: Any new event type must be added to `src/events`, with producers/consumers listed in this file. Avoid anonymous payloads.

8. **Telemetry & logging**: Extend `src/telemetry`/`src/logging` when adding spans or log formats. Other modules should request loggers from there, not instantiate ad-hoc log sinks.

9. **Documentation cadence**: When reorganizing files or adding modules, update both this inventory and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) in the same PR. Mention the change under "Mixed Patterns & Action Items" until the follow-up refactor completes.

10. **Boy Scout Rule**: Always leave the code better than you found it. When you touch a file, take a moment to fix obvious issues, improve naming, move misplaced code to its correct layer, or clarify comments. Small, incremental improvements are key to our long-term success.

## Mixed Patterns & Action Items

### Completed Improvements
- **Configuration Architecture (COMPLETED 2025-01-18)**: Centralized all config path construction through `ConfigService.getConfigPath(subdir)`. Removed singleton pattern - now exports `config` instance. **Breaking change**: `config.json` and `llms.json` are now global-only (`~/.tenex/`); only `mcp.json` remains at project level. Migration path: Users must manually move project-level configs to global. See `ConfigService.ts` for API.
- **Pure Utilities to lib/ (COMPLETED 2025-01-19)**: Moved `string.ts`, `validation.ts`, `error-formatter.ts`, and `time.ts` from `utils/` to `lib/`. These are now pure utilities with zero TENEX dependencies.
- **Git Utilities Consolidated (COMPLETED 2025-01-19)**: Moved `utils/worktree/` into `utils/git/worktree.ts` for better organization.
- **Circular Dependency Fixed (COMPLETED 2025-01-19)**: Removed `lib/fs/filesystem.ts` dependency on `utils/logger`. Now uses `console.error` to maintain layer separation.
- **Service Naming (COMPLETED 2025-01-19)**: Renamed `ReportManager.ts` → `ReportService.ts` and `PubkeyNameRepository.ts` → `PubkeyService.ts` for consistency. Also renamed the classes `ReportManager` → `ReportService` and `PubkeyNameRepository` → `PubkeyService`.
- **Services Reorganization (COMPLETED 2025-12-20)**: Grouped related services into subdirectories: `projects/` (ProjectContext, ProjectContextStore), `embedding/` (EmbeddingProvider), `scheduling/` (SchedulerService), `reports/` (ReportService), `nudge/` (NudgeService), `agents/` (NDKAgentDiscovery). Each subdirectory has an `index.ts` barrel export.

### Architecture Guidelines Added (2025-01-19)
- Created [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) with comprehensive architectural principles
- Created [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) with developer workflow guidelines
- Added pre-commit hook for AI-powered architecture review
- Added `lint:architecture` script for static architecture checks

### Ongoing Improvements (Gradual Migration)
- **Layer violations fixed (COMPLETED 2025-12-20)**: Fixed all `utils/` → `services/` layer violations:
  - Moved `relays.ts` to `nostr/` (Nostr-specific)
  - Refactored `lockfile.ts` to accept path parameter
  - Deleted `cli-config-scope.ts` (unused)
  - Moved `setup.ts` to `commands/setup/interactive.ts`
  - Refactored `worktree.ts` metadata functions to accept projectsConfigPath
  - Moved `agent-resolution.ts` to `services/agents/`
- **Dependency injection pattern**: Gradually convert singletons to DI pattern with exported convenience instances.

### Known Issues to Address
- **MCP Ownership Boundary (RESOLVED 2025-01-25)**: The MCP subsystem has clear ownership boundaries:
  - `services/mcp/MCPManager.ts`: Owns MCP server lifecycle management (start, stop, health checks, tool caching, resource access). This is the single source of truth for running MCP servers.
  - `services/mcp/mcpInstaller.ts`: Owns MCP server installation (downloading, configuring servers).
  - `tools/implementations/mcp_discover.ts`: Discovers MCP tool *definitions* published to Nostr (kind:4200 events). This is a tool for agents to browse available MCP tools, not server management.
  - This separation is correct: discovery of tool definitions (tools/) vs server lifecycle (services/).

### Target State (Long-Term Vision)
See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for our detailed architectural roadmap. The key pillars of our target state are:

- **Strict Layering**: A clean, unidirectional dependency flow with zero upward dependencies.
- **Service-Oriented**: All stateful business logic encapsulated in services with consistent naming and clear boundaries.
- **Explicitness**: No barrel exports and a preference for direct imports to make dependencies clear.
- **Testability**: A comprehensive suite of unit and integration tests, facilitated by dependency injection.
- **Discoverability**: Well-organized modules and up-to-date documentation that make the codebase easy to navigate.

**Completed Goals:**
- ✅ Strict layer separation with zero upward dependencies.
- ✅ Pure utilities are fully isolated in `lib/`.
- ✅ All services now use the "Service" suffix.

**Ongoing Goals:**
- ⏳ **Subdirectory Grouping**: Continue to group related services into subdirectories as domains grow.
- ⏳ **Dependency Injection**: Consistently apply the dependency injection pattern across all services.
