# TENEX Architecture - Code Reference Guide

Quick reference for finding key architectural components in the codebase.

## Entry Points

| Command | File | Description |
|---------|------|-------------|
| `tenex daemon` | `/src/commands/daemon.ts` (99 lines) | Multi-project daemon with EventMonitor |
| `tenex project run` | `/src/commands/project/run.ts` (153 lines) | Single-project listener |
| `tenex agent` | `/src/commands/agent/` | Agent management commands |
| CLI Main | `/src/tenex.ts` (53 lines) | Commander.js CLI setup |

## Core Daemon Components

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **EventMonitor** | `/src/daemon/EventMonitor.ts` | 128 | Listens to Nostr for project events, triggers spawning |
| **ProcessManager** | `/src/daemon/ProcessManager.ts` | 134 | Spawns/tracks child processes (project run) |
| **ProjectManager** | `/src/daemon/ProjectManager.ts` | 346 | Initializes projects, loads from Nostr |

## Event Handling Pipeline

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **SubscriptionManager** | `/src/daemon/SubscriptionManager.ts` | - | Manages unified daemon subscriptions |
| **EventHandler** | `/src/event-handler/index.ts` | 411 | Routes events by kind, initiates processing |
| **AgentRouter** | `/src/event-handler/AgentRouter.ts` | 152 | Determines which agents should process event |
| **Reply Handler** | `/src/event-handler/reply.ts` | 280 | Handles chat messages (kind 1111) |
| **New Conversation** | `/src/event-handler/newConversation.ts` | 57 | Handles new threads (kind 11) |
| **Project Handler** | `/src/event-handler/project.ts` | 167 | Handles project updates (kind 31933) |

## Agent Management

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **AgentRegistry** | `/src/agents/AgentRegistry.ts` | 612 | Master registry for project agents |
| **AgentStorage** | `/src/agents/AgentStorage.ts` | 276 | Persistent agent storage (~/.tenex/agents/) |
| **AgentExecutor** | `/src/agents/execution/AgentExecutor.ts` | 514 | Executes agents with LLM calls |
| **Agent Types** | `/src/agents/types.ts` | 141 | AgentInstance, AgentConfig types |
| **Agent Constants** | `/src/agents/constants.ts` | 133 | Tool lists, delegation tools |

## Project Context & Services

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **ProjectContext** | `/src/services/ProjectContext.ts` | 307 | Global project state, agent access |
| **ConfigService** | `/src/services/ConfigService.ts` | 505 | Load/save configs (global & project) |
| **StatusPublisher** | `/src/services/status/StatusPublisher.ts` | 341 | Publishes kind 24010 status events every 30s |
| **SchedulerService** | `/src/services/SchedulerService.ts` | 238 | Scheduler singleton for delayed tasks |
| **DynamicToolService** | `/src/services/DynamicToolService.ts` | 240 | Dynamic tool loading service |
| **MCPService** | `/src/services/mcp/MCPManager.ts` | 287 | MCP server management |
| **RagSubscriptionService** | `/src/services/rag/RagSubscriptionService.ts` | 146 | RAG operations |

## Conversations & Coordination

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **ConversationCoordinator** | `/src/conversations/index.ts` | 289 | Manages conversations per project |
| **ConversationResolver** | `/src/conversations/services/ConversationResolver.ts` | 236 | Resolves which conversation an event belongs to |
| **AgentMetadataStore** | `/src/conversations/services/AgentMetadataStore.ts` | 159 | Stores agent-specific conversation metadata |

## LLM & Operations

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **LLMOperationsRegistry** | `/src/services/LLMOperationsRegistry.ts` | 224 | Tracks active LLM operations |
| **OperationsStatusPublisher** | `/src/services/OperationsStatusPublisher.ts` | 223 | Publishes operation status (kind 24113) |
| **DelegationRegistry** | `/src/services/DelegationRegistry.ts` | 892 | Handles agent delegations |

