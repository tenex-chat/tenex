# Agent Context Management System - Internal Architecture

## Overview

The Agent Context Management System is a critical component of the TENEX backend that governs how agents maintain awareness of conversation state, process message history, and preserve context continuity across multiple interactions. This system ensures that each agent in the multi-agent orchestration maintains a coherent understanding of the conversation while managing its own state independently.

## Core Components

### 1. Agent State Tracking (`AgentState`)

The foundation of context management is the `AgentState` interface, which tracks what each agent has "seen" in a conversation:

```typescript
interface AgentState {
    lastProcessedMessageIndex: number;  // Index into Conversation.history
    claudeSessionId?: string;            // Claude Code session ID (per-agent, per-conversation)
}
```

**Key Design Decision**: Each agent maintains its own independent view of the conversation through a `lastProcessedMessageIndex`. This enables:
- Agents to join conversations at different points
- Selective message visibility based on agent involvement
- Efficient context rebuilding without redundant processing

### 2. Conversation State Management

The `ConversationCoordinator` class (src/conversations/ConversationCoordinator.ts:24-699) orchestrates all context-related operations:

- **State Storage**: Uses a `Map<string, AgentState>` per conversation to track each agent's position
- **Persistence**: Serializes agent states to disk via `FileSystemAdapter` for recovery
- **Lazy Initialization**: Agent states are created on-demand when an agent first interacts

### 3. Context Building Pipeline

The `buildAgentMessages()` method (src/conversations/ConversationCoordinator.ts:278-486) implements a sophisticated pipeline for constructing agent context:

#### Phase 1: State Initialization
When an agent enters a conversation for the first time:

1. **Direct P-tagging Detection**: The system checks if the agent was directly mentioned via p-tags
2. **Index Calculation**: 
   - If p-tagged at conversation start (index 0): Start fresh with no history
   - If p-tagged mid-conversation: Include all prior history for context
   - If not p-tagged: Standard initialization at index 0

```typescript
// ConversationCoordinator.ts:294-326
if (triggeringEvent?.id) {
    const isDirectlyAddressed = triggeringEvent.tags?.some(
        tag => tag[0] === "p" && tag[1] === targetAgent.pubkey
    );
    
    if (isDirectlyAddressed && triggeringEventIndex === 0) {
        initialIndex = 0;  // Fresh start
    } else if (isDirectlyAddressed && triggeringEventIndex > 0) {
        initialIndex = 0;  // See all history
    }
}
```

#### Phase 2: History Reconstruction
The system builds a complete conversation history up to the triggering event:

1. **Message Collection**: Gathers all events before the triggering event
2. **Attribution Classification**: Separates messages into:
   - Agent's own messages → Rendered as "assistant" role
   - User messages → Rendered as "user" role  
   - Other agents' messages → Rendered as "system" role with attribution

3. **Chronological Ordering**: Maintains conversation flow by preserving temporal order

#### Phase 3: Missed Message Handling
For returning agents, the system identifies "missed" messages:

```typescript
// ConversationCoordinator.ts:398-434
const missedEvents = conversation.history.slice(agentState.lastProcessedMessageIndex);
// Filter for messages from others
// Construct "MESSAGES WHILE YOU WERE AWAY" block if needed
```

This creates a clear delineation between:
- Historical context the agent has already processed
- New messages that occurred while the agent was inactive
- The current triggering message requiring response

#### Phase 4: Context Enrichment
The system performs several enrichment operations:

1. **Nostr Entity Processing**: Resolves nostr: URIs to actual content via `processNostrEntities()`
2. **Handoff Context**: Incorporates phase transition summaries when available
3. **Session ID Propagation**: Maintains Claude session continuity through event tags

### 4. State Persistence and Recovery

The `FileSystemAdapter` (src/conversations/persistence/FileSystemAdapter.ts:21-226) handles durable storage:

#### Serialization Process:
1. Converts `Map<string, AgentState>` to plain objects for JSON compatibility
2. Serializes NDKEvent history using native serialization methods
3. Validates schema compliance using Zod

