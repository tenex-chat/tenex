# Tools System (Layer 3)

## Directory Purpose
Tool implementations that agents can invoke. Contains 57+ concrete actions organized by domain. Tools **delegate to services** for stateful operations - they never hold state themselves.

## Architecture Overview

```
tools/
├── implementations/       # 57+ tool files
│   ├── agents_list.ts
│   ├── agents_remove.ts
│   ├── delegation_*.ts    # Delegation tools
│   ├── rag_*.ts           # RAG tools
│   ├── schedule_*.ts      # Scheduling tools
│   ├── file_*.ts          # File access
│   ├── shell_*.ts         # Shell execution
│   └── ...
│
├── registry.ts            # Tool registration and metadata
├── utils.ts               # Tool utilities
├── executor.ts            # Tool execution engine
└── __tests__/             # Unit tests
```

## Commands

```bash
# Test all tools
bun test src/tools/

# Test specific tool category
bun test src/tools/__tests__/rag_*.test.ts

# Check tool registration
bun run validate:events
```

## Tool Implementation Pattern

### Anatomy of a Tool

```typescript
// src/tools/implementations/rag-search.ts
import { tool } from "ai";
import { z } from "zod";
import { UnifiedSearchService } from "@/services/search";

export const rag_search = tool({
  description: "Search across all RAG collections",
  parameters: z.object({
    query: z.string().describe("The search query"),
    limit: z.number().optional().default(10)
  }),
  execute: async ({ query, limit }) => {
    // CORRECT: Delegate to service
    const searchService = UnifiedSearchService.getInstance();
    return await searchService.search({ query, limit });
  }
});
```

### Naming Convention
Files follow `<domain>_<action>.ts` pattern:

| Domain | Examples |
|--------|----------|
| `agents_` | `agents_list.ts`, `agents_remove.ts` |
| `rag_` / `rag-` | `rag-search.ts`, `rag_create_collection.ts` |
| `delegation_` | `delegation_create.ts`, `delegation_complete.ts` |
| `schedule_` | `schedule_create.ts`, `schedule_list.ts` |
| `file_` | `file_read.ts`, `file_write.ts` |
| `shell_` | `shell_execute.ts` |

## Conventions

### Single Purpose
One file = one tool. If a tool does multiple things, split it:

```typescript
// CORRECT: Separate tools
// rag-search.ts - Search across all RAG collections
// rag_create_collection.ts - Create a collection
// rag_add_documents.ts - Ingest documents

// WRONG: God tool
// rag.ts - Query, ingest, list, delete, everything...
```

### Delegate to Services
Tools are thin wrappers around service calls:

```typescript
// CORRECT: Tool delegates to service
export const schedule_create = tool({
  execute: async (params) => {
    const scheduler = new SchedulerService();
    return await scheduler.create(params);
  }
});

// WRONG: Tool implements business logic
export const schedule_create = tool({
  execute: async (params) => {
    const db = await sqlite.open();
    await db.run("INSERT INTO schedules...");
    // 100 lines of implementation
  }
});
```

### No State in Tools
Tools must be stateless. Any state belongs in services:

```typescript
// WRONG: Tool holding state
let cachedResults = [];
export const my_tool = tool({
  execute: async () => {
    cachedResults.push(result);  // State leak!
  }
});

// CORRECT: State in service
export const my_tool = tool({
  execute: async () => {
    const service = new MyService();  // Service manages state
    return await service.process();
  }
});
```

### Zod Schemas
Use Zod for parameter validation with descriptions:

```typescript
parameters: z.object({
  query: z.string()
    .describe("The search query to execute"),
  limit: z.number()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe("Maximum number of results"),
  filter: z.enum(["all", "recent", "starred"])
    .optional()
    .describe("Filter type for results")
})
```

## Tool Categories

### Agent Management (`agents_*`)
- `agents_list` - List registered agents
- `agents_remove` - Remove an agent
- `agents_configure` - Configure agent settings

### RAG Operations (`rag_*`)
- `rag_search` - Search across all RAG collections
- `rag_create_collection` - Create a collection
- `rag_add_documents` - Ingest documents
- `rag_delete_collection` - Delete a collection

### Delegation (`delegation_*`)
- `delegation_create` - Create new delegation
- `delegation_complete` - Mark delegation complete
- `delegation_status` - Check delegation status

### Scheduling (`schedule_*`)
- `schedule_create` - Create scheduled task
- `schedule_list` - List scheduled tasks
- `schedule_cancel` - Cancel scheduled task

### File Operations (`file_*`)
- `file_read` - Read file contents
- `file_write` - Write file contents
- `file_list` - List directory contents

### Shell (`shell_*`)
- `shell_execute` - Execute shell command

## Dynamic Tools

User-defined tools are loaded from `~/.tenex/tools/` by `DynamicToolService`:

```typescript
// ~/.tenex/tools/my_custom_tool.ts
import { tool } from "ai";
import { z } from "zod";

export default tool({
  description: "My custom tool",
  parameters: z.object({ /* ... */ }),
  execute: async (params) => { /* ... */ }
});
```

## Anti-Patterns

```typescript
// REJECT: Business logic in tool
export const my_tool = tool({
  execute: async () => {
    // 200 lines of business logic
    // Should be in a service
  }
});

// REJECT: Tool holding state
const cache = new Map();
export const my_tool = tool({ /* uses cache */ });

// REJECT: Direct DB access
import { lancedb } from "lancedb";
export const rag_tool = tool({
  execute: async () => {
    const db = await lancedb.connect();  // Use RAGService
  }
});

// REJECT: Wrong naming
export const query_rag = tool();  // Should be rag_search
```

## Testing

Test tools by mocking their service dependencies:

```typescript
import { createRAGSearchTool } from "@/tools/implementations/rag-search";

describe("rag_search", () => {
  it("should search across all RAG collections", async () => {
    const mockService = createMockRAGService({
      queryResult: [{ content: "result" }]
    });

    const result = await ragSearchTool.execute({
      query: "test",
      limit: 5
    });

    expect(result).toHaveLength(1);
  });
});
```

## Dependencies

**Imports from:**
- `services/` - Business logic and state
- `utils/` - Utility functions
- `lib/` - Pure utilities
- External: `ai` (tool helper), `zod` (schemas)

**Imported by:**
- `agents/` - Tool execution via registry
- `llm/providers/agent/` - Agent provider tool adapters

## Related
- [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md) - Architecture reference
- `../services/` - Service implementations
- `../agents/execution/` - Tool execution engine
- `../services/DynamicToolService.ts` - Dynamic tool loading
