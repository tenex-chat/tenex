# Services Catalog (Layer 3)

## Directory Purpose
**Stateful orchestration layer**. Services hold state, integrate external infrastructure, and coordinate workflows over time. This is the largest domain module with 22+ subdirectories.

## Architecture Overview

```
services/
├── ConfigService.ts       # Centralized configuration (root-level, small)
├── PubkeyService.ts       # Pubkey caching and lookup
├── TrustPubkeyService.ts  # Trust determination
├── LLMOperationsRegistry.ts # Request throttling
├── DynamicToolService.ts  # User-defined tool loading
│
├── dispatch/              # Chat routing, delegation handling
│   ├── AgentDispatchService.ts
│   ├── AgentRouter.ts
│   └── DelegationCompletionHandler.ts
│
├── ral/                   # Delegation/RAL state
│   ├── RALRegistry.ts
│   └── types.ts
│
├── rag/                   # LanceDB, document ingestion
│   ├── RagService.ts
│   ├── RagSubscriptionService.ts
│   └── collections/
│
├── agents/                # NDK agent discovery
│   └── NDKAgentDiscovery.ts
│
├── agents-md/             # AGENTS.md compilation
│   └── AgentInstructionCompiler.ts
│
├── mcp/                   # MCP server management
│   ├── MCPManager.ts      # Lifecycle management (single source of truth)
│   └── mcpInstaller.ts    # Server installation
│
├── projects/              # Project context management
│   ├── ProjectContext.ts
│   └── ProjectContextStore.ts
│
├── embedding/             # Embedding provider wrappers
├── scheduling/            # Cron-like scheduling
├── status/                # Progress event broadcasting
├── reports/               # Task reports
├── nudge/                 # Stalled agent reminders
├── prompt-compiler/       # Lesson + comment synthesis
├── system-reminder/       # System reminder utilities (<system-reminder> tags)
└── trust-pubkeys/         # Trust determination
```

## Commands

```bash
# Test all services
bun test src/services/

# Test specific service
bun test src/services/ral/
bun test src/services/rag/

# Check architecture
bun run lint:architecture
```

## Key Services

### ConfigService
Centralized configuration management. **Always use this for config access.**

```typescript
import { config } from "@/services/ConfigService";

// Get config paths
const agentsPath = config.getConfigPath("agents");
const projectsBase = config.getProjectsBase();

// Load configuration
const llmConfig = config.loadConfig();
```

**Key Rules:**
- `config.json` and `llms.json` are **global only** (`~/.tenex/`)
- Only `mcp.json` is project-level
- Never construct `~/.tenex` paths manually

### RALRegistry (`ral/`)
Tracks active RALs (Request-Agent Lifecycle), pending/completed delegations, queued injections, and stop-signal aborts.

```typescript
import { RALRegistry } from "@/services/ral";

const ral = ralRegistry.getRAL(conversationId);
ral.addPendingDelegation(delegationId);
```

### AgentDispatchService (`dispatch/`)
Orchestrates chat message routing and delegation completion handling.

```typescript
import { AgentDispatchService } from "@/services/dispatch";

await dispatchService.dispatch({
  conversationId,
  message,
  agentId
});
```

### MCPManager (`mcp/`)
**Single source of truth** for MCP server lifecycle management.

```typescript
import { MCPManager } from "@/services/mcp";

// Start, stop, health check MCP servers
await mcpManager.startServer(serverConfig);
const tools = await mcpManager.getTools(serverId);
```

## Conventions

### Service Naming
- Always suffix with `Service`: `ProjectStatusService`, `RAGService`
- Use PascalCase for filenames matching class name

### Directory Organization
```typescript
// When 3+ related files exist, create subdirectory:
services/
├── ral/
│   ├── RALRegistry.ts
│   ├── types.ts
│   └── index.ts          # Barrel export

// Small services stay at root:
├── ConfigService.ts
├── PubkeyService.ts
```

### Dependency Injection Pattern
```typescript
// PREFERRED: Accept dependencies in constructor
class MyService {
  constructor(private ragService: RAGService) {}
}

// ACCEPTABLE: Use exported instances
import { config } from "@/services/ConfigService";
```

### Import Patterns
```typescript
// CORRECT: Direct subdirectory imports
import { RALRegistry } from "@/services/ral";
import { MCPManager } from "@/services/mcp";

// WRONG: Barrel imports
import { RALRegistry, MCPManager } from "@/services";
```

## Anti-Patterns

```typescript
// REJECT: Service importing from commands/
import { daemonCommand } from "@/commands/daemon";  // Layer violation!

// REJECT: Services without "Service" suffix
class ProjectManager { }  // Should be ProjectManagerService

// REJECT: Business logic in utils/
// If it needs state or coordinates workflows, it's a service

// REJECT: Manual config path construction
const configPath = `${process.env.HOME}/.tenex/config.json`;
// Use: config.getConfigPath()
```

## Service Boundaries

| Service | Owns | Does NOT Own |
|---------|------|--------------|
| `ConfigService` | Config loading, path construction | Provider initialization |
| `MCPManager` | Server lifecycle, tool caching | Server installation |
| `mcpInstaller` | Server installation | Runtime management |
| `RALRegistry` | Delegation state, stop signals | Agent execution |
| `RAGService` | Document ingestion, queries | Embedding generation |
| `EmbeddingProvider` | Embedding generation | Document storage |

## Testing

Services should be tested with dependency injection:

```typescript
describe("MyService", () => {
  it("should work", async () => {
    const mockRag = createMockRAGService();
    const service = new MyService(mockRag);

    await service.doSomething();

    expect(mockRag.query).toHaveBeenCalled();
  });
});
```

## Dependencies

**Imports from:**
- `utils/` - Utility functions
- `lib/` - Pure utilities
- `llm/` - LLM providers
- `nostr/` - Event publishing
- `events/` - Event schemas

**Imported by:**
- `agents/` - Execution engine
- `commands/` - CLI commands
- `daemon/` - Background processing
- `event-handler/` - Event routing
- `tools/` - Tool implementations

## Related
- [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md) - Full service catalog
- `../agents/` - Agent execution
- `../tools/` - Tool implementations