#### Deserialization Process:
1. Reconstructs agent state Maps from stored objects
2. Deserializes NDKEvents with full signature validation
3. Ensures backward compatibility for conversations without agent states

### 5. Claude Session Management

The system maintains per-agent, per-conversation Claude sessions:

1. **Session Discovery**: Extracted from triggering event tags (`claude-session`)
2. **Session Persistence**: Stored in agent state for reuse
3. **Session Propagation**: Passed through execution context to backends

```typescript
// AgentExecutor.ts:72-83
const agentState = conversation?.agentStates.get(context.agent.slug);
const claudeSessionId = context.claudeSessionId || agentState?.claudeSessionId;
```

## Interaction Patterns

### Pattern 1: New Agent Joining Mid-Conversation

When a user p-tags a new agent mid-conversation:

1. **History Inclusion**: Agent receives full conversation history
2. **Context Awareness**: Sees all prior messages from user and other agents
3. **State Initialization**: `lastProcessedMessageIndex` set to 0 to see everything

### Pattern 2: Agent Continuation

When an existing agent receives a follow-up message:

1. **Incremental Updates**: Only processes messages since `lastProcessedMessageIndex`
2. **Own Message Recognition**: Agent's previous responses appear as "assistant" messages
3. **Context Preservation**: Maintains conversation continuity

### Pattern 3: Multi-Agent Coordination

When multiple agents work simultaneously:

1. **Independent States**: Each agent maintains its own view index
2. **Selective Visibility**: Agents only see relevant messages based on their involvement
3. **Attribution Tracking**: System clearly identifies message sources

## State Transitions

### Agent State Lifecycle:

```
[Non-existent] → [Initialized] → [Active] → [Updated] → [Persisted]
      ↓              ↓                ↓          ↓            ↓
   (first ref)    (index set)    (processing) (index++)   (to disk)
```

### Context Building Flow:

```
Triggering Event → Check P-tags → Initialize/Load State → Build History →
Add Missed Messages → Add Current Message → Update State → Return Context
```

## Implementation Details

### Memory Optimization

The system employs several optimizations:

1. **Lazy Loading**: Agent states only created when needed
2. **Index-based Tracking**: Avoids duplicating message storage
3. **Incremental Processing**: Only processes new messages

### Concurrency Handling

The `updateAgentState()` method (src/conversations/ConversationCoordinator.ts:593-606) ensures atomic updates:

```typescript
async updateAgentState(conversationId: string, agentSlug: string, updates: Partial<AgentState>) {
    // Get or create state
    // Apply updates
    // Persist immediately
    await this.persistence.save(conversation);
}
```

### Error Recovery

The system handles various failure modes:

1. **Missing Conversations**: Graceful errors with clear messages
2. **Corrupted State**: Schema validation catches malformed data
3. **Deserialization Failures**: Individual event failures don't crash recovery

## Critical Behaviors

### 1. Message Attribution Logic

The system uses sophisticated logic to determine message attribution:

- **User Detection**: Via `isEventFromUser()` utility
- **Agent Detection**: Via `getAgentSlugFromEvent()` mapping pubkeys to agent slugs
- **Display Formatting**: Different prefixes for clarity (🟢 USER, 💬 Agent Name)

### 2. History Window Management

The "MESSAGES WHILE YOU WERE AWAY" block serves crucial purposes:

1. **Temporal Clarity**: Distinguishes past from present interactions
2. **Context Compression**: Groups missed messages efficiently
3. **Cognitive Load**: Reduces confusion about conversation state

### 3. Session Continuity

Claude session IDs flow through the system:

```
Event Tag → Triggering Event → Execution Context → Agent State → Next Interaction
```

This ensures tools and context remain consistent across agent turns.

## Integration Points

### 1. Persistence Layer

- **FileSystemAdapter**: Primary storage backend
- **Schema Validation**: Zod schemas ensure data integrity
- **Metadata Management**: Separate metadata file for conversation listing

