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

### Rust Workspace (`crates`)
- **`Cargo.toml`**: Root Rust workspace manifest for the daemon migration. It is separate from the Bun package manifest and should stay scoped to Rust crates.
- **`crates/tenex-daemon`**: Future Rust control-plane crate for the daemon migration described in `docs/rust/`. Its current executable responsibility is cross-language compatibility verification: Rust consumes the same fixture artifacts as Bun tests for NIP-01 event encoding, daemon subscription filters, routing decisions, daemon filesystem state, worker protocol frames, RAL lifecycle fixtures, and publish-outbox diagnostics/maintenance reports. `worker_process.rs` is the first worker-supervision slice: it spawns framed stdio workers, validates `ready`, sends daemon-to-worker protocol frames, captures stderr, can drive ignored Rust-to-Bun smoke tests, and exposes the opt-in `test:rust:publish-interop` gate for real Bun worker publish requests relayed through Rust and consumed by the TypeScript Nostr client path. `dispatch_queue.rs` owns the first filesystem-backed worker dispatch queue contract under `daemon/workers/dispatch-queue.jsonl`, including typed queued/leased/terminal records, synced append helpers, sequence-checked replay, and EOF-only truncated-final-record recovery while failing closed on corrupt or malformed complete records. `ral_journal.rs` owns the filesystem RAL journal contract under `daemon/ral/journal.jsonl`, including Rust/TS-compatible pending delegation shape, terminal worker error states, synced appends, replay from the TS lifecycle fixture, and the non-authoritative compaction cache under `daemon/ral/snapshot.json`. `ral_scheduler.rs` derives in-memory scheduler state from journal replay, bootstraps from the on-disk journal, persists versioned scheduler snapshots, allocates monotonic RAL numbers per `(projectId, agentPubkey, conversationId)`, rejects duplicate active triggering events, validates claim tokens, and plans orphan reconciliation records for claimed RALs whose workers are missing without becoming production daemon authority yet. `publish_outbox.rs` is the first Rust-owned publishing slice: it validates worker-signed NIP-01 publish requests, persists accepted records under `publish-outbox/pending/`, builds correlated `publish_result.status=accepted` frames, drains pending records into `publish-outbox/published/` or `publish-outbox/failed/` through a publisher interface, owns event IDs globally across outbox states, can requeue retryable failed records using durable `nextAttemptAt` metadata, can rebuild versioned publish diagnostics directly from filesystem records, and exposes a library-first maintenance pass for requeue/drain/diagnostic snapshots that future startup hooks and `doctor` repair commands can call. `src/bin/publish-outbox.rs` is a thin internal binary over that library contract for inspect/maintain JSON output; it is intended as a future `doctor publish-outbox` adapter target, not a separate user-facing surface. `relay_publisher.rs` speaks the NIP-01 WebSocket publish protocol for exact signed events and reports per-relay `OK` outcomes. The crate must not take production daemon authority until the milestone gates in `docs/rust/implementation-milestones-and-quality-gates.md` are satisfied.

### Command Layer (`src/commands`)
- **`agent/`**: User-facing subcommands for listing/removing/operating agents, including the interactive installed-agent manager for 4199 installs and permanent deletions. Orchestrates `agents/` runtimes, `services/ConfigService`, and `nostr` publishers; no business logic should remain inside command handlers.
- **`config/`**: Interactive settings editors for backend and transport configuration. `config/telegram.ts` is the operator-facing UI for single-bot-per-agent Telegram transport config plus the global Telegram DM allowlist, while remembered chat/topic-to-project bindings remain derived runtime state backed by `AgentStorage`, `TransportBindingStore`, and global `whitelistedIdentities`.
- **`daemon.ts` + `daemon/`**: Starts the long-running orchestrator and UI loop by delegating to `src/daemon`.
- **`doctor.ts` + `doctor/`**: Diagnostics and repair entrypoint — agent refetch, orphan detection/purge, agent auto-categorization backfill, explicit state migrations via `doctor migrate`, and the `doctor publish-outbox` operator surface. The publish-outbox subcommands delegate to the Rust adapter/binary for JSON inspect/status and repair/drain behavior instead of duplicating Rust outbox state logic in TypeScript.
- **`setup/`**: Guided onboarding flows for LLM and embed providers (ties into `ConfigService` and `llm/LLMServiceFactory`).

