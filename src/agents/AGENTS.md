# Agents Runtime (Layer 3)

## Directory Purpose
Core multi-agent coordination system. Manages agent definitions, registration, execution orchestration, tool invocation, and session lifecycle. This is the heart of TENEX's agent execution model.

## Architecture Overview

```
agents/
├── AgentRegistry.ts       # Built-in agent definitions
├── AgentStorage.ts        # On-disk agent metadata
├── agent-loader.ts        # Dynamic agent loading
├── tool-names.ts          # Tool name parsing/categorization
├── tool-normalization.ts  # Tool input normalization
├── constants.ts           # Agent constants
├── types.ts               # Shared type definitions
├── execution/             # Core execution engine (18 files)
│   ├── AgentExecutor.ts   # Main orchestrator
│   ├── MessageCompiler.ts # Provider-aware message assembly
│   ├── StreamSetup.ts     # LLM stream configuration
│   ├── StreamCallbacks.ts # Stream event handling
│   ├── ToolExecutionTracker.ts
│   ├── SessionManager.ts
│   └── ...
├── supervision/           # Agent supervision logic
└── __tests__/            # Unit tests
```

## Commands

```bash
# Test agents module
bun test src/agents/

# Test execution specifically
bun test src/agents/execution/

# Test with coverage
bun test --coverage src/agents/
```

## Key Components

### AgentExecutor (`execution/AgentExecutor.ts`)
The main orchestrator for agent execution. Coordinates:
- Prompt construction via `prompts/`
- Tool execution via `tools/registry`
- Conversation state via `conversations/ConversationStore`
- Event publishing via `nostr/AgentPublisher`
- Delegation state via `services/ral`

### MessageCompiler (`execution/MessageCompiler.ts`)
Assembles provider-aware `messages[]` payloads:
- Full vs delta message compilation
- Dynamic execution context injection (todos, response routing)
- Provider-specific formatting

### Tool Execution Flow
```
User Request → AgentExecutor → ToolExecutionTracker → Tool Registry → Service
                    ↓
              Stream Callbacks → Nostr Publisher → User Response
```

## Conventions

### Configuration Access
```typescript
// CORRECT: Import config from services
import { config } from "@/services/ConfigService";
const configPath = config.getConfigPath("agents");

// WRONG: Constructing paths manually
const configPath = path.join(process.env.HOME, ".tenex", "agents");
```

### Import Restrictions
```typescript
// FORBIDDEN: Never import from commands/
import { something } from "@/commands/daemon";  // Layer violation!

// ALLOWED: Import from lower layers
import { RALRegistry } from "@/services/ral";
import { ToolRegistry } from "@/tools/registry";
import { buildSystemPrompt } from "@/prompts/core";
```

### Creating New Agent Types
1. Define in `AgentRegistry.ts` for built-in agents
2. Use `AgentStorage.ts` for dynamic/user-defined agents
3. Follow execution patterns in `execution/` directory

## Common Patterns

### Agent Context Building
```typescript
import { buildAgentContext } from "@/agents/context";

const context = buildAgentContext({
  agentId: "my-agent",
  projectId: "project-123",
  conversationId: "conv-456",
  workingDirectory: "/path/to/project"
});
```

### Tool Name Handling
```typescript
import { parseToolName, categorizeToolCall } from "@/agents/tool-names";

const { domain, action } = parseToolName("rag_query");
// domain: "rag", action: "query"
```

## Agent Identity Preservation Policy

Agent files (`.tenex/agents/<pubkey>.json`) are **NEVER deleted** when an agent is removed from projects. Instead:

1. **Inactive Status**: Agents removed from all projects get `status: "inactive"`
2. **Identity Preserved**: The agent's `pubkey` and `nsec` are retained indefinitely
3. **Reactivation**: When the same agent is added to a project, it reactivates with original keys
4. **Filtering**: `getProjectAgents()` filters out inactive agents automatically

### Why This Matters
- Nostr identity (pubkey) is permanent - re-using keys maintains trust/reputation
- Prevents "identity churn" where the same agent gets different keys over time
- Enables agent hibernation/reactivation patterns

### Code Implications
```typescript
// CORRECT: Use removeAgentFromProject (sets inactive status)
await agentStorage.removeAgentFromProject(pubkey, projectDTag);

// DEPRECATED: deleteAgent permanently destroys identity
await agentStorage.deleteAgent(pubkey);  // Logs warning, use sparingly
```

### Agent Lifecycle States
```
┌─────────────┐     removeAgentFromProject()     ┌──────────────┐
│   ACTIVE    │ ─────────────────────────────────▶│   INACTIVE   │
│ (in project)│                                  │ (preserved)  │
└─────────────┘                                  └──────────────┘
       ▲                                                │
       │              addAgentToProject()               │
       └────────────────────────────────────────────────┘
```

## Anti-Patterns

```typescript
// REJECT: Holding conversation state in executor
class AgentExecutor {
  private messages = [];  // State should be in ConversationStore
}

// REJECT: Direct NDK access
import { NDKEvent } from "@nostr-dev-kit/ndk";
const event = new NDKEvent();  // Use AgentPublisher instead

// REJECT: Inline prompt strings
const systemPrompt = "You are an agent...";  // Use prompts/

// REJECT: Deleting agents to remove from project
await agentStorage.deleteAgent(pubkey);  // Use removeAgentFromProject instead
```

## Testing

Tests live in `__tests__/` subdirectory:
```bash
src/agents/__tests__/
├── AgentRegistry.test.ts
├── execution/
│   ├── AgentExecutor.test.ts
│   └── MessageCompiler.test.ts
```

Use mock providers from `src/test-utils/mock-llm/` for execution tests.

## Dependencies

**Imports from:**
- `services/` - RALRegistry, ConfigService, dispatch
- `tools/` - ToolRegistry, tool execution
- `prompts/` - System prompt building
- `conversations/` - ConversationStore
- `nostr/` - AgentPublisher, event encoding
- `llm/` - Provider adapters

**Imported by:**
- `daemon/` - Background agent orchestration
- `event-handler/` - Event-triggered execution

## Related
- [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md) - Architecture reference
- `../services/ral/` - Delegation state management
- `../tools/` - Tool implementations
- `../prompts/` - Prompt construction
