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
- **Execution (`execution/*`)**: `AgentExecutor`, `AgentSupervisor`, `BrainstormModerator`, and related utilities orchestrate prompt construction, tool execution, tracking, and session lifecycle. They depend on `llm/`, `prompts/`, `tools/registry`, `conversations/services`, `nostr/AgentPublisher`, and `services/DelegationService`.
- **Utilities & Types**: Provide normalization, context building, and shared typings for consumers such as `event-handler`.
- **Guideline**: Agents should never import `commands/*` or directly instantiate `ConfigService`; pass configuration/context through constructors.

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
| `AgentsRegistryService` | `src/services/AgentsRegistryService.ts` | Maintains `~/.tenex/agents-registry.json`, publishes kind 14199 snapshots with project + agent pubkeys. Depends on `lib/fs`, `nostr/ndkClient`, `ConfigService`. |
| `BrainstormService` | `src/services/BrainstormService.ts` | Coordinates brainstorm phases between moderators/executors, consumes `agents/execution` and `conversations/services`. |
| `ConfigService` (+ `config/`) | `src/services/ConfigService.ts` | Loads, validates, and caches TENEX, LLM, and MCP config files; initializes providers via `llm/LLMServiceFactory`. Should be the only place touching config JSON. |
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
- **`src/lib`**: Platform-level primitives such as file-system helpers (`lib/fs/*`) and shell utilities. These should not import TENEX-specific modules.
- **`src/utils`**: Higher-level utilities tied to TENEX behavior (agent fetchers, CLI config scope, Git helpers, logger configuration). Refactor toward `lib/` when code becomes framework-agnostic. See action item below.

### Tools for Tests & Scripts
- **`src/test-utils`**: Mock LLM providers, nostr fixtures, and scenario harnesses shared by unit tests. Any new reusable fixture belongs here to avoid duplicating test helpers.
- **`scripts/` + `tools/` (root)**: Build scripts, telemetry helpers, and CLI-adjacent automation. Document additions here when they influence runtime organization.

## Organization Guidelines
1. **Domain-first placement**: Always prefer enhancing an existing module (agents, conversations, nostr, llm, tools, services, daemon) before creating new top-level directories. New folders require documenting their scope here.
2. **Clear dependency flow**: CLI → commands → services/agents → conversations/tools/nostr → telemetry/logging. Lower layers must not import higher layers.
3. **Stateful logic lives in services**: If code needs to persist data, hold onto sockets, or coordinate workflows over time, it belongs under `src/services/<domain>`.
4. **Pure helpers live near usage**: Stateless helpers that are domain-specific should be co-located (e.g., `conversations/utils`), whereas environment-agnostic helpers belong in `src/lib`.
5. **Events as contracts**: Any new event type must be added to `src/events`, with producers/consumers listed in this file. Avoid anonymous payloads.
6. **Telemetry & logging**: Extend `src/telemetry`/`src/logging` when adding spans or log formats. Other modules should request loggers from there, not instantiate ad-hoc log sinks.
7. **Documentation cadence**: When reorganizing files or adding modules, update both this inventory and `AGENTS.md` in the same PR. Mention the change under “Mixed Patterns & Action Items” until the follow-up refactor completes.

## Mixed Patterns & Action Items
- **`lib/` vs `utils/` overlap**: `utils/` currently mixes CLI helpers, Git adapters, and platform-agnostic code. Action: audit imports, migrate pure helpers to `lib/`, and scope `utils/` to TENEX-specific helpers. Track files moved here.
- **`tools/` vs `services/mcp` coupling**: MCP discovery/install logic spans both tool implementations and services. Action: document ownership each time we touch these areas and aim to consolidate under either `services/mcp` (for orchestration) or `tools/implementations` (for tool wrappers).
- **Daemon UI dependencies**: UI components import some conversation services directly. Action: move data access into daemon stores/controllers and note progress here.
- **Legacy `services/status` vs `daemon/StatusPublisher`**: Determine the single source of truth for runtime status broadcasting; document chosen direction before further work.

Log every relocation, ambiguity, or clean-up plan here so the roadmap stays discoverable.
