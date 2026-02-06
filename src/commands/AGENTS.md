# Commands (Layer 4)

## Directory Purpose
CLI entry points and user-facing commands. Handlers should be **thin wrappers** that delegate to services - no business logic belongs here. This is the topmost layer that wires user input to the TENEX system.

## Architecture Overview

```
commands/
├── daemon.ts              # Daemon start/stop commands
│
├── agent/                 # Agent management commands
│   ├── list.ts
│   ├── remove.ts
│   └── configure.ts
│
├── setup/                 # Onboarding flows
│   ├── interactive.ts     # Guided setup wizard
│   ├── llm.ts             # LLM provider setup
│   └── embed.ts           # Embedding provider setup
│
└── __tests__/
```

## Commands

```bash
# Test commands
bun test src/commands/

# Run a command (from CLI)
bun run start agent list
bun run start daemon
bun run start setup
```

## Key Components

### Daemon Command
Starts the background orchestrator:

```typescript
// src/commands/daemon.ts
import { Daemon } from "@/daemon/Daemon";

export async function startDaemon(options: DaemonOptions): Promise<void> {
  const daemon = new Daemon();
  await daemon.start();
  // UI loop handled by daemon
}
```

### Agent Commands
User-facing agent management:

```typescript
// src/commands/agent/list.ts
import { AgentRegistry } from "@/agents/AgentRegistry";
import { formatAgentList } from "@/utils/formatting";

export async function listAgents(): Promise<void> {
  const registry = new AgentRegistry();
  const agents = registry.getAll();

  // Thin: just format and output
  console.log(formatAgentList(agents));
}
```

### Setup Commands
Guided onboarding flows:

```typescript
// src/commands/setup/interactive.ts
import { LLMServiceFactory } from "@/llm/LLMServiceFactory";
import { config } from "@/services/ConfigService";

export async function interactiveSetup(): Promise<void> {
  // Prompt user for provider choice
  const provider = await promptProvider();

  // Validate credentials
  await LLMServiceFactory.validate(provider);

  // Save configuration
  await config.saveConfig({ llm: provider });

  console.log("Setup complete!");
}
```

## Conventions

### Thin Handlers
Commands should be thin - parse input, delegate, format output:

```typescript
// CORRECT: Thin command handler
export async function removeAgent(agentId: string): Promise<void> {
  // 1. Validate input
  if (!agentId) throw new Error("Agent ID required");

  // 2. Delegate to service
  const storage = new AgentStorage();
  await storage.remove(agentId);

  // 3. Format output
  console.log(`Agent ${agentId} removed`);
}

// WRONG: Business logic in command
export async function removeAgent(agentId: string): Promise<void> {
  // 200 lines of cleanup logic
  // Should be in AgentStorage
}
```

### No Direct Service State
Commands don't hold state - services do:

```typescript
// WRONG: Command holding state
let cachedAgents: Agent[];
export async function listAgents(): Promise<void> {
  if (!cachedAgents) cachedAgents = await load();
  // ...
}

// CORRECT: Service manages state
export async function listAgents(): Promise<void> {
  const registry = new AgentRegistry();  // Service handles caching
  const agents = registry.getAll();
  // ...
}
```

### Commander Integration
Commands are wired via Commander in `cli.ts`:

```typescript
// src/cli.ts
import { Command } from "commander";
import { listAgents } from "@/commands/agent/list";

const program = new Command();

program
  .command("agent list")
  .description("List registered agents")
  .action(listAgents);
```

### Error Handling
Commands should catch and format errors for users:

```typescript
export async function myCommand(): Promise<void> {
  try {
    await doWork();
  } catch (error) {
    // User-friendly error message
    console.error(`Error: ${formatAnyError(error)}`);
    process.exit(1);
  }
}
```

## Anti-Patterns

```typescript
// REJECT: Business logic in commands
export async function processAgent(): Promise<void> {
  // RAG queries, LLM calls, etc.
  // Should be in services/
}

// REJECT: Commands importing other commands
import { listAgents } from "./agent/list";
export async function removeAgent(): Promise<void> {
  await listAgents();  // Should use shared service
}

// REJECT: Direct file access
import * as fs from "node:fs";
export async function loadConfig(): Promise<void> {
  const config = await fs.readFile("~/.tenex/config.json");
  // Use ConfigService
}

// REJECT: Hardcoded paths
const CONFIG_PATH = "/Users/me/.tenex";  // Use ConfigService.getConfigPath()
```

## Testing

Test commands with mocked services:

```typescript
import { listAgents } from "@/commands/agent/list";

describe("agent list", () => {
  it("should list agents", async () => {
    const mockRegistry = {
      getAll: vi.fn().mockReturnValue([{ id: "agent-1" }])
    };
    vi.mock("@/agents/AgentRegistry", () => ({
      AgentRegistry: vi.fn().mockImplementation(() => mockRegistry)
    }));

    const consoleSpy = vi.spyOn(console, "log");
    await listAgents();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("agent-1")
    );
  });
});
```

## Dependencies

**Imports from:**
- `services/` - All business logic
- `agents/` - Agent management
- `daemon/` - Background orchestration
- `llm/` - Provider configuration
- `nostr/` - Event publishing
- `utils/` - Formatting utilities

**Imported by:**
- `cli.ts` - Commander wiring
- `tenex.ts` - Runtime entry

## Related
- [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md) - Architecture reference
- `../cli.ts` - Commander setup
- `../tenex.ts` - Runtime entry
- `../services/` - Business logic
