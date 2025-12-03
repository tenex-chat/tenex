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
- **`setup/`**: Guided onboarding flows for LLM and embed providers (ties into `ConfigService`, `llm/LLMServiceFactory`, and `services/mcp`).
- **`debug/`**: Diagnostics surfaces to print prompts, formatted conversations, etc. Primary dependencies are `conversations/formatters` and `prompts/`.

### Agents Runtime (`src/agents`)
- **Registry & Storage**: `AgentRegistry`, `AgentStorage`, and `constants` describe built-in agent definitions, dynamic injection, and on-disk metadata.
- **Execution (`execution/*`)**: `AgentExecutor`, `AgentSupervisor`, and related utilities orchestrate prompt construction, tool execution, tracking, and session lifecycle. They depend on `llm/`, `prompts/`, `tools/registry`, `conversations/services`, `nostr/AgentPublisher`, and `services/DelegationService`.
- **Utilities & Types**: Provide normalization, context building, and shared typings for consumers such as `event-handler`.
- **Guideline**: Agents should never import `commands/*`. For configuration, import `{ config }` from `@/services` and use `config.getConfigPath(subdir)` for paths or `config.loadConfig()` for configuration data; pass loaded config through constructors when needed.

### Conversations (`src/conversations`)
- **Persistence**: `persistence/*` offers file-system backed history storage (`ConversationPersistenceService`, `FileSystemAdapter`, `ToolMessageStorage`).
- **Services**: `ConversationCoordinator`, `ConversationStore`, `ThreadService`, `SummarizationTimerManager`, and `ConversationEventProcessor` coordinate timeline updates, summarization jobs, and state hydration.
- **Formatting & Processors**: Format events for UI/debug output (`formatters/*`) and convert Nostr events into internal messages (`processors/*`, `utils/*`).
- **Responsibility**: This is the single source of truth for conversation context; other modules must request data via these services rather than reading persistence files directly.

### Event Handling & Workflow Orchestration
- **`src/events`**: Typed schemas, utils, and constants for every event TENEX produces or consumes (Nostr kinds, internal telemetry events). Treat as a contract; modifications require updates to this file.
- **`src/event-handler`**: Domain orchestrators triggered by incoming Nostr events. `AgentRouter`, `newConversation`, `reply`, and `DelegationCompletionHandler` decode events using `nostr/AgentEventDecoder`, resolve participants via `agents/` + `conversations/services`, then kick work to execution pipelines.

### Nostr Integration (`src/nostr`)
- **Core Clients**: `ndkClient` bootstraps NDK, while `AgentPublisher`, `AgentEventEncoder/Decoder`, and `kinds.ts` encapsulate event creation.
- **Utilities & Types**: Provide helper functions for relays, batching, and metadata so higher layers never manipulate `NDKEvent` directly.
- **Guideline**: Any code that needs to publish Nostr events uses `AgentPublisher` or helper APIs; do not access NDK objects outside this module (tests can mock as needed).

### LLM Layer (`src/llm`)
- **Services & Factories**: `LLMServiceFactory`, `service.ts`, and `LLMConfigEditor` manage provider initialization, request pipelines, and CLI editing tasks.
- **Selection & Middleware**: `selection/ModelSelector`, `utils/ModelSelector`, and `middleware/throttlingMiddleware` control model choice, throttling, cost tracking.
- **Providers**: `providers/*` house adapters for Claude, OpenRouter, Ollama, Tenex custom tools, etc., plus `provider-configs.ts` for metadata.
- **Guideline**: Agents and services never talk to provider SDKs directly—use this module to ensure credentials, retries, and middleware are consistent.

### Prompts (`src/prompts`)
- **`core/` + `fragments/` + `utils/`**: Compose reusable prompt pieces, compile structured system prompts, and host helper utilities. Execution modules should only import builders from here, never inline long prompt strings.

### Tools System (`src/tools`)
- **Implementations**: `implementations/*.ts` are the concrete actions agents can call (delegation, RAG management, scheduling, MCP discovery, file access, shell, etc.). They should delegate to `services/*` when stateful operations are required.
- **Registry & Runtime**: `registry.ts`, `utils.ts`, and executor/tests coordinate tool metadata, zod schemas, result marshalling, and permission enforcement.
- **Dynamic Tools**: `dynamic/` contains user-defined tool factories loaded by `services/DynamicToolService`. Tests live under `tools/__tests__`.
- **Guideline**: Keep external I/O localized; when a tool needs long-lived resources (RAG DB, scheduler), call the relevant service rather than re-implementing logic.