### Agents Runtime (`src/agents`)
- **Registry & Storage**: `AgentRegistry`, `AgentStorage`, `categorizeAgent`, and `backfillAgentCategories` describe built-in agent definitions, dynamic injection, on-disk metadata, and category inference/backfill.
- **Execution (`execution/*`)**: `AgentExecutor` and related utilities orchestrate prompt construction, tool execution, tracking, and session lifecycle. They depend on `llm/`, `prompts/`, `tools/registry`, `conversations/ConversationStore`, `nostr/AgentPublisher`, and `services/ral` for delegation state, including explicit silent-completion requests triggered by the core `no_response()` tool.
- `execution/worker/protocol.ts` owns the Bun-side stream helpers for the Rust daemon worker protocol. `execution/worker/agent-worker.ts` is the Bun worker process entrypoint; it speaks the framed protocol and currently exposes the explicit mock execution engine used by Rust/Bun supervision gates. `execution/worker/dispatch-adapter.ts` is the disabled-by-default TypeScript-daemon bridge selected by `TENEX_AGENT_WORKER=1`; it only routes fresh first-turn executions to a child worker and keeps resumptions/delegation completions on the in-process executor. These files must stay aligned with `events/runtime/AgentWorkerProtocol.ts` and the shared fixtures under `src/test-utils/fixtures/worker-protocol/`.
- **Supervision (`supervision/*`)**: Owns heuristic registration, runtime verification, enforcement state, and correction decisions for post-completion and pre-tool checks. `SupervisorOrchestrator` evaluates detections, optionally calls the supervision LLM, and applies `once-per-execution` versus `repeat-until-resolved` semantics. `PostCompletionChecker` bridges this subsystem into `AgentExecutor`, using reminder overlays plus machine-visible state transitions such as `ask()` pending delegations and `todo_write` updates to determine whether a turn may actually finish.
- `MessageCompiler` now only compiles canonical full or delta history. Request-time context reduction for full-history providers lives in `execution/context-management.ts`, which instantiates `ai-sdk-context-management` middleware plus optional tools using the graduated default stack (`CompactionToolStrategy`, `ToolResultDecayStrategy`, `RemindersStrategy`). Reminders are applied inside the library and may become append-only runtime overlays or provider-specific stable system blocks. TENEX runs tool-result decay continuously rather than gating it on a working-budget threshold. The decay strategy remains pressure-aware, emits forecast warnings for at-risk tool results, and forwards runtime telemetry into OpenTelemetry span events while passing request identity into AI SDK `providerOptions` / `experimental_context`.
- `execution/prompt-history.ts` freezes the per-agent, pre-context-management prompt view that was actually sent to the model. It appends newly visible canonical conversation messages plus standalone runtime overlays such as system reminders, but never rewrites older user messages. `execution/prompt-cache.ts` detects when a provider has actually established prompt cache usage so reminder overlays can stay ephemeral until the frozen history has a real cache anchor. `StreamSetup` and `StreamCallbacks.prepareStep` both assemble requests through this module before calling `request-preparation.ts`.
- **Utilities & Types**: Provide normalization, context building, shared typings, and shared tool-name parsing/categorization (see `src/agents/tool-names.ts`) for consumers such as `event-handler`.
- **Guideline**: Agents should never import `commands/*`. For configuration, import `{ config }` from `@/services` and use `config.getConfigPath(subdir)` for paths or `config.loadConfig()` for configuration data; pass loaded config through constructors when needed.

