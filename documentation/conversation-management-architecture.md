# Conversation Management Architecture

## Executive Summary

The Conversation Management system is the central nervous system of TENEX, orchestrating all multi-agent interactions and maintaining state across distributed, asynchronous conversations. This sophisticated system tracks the complete lifecycle of conversations through phases, manages individual agent states to ensure proper context awareness, handles orchestrator routing decisions, and provides persistent storage with recovery capabilities. The architecture uniquely solves the challenge of maintaining conversational coherence across multiple autonomous agents while ensuring each agent sees only the context relevant to their participation.

## Core Architecture

### System Overview

The ConversationManager implements a layered state management architecture:

```
┌─────────────────────────────────────────────────────────┐
│                   Nostr Event Stream                     │
│                 (User & Agent Messages)                  │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│               ConversationManager                        │
│         (Central State & Context Manager)                │
│                                                          │
│  • Conversation Creation & Lifecycle                     │
│  • Phase Management & Transitions                        │
│  • Agent State Tracking (per-agent views)                │
│  • Message History Management                            │
│  • Orchestrator Routing Context                          │
│  • Persistence Coordination                              │
└──────┬──────────────┬──────────────┬────────────────────┘
       │              │              │
       ▼              ▼              ▼
┌──────────┐  ┌──────────────┐  ┌──────────────┐
│  Agent    │  │ Orchestrator │  │ Persistence  │
│ Executor  │  │   Routing    │  │   Adapter    │
└───────────┘  └──────────────┘  └──────────────┘
```

## Key Components

### 1. ConversationManager (Core Manager)
**Location**: `src/conversations/ConversationManager.ts`

The singleton manager that orchestrates all conversation state:

#### Core Responsibilities:

- **Conversation Lifecycle**: Creates, loads, archives, and completes conversations
- **Phase Management**: Tracks and transitions between conversation phases (chat, plan, execute, etc.)
- **Agent State Tracking**: Maintains per-agent view of conversation history
- **Message Building**: Constructs appropriate context for each agent based on their participation
- **Orchestrator Support**: Provides structured routing context for orchestrator decisions
- **Persistence Management**: Coordinates with adapters for durable storage

#### Critical Design Decisions:

**1. Per-Agent State Tracking**

Each agent maintains its own view of the conversation through an `AgentState`:
```typescript
interface AgentState {
    lastProcessedMessageIndex: number; // Last seen message in history
    claudeSessionId?: string;          // Claude Code session tracking
}
```

This design ensures:
- Agents only see messages relevant to them
- Late-joining agents get appropriate context
- Session continuity for stateful agents (like Claude)

**2. Single Source of Truth**

The `history: NDKEvent[]` array is the canonical record of all conversation events. All agent views are derived from this single source, preventing synchronization issues.

**3. Phase-Based Workflow**

Conversations flow through defined phases:
- **chat**: Requirements gathering
- **brainstorm**: Creative exploration  
- **plan**: Architecture and design
- **execute**: Implementation
- **verification**: Testing and validation
- **chores**: Documentation and cleanup
- **reflection**: Learning and insights

### 2. Message Context Building
**Method**: `buildAgentMessages()`

This critical method constructs the appropriate message context for each agent:

#### Context Building Algorithm:

1. **Initialize Agent State**: Create or retrieve the agent's view state
2. **Build Historical Context**: Include all previous messages up to the triggering event
3. **Attribute Messages**: Mark messages as user/assistant/system based on sender
4. **Handle Missing Messages**: Add "MESSAGES WHILE YOU WERE AWAY" block for context
5. **Add Triggering Event**: Include the current message that triggered the agent
6. **Update State**: Record what the agent has now seen

#### Special Cases:

**P-Tagged Agents**: When an agent is directly mentioned via p-tag:
- At conversation start: Agent sees no prior history
- Mid-conversation: Agent sees full history for context

**Nostr Entity Processing**: The system automatically:
- Detects nostr entities (nevent, naddr, etc.) in messages
- Fetches and inlines the referenced content
- Preserves entity references for traceability

### 3. Orchestrator Routing Context
**Method**: `buildOrchestratorRoutingContext()`

Provides structured JSON context for orchestrator routing decisions:

```typescript
interface OrchestratorRoutingContext {
    user_request: string;              // Original user request
    routing_history: RoutingEntry[];   // Past routing decisions
    current_routing: RoutingEntry | null; // Active routing state
}
```

#### Orchestrator Turn Management:

The system tracks orchestrator "turns" - coordinated multi-agent executions:

1. **Turn Creation**: `startOrchestratorTurn()` initiates a new routing decision
2. **Completion Tracking**: `addCompletionToTurn()` records agent completions
3. **Turn Resolution**: Marks turns complete when all routed agents finish
4. **History Building**: Converts completed turns into routing history

