# Modules
* **Entrypoints & CLI (`src/tenex.ts`, `src/cli.ts`, `src/index.ts`)**: Wire telemetry, Commander commands, and binary exports. Dependency-light, delegate to commands/*.
* **Command Layer (`src/commands/`)**: User-facing CLI subcommands (agent/, daemon/, setup/, debug/). Orchestrate higher-level modules without business logic.
* **Agents Runtime (`src/agents/`)**: Registry, storage, execution (AgentExecutor), utilities. Handles prompt construction, tool calls, session lifecycle.
* **Conversations (`src/conversations/`)**: Persistence (FileSystemAdapter), services (ConversationCoordinator, ThreadService), formatters, processors. Single source of truth for context.
* **Event Handling (`src/event-handler/`)**: Orchestrates workflows from Nostr events (AgentRouter, reply handlers). Depends on agents, conversations, execution.
* **Nostr Integration (`src/nostr/`)**: NDK client, AgentPublisher, encoders/decoders, kinds. Encapsulates all Nostr interactions.
* **LLM Layer (`src/llm/`)**: LLMServiceFactory, providers (Claude, OpenAI, etc.), model selection, middleware. Consistent abstraction for LLMs.
* **Prompts (`src/prompts/`)**: Core builders, fragments, utils for composing agent prompts.
* **Tools System (`src/tools/`)**: Implementations (RAG, shell, delegation), registry, dynamic tools.
* **Services (`src/services/`)**: Stateful orchestrators like ConfigService, DelegationService, RAG services, SchedulerService, MCP services.
* **Daemon (`src/daemon/`)**: Background runtime, ProjectRuntime, Ink UI components.
* **Telemetry (`src/telemetry/`)**: OpenTelemetry setup and helpers.
* **Logging (`src/logging/`)**: Structured loggers.
* **Lib (`src/lib/`)**: Pure platform utilities (fs, string, validation). No TENEX dependencies.
* **Utils (`src/utils/`)**: TENEX-specific helpers (git, agent fetchers).

# Relationships
* Strict unidirectional layered architecture: commands/daemon/event-handler → agents/conversations/tools/services → llm/nostr/prompts/events → utils → lib (lib has ZERO upward imports).
* Events (`src/events/`) act as contracts between modules.
* Services hold state and coordinate external resources; pure logic stays in domain modules or utils.
* All modules import config from `@/services`, use AgentPublisher for Nostr publishes.
* No direct file reads outside conversations persistence; use services for state access.

# Technologies
- **Language/Runtime**: TypeScript, Bun/Node.js >=20
- **CLI/UI**: Commander.js, Ink (React terminal UI)
- **AI/LLM**: ai-sdk (@ai-sdk/openai, anthropic, etc.), OpenRouter, Ollama, custom providers (claude-code, gemini-cli)
- **Protocol**: Nostr (NDK, nostr-tools)
- **Vector DB**: LanceDB (@lancedb/lancedb)
- **Embeddings**: Transformers.js (@xenova/transformers)
- **Observability**: OpenTelemetry (traces, metrics)
- **Scheduling**: node-cron
- **Build/Test/Lint**: esbuild, Vitest, ESLint, Biome, Husky
- **Other**: Zod (validation), lodash, inquirer

# Organization
- Domain-driven folders under `src/` with strict layering and dependency flow downward.
- Stateful/integration logic in `services/`; pure utils in `lib/`; domain utils in `utils/`.
- Comprehensive documentation: MODULE_INVENTORY.md (this project's canonical architecture reference), ARCHITECTURE.md, CONTRIBUTING.md.
- Pre-commit hooks for AI architecture review, lint:architecture script.
- Git worktree integration for agent isolation.
- Boy Scout Rule enforced; all structural changes update MODULE_INVENTORY.md.
- Detailed service catalog in MODULE_INVENTORY.md table.

# High-complexity modules
**Agents Runtime (`src/agents/`)**: Core of multi-agent system. AgentRegistry manages definitions from Nostr/local. Execution pipeline (AgentExecutor) builds context from conversations, compiles prompts via prompts/, selects tools via registry, executes via LLM services, handles delegation loops via DelegationService. Tracks sessions, enforces phases (PLAN, EXECUTE, etc.). Integrates telemetry for spans. Critical for routing and parallel execution.

**Services Layer (`src/services/`)**: 15+ services managing cross-cutting concerns. ConfigService centralizes all config paths (~/.tenex/), LLM init. DelegationService publishes/wait for responses on Nostr. RAG services (LanceDB collections, embedding via EmbeddingProvider). SchedulerService for cron jobs/nudges. DynamicToolService loads user TS tools. NDKAgentDiscovery caches external agents. OperationsStatusPublisher broadcasts progress. High coordination density; each service is stateless where possible, persists via conversations/ or dedicated stores.

**Conversations (`src/conversations/`)**: Backbone for context. ConversationStore hydrates timelines from FS persistence. ThreadService manages branching/replies. SummarizationTimerManager triggers background summaries. EventProcessor converts Nostr to internal models. Formatters for debug/UI. All agents/services query here for history, never read files directly. Ensures context isolation per project/conversation.

**Tools (`src/tools/`)**: 20+ tools for file ops, shell, git, RAG query/add, MCP discover/hire, delegation. Registry validates schemas, enforces permissions. Dynamic/ loads runtime TS factories. Implementations delegate to services (e.g., rag tools → RAG services). Composable via agent reasoning.

**Daemon (`src/daemon/`)**: Long-running mode with Ink UI. SubscriptionManager relays Nostr → UI state. ProcessManagerController spawns per-project runtimes. UI components react to stores (projects, convos, agents). Status publishers feed live updates. Enables real-time collaboration monitoring.

For full details, see root `MODULE_INVENTORY.md` - the canonical source maintained with every structural change.