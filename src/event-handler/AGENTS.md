# Event Handler (Layer 4)

## Directory Purpose
Domain orchestrators triggered by incoming Nostr events. Decodes events, resolves participants, and delegates routing/execution to services. This is the bridge between raw Nostr events and TENEX's business logic.

## Architecture Overview

```
event-handler/
├── index.ts               # Main exports
├── project.ts             # Project event handling
├── reply.ts               # Reply event handling
├── newConversation.ts     # New conversation handling
└── __tests__/
```

## Commands

```bash
# Test event handlers
bun test src/event-handler/

# Test specific handler
bun test src/event-handler/__tests__/reply.test.ts
```

## Key Components

### Event Processing Flow

```
Nostr Event (NDKEvent)
    ↓
AgentEventDecoder (decode)
    ↓
Participant Resolution (agents/ + conversations/services)
    ↓
Dispatch (services/dispatch)
    ↓
Response → AgentPublisher
```

### newConversation Handler
Handles creation of new conversations:

```typescript
import { handleNewConversation } from "@/event-handler/newConversation";

await handleNewConversation({
  event: ndkEvent,
  projectId: "my-project",
  agentId: "claude-code"
});
```

### reply Handler
Handles replies to existing conversations:

```typescript
import { handleReply } from "@/event-handler/reply";

await handleReply({
  event: ndkEvent,
  conversationId: "conv-123",
  projectId: "my-project"
});
```

### project Handler
Handles project-level events:

```typescript
import { handleProjectEvent } from "@/event-handler/project";

await handleProjectEvent({
  event: ndkEvent,
  projectId: "my-project"
});
```

## Conventions

### Thin Handlers
Handlers should be thin - decode, resolve, delegate:

```typescript
// CORRECT: Thin handler that delegates
export async function handleReply(params: ReplyParams): Promise<void> {
  // 1. Decode event
  const decoded = decoder.decode(params.event);

  // 2. Resolve participants
  const conversation = await resolver.resolve(decoded.conversationId);

  // 3. Delegate to dispatch
  await dispatchService.dispatch({
    conversation,
    message: decoded.content,
    sender: decoded.sender
  });
}

// WRONG: Fat handler with business logic
export async function handleReply(params: ReplyParams): Promise<void> {
  // 500 lines of business logic
  // Should be in services/
}
```

### Event Decoding
Always use `AgentEventDecoder`:

```typescript
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";

const decoder = new AgentEventDecoder();
const decoded = decoder.decode(ndkEvent);
```

### Participant Resolution
Use services for resolving participants:

```typescript
import { ConversationResolver } from "@/conversations/services/ConversationResolver";
import { AgentRegistry } from "@/agents/AgentRegistry";

const conversation = await conversationResolver.resolve(conversationId);
const agent = agentRegistry.get(agentId);
```

### Error Handling
Handle errors gracefully and report via Nostr:

```typescript
export async function handleReply(params: ReplyParams): Promise<void> {
  try {
    await processReply(params);
  } catch (error) {
    // Log error
    logger.error("Failed to process reply", { error, params });

    // Optionally notify sender
    await publisher.publishError({
      conversationId: params.conversationId,
      error: formatAnyError(error)
    });
  }
}
```

## Anti-Patterns

```typescript
// REJECT: Business logic in handlers
export async function handleReply(params) {
  // RAG query logic
  const results = await db.query(params.content);
  // LLM logic
  const response = await llm.complete(results);
  // Should be in services/dispatch
}

// REJECT: Direct NDK access
export async function handleReply(params) {
  const event = new NDKEvent();
  event.content = "response";
  await event.publish();  // Use AgentPublisher
}

// REJECT: Missing error handling
export async function handleReply(params) {
  await processReply(params);  // No try-catch
}

// REJECT: Handlers importing other handlers
import { handleNewConversation } from "./newConversation";
// Handlers should be independent
```

## Testing

Test handlers with mocked dependencies:

```typescript
import { handleReply } from "@/event-handler/reply";
import { createMockNDKEvent } from "@/test-utils/nostr";

describe("handleReply", () => {
  it("should process reply and dispatch", async () => {
    const mockEvent = createMockNDKEvent({
      kind: 4199,
      content: "Hello"
    });

    const mockDispatch = vi.fn();
    vi.mock("@/services/dispatch", () => ({
      dispatchService: { dispatch: mockDispatch }
    }));

    await handleReply({
      event: mockEvent,
      conversationId: "conv-123",
      projectId: "project-456"
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-123"
      })
    );
  });
});
```

## Dependencies

**Imports from:**
- `nostr/` - AgentEventDecoder, AgentPublisher
- `agents/` - AgentRegistry, agent resolution
- `conversations/` - ConversationResolver
- `services/dispatch/` - AgentDispatchService
- `utils/` - Utility functions

**Imported by:**
- `daemon/` - Event routing

## Event Types Handled

| Event Kind | Handler | Purpose |
|------------|---------|---------|
| 4199 | `reply` / `newConversation` | Conversation messages |
| 4200 | `delegation` | Delegation requests |
| 31990 | `project` | Project metadata |

## Related
- [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md) - Architecture reference
- `../nostr/` - Event encoding/decoding
- `../services/dispatch/` - Request routing
- `../daemon/` - Event subscription
- `../events/` - Event schemas
