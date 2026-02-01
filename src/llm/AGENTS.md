# LLM Layer (Layer 2)

## Directory Purpose
Abstraction layer for Large Language Model providers. Manages provider initialization, request pipelines, model selection, and response validation. **Agents and services never talk to provider SDKs directly** - this module ensures credentials, retries, and middleware are consistent.

## Architecture Overview

```
llm/
├── LLMServiceFactory.ts   # Provider initialization
├── service.ts             # Core LLM service
├── LLMConfigEditor.ts     # CLI config editing
│
├── providers/
│   ├── base/              # Base provider interfaces
│   ├── standard/          # Standard providers (OpenAI, Claude, etc.)
│   ├── agent/             # Agent-specific adapters
│   │   ├── ClaudeCodeToolsAdapter.ts
│   │   ├── TenexStdioMcpServer.ts
│   │   └── CodexCliProvider.ts
│   └── registry/          # Provider registration
│
├── middleware/
│   ├── flight-recorder.ts # Request/response logging
│   └── ...
│
├── utils/
│   └── ModelSelector.ts   # Model selection logic
│
├── meta/                  # Provider metadata
└── __tests__/
```

## Commands

```bash
# Test LLM module
bun test src/llm/

# Test specific provider
bun test src/llm/providers/

# Test with coverage
bun test --coverage src/llm/
```

## Key Components

### LLMServiceFactory
Creates and configures LLM provider instances:

```typescript
import { LLMServiceFactory } from "@/llm/LLMServiceFactory";

const provider = await LLMServiceFactory.create({
  provider: "claude",
  model: "claude-sonnet-4-20250514"
});
```

### Provider Types

**Standard Providers** (`providers/standard/`):
- Claude (Anthropic)
- OpenAI
- OpenRouter
- Ollama
- Gemini

**Agent-Specific Providers** (`providers/agent/`):
- **ClaudeCodeToolsAdapter**: Converts TENEX tools to SDK MCP format for Claude Code (in-process)
- **TenexStdioMcpServer**: Generates stdio MCP server config for Codex CLI
- **CodexCliProvider**: Spawns Codex CLI with TENEX tools via MCP

### Model Selection
```typescript
import { ModelSelector } from "@/llm/utils/ModelSelector";

const model = ModelSelector.select({
  task: "complex-reasoning",
  budget: "standard"
});
```

### Middleware
```typescript
// Flight recorder logs all LLM requests/responses
import { flightRecorder } from "@/llm/middleware/flight-recorder";

// Applied automatically by LLMServiceFactory
```

## Conventions

### Provider Implementation
All providers must implement the base interface:

```typescript
import { LLMProvider } from "@/llm/providers/base";

class MyProvider implements LLMProvider {
  async complete(messages: Message[]): Promise<Response> { }
  async stream(messages: Message[]): AsyncIterable<Chunk> { }
}
```

### Tool Adaptation Pattern

**For Claude Code** (in-process):
```typescript
// ClaudeCodeToolsAdapter converts TENEX tools to MCP format
const mcpTools = adapter.convertTools(tenexTools);
```

**For Codex CLI** (subprocess):
```typescript
// TenexStdioMcpServer generates launch config with env vars
const serverConfig = TenexStdioMcpServer.generateConfig({
  projectId,
  agentId,
  conversationId,
  workingDirectory,
  currentBranch
});
// CodexCliProvider spawns subprocess with this config
```

### Adding New Providers

1. Create provider in `providers/standard/` or `providers/agent/`
2. Implement `LLMProvider` interface
3. Register in `providers/registry/`
4. Add configuration schema
5. Update `LLMServiceFactory`

## Anti-Patterns

```typescript
// REJECT: Direct SDK access outside this module
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();  // Use LLMServiceFactory instead

// REJECT: Hardcoded API keys
const apiKey = "sk-...";  // Use ConfigService

// REJECT: Provider-specific code in agents/
if (provider === "claude") {
  // Special handling
}
// Provider differences should be abstracted here

// REJECT: Inline retry logic
for (let i = 0; i < 3; i++) {
  try { await llm.complete(); break; }
  catch { continue; }
}
// Retries are handled by middleware
```

## Testing

Use mock providers from `src/test-utils/mock-llm/`:

```typescript
import { createMockLLMProvider } from "@/test-utils/mock-llm";

describe("MyFeature", () => {
  it("should handle LLM response", async () => {
    const mockLLM = createMockLLMProvider({
      response: "Mocked response"
    });

    const result = await myFeature.process(mockLLM);
    expect(result).toBe("expected");
  });
});
```

## Dependencies

**Imports from:**
- `utils/` - Utility functions
- `lib/` - Pure utilities
- `events/` - Event schemas
- External: AI SDK packages, provider SDKs

**Imported by:**
- `agents/` - Agent execution
- `services/` - LLM operations registry
- `commands/` - Setup commands

## Environment Variables

Providers read credentials from environment:
- `ANTHROPIC_API_KEY` - Claude
- `OPENAI_API_KEY` - OpenAI
- `OPENROUTER_API_KEY` - OpenRouter
- `GEMINI_API_KEY` - Gemini

Or from `~/.tenex/llms.json` via ConfigService.

## Related
- [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md) - Architecture reference
- `../agents/` - Agent execution (consumer)
- `../services/ConfigService.ts` - Configuration
- `../tools/` - Tool definitions for MCP adapters
