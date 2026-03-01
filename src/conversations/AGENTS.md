# conversations/ — Conversation Management (Layer 3)

Single source of truth for conversation context and persistence. Other modules request data via these services — never read persistence files directly.

## Key Files

- `ConversationStore.ts` — Main persistence layer
- `ConversationRegistry.ts` — Active conversation tracking
- `ConversationDiskReader.ts` — Low-level disk reading
- `MessageBuilder.ts` — Message construction
- `executionTime.ts` — Execution time tracking

## Subdirectories

- `persistence/` — `ToolMessageStorage` for tool call/result storage
- `services/` — `ConversationResolver`, `ConversationSummarizer`, `MetadataDebounceManager`
- `formatters/` — Human-readable output generation
- `search/` — Conversation search
- `utils/` — Conversation utilities

## Persistence Layout

```
~/.tenex/projects/<projectId>/conversations/<conversationId>/
├── messages.json      # Message history
├── metadata.json      # Conversation metadata
└── tools/             # Tool call/result storage
```

Messages follow the AI SDK message format (role, content, toolCalls, toolCallId).
