# Conversations (Layer 3)

## Directory Purpose
**Single source of truth** for conversation context and persistence. Manages conversation state, tool message storage, formatting, and search. Other modules must request data via these services rather than reading persistence files directly.

## Architecture Overview

```
conversations/
├── ConversationStore.ts      # Main persistence layer
├── ConversationRegistry.ts   # Conversation tracking
│
├── persistence/
│   └── ToolMessageStorage.ts # Tool call/result storage
│
├── services/
│   ├── ConversationResolver.ts
│   ├── ConversationSummarizer.ts
│   └── MetadataDebounceManager.ts
│
├── formatters/
│   ├── index.ts
│   └── utils/                # Formatting utilities
│
├── utils/                    # Conversation utilities
├── search/                   # Conversation search
└── __tests__/
```

## Commands

```bash
# Test conversations module
bun test src/conversations/

# Test specific component
bun test src/conversations/__tests__/ConversationStore.test.ts
```

## Key Components

### ConversationStore
Main persistence layer for conversation state and tool messages:

```typescript
import { ConversationStore } from "@/conversations/ConversationStore";

const store = new ConversationStore(projectId);

// Save conversation
await store.save(conversationId, messages);

// Load conversation
const conversation = await store.load(conversationId);

// Append message
await store.append(conversationId, newMessage);
```

### ConversationRegistry
Tracks active and historical conversations:

```typescript
import { ConversationRegistry } from "@/conversations/ConversationRegistry";

const registry = new ConversationRegistry();
registry.register(conversationId, metadata);
const active = registry.getActive();
```

### ToolMessageStorage
Specialized storage for tool calls and results:

```typescript
import { ToolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";

const storage = new ToolMessageStorage(conversationId);
await storage.saveToolCall(toolCall);
await storage.saveToolResult(toolResult);
```

### ConversationResolver
Resolves conversation context from various sources:

```typescript
import { ConversationResolver } from "@/conversations/services/ConversationResolver";

const resolver = new ConversationResolver();
const context = await resolver.resolve(conversationId);
```

### ConversationSummarizer
Generates conversation summaries:

```typescript
import { ConversationSummarizer } from "@/conversations/services/ConversationSummarizer";

const summarizer = new ConversationSummarizer();
const summary = await summarizer.summarize(conversation);
```

## Conventions

### Data Access Pattern
**Never read persistence files directly.** Always use services:

```typescript
// CORRECT: Use ConversationStore
const store = new ConversationStore(projectId);
const conversation = await store.load(conversationId);

// WRONG: Direct file access
const data = await fs.readFile(`~/.tenex/conversations/${id}.json`);
```

### Message Format
Messages follow the AI SDK message format:

```typescript
interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentPart[];
  toolCallId?: string;
  toolCalls?: ToolCall[];
}
```

### Tool Message Pairing
Tool calls and results are always paired:

```typescript
// Tool call from assistant
{
  role: "assistant",
  toolCalls: [{
    id: "call_123",
    name: "rag_query",
    arguments: { query: "test" }
  }]
}

// Tool result
{
  role: "tool",
  toolCallId: "call_123",
  content: [{ content: "result" }]
}
```

### Metadata Debouncing
Use `MetadataDebounceManager` to avoid excessive metadata writes:

```typescript
import { MetadataDebounceManager } from "@/conversations/services/MetadataDebounceManager";

const debouncer = new MetadataDebounceManager();
debouncer.scheduleUpdate(conversationId, metadata);
```

## Formatters

Human-readable output generation for UI and debugging:

```typescript
import { formatConversation } from "@/conversations/formatters";

const formatted = formatConversation(conversation, {
  includeToolCalls: true,
  truncateContent: 500
});
```

## Search

Conversation search capabilities:

```typescript
import { ConversationSearch } from "@/conversations/search";

const search = new ConversationSearch();
const results = await search.find({
  query: "deployment issue",
  projectId: "my-project"
});
```

## Anti-Patterns

```typescript
// REJECT: Direct file access
import * as fs from "node:fs";
const conv = JSON.parse(await fs.readFile(path));

// REJECT: Modifying conversation state outside store
conversation.messages.push(newMessage);  // Use store.append()

// REJECT: Storing state in formatters
const formatter = new ConversationFormatter();
formatter.cachedResults = results;  // Formatters are stateless

// REJECT: Inline message format
const message = { r: "user", c: "hi" };  // Use proper Message type
```

## Testing

Use fixtures from `src/test-utils/`:

```typescript
import { createMockConversation } from "@/test-utils/fixtures";

describe("ConversationStore", () => {
  it("should save and load", async () => {
    const conv = createMockConversation();
    const store = new ConversationStore("test-project");

    await store.save(conv.id, conv.messages);
    const loaded = await store.load(conv.id);

    expect(loaded.messages).toEqual(conv.messages);
  });
});
```

## Dependencies

**Imports from:**
- `utils/` - Utility functions
- `lib/` - Pure utilities (fs operations)
- `events/` - Event schemas

**Imported by:**
- `agents/` - Conversation context for execution
- `services/` - Conversation resolution
- `event-handler/` - New conversation handling
- `daemon/` - Background conversation processing

## File Locations

Conversations are persisted to:
```
~/.tenex/projects/<projectId>/conversations/
├── <conversationId>/
│   ├── messages.json      # Main message history
│   ├── metadata.json      # Conversation metadata
│   └── tools/             # Tool call/result storage
│       ├── <callId>.json
│       └── ...
```

## Related
- [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md) - Architecture reference
- `../agents/execution/` - Uses conversation context
- `../services/dispatch/` - Conversation routing
- `../event-handler/` - New conversation creation