### Services Catalog (`src/services`)
Use this section to understand each service’s scope and dependencies:

| Service | Location | Responsibility & Key Dependencies |
| --- | --- | --- |
| `ConfigService` (+ `config/`) | `src/services/ConfigService.ts` | **Centralized configuration service** - Loads, validates, and caches config files from `~/.tenex/` (global only: `config.json`, `llms.json`; project-level: `mcp.json` only). Exports `config` instance (no singleton pattern). Provides `getConfigPath(subdir?)` for centralized path construction. Initializes providers via `llm/LLMServiceFactory`. All modules must import `{ config }` from `@/services` - never construct `~/.tenex` paths manually. |
| `DelegationRegistry` | `src/services/DelegationRegistry.ts` | Tracks delegation batches, prevents duplicates, exposes lookups for follow-up handling. |
| `DelegationService` | `src/services/DelegationService.ts` | Publishes delegation/ask events via `nostr/AgentPublisher`, waits for responses, enforces policy (self-delegation rules). Requires `conversationCoordinator`. |
| `DynamicToolService` | `src/services/DynamicToolService.ts` | Watches `~/.tenex/tools`, compiles TS tool factories, and exposes them to the tool registry. Uses Bun file APIs and `agents/execution` contexts. |
| `EmbeddingProvider` | `src/services/EmbeddingProvider.ts` | High-level wrapper over embedding vendors for RAG. Works with `services/rag/*.ts`. |
| `LLMOperationsRegistry` | `src/services/LLMOperationsRegistry.ts` | Tracks active LLM requests per project for throttling and telemetry; referenced by scheduler/status publishers. |
| `NDKAgentDiscovery` | `src/services/NDKAgentDiscovery.ts` | Subscribes to relays to discover external agents, caches metadata via `PubkeyNameRepository`. |
| `NudgeService` | `src/services/NudgeService.ts` | Emits reminders/prompts to stalled agents or phases; depends on scheduler + conversations. |
| `OperationsStatusPublisher` & `status/` | `src/services/OperationsStatusPublisher.ts`, `src/services/status/*` | Broadcasts progress events to daemon/status consumers. Depends on scheduler and Nostr publisher provided by daemon. |
| `ProjectContext` + `ProjectContextStore` | `src/services/ProjectContext*.ts` | Maintains view of open projects, current working dirs, and runtime metadata used by CLI + daemon. |
| `PubkeyNameRepository` | `src/services/PubkeyNameRepository.ts` | Provides caching and lookup for pubkey display names from Nostr. |
| `RAG*` services | `src/services/rag/*.ts` | Manage LanceDB collections, document ingestion, query APIs, and subscription services. Tools in `src/tools/implementations/rag_*` should call these. |
| `ReportManager` | `src/services/ReportManager.ts` | Creates, lists, updates task reports; used by reporting tools. |
| `SchedulerService` | `src/services/SchedulerService.ts` | Cron-like scheduling for follow-ups/nudges/tasks with persistence via `services/status`. |
| `MCP` services | `src/services/mcp/*` | Install/manage MCP servers, expose them to dynamic tools and CLI setup flows. |
| `EmbeddingProviderFactory` & `RagSubscriptionService` | `src/services/rag` | Glue for RAG ingestion/subscription workflows, bridging `EmbeddingProvider` and `tools`. |

**Guideline**: Place orchestrators that maintain state or integrate external infrastructure here. Pure helper logic should live in `src/lib` or inside the domain folder that uses it.

### Daemon Runtime (`src/daemon`)
- **Core Runtime**: `Daemon`, `ProjectRuntime`, `ProcessManagerController`, and `SubscriptionManager` run background loops that subscribe to relays and forward updates to the terminal UI.
- **UI (`daemon/ui`)**: React components (rendered with Ink) for projects, conversations, and agents. They read data via daemon state stores, not directly from `conversations/`.
- **Guideline**: Keep daemon modules dependent on services + stores, never the other way around.

### Telemetry & Logging
- **`src/telemetry`**: OpenTelemetry initialization, exporters, span helpers. Modules needing tracing should import helpers rather than reconfiguring OTel.
- **`src/logging`**: Structured log helpers (e.g., `LLMLogger`). Keep logger usage centralized so formatting stays consistent.

