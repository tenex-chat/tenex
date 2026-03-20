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
- **`config/`**: Interactive settings editors for backend and transport configuration. `config/telegram.ts` is the operator-facing UI for per-agent Telegram bot tokens, DM allowlists, and chat/topic bindings backed by `AgentStorage` plus global `whitelistedIdentities`.
- **`daemon.ts` + `daemon/`**: Starts the long-running orchestrator and UI loop by delegating to `src/daemon`.
- **`doctor.ts` + `doctor-transport-chat.ts` + `doctor-transport-smoke.ts` + `doctor-telegram-smoke.ts`**: Diagnostics and local runtime harnesses. `doctor transport-smoke` is the branch-safe validation path for transport-neutral ingress plus injected publishers without relays, `doctor transport-chat` is the reusable session harness for exercising the same seams across multiple turns with persisted artifacts and either `local` or `nostr` simulated ingress, and `doctor telegram-smoke` boots a mock Bot API server so the Telegram gateway can be exercised end to end, including first-contact project binding for shared bots across multiple projects, without live relays or a live bot token.
- **`setup/`**: Guided onboarding flows for LLM and embed providers (ties into `ConfigService` and `llm/LLMServiceFactory`).

### Agents Runtime (`src/agents`)
- **Registry & Storage**: `AgentRegistry`, `AgentStorage`, and `constants` describe built-in agent definitions, dynamic injection, and on-disk metadata.
- **Execution (`execution/*`)**: `AgentExecutor` and related utilities orchestrate prompt construction, tool execution, tracking, and session lifecycle. They depend on `llm/`, `prompts/`, `tools/registry`, `conversations/ConversationStore`, `nostr/AgentPublisher`, and `services/ral` for delegation state, including explicit silent-completion requests triggered by the core `no_response()` tool.
- `MessageCompiler` now only compiles canonical full or delta history. Request-time context reduction for full-history providers lives in `execution/context-management.ts`, which instantiates `ai-sdk-context-management` middleware plus optional tools using the graduated default stack (`SystemPromptCachingStrategy`, `ToolResultDecayStrategy`, `SummarizationStrategy`, `ScratchpadStrategy`, `ContextUtilizationReminderStrategy`). The decay strategy is pressure-aware, emits forecast warnings for at-risk tool results, and forwards runtime telemetry into OpenTelemetry span events while passing request identity into AI SDK `providerOptions` / `experimental_context`.
- **Utilities & Types**: Provide normalization, context building, shared typings, and shared tool-name parsing/categorization (see `src/agents/tool-names.ts`) for consumers such as `event-handler`.
- **Guideline**: Agents should never import `commands/*`. For configuration, import `{ config }` from `@/services` and use `config.getConfigPath(subdir)` for paths or `config.loadConfig()` for configuration data; pass loaded config through constructors when needed.

### Conversations (`src/conversations`)
- **Persistence & Stores**: `ConversationStore` persists canonical `ConversationRecord`s plus per-agent context-management scratchpads to the filesystem. `persistence/ToolMessageStorage` manages tool-call/result storage.
- **Services**: `ConversationResolver`, `ConversationSummarizer`, and `MetadataDebounceManager` coordinate resolution, summarization, and metadata updates.
- **Prompt Projection**: `PromptBuilder.ts` exposes the canonical prompt-building API for turning `ConversationRecord[]` into provider-facing `PromptMessage[]`, while `MessageBuilder.ts` remains the compatibility implementation module underneath.
- **Formatting**: `formatters/*` and `formatters/utils/*` produce human-readable outputs for UI/debug tooling.
- **Responsibility**: This is the single source of truth for conversation context; other modules must request data via these services rather than reading persistence files directly.

### Event Handling & Workflow Orchestration
- **`src/events`**: Typed schemas, utils, and constants for every event TENEX produces or consumes (Nostr kinds, internal telemetry events). Also hosts layer-2 runtime contracts and testing adapters that higher layers can depend on without importing concrete transport implementations (for example `events/runtime/AgentRuntimePublisher.ts`, `AgentRuntimePublisherFactory.ts`, `InboundEnvelope.ts`, `LocalInboundAdapter.ts`, `RecordingRuntimePublisher.ts`). Treat as a contract; modifications require updates to this file.
- **`src/event-handler`**: Domain orchestrators triggered by incoming Nostr events. `reply` now terminates at the transport-neutral ingress seam by normalizing Nostr events through `nostr/NostrInboundAdapter` and delegating the canonical envelope to `services/ingress/RuntimeIngressService`.

