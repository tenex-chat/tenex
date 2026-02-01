# Prompts (Layer 2)

## Directory Purpose
Reusable prompt composition and system prompt building. Contains core prompt builders, 26+ fragment subdirectories, and utilities. **Execution modules should only import builders from here, never inline long prompt strings.**

## Architecture Overview

```
prompts/
├── core/                  # Core prompt builders
│   ├── SystemPromptBuilder.ts
│   └── ...
│
├── fragments/             # 26+ reusable prompt fragments
│   ├── agent-identity/
│   ├── tool-usage/
│   ├── response-format/
│   ├── context-injection/
│   ├── delegation/
│   ├── conversation/
│   └── ...
│
├── utils/                 # Prompt utilities
│   ├── interpolation.ts
│   ├── validation.ts
│   └── ...
│
└── __tests__/
```

## Commands

```bash
# Test prompts module
bun test src/prompts/

# Test specific fragment
bun test src/prompts/__tests__/fragments.test.ts
```

## Key Components

### SystemPromptBuilder
Compiles fragments into complete system prompts:

```typescript
import { SystemPromptBuilder } from "@/prompts/core/SystemPromptBuilder";

const builder = new SystemPromptBuilder();
const systemPrompt = builder
  .withIdentity(agentConfig)
  .withTools(availableTools)
  .withContext(projectContext)
  .build();
```

### Fragments
Reusable prompt pieces organized by concern:

```typescript
import { agentIdentityFragment } from "@/prompts/fragments/agent-identity";
import { toolUsageFragment } from "@/prompts/fragments/tool-usage";
import { responseFormatFragment } from "@/prompts/fragments/response-format";

const fragment = agentIdentityFragment({
  name: "Claude Code",
  role: "Developer",
  capabilities: ["coding", "debugging"]
});
```

### Fragment Categories

| Fragment | Purpose |
|----------|---------|
| `agent-identity/` | Agent name, role, personality |
| `tool-usage/` | Tool invocation guidelines |
| `response-format/` | Output format instructions |
| `context-injection/` | Dynamic context insertion |
| `delegation/` | Multi-agent delegation rules |
| `conversation/` | Conversation handling rules |
| `error-handling/` | Error response patterns |
| `code-style/` | Code generation conventions |

## Conventions

### No Inline Prompts
**Never inline long prompt strings in execution code:**

```typescript
// WRONG: Inline prompt string
const systemPrompt = `You are an AI assistant that helps with coding.
You should always be helpful and concise.
When writing code, follow best practices...
[500 more lines]`;

// CORRECT: Use prompt builder
import { SystemPromptBuilder } from "@/prompts/core";

const systemPrompt = new SystemPromptBuilder()
  .withIdentity(config)
  .build();
```

### Fragment Structure
Each fragment is a function that returns a string:

```typescript
// src/prompts/fragments/tool-usage/index.ts
export function toolUsageFragment(options: ToolUsageOptions): string {
  return `
## Tool Usage Guidelines

${options.tools.map(t => `- ${t.name}: ${t.description}`).join("\n")}

When using tools:
1. Always check tool availability first
2. Handle errors gracefully
3. Report results clearly
`.trim();
}
```

### Interpolation
Use template utilities for variable interpolation:

```typescript
import { interpolate } from "@/prompts/utils/interpolation";

const template = "Hello, {{name}}! You are working on {{project}}.";
const result = interpolate(template, {
  name: "Agent",
  project: "TENEX"
});
```

### Fragment Composition
Fragments can be composed together:

```typescript
import { composeFragments } from "@/prompts/utils";

const systemPrompt = composeFragments([
  agentIdentityFragment(identityConfig),
  toolUsageFragment(toolConfig),
  responseFormatFragment(formatConfig)
]);
```

## Creating New Fragments

1. Create directory in `fragments/`: `fragments/my-fragment/`
2. Create `index.ts` with exported function
3. Add types if needed: `types.ts`
4. Add tests: `__tests__/my-fragment.test.ts`

```typescript
// fragments/my-fragment/index.ts
import type { MyFragmentOptions } from "./types";

export function myFragment(options: MyFragmentOptions): string {
  return `
## My Fragment Section

${options.content}
`.trim();
}

// fragments/my-fragment/types.ts
export interface MyFragmentOptions {
  content: string;
  // ...
}
```

## Anti-Patterns

```typescript
// REJECT: Inline prompt strings in agents/
// In agents/execution/AgentExecutor.ts:
const prompt = "You are an AI...";  // Use prompts/ instead

// REJECT: Hardcoded values in fragments
function myFragment(): string {
  return "Use model claude-3...";  // Should be parameterized
}

// REJECT: Business logic in prompts
function toolFragment(tools: Tool[]): string {
  const filtered = tools.filter(t => t.isEnabled);  // Logic belongs elsewhere
  return `Tools: ${filtered.map(t => t.name)}`;
}

// REJECT: Stateful fragments
let cachedPrompt: string;
function getFragment(): string {
  if (!cachedPrompt) cachedPrompt = compute();  // Fragments are pure
  return cachedPrompt;
}
```

## Testing

Test fragments produce expected output:

```typescript
import { agentIdentityFragment } from "@/prompts/fragments/agent-identity";

describe("agentIdentityFragment", () => {
  it("should include agent name", () => {
    const result = agentIdentityFragment({
      name: "Test Agent",
      role: "Developer"
    });

    expect(result).toContain("Test Agent");
    expect(result).toContain("Developer");
  });
});
```

## Dependencies

**Imports from:**
- `utils/` - Utility functions
- `lib/` - Pure utilities

**Imported by:**
- `agents/` - System prompt compilation
- `services/prompt-compiler/` - Lesson synthesis

## Related
- [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md) - Architecture reference
- `../agents/execution/` - Prompt consumption
- `../services/prompt-compiler/` - Lesson/comment synthesis