### Utilities & Shared Libraries
- **`src/lib`**: Platform-level primitives such as file-system helpers (`lib/fs/*`), shell utilities, and pure utilities (`string.ts`, `validation.ts`, `formatting.ts`, `error-formatter.ts`, `time.ts`). **Critical rule**: `lib/` must have ZERO imports from TENEX modules (`utils/`, `services/`, etc.). Use `console.error` instead of TENEX logger.
- **`src/utils`**: Higher-level utilities tied to TENEX behavior (agent fetchers, CLI config scope, Git helpers including worktree management, logger configuration). Can import from `lib/` and infrastructure, but not from `services/` or higher layers.

### Tools for Tests & Scripts
- **`src/test-utils`**: Mock LLM providers, nostr fixtures, and scenario harnesses shared by unit tests. Any new reusable fixture belongs here to avoid duplicating test helpers.
- **`scripts/` + `tools/` (root)**: Build scripts, telemetry helpers, and CLI-adjacent automation. Document additions here when they influence runtime organization.

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

10. **Boy Scout Rule**: Leave code better than you found it. Fix obvious issues, improve naming, move misplaced code to correct layers.

## Mixed Patterns & Action Items

### Completed Improvements
- **Configuration Architecture (COMPLETED 2025-01-18)**: Centralized all config path construction through `ConfigService.getConfigPath(subdir)`. Removed singleton pattern - now exports `config` instance. **Breaking change**: `config.json` and `llms.json` are now global-only (`~/.tenex/`); only `mcp.json` remains at project level. Migration path: Users must manually move project-level configs to global. See `ConfigService.ts` for API.
- **Pure Utilities to lib/ (COMPLETED 2025-01-19)**: Moved `string.ts`, `validation.ts`, `formatting.ts`, `error-formatter.ts`, and `time.ts` from `utils/` to `lib/`. These are now pure utilities with zero TENEX dependencies.
- **Git Utilities Consolidated (COMPLETED 2025-01-19)**: Moved `utils/worktree/` into `utils/git/worktree.ts` for better organization.
- **Circular Dependency Fixed (COMPLETED 2025-01-19)**: Removed `lib/fs/filesystem.ts` dependency on `utils/logger`. Now uses `console.error` to maintain layer separation.
- **Service File Naming (COMPLETED 2025-01-19)**: Renamed `ReportManager.ts` → `ReportService.ts` and `PubkeyNameRepository.ts` → `PubkeyService.ts` for consistency. Class names remain unchanged for now (gradual migration).

### Architecture Guidelines Added (2025-01-19)
- Created [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) with comprehensive architectural principles
- Created [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) with developer workflow guidelines
- Added pre-commit hook for AI-powered architecture review
- Added `lint:architecture` script for static architecture checks

### Ongoing Improvements (Gradual Migration)
- **Service naming consistency**: Gradually rename remaining services to use "Service" suffix (e.g., `ReportManager` → `ReportService` class, `PubkeyNameRepository` → `PubkeyService` class). Files already renamed; class renames will follow in separate PRs.
- **Service subdirectory grouping**: Group related services into subdirectories (e.g., `services/delegation/`, `services/reports/`) when 3+ related files exist.
- **Dependency injection pattern**: Gradually convert singletons to DI pattern with exported convenience instances.
- **Remove barrel exports**: Phase out `services/index.ts` barrel export in favor of direct imports from service subdirectories.

### Known Issues to Address
- **`tools/` vs `services/mcp` coupling**: MCP discovery/install logic spans both tool implementations and services. Action: document ownership each time we touch these areas. Currently: `services/mcp/` handles server lifecycle, `tools/implementations/mcp_discover.ts` discovers tools on Nostr (appropriate separation).
- **Status publisher naming**: Three status publishers exist (`daemon/StatusPublisher.ts` as `DaemonStatusService`, `services/status/StatusPublisher.ts`, `services/OperationsStatusPublisher.ts`). Consider renaming for clarity: `DaemonStatusService`, `ProjectStatusService`, `OperationsStatusService`.

### Target State (Long-Term Vision)
See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for detailed target architecture. Key goals:
1. ✅ Strict layer separation with zero upward dependencies
2. ✅ Pure utilities isolated in `lib/`
3. 🔄 Consistent "Service" suffix for all business logic
4. ⏳ Subdirectory grouping for related services
5. ⏳ Dependency injection pattern throughout
6. ⏳ Direct imports, no barrel exports

Log every relocation, ambiguity, or clean-up plan here so the roadmap stays discoverable.