This enables the orchestrator to:
- Understand what's been tried before
- Avoid routing loops
- Make informed next-step decisions
- Track multi-agent coordination

### 4. Persistence Layer
**Implementation**: `FileSystemAdapter`

The persistence system provides durable storage with:

#### Storage Strategy:

- **Active Conversations**: Stored in `.tenex/conversations/`
- **Archived Conversations**: Moved to `.tenex/conversations/archive/`
- **Metadata Index**: Maintained in `metadata.json` for fast lookups
- **Serialization**: NDKEvents serialized with full signature preservation

#### Key Features:

**Atomic Updates**: Metadata updates are serialized through a lock mechanism to prevent race conditions

**Recovery Support**: Handles daemon restarts gracefully:
- Detects orphaned active sessions
- Resets execution time tracking
- Preserves conversation state

**Search Capabilities**: Supports searching by:
- Title (fuzzy matching)
- Phase
- Date range
- Archive status

### 5. Phase Transition System

Phase transitions are first-class entities with full tracking:

```typescript
interface PhaseTransition {
    from: Phase;
    to: Phase;
    message: string;      // Context for transition
    timestamp: number;
    agentPubkey: string;  // Who initiated
    agentName: string;    // Human-readable
    reason?: string;      // Why transition occurred
    summary?: string;     // State summary for handoff
}
```

#### Transition Rules:

The system enforces valid phase transitions:
- `chat` → `execute`, `plan`, `brainstorm`
- `execute` → `verification`, `chat`
- `verification` → `chores`, `execute`, `chat`
- `reflection` → `chat` (terminal reflection)

#### Special Behaviors:

**Reflection Reset**: When transitioning from `reflection` back to `chat`, the system clears `readFiles` metadata to prevent stale security context.

### 6. Execution Time Tracking

The system tracks actual execution time across:
- Multiple sessions (daemon restarts)
- Active and inactive periods
- Per-conversation granularity

```typescript
interface ExecutionTime {
    totalSeconds: number;          // Cumulative time
    currentSessionStart?: number;   // Active session start
    isActive: boolean;             // Currently executing
    lastUpdated: number;           // For crash recovery
}
```

## Critical Implementation Details

### 1. Message Attribution Strategy

The system uses different attribution strategies based on context:

**For Historical Context**:
- User messages: Added as "user" role
- Agent's own messages: Added as "assistant" role
- Other agents: Added as "system" with attribution

**For Current Context**:
- Clearly marks "MESSAGES WHILE YOU WERE AWAY"
- Uses "NEW INTERACTION" separator
- Preserves sender attribution for clarity

### 2. Conversation Initialization Flow

1. **Event Reception**: New conversation event arrives
2. **Conversation Creation**: Manager creates conversation with initial state
3. **Article Reference Check**: Detects and fetches NDKArticle references (30023 events)
4. **Tracing Context**: Creates unique tracing context for debugging
5. **Initial Phase**: Sets to CHAT phase by default
6. **Agent State Init**: Prepares empty agent state map
7. **Persistence**: Immediately saves to disk

### 3. Agent Context Building Nuances

**Late-Joining Agents**: When an agent joins mid-conversation:
- They see the full conversation history for context
- Their state starts at index 0 to process all messages
- System tracks what they've "seen" for future turns

**Multi-Agent Coordination**: When multiple agents work simultaneously:
- Each maintains independent state
- Orchestrator tracks completion through turns
- Context building ensures no message duplication

**Session Continuity**: For stateful agents (Claude):
- Session IDs preserved across turns
- Passed through event tags
- Maintained in agent state

### 4. Orchestrator Integration Points

The ConversationManager provides three key integration points:

1. **Routing Context Building**: Structured JSON for routing decisions
2. **Turn Management**: Tracks multi-agent coordination
3. **Completion Extraction**: Identifies complete() tool calls in events

This enables the orchestrator to operate as an "invisible router" that never directly responds to users but coordinates agent collaboration.

### 5. Persistence Serialization Details

**NDKEvent Serialization**: Events are serialized with `serialize(true, true)` to preserve:
- Full event content
- Signature data
- All tags and metadata

**Map to Object Conversion**: Agent states are converted from Map to plain object for JSON serialization, then reconstructed on load.

**Zod Validation**: All loaded data is validated against schemas to ensure data integrity and handle migration gracefully.

## State Management Patterns

### 1. Optimistic Updates

The system performs optimistic updates followed by persistence:
1. Update in-memory state immediately
2. Persist to disk asynchronously
3. Handle persistence failures gracefully

### 2. Event Sourcing Pattern

All state changes derive from the event stream:
- Events are the source of truth
- State is reconstructed from events
- Enables replay and recovery

### 3. Agent Isolation