### Conversations (`src/conversations`)
- **Persistence & Stores**: `ConversationStore` persists canonical `ConversationRecord`s, per-agent context-management compactions, per-agent frozen prompt histories, and per-agent context-management reminder state to the filesystem as JSON transcripts. The prompt-history branch stores model-facing replay state (frozen canonical prompt projections plus runtime overlay entries) separately from the canonical transcript, while reminder delta/full bookkeeping now lives in dedicated reminder state. `ConversationCatalogService` owns the per-project SQLite read model at `~/.tenex/projects/<project-dTag>/conversation-catalog.db` for metadata queries such as previews, recent-conversation lookups, participant/delegation listing, and durable conversation embedding indexing state. `persistence/ToolMessageStorage` manages tool-call/result storage.
- **Services**: `ConversationResolver`, `ConversationSummarizer`, and `MetadataDebounceManager` coordinate resolution, summarization, and metadata updates.
- **Prompt Projection**: `PromptBuilder.ts` exposes the canonical prompt-building API for turning `ConversationRecord[]` into provider-facing `PromptMessage[]`, while `MessageBuilder.ts` remains the compatibility implementation module underneath.
- **Formatting**: `formatters/*` and `formatters/utils/*` produce human-readable outputs for UI/debug tooling.
- **Presentation**: `presenters/ConversationPresenter` transforms catalog data for display, shortening IDs while preserving full IDs for lookups. The presentation layer sits between `ConversationCatalogService` (data) and tools/UI (consumers).
- **Responsibility**: Canonical transcript data lives in `ConversationStore`; metadata-style queries should go through `ConversationCatalogService` or `ConversationRegistry` compatibility APIs rather than reparsing transcript files directly.

### Event Handling & Workflow Orchestration
- **`src/events`**: Typed schemas, utils, and constants for every event TENEX produces or consumes (Nostr kinds, internal telemetry events). Also hosts layer-2 runtime contracts and testing adapters that higher layers can depend on without importing concrete transport implementations (for example `events/runtime/AgentRuntimePublisher.ts`, `AgentRuntimePublisherFactory.ts`, `InboundEnvelope.ts`, `AgentWorkerProtocol.ts`, `LocalInboundAdapter.ts`, `RecordingRuntimePublisher.ts`). Treat as a contract; modifications require updates to this file.
- **`src/event-handler`**: Domain orchestrators triggered by incoming Nostr events. `reply` now terminates at the transport-neutral ingress seam by normalizing Nostr events through `nostr/NostrInboundAdapter` and delegating the canonical envelope to `services/ingress/RuntimeIngressService`.

### Nostr Integration (`src/nostr`)
- **Core Clients**: `ndkClient` bootstraps NDK, while `AgentPublisher`, `AgentEventEncoder/Decoder`, `NostrInboundAdapter`, `InboundEnvelopeEventBridge`, `InterventionPublisher`, and `kinds.ts` encapsulate event creation and transport-specific normalization. `InboundEnvelopeEventBridge` now preserves transport tags such as Telegram chat/thread/message IDs so legacy Nostr-shaped execution context can still render transport-native replies.
- **Key Derivation** (`keys.ts`): Provides `pubkeyFromNsec()` helper to derive pubkeys from nsec strings. Isolates NDK key operations so services don't import NDK directly.
- **Utilities & Types**: Provide helper functions for relays, batching, and metadata so higher layers never manipulate `NDKEvent` directly.
- **Guideline**: Any code that needs to publish Nostr events uses `AgentPublisher` or helper APIs; do not access NDK objects outside this module (tests can mock as needed).

### LLM Layer (`src/llm`)
- **Services & Factories**: `LLMServiceFactory`, `service.ts`, and `LLMConfigEditor` manage provider initialization, request pipelines, and CLI editing tasks.
- **Selection & Middleware**: `utils/ModelSelector` and `chunk-validators` coordinate model choice and response validation. `middleware/message-sanitizer` is a `transformParams` middleware that sanitizes message arrays before every API call (strips trailing assistant messages, empty-content messages) to prevent provider rejections. `multimodal-preparation.ts` performs provider-aware image input normalization at the request boundary, including Ollama URL-to-base64 conversion for vision-capable models.
- **Providers**: `providers/base`, `providers/standard`, `providers/agent`, and `providers/registry` house adapters for Claude, OpenRouter, Ollama, Codex, and mock providers. Agent providers use specialized adapters:
  - **`CodexToolsAdapter.ts`**: Converts TENEX tools to SDK MCP format for Codex app-server sessions (in-process, via `createSdkMcpServer`).
- **Guideline**: Agents and services never talk to provider SDKs directly—use this module to ensure credentials, retries, and middleware are consistent.

### Prompts (`src/prompts`)
- **`core/` + `fragments/` + `utils/`**: Compose reusable prompt pieces, compile structured system prompts, and host helper utilities. Execution modules should only import builders from here, never inline long prompt strings.
- Telegram-specific fragments inject both live chat context and transport rules, including the reserved `telegram_voice` marker used for outbound voice replies.

