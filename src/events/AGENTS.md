# Events (Layer 2)

## Directory Purpose
Typed schemas, utilities, and constants for every event TENEX produces or consumes. This module defines the **contract** for event structure - modifications require careful consideration and updates to this documentation.

## Architecture Overview

```
events/
├── schemas/               # Zod schemas for event validation
│   ├── conversation.ts
│   ├── delegation.ts
│   ├── agent.ts
│   └── ...
│
├── constants.ts           # Event kind constants
├── types.ts               # TypeScript type definitions
├── utils.ts               # Event utilities
└── __tests__/
```

## Commands

```bash
# Test events module
bun test src/events/

# Validate event schemas
bun run validate:events
```

## Key Components

### Event Schemas
Zod schemas for runtime validation:

```typescript
import { conversationEventSchema } from "@/events/schemas/conversation";

const result = conversationEventSchema.safeParse(eventData);
if (!result.success) {
  console.error("Invalid event:", result.error);
}
```

### Event Types
TypeScript types derived from schemas:

```typescript
import type {
  ConversationEvent,
  DelegationEvent,
  AgentMetadataEvent
} from "@/events/types";

function handleConversation(event: ConversationEvent): void {
  // Type-safe event handling
}
```

### Constants
Event kind definitions:

```typescript
import { EVENT_KINDS } from "@/events/constants";

EVENT_KINDS.CONVERSATION_MESSAGE  // 4199
EVENT_KINDS.DELEGATION           // 4200
EVENT_KINDS.AGENT_METADATA       // 31990
```

## Event Catalog

### Conversation Events (4199)
```typescript
interface ConversationEvent {
  kind: 4199;
  content: string;
  tags: [
    ["e", conversationId],     // Thread reference
    ["p", recipientPubkey],    // Recipient
    ["t", "conversation"]      // Type tag
  ];
}
```

### Delegation Events (4200)
```typescript
interface DelegationEvent {
  kind: 4200;
  content: JSON.stringify({
    task: string;
    context: object;
  });
  tags: [
    ["e", parentConversation],
    ["p", delegatePubkey],
    ["t", "delegation"]
  ];
}
```

### Agent Metadata (31990)
```typescript
interface AgentMetadataEvent {
  kind: 31990;
  content: JSON.stringify({
    name: string;
    description: string;
    capabilities: string[];
  });
  tags: [
    ["d", agentId],            // Unique identifier
    ["t", "agent"]
  ];
}
```

## Conventions

### Schema First
Define schemas before using events:

```typescript
// CORRECT: Schema-driven development
import { z } from "zod";

export const myEventSchema = z.object({
  kind: z.literal(4201),
  content: z.string(),
  tags: z.array(z.tuple([z.string(), z.string()]))
});

export type MyEvent = z.infer<typeof myEventSchema>;

// WRONG: Type-only definition
interface MyEvent {
  kind: number;
  content: string;
}
```

### Validation
Always validate incoming events:

```typescript
import { conversationEventSchema } from "@/events/schemas";

function processEvent(raw: unknown): ConversationEvent {
  const result = conversationEventSchema.parse(raw);
  return result;  // Type-safe after validation
}
```

### Anonymous Payloads
Avoid anonymous event payloads:

```typescript
// WRONG: Anonymous payload
const event = {
  kind: 4199,
  content: JSON.stringify({ message: "hi" })
};

// CORRECT: Use defined schema
import { createConversationEvent } from "@/events/utils";

const event = createConversationEvent({
  message: "hi",
  conversationId: "conv-123"
});
```

### Adding New Events

1. Define schema in `schemas/`
2. Export type from `types.ts`
3. Add constant to `constants.ts`
4. Document in this AGENTS.md
5. Update consumers (nostr/, event-handler/)

```typescript
// 1. schemas/myNewEvent.ts
export const myNewEventSchema = z.object({
  kind: z.literal(4202),
  // ...
});

// 2. types.ts
export type MyNewEvent = z.infer<typeof myNewEventSchema>;

// 3. constants.ts
export const EVENT_KINDS = {
  // ...
  MY_NEW_EVENT: 4202,
};
```

## Anti-Patterns

```typescript
// REJECT: Hardcoded event kinds
if (event.kind === 4199) { }  // Use EVENT_KINDS.CONVERSATION_MESSAGE

// REJECT: Untyped event handling
function handle(event: any) { }  // Use proper event types

// REJECT: Skipping validation
const conv = event as ConversationEvent;  // Validate first!

// REJECT: Inline event structure
const event = { kind: 1, content: "..." };  // Use factory functions
```

## Testing

Test schemas with valid and invalid data:

```typescript
import { conversationEventSchema } from "@/events/schemas";

describe("conversationEventSchema", () => {
  it("should accept valid event", () => {
    const valid = {
      kind: 4199,
      content: "Hello",
      tags: [["e", "conv-123"]]
    };

    expect(() => conversationEventSchema.parse(valid)).not.toThrow();
  });

  it("should reject invalid kind", () => {
    const invalid = {
      kind: 1,  // Wrong kind
      content: "Hello"
    };

    expect(() => conversationEventSchema.parse(invalid)).toThrow();
  });
});
```

## Dependencies

**Imports from:**
- `lib/` - Pure utilities
- External: `zod` for schemas

**Imported by:**
- `nostr/` - Event encoding/decoding
- `event-handler/` - Event processing
- `services/` - Event creation
- `agents/` - Event publishing

## Event Kinds Reference

All TENEX-specific kinds are defined in `../nostr/kinds.ts`. Import from there — never use magic numbers.

### Standard NIP Kinds (used by TENEX)

| Kind | Constant | Description |
|------|----------|-------------|
| 1 | `Text` | Regular text note — unified conversation format |
| 513 | `EventMetadata` | Event metadata (titles, summaries) |
| 1111 | `Comment` | NIP-22 Comment — used for lesson refinements |

### Agent Kinds (4xxx range)

| Kind | Constant | Description |
|------|----------|-------------|
| 4129 | `AgentLesson` | Agent Lesson — learned knowledge |
| 4199 | `AgentDefinition` | Agent Definition |
| 4201 | `AgentNudge` | Agent Nudge — system prompt injection |
| 4202 | `AgentSkill` | Agent Skill — transient capability injection |
| 4203 | `DelegationMarker` | Delegation Marker — lifecycle tracking |

### Replaceable Agent Kinds (1xxxx range)

| Kind | Constant | Description |
|------|----------|-------------|
| 14199 | `ProjectAgentSnapshot` | Owner-agent declaration (replaceable, p-tags agents) |
| 14202 | `NudgeSkillWhitelist` | Nudge/Skill Whitelist — NIP-51-like list of e-tagged nudges/skills |

### TENEX Custom Kinds (2xxxx range)

| Kind | Constant | Description |
|------|----------|-------------|
| 24000 | `TenexBootProject` | Boot project via a-tag |
| 24010 | `TenexProjectStatus` | Project status |
| 24020 | `TenexAgentConfigUpdate` | Agent configuration update |
| 24030 | `TenexAgentDelete` | Agent deletion from projects or globally |
| 24133 | `TenexOperationsStatus` | Operations status |
| 24134 | `TenexStopCommand` | Stop command |
| 25000 | `TenexConfigUpdate` | Encrypted config updates (e.g., APNs device tokens) |

## Related
- [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md) - Architecture reference
- `../nostr/kinds.ts` - Nostr kind constants
- `../nostr/AgentEventEncoder.ts` - Event creation
- `../event-handler/` - Event processing