### Nostr Integration (`src/nostr`)
- **Core Clients**: `ndkClient` bootstraps NDK, while `AgentPublisher`, `AgentEventEncoder/Decoder`, `NostrInboundAdapter`, `InboundEnvelopeEventBridge`, `InterventionPublisher`, and `kinds.ts` encapsulate event creation and transport-specific normalization. `InboundEnvelopeEventBridge` now preserves transport tags such as Telegram chat/thread/message IDs so legacy Nostr-shaped execution context can still render transport-native replies.
- **Key Derivation** (`keys.ts`): Provides `pubkeyFromNsec()` helper to derive pubkeys from nsec strings. Isolates NDK key operations so services don't import NDK directly.
- **Utilities & Types**: Provide helper functions for relays, batching, and metadata so higher layers never manipulate `NDKEvent` directly.
- **Guideline**: Any code that needs to publish Nostr events uses `AgentPublisher` or helper APIs; do not access NDK objects outside this module (tests can mock as needed).

### LLM Layer (`src/llm`)
- **Services & Factories**: `LLMServiceFactory`, `service.ts`, and `LLMConfigEditor` manage provider initialization, request pipelines, and CLI editing tasks.
- **Selection & Middleware**: `utils/ModelSelector` and `chunk-validators` coordinate model choice and response validation. `middleware/message-sanitizer` is a `transformParams` middleware that sanitizes message arrays before every API call (strips trailing assistant messages, empty-content messages) to prevent provider rejections.
- **Providers**: `providers/base`, `providers/standard`, `providers/agent`, and `providers/registry` house adapters for Claude, OpenRouter, Ollama, Codex App Server, and mock providers. Agent providers use specialized adapters:
  - **`CodexAppServerToolsAdapter.ts`**: Converts TENEX tools to SDK MCP format for Codex App Server (in-process, via `createSdkMcpServer`).
- **Guideline**: Agents and services never talk to provider SDKs directly—use this module to ensure credentials, retries, and middleware are consistent.

### Prompts (`src/prompts`)
- **`core/` + `fragments/` + `utils/`**: Compose reusable prompt pieces, compile structured system prompts, and host helper utilities. Execution modules should only import builders from here, never inline long prompt strings.
- `fragments/04-scratchpad-practice.ts` adds proactive scratchpad guidance only when the current execution still has access to `scratchpad(...)`, so prompt instructions stay aligned with tool restrictions.

### Tools System (`src/tools`)
- **Implementations**: `implementations/*.ts` are the concrete actions agents can call (delegation, RAG management, scheduling, file access, shell, silent completion, etc.). They should delegate to `services/*` when stateful operations are required. The `fs_*` tools are thin TENEX adapters over the external `ai-sdk-fs-tools` package, with TENEX-only hooks for agent-home access, report protection, tool-result loading, and LLM-backed file analysis.
- **Registry & Runtime**: `registry.ts`, `utils.ts`, and executor/tests coordinate tool metadata, zod schemas, result marshalling, and permission enforcement.
- **Dynamic Tools**: User-defined tool factories are loaded by `services/DynamicToolService` from `~/.tenex/tools` and surfaced through the tool registry. Tests live under `tools/__tests__`.
- **Guideline**: Keep external I/O localized; when a tool needs long-lived resources (RAG DB, scheduler), call the relevant service rather than re-implementing logic.

### Services Catalog (`src/services`)
Use this section to understand each service’s scope and dependencies:

| Service | Location | Responsibility & Key Dependencies |
| --- | --- | --- |
| `ConfigService` (+ `config/`) | `src/services/ConfigService.ts` | **Centralized configuration service** - Loads, validates, and caches config files from `~/.tenex/` (global only: `config.json`, `llms.json`). Exports `config` instance (no singleton pattern). Provides `getConfigPath(subdir?)` and `getProjectsBase()` for centralized path construction. Initializes providers via `llm/LLMServiceFactory`. All modules must import `{ config }` from `@/services/ConfigService` - never construct `~/.tenex` paths manually. |
| `AgentDispatchService` (+ `dispatch/`) | `src/services/dispatch/AgentDispatchService.ts` | Orchestrates chat message routing, delegation completion handling, injection strategy, and agent execution. Hosts `AgentRouter` + `DelegationCompletionHandler` for routing and completion bookkeeping. |
| `RuntimeIngressService` (+ `ingress/`) | `src/services/ingress/RuntimeIngressService.ts` | Canonical conversation-plane ingress seam. Accepts transport-neutral inbound envelopes, emits ingress telemetry, and forwards provided or bridged legacy events into `AgentDispatchService` while migration is in progress. |
| `ChannelSessionStore` | `src/services/ingress/ChannelSessionStoreService.ts` | Persists per-channel conversation continuity for non-Nostr gateways. Telegram DMs/groups use it to map `(project, agent, channel)` to the last inbound message ID and active conversation ID so later turns can be bridged back into the correct conversation without native Nostr threading. |
| Runtime publisher factory | `src/services/runtime/runtime-publisher-factory.ts` | Composes the concrete runtime publisher implementation for a project runtime. This stays in the services layer because it selects between concrete Nostr and Telegram publishers while returning the transport-neutral `AgentRuntimePublisherFactory` contract. |
| `IdentityService` (+ `identity/`) | `src/services/identity/IdentityService.ts` | Transport-neutral identity facade. Prefers linked Nostr pubkeys for canonical naming, but persists transport-only principal bindings and display names through `IdentityBindingStore` so non-Nostr transports can participate without becoming pubkeys. |
| `AuthorizedIdentityService` | `src/services/identity/AuthorizedIdentityService.ts` | Resolves whether a transport principal is allowed to interact with TENEX. Merges global `whitelistedIdentities`, legacy `whitelistedPubkeys` (as `nostr:<pubkey>` principals), and per-agent overrides such as Telegram DM allowlists. |
| `RALRegistry` | `src/services/ral/RALRegistry.ts` | Tracks active RALs, pending/completed delegations, queued injections, stop-signal aborts, and explicit silent-completion requests. Used by `AgentExecutor`, `services/dispatch/DelegationCompletionHandler`, and runtime tools such as `no_response()`. |
| `DynamicToolService` | `src/services/DynamicToolService.ts` | Watches `~/.tenex/tools`, compiles TS tool factories, and exposes them to the tool registry. Uses Bun file APIs and `agents/execution` contexts. |
| `EmbeddingProvider` | `src/services/embedding/` | High-level wrapper over embedding vendors for RAG. Works with `services/rag/*.ts`. |
| `LLMOperationsRegistry` | `src/services/LLMOperationsRegistry.ts` | Tracks active LLM requests per project for throttling and telemetry; referenced by scheduler/status publishers. |
| `NDKAgentDiscovery` + agent metadata | `src/services/agents/` | Subscribes to relays to discover external agents, resolves agent metadata, and caches pubkey lookups via `PubkeyService`. |
| `EscalationService` | `src/services/agents/EscalationService.ts` | Resolves escalation targets for `ask` tool with auto-add capability. Determines whether to use a configured escalation agent (auto-adding to project if needed) or fall back to project owner. Exports `resolveEscalationTarget()`, `getConfiguredEscalationAgent()`. |
| `NudgeService` | `src/services/nudge/` | Emits reminders/prompts to stalled agents or phases; depends on scheduler + conversations. |
| `OperationsStatusService` & `status/` | `src/services/status/` | Broadcasts progress events to daemon/status consumers. Depends on scheduler and Nostr publisher provided by daemon. |
| `ProjectContext` + `ProjectContextStore` | `src/services/projects/` | Maintains view of open projects, current working dirs, and runtime metadata used by CLI + daemon. |
| `PubkeyService` | `src/services/PubkeyService.ts` | Provides caching and lookup for pubkey display names from Nostr. |
| `Telegram*` services | `src/services/telegram/` | Telegram transport gateway and delivery adapters. `TelegramGatewayCoordinator` is the daemon-facing shared poller for bot tokens reused across multiple project runtimes; it persists first-contact project bindings via `TelegramChannelBindingStore` / `TelegramPendingBindingStore`, prompts users to choose a project when a DM/group is ambiguous, expires stale pending selections after 24 hours, normalizes updates through `TelegramInboundAdapter`, enriches group/topic turns with `TelegramChatContextService` snapshots (chat title, admins, member count, recently seen speakers), and uses `TelegramBindingPersistenceService` to backfill project-scoped `agent.telegram.chatBindings` plus hot-reload the runtime after auto-bound groups/topics. `TelegramChatContextStore` is the runtime JSON cache for those best-effort snapshots. `TelegramDeliveryService` / `TelegramRuntimePublisher` deliver replies back to Telegram while preserving Nostr as the canonical agent identity substrate, and `telegram-runtime-tool-publications.ts` owns the Telegram-only allowlist/formatter for mirrored runtime tool events such as `todo_write`. `TelegramGatewayService` remains the single-project gateway used by focused tests and lower-level harnesses. |
| `TrustPubkeyService` | `src/services/trust-pubkeys/` | Determines if a pubkey should be trusted (heeded or ignored). A pubkey is trusted if it's whitelisted in config, the backend's own pubkey, or a registered agent. Enforces precedence: whitelisted > backend > agent. Provides both async (`isTrusted`) and sync (`isTrustedSync`) checks with backend pubkey caching. |
| `SystemPubkeyListService` | `src/services/trust-pubkeys/SystemPubkeyListService.ts` | Rebuilds `$TENEX_BASE_DIR/daemon/whitelist.txt` (one pubkey per line) with all known system pubkeys: whitelisted users, backend, stored agents, plus call-site additions. Used before kind:0 profile publishes to keep daemon whitelist current. |
| `RAG*` services | `src/services/rag/` | Manage LanceDB collections, document ingestion, query APIs, subscriptions, and embedding integration (`EmbeddingProviderFactory`, `RagSubscriptionService`). Tools in `src/tools/implementations/rag_*` should call these. |
| `ReportService` | `src/services/reports/` | Creates, lists, updates task reports; used by reporting tools. |
| `SchedulerService` | `src/services/scheduling/` | Cron-like scheduling for follow-ups/nudges/tasks with persistence via `services/status`. |
| `PromptCompilerService` | `src/services/prompt-compiler/` | Compiles agent lessons with user comments into Effective Agent Instructions (TIN-10). Takes Base Agent Instructions (from `agent.instructions` in Kind 4199 event) and synthesizes them with Lessons + NIP-22 comments to produce the final instructions the agent uses. Disk caching at `~/.tenex/agents/prompts/`. One instance per agent, registered during `ProjectRuntime.start()`. Handles subscription to kind 1111 comment events filtered by `#K: [4129]`. |
| `InterventionService` | `src/services/intervention/InterventionService.ts` | Monitors agent work completions and triggers human-replica review if user doesn't respond within timeout. Uses lazy agent resolution (deferred until ProjectContext is available), serialized atomic state writes, and retry/backoff for failed publishes. State is project-scoped (`~/.tenex/intervention_state_<dTag>.json`, with legacy coordinate-path fallback on load). |
| `APNsService` + `APNsClient` | `src/services/apns/` | Apple Push Notification service integration. `APNsService` subscribes to kind 25000 config-update events (NIP-44 encrypted), manages an in-memory device-token store (`Map<pubkey, Set<token>>`), and exposes `notifyIfNeeded()` for the ask tool to push alerts when the user is offline. `APNsClient` handles HTTP/2 delivery to Apple's APNs API with ES256 JWT authentication and automatic token refresh. Decryption is delegated to `nostr/encryption` to respect the "NDK only for types" rule. |
| Event Context Utils | `src/services/event-context/` | Factory functions for creating `EventContext` instances for Nostr event encoding. Provides `createEventContext(context, options?: CreateEventContextOptions | string)` (creates context with pre-resolved completion recipient) and `resolveCompletionRecipient(conversationStore: ConversationStore | undefined)` (resolves immediate delegator from conversation's delegation chain). Used by `AgentExecutor` to support proper routing of delegation completions back to immediate delegators. |

**Guideline**: Place orchestrators that maintain state or integrate external infrastructure here. Pure helper logic should live in `src/lib` or inside the domain folder that uses it.

### Daemon Runtime (`src/daemon`)
- **Core Runtime**: `Daemon`, `ProjectRuntime`, and `SubscriptionManager` run background loops that subscribe to relays and process events.
- **Guideline**: Keep daemon modules dependent on services + stores, never the other way around.

### Telemetry & Logging
- **`src/telemetry`**: OpenTelemetry initialization, exporters, span helpers. Modules needing tracing should import helpers rather than reconfiguring OTel.

### Utilities & Shared Libraries
- **`src/lib`**: Platform-level primitives such as file-system helpers (`lib/fs/*`) and pure utilities (`string.ts`, `error-formatter.ts`, `time.ts`). **Critical rule**: `lib/` must have ZERO imports from TENEX modules (`utils/`, `services/`, etc.). Use `console.error` instead of TENEX logger.
- **`src/utils`**: Higher-level utilities tied to TENEX behavior (Nostr parsing, lesson formatting, Git helpers including worktree management, logger configuration). Can import from `lib/` and infrastructure, but not from `services/` or higher layers.

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
- **Configuration Architecture (COMPLETED 2025-01-18)**: Centralized all config path construction through `ConfigService.getConfigPath(subdir)`. Removed singleton pattern - now exports `config` instance. **Breaking change**: `config.json` and `llms.json` are now global-only (`~/.tenex/`). Migration path: Users must manually move project-level configs to global. See `ConfigService.ts` for API.
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