### Tools System (`src/tools`)
- **Implementations**: `implementations/*.ts` are the concrete actions agents can call (delegation, project mutation, RAG management, scheduling, file access, shell, silent completion, etc.). They should delegate to `services/*` when stateful operations are required. The `fs_*` tools are thin TENEX adapters over the external `ai-sdk-fs-tools` package, with TENEX-only hooks for agent-home access, report protection, tool-result loading, and LLM-backed file analysis. The `shell` tool now resolves TENEX-scoped `.env` overlays through `AgentEnvironmentService` before spawning subprocesses.
- Context-injected tools still belong to the registry/tool layer: `send_message` is exposed only when an agent has remembered Telegram transport bindings and delegates proactive delivery to `services/telegram/TelegramDeliveryService` rather than holding transport state itself.
- **Registry & Runtime**: `registry.ts`, `utils.ts`, and executor/tests coordinate tool metadata, zod schemas, result marshalling, and permission enforcement.
- **Dynamic Tools**: User-defined tool factories are loaded by `services/DynamicToolService` from `~/.tenex/tools` and surfaced through the tool registry. Tests live under `tools/__tests__`.
- **Guideline**: Keep external I/O localized; when a tool needs long-lived resources (RAG DB, scheduler), call the relevant service rather than re-implementing logic.

### Services Catalog (`src/services`)
Use this section to understand each service’s scope and dependencies:

| Service | Location | Responsibility & Key Dependencies |
| --- | --- | --- |
| `ConfigService` (+ `config/`) | `src/services/ConfigService.ts` | **Centralized configuration service** - Loads, validates, and caches config files from `~/.tenex/` (global only: `config.json`, `llms.json`). Exports `config` instance (no singleton pattern). Provides `getConfigPath(subdir?)`, `getProjectMetadataPath(projectId)`, `getConversationCatalogPath(projectId)`, and `getProjectsBase()` for centralized path construction. Initializes providers via `llm/LLMServiceFactory`. All modules must import `{ config }` from `@/services/ConfigService` - never construct `~/.tenex` paths manually. |
| `TeamService` (+ `teams/`) | `src/services/teams/TeamService.ts` | Loads local JSON-defined teams, normalizes membership, resolves team names to lead pubkeys for delegation, and computes prompt-facing team context with mtime/size-aware caching. |
| `AgentEnvironmentService` | `src/services/AgentEnvironmentService.ts` | Resolves TENEX shell environment overlays from `$TENEX_BASE_DIR/.env`, `$TENEX_BASE_DIR/projects/<project-dTag>/.env`, and the agent home `~/.env` with precedence `agent > project > global` over inherited process env. Bootstraps missing agent-home `.env` files with `NSEC`, preserves the host home as `TENEX_HOST_HOME`, and is currently consumed by the `shell` tool. |
| `AgentDispatchService` (+ `dispatch/`) | `src/services/dispatch/AgentDispatchService.ts` | Orchestrates chat message routing, delegation completion handling, injection strategy, and agent execution. Hosts `AgentRouter` + `DelegationCompletionHandler` for routing and completion bookkeeping. |
| `RuntimeIngressService` (+ `ingress/`) | `src/services/ingress/RuntimeIngressService.ts` | Canonical conversation-plane ingress seam. Accepts transport-neutral inbound envelopes, emits ingress telemetry, and forwards provided or bridged legacy events into `AgentDispatchService` while migration is in progress. |
| `ChannelSessionStore` | `src/services/ingress/ChannelSessionStoreService.ts` | Persists per-channel conversation continuity for non-Nostr gateways. Telegram DMs/groups use it to map `(project, agent, channel)` to the last inbound message ID and active conversation ID so later turns can be bridged back into the correct conversation without native Nostr threading. |
| `TransportBindingStore` | `src/services/ingress/TransportBindingStoreService.ts` | Persists transport-native channel-to-project bindings for remembered first-contact routing decisions. Records the transport explicitly in `transport-bindings.json` and currently backs Telegram auto-binding. |
| Runtime services | `src/services/runtime/` | Composes concrete runtime publisher implementations for project runtimes and tracks active project runtime registrations. `runtime-publisher-factory.ts` selects between Nostr and Telegram publishers while returning the transport-neutral `AgentRuntimePublisherFactory` contract. `ProjectRuntimeRegistryService` maps active project IDs to their `ProjectContext` and `AgentExecutor` so service-layer routing paths such as kill wake-ups can resume work in the project that owns the waiting agent. |
| `IdentityService` (+ `identity/`) | `src/services/identity/IdentityService.ts` | Transport-neutral identity facade. Prefers linked Nostr pubkeys for canonical naming, but persists transport-only principal bindings and display names through `IdentityBindingStore` so non-Nostr transports can participate without becoming pubkeys. |
| `AuthorizedIdentityService` | `src/services/identity/AuthorizedIdentityService.ts` | Resolves whether a transport principal is allowed to interact with TENEX. Merges global `whitelistedIdentities`, legacy `whitelistedPubkeys` (as `nostr:<pubkey>` principals), and per-agent overrides such as Telegram DM allowlists. |
| `RALRegistry` + `ral/` helpers | `src/services/ral/` | `RALRegistry` remains the singleton coordinator for active RALs, pending/completed delegations, queued injections, stop-signal aborts, and explicit silent-completion requests. Focused owned helpers now live beside it: `DelegationRegistry`, `KillSwitchRegistry`, `HeuristicViolationManager`, `MessageInjectionQueue`, and `ExecutionTimingTracker`. Used by `AgentExecutor`, `services/dispatch/DelegationCompletionHandler`, and runtime tools such as `no_response()`. |
| `DynamicToolService` | `src/services/DynamicToolService.ts` | Watches `~/.tenex/tools`, compiles TS tool factories, and exposes them to the tool registry. Uses Bun file APIs and `agents/execution` contexts. |
| `EmbeddingProvider` | `src/services/embedding/` | High-level wrapper over embedding vendors for RAG. Works with `services/rag/*.ts`. |
| `LLMOperationsRegistry` | `src/services/LLMOperationsRegistry.ts` | Tracks active LLM requests per project for throttling and telemetry; referenced by scheduler/status publishers. |
| `MigrationService` | `src/services/migrations/` | Orchestrates TENEX state migrations based on global `config.json` migration `version`. Each migration step lives in its own isolated file under `migrations/`, and `doctor migrate` is the explicit operator entrypoint. |
| `AnalysisTelemetryService` + `AnalysisSchemaManager` | `src/services/analysis/` | Records LLM/context telemetry and owns the SQLite schema, migrations, versioning, views, and backfill helpers used by the analysis read models. `AnalysisSchemaManager` is injectable and can initialize or migrate a database independently of the telemetry runtime. |
| `AnalysisQueryService` | `src/services/analysis/AnalysisQueryService.ts` | Read-side query service for the analysis telemetry database and derived views. |
| `NDKAgentDiscovery` + agent metadata | `src/services/agents/` | Subscribes to relays to discover external agents, resolves agent metadata, and caches pubkey lookups via `PubkeyService`. |
| `AgentConfigUpdateService` | `src/services/agents/AgentConfigUpdateService.ts` | Canonical interpreter for kind:24020 Tenex agent config events. Owns partial-update semantics, global override clearing, project-scoped delta conversion, skill snapshots, and PM flag application so daemon/event-handler only route and reload. |
| `EscalationService` | `src/services/agents/EscalationService.ts` | Resolves escalation targets for `ask` tool with auto-add capability. Determines whether to use a configured escalation agent (auto-adding to project if needed) or fall back to project owner. Exports `resolveEscalationTarget()`, `getConfiguredEscalationAgent()`. |
| `SkillService` + `SkillWhitelistService` + `SkillIdentifierResolver` | `src/services/skill/` | `SkillService` resolves the effective local skill set (see below) and also fetches active skill content/tool permissions . `SkillWhitelistService` caches whitelisted skills from kind:14202 bookmark-style events with prompt-facing slug IDs plus short-id fallbacks. `SkillIdentifierResolver` maps prompt IDs back to canonical event IDs for delegation. `tool-permissions.ts` aggregates tool permission directives (only-tool, allow-tool, deny-tool) across active skills. Daemon startup subscribes to whitelist-cache updates and eagerly hydrates whitelisted skills into the authoritative local skill store. |
| `OperationsStatusService` & `status/` | `src/services/status/` | Broadcasts progress events to daemon/status consumers. Depends on scheduler and Nostr publisher provided by daemon. |
| `ProjectContext` + `ProjectContextStore` | `src/services/projects/` | Maintains view of open projects, current working dirs, and runtime metadata used by CLI + daemon. |
| `PubkeyService` | `src/services/PubkeyService.ts` | Provides caching and lookup for pubkey display names from Nostr. |
| `Telegram*` services | `src/services/telegram/` | Telegram transport gateway and delivery adapters. `TelegramGatewayService` is the canonical token-keyed Telegram gateway: it registers project runtimes behind a bot token, resolves each inbound channel to a project via `TransportBindingStore` / `ChannelSessionStore`, prompts for project selection only when a channel is still unbound and multiple projects are candidates, expires stale pending selections after 24 hours, normalizes updates through `TelegramInboundAdapter`, enriches group/topic turns with `TelegramChatContextService` snapshots (chat title, topic title, admins, member count, recently seen speakers), and uses `TelegramBindingPersistenceService` to remember project-scoped runtime transport bindings without backfilling agent JSON. `TelegramChatContextStore` is the runtime JSON cache for those best-effort snapshots. `TelegramDeliveryService` / `TelegramRuntimePublisherService` deliver replies back to Telegram while preserving Nostr as the canonical agent identity substrate; outbound delivery now also interprets the reserved `telegram_voice` marker to upload local voice-note files via the Bot API. `telegram-runtime-tool-publications.ts` owns the Telegram-only allowlist/formatter for mirrored runtime tool events such as `todo_write`. |
| `TrustPubkeyService` | `src/services/trust-pubkeys/` | Determines if a pubkey should be trusted (heeded or ignored). A pubkey is trusted if it's whitelisted in config, the backend's own pubkey, or a registered agent. Enforces precedence: whitelisted > backend > agent. Provides both async (`isTrusted`) and sync (`isTrustedSync`) checks with backend pubkey caching. |
| `SystemPubkeyListService` | `src/services/trust-pubkeys/SystemPubkeyListService.ts` | Rebuilds `$TENEX_BASE_DIR/daemon/whitelist.txt` (one pubkey per line) with all known system pubkeys: whitelisted users, backend, stored agents, plus call-site additions. Used before kind:0 profile publishes to keep daemon whitelist current. |
| `RAG*` services | `src/services/rag/` | Manage LanceDB collections, document ingestion, query APIs, subscriptions, and embedding integration (`EmbeddingProviderFactory`, `RagSubscriptionService`). Tools in `src/tools/implementations/rag_*` should call these. |
| `SchedulerService` | `src/services/scheduling/` | Cron-like scheduling for follow-ups and tasks with per-project persistence in `~/.tenex/projects/<project-dTag>/schedules.json`. Scheduled task targets are stored as agent slugs and resolved to pubkeys at execution time. |
| `PromptCompilerRegistryService` + `PromptCompilerService` | `src/services/prompt-compiler/` | Runtime-owned lesson compilation stack (TIN-10). `ProjectRuntime` creates one `PromptCompilerRegistryService` per project and registers every agent with it. The registry owns one `PromptCompilerService` per agent, synchronizes lesson/comment snapshots from `ProjectContext`, and exposes read-only compiled instructions to prompt assembly. `PromptCompilerService` performs LLM synthesis of Base Agent Instructions + lessons + lesson comments, keeps last-good compiled instructions in memory, persists scoped disk cache at `~/.tenex/agents/prompts/<project-dTag>/`, debounces recompilation, and republishes kind:0 profiles after successful compilation. It no longer owns NDK subscriptions or lesson-comment ingestion. |
| `ProjectEventPublishService` | `src/services/projects/ProjectEventPublishService.ts` | Fetches the latest owner-authored kind:31933 event for a project, applies membership/metadata mutations against relay state, strips signing fields, and republishes via `Nip46SigningService`. Used by `modify_project` plus project membership sync paths. |
| `TeamService` | `src/services/teams/` | Loads local team definitions from disk, normalizes membership, resolves team names to lead agents, and computes prompt-facing team context plus delegation routing metadata. |
| `InterventionService` | `src/services/intervention/InterventionService.ts` | Monitors agent work completions and triggers human-replica review if user doesn't respond within timeout. Uses lazy agent resolution (deferred until ProjectContext is available), serialized atomic state writes, and retry/backoff for failed publishes. State is project-scoped (`~/.tenex/intervention_state_<dTag>.json`, with legacy coordinate-path fallback on load). |
| `APNsService` + `APNsClient` | `src/services/apns/` | Apple Push Notification service integration. `APNsService` subscribes to kind 25000 config-update events (NIP-44 encrypted), manages an in-memory device-token store (`Map<pubkey, Set<token>>`), and exposes `notifyIfNeeded()` for the ask tool to push alerts when the user is offline. `APNsClient` handles HTTP/2 delivery to Apple's APNs API with ES256 JWT authentication and automatic token refresh. Decryption is delegated to `nostr/encryption` to respect the "NDK only for types" rule. |
| Event Context Utils | `src/services/event-context/` | Factory functions for creating `EventContext` instances for Nostr event encoding. Provides `createEventContext(context, options?: CreateEventContextOptions | string)` (creates context with pre-resolved completion recipient) and `resolveCompletionRecipient(conversationStore: ConversationStore | undefined)` (resolves immediate delegator from conversation's delegation chain). Used by `AgentExecutor` to support proper routing of delegation completions back to immediate delegators. |
| `SkillService` | `src/services/skill/` | `SkillService` resolves the effective local skill set across `$TENEX_BASE_DIR/home/<agent-short-pubkey>/skills/<id>/`, `$TENEX_BASE_DIR/projects/<project-dTag>/skills/<id>/`, `$TENEX_BASE_DIR/skills/<id>/`, and `~/.agents/skills/<id>/` with precedence `agent > project > global > ~/.agents`. Local skill metadata comes from `SKILL.md` YAML frontmatter, and remote kind:4202 skills hydrate back into the global store as spec-style `SKILL.md` files with top-level `name`/`description` plus `metadata.tenex-event-id` when applicable. Agents only refer to skills by local directory ID; `SkillData.identifier` is always that local ID, `skills_set` validates against the effective local skill set and persists those IDs in `ConversationStore.selfAppliedSkills` per agent pubkey. `skill-blocking.ts` expands blocked skill IDs across identifier/shortId/eventId aliases and filters runtime activation requests before fetch. `renderSkill()` (exported from `prompts/fragments/12-skills.ts`) formats skills for system prompt injection, and `StreamCallbacks.prepareStep` rehydrates stored local skill IDs each step so mid-RAL changes take effect immediately. |

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
- **`src/test-utils`**: Mock LLM providers, nostr fixtures, and scenario harnesses shared by unit tests. Cross-language golden fixtures live under `src/test-utils/fixtures/` so Bun and Rust tests can consume the same protocol artifacts. Any new reusable fixture belongs here to avoid duplicating test helpers.
- **`scripts/` (root)**: Build scripts, telemetry helpers, and CLI-adjacent automation. Place supporting tooling under `tools/` when needed, and document additions here when they influence runtime organization. `tools/rust-migration/protocol-probe-worker.ts` is a child-process probe for the Rust/Bun worker protocol smoke test.

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
- **Service Naming (COMPLETED 2025-01-19)**: Renamed `PubkeyNameRepository.ts` → `PubkeyService.ts` for consistency. Also renamed the class `PubkeyNameRepository` → `PubkeyService`.
- **Services Reorganization (COMPLETED 2025-12-20)**: Grouped related services into subdirectories: `projects/` (ProjectContext, ProjectContextStore), `embedding/` (EmbeddingProvider), `scheduling/` (SchedulerService), `skill/` (SkillService, SkillWhitelistService, SkillIdentifierResolver), `agents/` (NDKAgentDiscovery). Each subdirectory has an `index.ts` barrel export.

### Architecture Guidelines Added (2025-01-19)
- Created [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) with comprehensive architectural principles
- Created [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) with developer workflow guidelines
- Added pre-commit hook for AI-powered architecture review
- Added `lint:architecture` script for static architecture checks

### Ongoing Improvements (Gradual Migration)
- **Prompt-history cache anchoring (2026-04-13)**: `src/agents/execution/prompt-cache.ts` now gates durable reminder overlays on observed provider cache usage. Cold histories resend current-state reminders each turn instead of carrying historical reminder overlays until a real cache anchor exists.
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