## Nostr Integration

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **NDK Client** | `/src/nostr/ndkClient.ts` | 94 | NDK singleton initialization |
| **AgentPublisher** | `/src/nostr/AgentPublisher.ts` | 473 | Publishes agent responses to Nostr |
| **AgentEventDecoder** | `/src/nostr/AgentEventDecoder.ts` | 203 | Decodes agent-related event structure |
| **Event Types** | `/src/events/` | Multiple | NDK event subclasses (NDKProject, NDKAgent, etc) |

## Storage & Persistence

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **agentStorage** | `/src/agents/AgentStorage.ts` | 276 | Global agent persistence |
| **EventRouter** | `/src/daemon/EventRouter.ts` | 443 | Per-project event deduplication & routing |
| **ConversationStorage** | `/src/conversations/storage/ConversationStorage.ts` | 203 | Conversation history persistence |

## LLM Integration

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **LLMService Factory** | `/src/llm/` | Multiple | LLM service creation & streaming |
| **LLMLogger** | `/src/logging/LLMLogger.ts` | 187 | Logs LLM operations & costs |

## Tool System

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **Tool Registry** | `/src/tools/registry.ts` | 342 | Tool registration & validation |
| **Tool Implementations** | `/src/tools/implementations/` | Multiple | Individual tool implementations |
| **ToolExecutionTracker** | `/src/agents/execution/ToolExecutionTracker.ts` | 396 | Tracks tool execution in agents |

## Utilities

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **CLI Error Handler** | `/src/utils/cli-error.ts` | 52 | Formats CLI errors |
| **Error Formatter** | `/src/utils/error-formatter.ts` | 42 | Standardizes error messages |
| **Logger** | `/src/utils/logger.ts` | 54 | Pino-based logger |
| **Graceful Shutdown** | `/src/utils/process.ts` | 46 | Handles Ctrl+C cleanup |

## Data Flow Entry Points

### Event Reception → Agent Execution
```
EventMonitor.handleEvent() [daemon/EventMonitor.ts:46]
  → ProjectManager.ensureProjectExists() [daemon/ProjectManager.ts:154]
  → ProcessManager.spawnProjectRun() [daemon/ProcessManager.ts:21]
  → SubscriptionManager.handleIncomingEvent() [commands/run/SubscriptionManager.ts:239]
  → EventHandler.handleEvent() [event-handler/index.ts:58]
  → AgentRouter.resolveTargetAgents() [event-handler/AgentRouter.ts]
  → AgentExecutor.execute() [agents/execution/AgentExecutor.ts]
  → AgentPublisher.publish() [nostr/AgentPublisher.ts]
```

### Project Initialization
```
projectRunCommand [commands/project/run.ts:22]
  → ensureProjectInitialized() [utils/projectInitialization.ts]
  → ProjectManager.loadAndInitializeProjectContext() [daemon/ProjectManager.ts:168]
  → AgentRegistry.loadFromProject() [agents/AgentRegistry.ts:56]
  → setProjectContext() [services/ProjectContext.ts:280]
```

### Status Publishing
```
StatusPublisher.startPublishing() [services/status/StatusPublisher.ts:41]
  → publishStatusEvent() [services/status/StatusPublisher.ts:107]
  → createStatusEvent() [services/status/StatusPublisher.ts:60]
  → event.publish() [NDK]
```

## Key Constants

| Constant | File | Value | Purpose |
|----------|------|-------|---------|
| STATUS_INTERVAL_MS | `/src/services/status/StatusPublisher.ts` | 30,000 | 24010 publish interval |
| PROJECT_STATUS | `/src/llm/types.ts` | 24010 | Ephemeral project status kind |
| AGENT_CONFIG_UPDATE | `/src/llm/types.ts` | 24020 | Agent config change kind |
| OPERATIONS_STATUS | `/src/llm/types.ts` | 24113 | LLM operations status kind |
| STREAMING_RESPONSE | `/src/llm/types.ts` | 24111 | Streaming response kind |
| STOP_EVENT_KIND | `/src/event-handler/index.ts` | 24134 | Stop LLM operations kind |

