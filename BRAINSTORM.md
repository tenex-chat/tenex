# Brainstorm System Refactor

## Overview

This document describes a refactored brainstorm system that leverages Nostr's native reaction events (kind:7) for response selection instead of custom tags. This approach simplifies the implementation, enables user participation in selection, and better aligns with Nostr protocol patterns.

## Core Concepts

### Current Problems
1. **Duplicated execution logic** - BrainstormService reimplements LLM execution, conversation management, and publishing
2. **Complex tag management** - Using "not-chosen" tags to mark unselected responses
3. **Rigid selection** - Only moderator can determine which response is shown
4. **Type mismatches** - Passing NDKEvents where ModelMessages are expected

### New Architecture
- **Parallel execution** of standard agents (no special brainstorm logic)
- **Reaction-based selection** using kind:7 events with "+" content
- **User participation** - users can add their own "+" reactions to include alternative responses
- **Simplified service** - BrainstormService only orchestrates, doesn't reimplement

## Nostr Event Structure

### 1. Initial Brainstorm Request (kind:11)
```json
{
  "kind": 11,
  "content": "Let's brainstorm about marketing strategies",
  "tags": [
    ["title", "Marketing brainstorm"],
    ["mode", "brainstorm"],
    ["t", "brainstorm"],
    ["p", "<moderator-pubkey>"],
    ["participant", "<agent1-pubkey>"],
    ["participant", "<agent2-pubkey>"],
    ["participant", "<agent3-pubkey>"],
    ["a", "31933:<requester-pubkey>:TENEX-<id>"]
  ]
}
```

### 2. Agent Responses (kind:1111)
Each participant publishes a normal response - no special tags needed:
```json
{
  "kind": 1111,
  "content": "Here's my marketing strategy suggestion...",
  "tags": [
    ["E", "<brainstorm-root-event-id>"],
    ["K", "11"],
    ["P", "<requester-pubkey>"],
    ["e", "<brainstorm-root-event-id>"],
    ["a", "31933:<requester-pubkey>:TENEX-<id>"]
  ]
}
```

### 3. Moderator Selection (kind:7)
The **moderator agent** (not the system) evaluates responses and publishes a reaction to select the best:
```json
{
  "kind": 7,
  "content": "+",
  "pubkey": "<moderator-agent-pubkey>",  // The moderator agent publishes this
  "tags": [
    ["E", "<brainstorm-root-event-id>"],  // Root brainstorm event
    ["e", "<chosen-response-id>"],         // Selected response
    ["p", "<chosen-response-author>"],     // Author of chosen response
    ["a", "31933:<requester-pubkey>:TENEX-<id>"],  // CRITICAL: a-tag for routing
    ["brainstorm-selection"]               // Optional marker
  ]
}
```

### 4. User Override/Addition (kind:7)
Users can add their own selections, which get routed back to agents:
```json
{
  "kind": 7,
  "content": "+",
  "pubkey": "<user-pubkey>",
  "tags": [
    ["E", "<brainstorm-root-event-id>"],
    ["e", "<alternative-response-id>"],    // Different response they prefer
    ["p", "<alternative-response-author>"],
    ["a", "31933:<requester-pubkey>:TENEX-<id>"]  // Gets routed to agents
  ]
}
```

**Important**: These kind:7 events are a-tagged and get routed through the normal event handling system. When a user publishes a kind:7 to select a previously non-chosen response, it triggers the agents to update their conversation history.

## How Selection Works

### Brainstorm Metadata Through Reactions

1. **Moderator agent publishes kind:7** → Marks which response is "chosen"
2. **User can publish kind:7** → Adds additional selections to conversation
3. **BrainstormStrategy reads these reactions** → Determines which kind:1111 events to include
4. **LLM sees selected responses** → Only chosen responses become part of conversation context

The kind:7 events act as **metadata** that tells the BrainstormStrategy:
- Which responses were selected by the moderator
- Which additional responses the user wants included
- What should be part of the conversation vs. alternative context

This means:
- kind:7 events are selection metadata, not messages
- BrainstormStrategy uses them to filter which kind:1111 events become conversation
- User selections change what future LLM calls see as conversation history
- Non-selected responses can be included as "alternatives" in system messages

## Implementation Changes

### 1. BrainstormService Refactor

#### Remove
- Manual LLM preparation and execution
- Custom conversation history building
- Direct AgentPublisher usage
- "not-chosen" tag management

#### Keep/Add
- Parallel agent orchestration
- Moderation logic
- Reaction event publishing
- BrainstormStrategy for message building

### 2. New BrainstormStrategy

Create a new `BrainstormStrategy` implementing `MessageBuildingStrategy`:

```typescript
class BrainstormStrategy implements MessageBuildingStrategy {
  async buildMessages(context: ExecutionContext, triggeringEvent: NDKEvent): Promise<ModelMessage[]> {
    const conversation = context.conversationCoordinator.getConversation(context.conversationId);
    const messages: ModelMessage[] = [];

    // Find all brainstorm rounds (kind:11 events)
    const brainstormRoots = conversation.history.filter(e => e.kind === 11);

    for (const root of brainstormRoots) {
      // Get all responses to this brainstorm
      const responses = conversation.history.filter(e =>
        e.kind === 1111 && e.tagValue("E") === root.id
      );

      // Find selection metadata (kind:7 reactions)
      const selections = conversation.history.filter(e =>
        e.kind === 7 &&
        e.content === "+" &&
        e.tagValue("E") === root.id
      );

      const selectedIds = new Set(selections.map(s => s.tagValue("e")));

      // Build conversation based on selections
      for (const response of responses) {
        if (selectedIds.has(response.id)) {
          // This was selected - include as part of conversation
          messages.push({
            role: "assistant",
            content: response.content
          });
        } else {
          // Not selected - optionally include as alternative context
          messages.push({
            role: "system",
            content: `[Alternative response not chosen: ${response.content}]`
          });
        }
      }
    }

    return messages;
  }
}
```

### 3. Simplified Execution Flow

```typescript
// In BrainstormService
async handleBrainstorm(event: NDKEvent) {
  // 1. Parse participants from event
  const participants = AgentEventDecoder.getParticipants(event);

  // 2. Execute each participant in parallel
  const responses = await Promise.all(
    participants.map(agent =>
      agentExecutor.execute({
        agent,
        conversationId,
        triggeringEvent: event,
        messageStrategy: new BrainstormStrategy() // Use brainstorm-aware strategy
      })
    )
  );

  // 3. Moderate and select best response
  const chosen = await this.moderate(responses);

  // 4. Publish selection reaction
  await this.publishSelection(event.id, chosen.id);
}
```

## UI Implementation Guide

### Displaying Brainstorm Responses

```typescript
// Check if a response should be shown based on reactions in conversation
function shouldShowBrainstormResponse(
  event: NDKEvent,
  conversation: Conversation
): boolean {
  // If not a brainstorm response, show normally
  if (event.kind !== 1111 || !event.tagValue("E")) {
    return true;
  }

  const rootId = event.tagValue("E");

  // Look for selection reactions in conversation history
  const hasSelection = conversation.history.some(e =>
    e.kind === 7 &&
    e.content === "+" &&
    e.tagValue("E") === rootId &&
    e.tagValue("e") === event.id
  );

  // Show if selected by moderator or user
  return hasSelection;
}
```

### Finding Selected Response

```typescript
function getSelectedResponses(
  brainstormRootId: string,
  conversation: Conversation
): string[] {
  // Find all selection reactions in conversation for this brainstorm
  const selections = conversation.history.filter(e =>
    e.kind === 7 &&
    e.content === "+" &&
    e.tagValue("E") === brainstormRootId
  );

  // Return all selected response IDs (may be multiple if user added selections)
  return selections.map(s => s.tagValue("e")).filter(id => id);
}
```

### Allowing User Selection

```typescript
async function selectAlternativeResponse(
  brainstormRootId: string,
  responseId: string
): Promise<void> {
  const reaction = new NDKEvent(ndk);
  reaction.kind = 7;
  reaction.content = "+";
  reaction.tags = [
    ["E", brainstormRootId],
    ["e", responseId],
    ["p", responseAuthorPubkey]
  ];
  await reaction.publish();
}
```

## Migration Path

### Phase 1: Backend Changes
1. Update `AgentEventDecoder.getParticipants()` to work with kind:1111 ✅
2. Fix orphaned brainstorm handling in reply.ts ✅
3. Create `BrainstormStrategy` class
4. Refactor `BrainstormService` to use `AgentExecutor`
5. Implement reaction publishing for moderation

### Phase 2: UI Changes
1. Update message filtering to check for reactions
2. Add UI for user to "+" additional responses
3. Show selection status in brainstorm threads
4. Update conversation view to handle multiple selected responses

### Phase 3: Cleanup
1. Remove "not-chosen" tag logic
2. Remove manual LLM execution from BrainstormService
3. Remove custom conversation building
4. Update tests

## Benefits

1. **Simplicity** - Leverages existing execution pipeline
2. **Flexibility** - Users can influence conversation flow
3. **Transparency** - All responses preserved, selection visible
4. **Protocol-native** - Uses standard Nostr patterns
5. **Backward compatible** - Old clients show all responses
6. **Extensible** - Could add different reaction types for different selection criteria

## Testing Considerations

1. **Parallel execution** - Ensure all participants respond
2. **Reaction queries** - Verify selection reactions are found correctly
3. **History building** - Confirm BrainstormStrategy includes right context
4. **User selections** - Test multiple selections on same brainstorm
5. **Follow-up messages** - Ensure conversation continues with selected response(s)

## Future Enhancements

1. **Weighted selection** - Different reaction emojis for preference levels
2. **Consensus selection** - Require multiple moderators to agree
3. **Time-based selection** - Auto-select after timeout
4. **Selection reasoning** - Moderator publishes note explaining choice
5. **Branch exploration** - UI to explore alternative conversation paths