Each agent operates in isolation:
- Independent state tracking
- No shared mutable state
- Context derived at execution time

## Security Considerations

### 1. File Access Tracking

The system tracks `readFiles` in metadata to:
- Prevent unauthorized file writes
- Scope agent permissions
- Clear on phase transitions

### 2. Event Validation

All incoming events are validated for:
- Valid signatures
- Proper tag structure
- Expected event kinds

### 3. Persistence Isolation

Each conversation is isolated:
- Separate file storage
- No cross-conversation access
- Archived conversations are read-only

## Performance Optimizations

### 1. Lazy Loading

Conversations are loaded on-demand:
- Metadata cached in memory
- Full conversation loaded when accessed
- Automatic cleanup of inactive conversations

### 2. Incremental Updates

Only changed data is persisted:
- Metadata updates are incremental
- Event history appends only
- State updates are minimal

### 3. Lock-Free Reads

Read operations are lock-free:
- Multiple agents can read simultaneously
- Writes are serialized through locks
- Metadata updates are atomic

## Error Recovery Mechanisms

### 1. Crash Recovery

On daemon restart:
- Active execution times are reset
- Conversations are reloaded from disk
- Agent states are preserved

### 2. Corruption Handling

If conversation data is corrupted:
- Zod validation catches issues
- Conversation skipped but not lost
- Metadata rebuilt from valid conversations

### 3. Missing Events

If events fail to load:
- Conversation continues with available events
- Missing events logged but not fatal
- State remains consistent

## Integration Points

### 1. Event Handlers

- `newConversation`: Creates and initiates conversations
- `reply`: Adds events and triggers agents
- `task`: Handles task-specific routing

### 2. Agent Executor

- Requests message context via `buildAgentMessages()`
- Updates agent states after execution
- Triggers phase transitions

### 3. Routing Backend

- Fetches orchestrator routing context
- Records routing decisions as turns
- Manages completion tracking

### 4. Nostr Publisher

- Reads conversation state for context
- Updates conversation with published events
- Maintains event ordering

## Future Considerations

### 1. Scalability

Current limitations:
- All conversations loaded in memory
- Single-node architecture
- File-based persistence

Potential improvements:
- Database-backed persistence
- Distributed state management
- Event streaming architecture

### 2. Advanced Features

Possible enhancements:
- Conversation branching/merging
- Time-travel debugging
- Real-time collaboration
- Advanced search capabilities

### 3. Performance Monitoring

Areas for instrumentation:
- Context building performance
- Persistence operation metrics
- Memory usage patterns
- Event processing throughput

## Open Questions and Uncertainties

### 1. Conversation Lifecycle

- **When should conversations be archived?** Currently manual, but could be automated based on age, inactivity, or completion status.
- **How to handle very long conversations?** The current in-memory model may struggle with conversations containing thousands of events.
- **Should completed conversations be immutable?** Currently they can be modified after completion.

### 2. Agent State Management

- **How to handle agent version changes?** If an agent's behavior changes significantly, should its state be reset?
- **What about shared agent state across conversations?** Currently each conversation has isolated agent state.
- **Should agent states be versioned?** For debugging and rollback capabilities.

### 3. Phase Transition Logic

- **Are phase transition rules too rigid?** Some workflows might benefit from more flexible transitions.
- **Should phases be pluggable?** Current phases are hardcoded, but projects might need custom phases.
- **How to handle phase timeout?** No mechanism exists for timing out stuck phases.

### 4. Orchestrator Routing

- **How to prevent routing loops?** Current system tracks history but doesn't explicitly prevent loops.
- **Should routing decisions be reversible?** No undo mechanism exists for routing decisions.
- **How to handle routing conflicts?** When multiple orchestrators operate on the same conversation.

### 5. Performance and Scale

- **What's the maximum practical conversation size?** No limits are enforced, but performance degradation is likely.
- **How to handle concurrent modifications?** Current locking is coarse-grained and might bottleneck.
- **Should old messages be pruned?** No mechanism exists to trim conversation history.

### 6. Error Handling

- **How to recover from partial state corruption?** Current approach skips entire conversations.
- **What about event replay for recovery?** No mechanism to replay events to rebuild state.
- **Should there be automatic error correction?** Currently all error handling is manual.

### 7. Security Model

- **How to implement fine-grained permissions?** Current file tracking is basic.
- **Should agent capabilities be conversation-scoped?** Currently agents have global capabilities.
- **How to audit agent actions?** No explicit audit log beyond event history.

### 8. Integration Challenges

- **How to handle external event sources?** System assumes all events come through Nostr.
- **What about non-Nostr message formats?** No adapter pattern for other protocols.
- **How to integrate with external state stores?** Persistence is currently file-only.

These questions represent areas where the architecture might need evolution based on real-world usage patterns and requirements that emerge over time.