## Type Definitions

| Type | File | Purpose |
|------|------|---------|
| `AgentInstance` | `/src/agents/types.ts` | In-memory agent with signer & execution |
| `StoredAgent` | `/src/agents/AgentStorage.ts` | Persistent agent definition |
| `ProjectContext` | `/src/services/ProjectContext.ts` | Project-level state singleton |
| `ExecutionContext` | `/src/agents/execution/types.ts` | Agent execution environment |
| `Conversation` | `/src/conversations/types.ts` | Conversation state |
| `NDKProject` | `/src/@types/ndk.d.ts` | Project event type |

## Configuration Files

| Config | Location | Purpose |
|--------|----------|---------|
| Global Config | `~/.tenex/config.json` | Whitelisted pubkeys, LLM configs |
| Project Config | `.tenex/config.json` | Project naddr, description |
| Agent Storage | `~/.tenex/agents/<pubkey>.json` | Agent definition & keys |
| Processed Events | `.tenex/projects/{projectId}/processed-events.json` | Per-project event deduplication cache (EventRouter) |
| Conversations | `.tenex/conversations/<id>.json` | Conversation history |

## Service Initialization Order

### Project Run Command
1. `ensureProjectInitialized()` → ProjectContext
2. `mcpService.initialize()`
3. `SchedulerService.initialize()`
4. `RagSubscriptionService.initialize()`
5. `dynamicToolService.initialize()`
6. `ProjectDisplay.displayProjectInfo()`
7. `EventHandler.initialize()`
8. `SubscriptionManager.start()`
9. `StatusPublisher.startPublishing()`
10. `OperationsStatusPublisher.start()`
11. `setupGracefulShutdown()`

### Daemon Command
1. `initNDK()`
2. `ProjectManager` (created)
3. `ProcessManager` (created)
4. `EventMonitor` (created)
5. `SchedulerService.initialize()`
6. `dynamicToolService.initialize()`
7. `EventMonitor.start()`

## Event Kinds Used

| Kind | Name | Purpose | Ignored |
|------|------|---------|---------|
| 0 | Metadata | User metadata | ✓ |
| 1 | Text Note | Agent responses | |
| 3 | Contacts | Contact lists | ✓ |
| 11 | Thread | New conversations | |
| 1111 | GenericReply | Chat messages | |
| 513 | Metadata | Conversation metadata | |
| 24010 | Project Status | Agent status | ✓ |
| 24020 | Agent Config | Agent config updates | |
| 24111 | Typing Indicator | Streaming response | ✓ |
| 24112 | Typing Stop | Streaming end | ✓ |
| 24113 | Operations Status | LLM operation status | ✓ |
| 24134 | Stop Event | Stop LLM operations | |
| 30023 | Article/Spec | Specification documents | |
| 31933 | Project | Project definition | |

## File Organization by Responsibility

### Orchestration
- `/src/commands/` - CLI commands
- `/src/daemon/` - Daemon-specific components

### Event Processing
- `/src/event-handler/` - Event routing
- `/src/commands/run/SubscriptionManager.ts` - Subscriptions

### Agent Management
- `/src/agents/` - Agent registry, execution
- `/src/agents/execution/` - Agent execution strategies

### Project State
- `/src/services/ProjectContext.ts` - Project-level singleton
- `/src/services/ConfigService.ts` - Configuration

### Conversation Management
- `/src/conversations/` - Conversation coordination
- `/src/conversations/services/` - Conversation utilities

### External Integration
- `/src/nostr/` - Nostr/NDK integration
- `/src/services/mcp/` - MCP servers
- `/src/llm/` - LLM service integration

### Persistence
- Agent storage: `/src/agents/AgentStorage.ts`
- Conversation storage: `/src/conversations/storage/`
- Event tracking: `/src/commands/run/processedEventTracking.ts`

