# Nostr Integration (Layer 2)

## Directory Purpose
Encapsulates all Nostr protocol interactions. Provides wrappers around NDK (Nostr Development Kit) for event publishing, encoding/decoding, and relay management. **Higher layers never manipulate NDKEvent directly** - they use these APIs.

## Architecture Overview

```
nostr/
├── ndkClient.ts           # NDK bootstrap and client
├── AgentPublisher.ts      # Event publishing wrapper
├── AgentEventEncoder.ts   # Event encoding
├── AgentEventDecoder.ts   # Event decoding
├── kinds.ts               # Event kind constants
│
├── utils/                 # Nostr utilities
│   ├── relay.ts
│   ├── batching.ts
│   └── metadata.ts
│
├── types.ts               # Nostr type definitions
└── __tests__/
```

## Commands

```bash
# Test nostr module
bun test src/nostr/

# Test with mock relays
bun test src/nostr/__tests__/
```

## Key Components

### ndkClient
Bootstrap and manage NDK connection:

```typescript
import { ndkClient } from "@/nostr/ndkClient";

// Initialize with relays
await ndkClient.connect(["wss://relay.example.com"]);

// Get NDK instance (for advanced use only)
const ndk = ndkClient.getNDK();
```

### AgentPublisher
Primary interface for publishing Nostr events:

```typescript
import { AgentPublisher } from "@/nostr/AgentPublisher";

const publisher = new AgentPublisher(ndkClient);

// Publish conversation event
await publisher.publishConversation({
  content: "Hello!",
  conversationId: "conv-123",
  recipientPubkey: "npub..."
});

// Publish delegation result
await publisher.publishDelegationResult({
  delegationId: "del-456",
  result: "Task completed"
});
```

### AgentEventEncoder
Encode data into Nostr event format:

```typescript
import { AgentEventEncoder } from "@/nostr/AgentEventEncoder";

const encoder = new AgentEventEncoder();
const event = encoder.encodeConversationMessage({
  content: "Hello",
  replyTo: "note1..."
});
```

### AgentEventDecoder
Decode Nostr events into TENEX data structures:

```typescript
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";

const decoder = new AgentEventDecoder();
const message = decoder.decodeConversationEvent(ndkEvent);
```

### Event Kinds
Centralized event kind constants:

```typescript
import { KINDS } from "@/nostr/kinds";

// Conversation kinds
KINDS.CONVERSATION_MESSAGE  // 4199
KINDS.AGENT_METADATA        // 31990
KINDS.DELEGATION           // 4200
```

## Conventions

### NDK Access Pattern
**Never use NDK directly outside this module:**

```typescript
// WRONG: Direct NDK access
import { NDKEvent } from "@nostr-dev-kit/ndk";
const event = new NDKEvent(ndk);
event.kind = 1;
await event.publish();

// CORRECT: Use AgentPublisher
import { AgentPublisher } from "@/nostr/AgentPublisher";
await publisher.publishMessage(content);
```

### Type Imports
Import NDK types for typing only:

```typescript
// CORRECT: Type imports from NDK
import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk";

function handleEvent(event: NDKEvent): void {
  // But use AgentEventDecoder to process
  const decoded = decoder.decode(event);
}
```

### Relay Management
Use utilities for relay operations:

```typescript
import { getDefaultRelays, validateRelay } from "@/nostr/utils/relay";

const relays = getDefaultRelays();
const isValid = await validateRelay("wss://relay.example.com");
```

### Event Batching
For bulk operations, use batching utilities:

```typescript
import { batchPublish } from "@/nostr/utils/batching";

await batchPublish(events, {
  batchSize: 10,
  delayMs: 100
});
```

## Event Flow

```
Publishing:
  Data → AgentEventEncoder → NDKEvent → AgentPublisher → Relay

Receiving:
  Relay → NDK Subscription → NDKEvent → AgentEventDecoder → Data
```

## Anti-Patterns

```typescript
// REJECT: Direct NDKEvent creation outside nostr/
import { NDKEvent } from "@nostr-dev-kit/ndk";
const event = new NDKEvent();
event.publish();  // Use AgentPublisher

// REJECT: Hardcoded event kinds
const event = { kind: 4199 };  // Use KINDS constants

// REJECT: Manual event signing
event.sig = await signEvent(event);  // NDK handles this

// REJECT: Direct relay connection
const ws = new WebSocket("wss://relay..");  // Use ndkClient
```

## Testing

Use mock NDK client for tests:

```typescript
import { createMockNDKClient } from "@/test-utils/nostr";

describe("AgentPublisher", () => {
  it("should publish event", async () => {
    const mockNDK = createMockNDKClient();
    const publisher = new AgentPublisher(mockNDK);

    await publisher.publishMessage({
      content: "Test",
      conversationId: "conv-123"
    });

    expect(mockNDK.publish).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 4199 })
    );
  });
});
```

## Dependencies

**Imports from:**
- `utils/` - Utility functions
- `lib/` - Pure utilities
- `events/` - Event schemas
- External: `@nostr-dev-kit/ndk`

**Imported by:**
- `agents/` - Event publishing during execution
- `services/` - Agent discovery, status publishing
- `daemon/` - Relay subscriptions
- `event-handler/` - Event decoding

## Event Kinds Reference

| Kind | Purpose |
|------|---------|
| 4199 | Conversation message |
| 31990 | Agent metadata |
| 4200 | Delegation |
| 1111 | Comment (NIP-22) |
| 4129 | Agent lesson |

See `kinds.ts` for complete list.

## Related
- [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md) - Architecture reference
- `../events/` - Event schemas
- `../daemon/` - Subscription management
- `../services/agents/` - Agent discovery
