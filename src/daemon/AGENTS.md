# Daemon Runtime (Layer 4)

## Directory Purpose
Long-running background orchestration. Manages relay subscriptions, event processing, and project runtime lifecycle. The daemon is the top-level entry point that drives TENEX's continuous operation.

## Architecture Overview

```
daemon/
├── Daemon.ts              # Main daemon class
├── ProjectRuntime.ts      # Per-project runtime management
├── SubscriptionManager.ts # Relay subscription handling
├── RuntimeLifecycle.ts    # Lifecycle management
│
├── filters/               # Nostr event filters
│   └── ...
│
├── routing/               # Event routing logic
│   └── ...
│
├── utils/                 # Daemon utilities
│   └── ...
│
└── __tests__/
```

## Commands

```bash
# Start daemon (from CLI)
bun run start daemon

# Test daemon module
bun test src/daemon/

# Test with specific timeout (daemon tests may be slow)
bun test --timeout 30000 src/daemon/
```

## Key Components

### Daemon
Main daemon class that orchestrates all background operations:

```typescript
import { Daemon } from "@/daemon/Daemon";

const daemon = new Daemon();
await daemon.start();

// Graceful shutdown
await daemon.stop();
```

### ProjectRuntime
Per-project runtime that manages subscriptions and event handling:

```typescript
import { ProjectRuntime } from "@/daemon/ProjectRuntime";

const runtime = new ProjectRuntime({
  projectId: "my-project",
  relays: ["wss://relay.example.com"]
});

await runtime.start();
// Runtime processes events until stopped
await runtime.stop();
```

### SubscriptionManager
Manages Nostr relay subscriptions:

```typescript
import { SubscriptionManager } from "@/daemon/SubscriptionManager";

const manager = new SubscriptionManager(ndkClient);

// Subscribe to conversation events
const sub = manager.subscribe({
  kinds: [4199],  // Conversation events
  "#p": [agentPubkey]
});

sub.on("event", handleEvent);
```

### RuntimeLifecycle
Coordinates startup and shutdown sequences:

```typescript
import { RuntimeLifecycle } from "@/daemon/RuntimeLifecycle";

const lifecycle = new RuntimeLifecycle();
lifecycle.onStart(async () => { /* init */ });
lifecycle.onStop(async () => { /* cleanup */ });
```

## Conventions

### Dependency Direction
Daemon modules depend on services/stores, **never the other way around**:

```typescript
// CORRECT: Daemon imports services
import { AgentDispatchService } from "@/services/dispatch";
import { ConversationStore } from "@/conversations/ConversationStore";

// WRONG: Service importing daemon
// In services/SomeService.ts:
import { Daemon } from "@/daemon/Daemon";  // Layer violation!
```

### Event Processing Flow
```
Relay → SubscriptionManager → Filters → Routing → EventHandler → Dispatch
```

### Graceful Shutdown
Always implement cleanup on shutdown:

```typescript
class MyComponent {
  async start() {
    this.subscription = manager.subscribe(filter);
  }

  async stop() {
    // Always clean up subscriptions
    this.subscription?.close();
    await this.flushPendingWork();
  }
}
```

### Filter Construction
Use the `filters/` directory for Nostr filters:

```typescript
import { createConversationFilter } from "@/daemon/filters";

const filter = createConversationFilter({
  projectId: "my-project",
  since: Date.now() - 3600000  // Last hour
});
```

## Event Flow

```
1. Daemon.start()
   └── ProjectRuntime.start() for each project
       └── SubscriptionManager.subscribe()
           └── Filters applied to incoming events

2. Event received
   └── Routing determines handler
       └── EventHandler processes event
           └── AgentDispatchService coordinates response

3. Daemon.stop()
   └── ProjectRuntime.stop() for each project
       └── SubscriptionManager.unsubscribe()
       └── Flush pending work
```

## Anti-Patterns

```typescript
// REJECT: Tight coupling with event handlers
class Daemon {
  handleEvent(event: NDKEvent) {
    // 500 lines of business logic
    // Should delegate to event-handler/
  }
}

// REJECT: Missing cleanup
class MyRuntime {
  start() {
    setInterval(this.poll, 1000);  // Never cleaned up!
  }
}

// REJECT: Blocking operations in event loop
async function handleEvent(event: NDKEvent) {
  await heavyComputation();  // Blocks all other events
  // Use worker threads or queue for heavy work
}

// REJECT: Service depending on daemon
// In services/MyService.ts:
import { Daemon } from "@/daemon";  // Layer violation!
```

## Testing

Daemon tests often require mocking Nostr clients:

```typescript
import { createMockNDKClient } from "@/test-utils/nostr";

describe("Daemon", () => {
  it("should start and stop cleanly", async () => {
    const mockNDK = createMockNDKClient();
    const daemon = new Daemon(mockNDK);

    await daemon.start();
    expect(daemon.isRunning()).toBe(true);

    await daemon.stop();
    expect(daemon.isRunning()).toBe(false);
  });
});
```

## Dependencies

**Imports from:**
- `services/` - Dispatch, configuration, status
- `agents/` - Agent execution
- `conversations/` - Conversation management
- `event-handler/` - Event processing
- `nostr/` - NDK client, event encoding

**Imported by:**
- `commands/daemon.ts` - CLI entry point

## Configuration

Daemon configuration via `ConfigService`:

```typescript
import { config } from "@/services/ConfigService";

const daemonConfig = {
  relays: config.getRelays(),
  projectsBase: config.getProjectsBase(),
  pollInterval: 30000
};
```

## Related
- [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md) - Architecture reference
- `../event-handler/` - Event processing logic
- `../services/dispatch/` - Agent dispatch
- `../nostr/` - Relay management
- `../commands/daemon.ts` - CLI entry point