### 2. Execution System

- **AgentExecutor**: Consumes constructed contexts for LLM interaction
- **ReasonActLoop**: The unified execution implementation uses context consistently
- **NostrPublisher**: Updates conversation state after agent responses

### 3. Orchestration Layer

- **OrchestratorRoutingContext**: Special context building for routing decisions
- **Phase Transitions**: Context handoffs between phases
- **Completion Tracking**: Records agent completions in orchestrator turns

## Performance Characteristics

### Time Complexity

- **Context Building**: O(n) where n = conversation history length
- **State Update**: O(1) for index updates
- **Persistence**: O(m) where m = size of serialized conversation

### Space Complexity

- **Per Conversation**: O(h × a) where h = history size, a = active agents
- **Agent States**: O(a) where a = number of unique agents

### Scalability Considerations

1. **History Growth**: Linear increase in context building time
2. **Agent Proliferation**: Each new agent adds minimal overhead
3. **Persistence Cost**: Grows with conversation complexity

## Edge Cases and Nuances

### 1. Empty History Handling

When an agent is the first responder:
- No "MESSAGES WHILE YOU WERE AWAY" block generated
- Direct user message becomes primary context

### 2. Rapid Re-entry

If an agent processes multiple messages quickly:
- State updates may race
- Persistence layer handles via write serialization

### 3. Cross-Phase Context

During phase transitions:
- Handoff summaries bridge context gaps
- Agent states persist across phases

### 4. Orphaned States

If an agent never responds:
- State remains at initial index
- No cleanup performed (intentional for recovery)

## Security Considerations

### 1. State Tampering

- Agent states are server-managed only
- No client-side state manipulation possible
- Persistence validates all state transitions

### 2. Context Isolation

- Agents cannot access other agents' state indices
- Context building enforces visibility rules
- No cross-conversation state leakage

### 3. Session Hijacking

- Claude session IDs bound to specific agent+conversation pairs
- Cannot transfer sessions between conversations
- Session validation at execution time

## Future Considerations

The current implementation makes several architectural choices that could evolve:

1. **Index-based Tracking**: Could move to event-ID-based for better resilience
2. **State Granularity**: Could track read vs. processed separately
3. **Context Windows**: Could implement sliding windows for long conversations
4. **State Garbage Collection**: Could prune old agent states

## Conclusion

The Agent Context Management System represents a sophisticated solution to the challenge of maintaining coherent multi-agent conversations. Its index-based tracking, lazy initialization, and careful state management ensure that each agent maintains an appropriate view of the conversation while minimizing redundancy and maximizing performance.

The system's strength lies in its simplicity (index tracking) combined with sophisticated context building logic that handles the nuances of multi-agent interaction, including p-tagging, session management, and conversation continuity.

---

## Outstanding Questions

1. **State Cleanup Policy**: Should agent states be cleaned up after a certain period of inactivity, or should they persist indefinitely for potential re-engagement?

2. **Context Window Limits**: How should the system handle conversations that exceed LLM context windows? The current implementation sends full history - should there be intelligent truncation?

3. **Cross-Conversation Context**: Should agents be able to reference context from other conversations with the same user? The current isolation is strict.

4. **State Migration**: How should agent states be handled during system upgrades that change the state schema? Current versioning strategy is implicit.

5. **Concurrent Updates**: While the persistence layer serializes writes, what happens if two instances of the system try to update the same conversation simultaneously?

6. **Performance Monitoring**: Should the system track metrics on context building time, state size growth, and cache hit rates for optimization?

7. **State Rehydration**: When loading conversations from disk, should all agent states be loaded eagerly or could lazy loading improve startup time?

8. **Message Deduplication**: If an event appears multiple times in history (network issues), how does the index-based system handle this?

9. **Agent State Versioning**: Should agent states include a version field to handle backward compatibility as the schema evolves?

10. **Context Prioritization**: In very long conversations, should there be a mechanism to prioritize recent vs. important historical context?