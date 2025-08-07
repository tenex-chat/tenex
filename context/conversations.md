# Conversation Management System

## Overview

The conversation management system is the core infrastructure that maintains context, state, and continuity across multi-agent interactions in TENEX. It ensures that every agent has the complete context needed to provide coherent responses while managing the complexity of asynchronous, multi-participant conversations.

## Core Concepts

### 1. Conversation

A conversation represents a complete interaction thread initiated by a user. It maintains:
- **Unique identifier**: The ID of the initiating event
- **Title**: Human-readable description of the conversation
- **Phase**: Current operational phase (chat, brainstorm, plan, execute, verification, chores, reflection)
- **History**: Ordered sequence of all events (messages) in the conversation
- **Agent States**: Per-agent tracking of conversation position and session information
- **Metadata**: Additional context like summaries, referenced articles, and execution timing

### 2. Agent State

Each agent participating in a conversation maintains its own state:
- **lastProcessedMessageIndex**: Position in the conversation history that the agent has processed
- **claudeSessionId**: Optional session identifier for maintaining API-level continuity with Claude

### 3. Event Types

Events in a conversation can be:
- **User messages**: Direct input from the human user
- **Agent responses**: Messages from AI agents
- **System events**: Phase transitions, handoffs, and other system-level notifications

## Message Building Process

When an agent needs to respond to a conversation, the system constructs a complete message context following these principles:

### Complete History Reconstruction

The system provides the FULL conversation history to maintain perfect context continuity. This is critical for agents to:
- Answer questions about earlier parts of the conversation
- Maintain consistent understanding of the task
- Reference previous decisions and context

The history includes:
1. **All previous messages** up to (but not including) the current triggering event
2. **Proper role attribution** for each message:
   - User messages → `user` role
   - Agent's own previous messages → `assistant` role  
   - Other agents' messages → `system` role with attribution
3. **Chronological ordering** to maintain conversation flow

### Message Role Assignment

The system uses standard LLM conversation roles:

- **user**: Messages from the human user
- **assistant**: The agent's own previous responses
- **system**: Messages from other agents (with attribution) and system notifications

This standard format ensures compatibility with LLM APIs and provides clear conversation structure.

### "Messages While You Were Away" Block

This special block is used ONLY when there are genuinely new messages from other participants that the agent hasn't seen yet (messages after the agent's `lastProcessedMessageIndex`). It serves to:
- Alert the agent to activity that occurred while it was inactive
- Provide handoff context when agents transition work
- Highlight important updates that need immediate attention
- Show messages from other agents that have been added since the agent last processed the conversation

The block is NOT used when:
- The agent's own messages are being provided (these are `assistant` messages)
- The agent is continuing a direct conversation with the user
- There are no new messages from others since the agent's last interaction

### NEW INTERACTION Marker

The "=== NEW INTERACTION ===" marker works in conjunction with the "MESSAGES WHILE YOU WERE AWAY" block to differentiate between:
- The backfilled context (messages while away)
- The new message that the agent needs to respond to

The marker is added ONLY when:
- A "MESSAGES WHILE YOU WERE AWAY" block has been added
- The agent needs a clear delineation between the backfilled messages and the current triggering event

The marker is NOT added when:
- There's no "MESSAGES WHILE YOU WERE AWAY" block
- The conversation flow is already clear (e.g., direct user message with no intervening messages)

This dual-marker system ensures agents can distinguish between context they're being caught up on versus the actual message they need to respond to.

## Agent Participation Patterns

### Direct P-tagging (First Message)

When a user starts a conversation by directly addressing an agent (e.g., "@project-manager"):
- The agent is immediately added to the conversation
- No "MESSAGES WHILE YOU WERE AWAY" block (nothing happened before)
- No "NEW INTERACTION" marker (agent is directly addressed)
- The agent's state starts at index 0

### P-tagging Mid-Conversation

When a user brings a new agent into an existing conversation:
- The agent receives the complete conversation history
- All previous messages are provided in proper role format
- The agent can see everything that happened before being invited
- No "MESSAGES WHILE YOU WERE AWAY" unless there are additional unprocessed messages

### Conversation Continuation

When an agent continues an ongoing conversation:
- Full conversation history is provided
- Agent's own messages appear as `assistant` role
- User messages appear as `user` role
- Other agents' messages appear as `system` role with attribution

### Multi-Agent Interactions

When multiple agents participate:
- Each agent maintains its own state and position in the conversation
- Agents see each other's messages as system messages with clear attribution
- The full conversation context is maintained for all participants
- Handoff summaries can be provided for context during phase transitions

## State Management

### Agent State Initialization

When an agent first joins a conversation:
1. Check if the agent is being directly addressed in the triggering event
2. If it's the first message and the agent is p-tagged, start at index 0
3. If joining mid-conversation, start at index 0 to see full history
4. Store the initial state in the conversation's agent states map

### State Updates

After each agent interaction:
1. Update `lastProcessedMessageIndex` to current history length
2. Preserve any session IDs from the triggering event
3. Save the updated state for future continuity

### Session Management

Claude session IDs are:
- Extracted from triggering events when present
- Stored in the agent's state
- Preserved across multiple interactions
- Updated when new session IDs are provided
- Used to maintain API-level conversation continuity

## Critical Requirements

### Context Completeness

**Every agent must receive the complete conversation history** to maintain coherent context. This is non-negotiable because:
- Agents may be asked about any part of the conversation
- Context loss leads to confusion and incorrect responses
- Full history enables proper reasoning and decision-making

### Message Ordering

Messages must be provided in strict chronological order to maintain conversation flow. The system:
- Preserves the exact sequence of events
- Maintains proper alternation between participants
- Ensures cause-and-effect relationships are clear

### Role Consistency

Message roles must follow standard LLM conventions:
- `user` for human input
- `assistant` for the agent's own messages
- `system` for other agents and system notifications

### Attribution Clarity

When multiple agents participate, clear attribution is essential:
- Other agents' messages include their name in brackets
- System messages are clearly marked
- Handoff context is explicitly provided

## Error Prevention

### Common Pitfalls to Avoid

1. **Never provide only recent messages** - Always include full history
2. **Never mix message roles** - Maintain clear role distinctions
3. **Never duplicate the triggering event** - It should appear only once as the primary message
4. **Never show "MESSAGES WHILE YOU WERE AWAY" for the agent's own messages**
5. **Never lose session IDs** - Preserve them across interactions

### Validation Requirements

The system must ensure:
- All messages have content and proper roles
- Agent states are properly initialized before use
- History is complete and properly ordered
- Session IDs are preserved when present
- Attribution is clear for all participants

## Phase Transitions and Handoffs

When agents hand off work or transition phases:
- The receiving agent gets full conversation context
- Handoff summaries provide transition context
- Phase metadata is updated appropriately
- All participants maintain their individual states

## Testing Considerations

Critical scenarios that must be tested:
1. **Single agent conversations** with multiple exchanges
2. **P-tagging agents** at conversation start vs mid-conversation
3. **Multi-agent interactions** with proper attribution
4. **Session ID management** across interactions
5. **Phase transitions** with context preservation
6. **Agent handoffs** with summary context
7. **NEW INTERACTION marker** appearing only when MESSAGES WHILE YOU WERE AWAY is present
8. **Complete history preservation** across all scenarios

## Implementation Notes

### Message Building Logic

The `buildAgentMessages` function follows this sequence:
1. **Build complete conversation history** - All messages up to but not including the triggering event
2. **Check for messages while away** - Messages from others after `lastProcessedMessageIndex`
3. **Add MESSAGES WHILE YOU WERE AWAY block** - Only if there are new messages from others
4. **Add NEW INTERACTION marker** - Only if a "while away" block was added
5. **Add the triggering event** - The actual message to respond to

Key implementation details:
- Messages from others after `lastProcessedMessageIndex` are included in "MESSAGES WHILE YOU WERE AWAY"
- The check no longer excludes messages already in `allPreviousMessages` 
- NEW INTERACTION marker is conditional on the presence of the "while away" block

Key functions involved in the conversation management:
- `buildAgentMessages`: Constructs the complete message context for an agent
- `addEvent`: Adds new events to conversation history
- `updatePhase`: Manages phase transitions
- `updateAgentState`: Updates agent-specific state information
- `getEventSender`/`getEventSenderForHistory`: Determines message attribution

The system maintains conversation state through:
- In-memory conversation map
- Persistent storage via FileSystemAdapter
- Agent state tracking per conversation
- Session ID management for API continuity

## Performance Considerations

While providing full history is essential for context:
- History is built efficiently in a single pass
- Messages are constructed in order without redundant processing
- Agent states prevent unnecessary reprocessing
- Persistence is handled asynchronously where possible

## Key Components

- **`ConversationManager.ts`**: The main class that manages the lifecycle of conversations. It provides methods for creating, retrieving, and updating conversations.

- **`persistence/`**: This directory contains the logic for persisting conversations to storage. It includes a `FileSystemAdapter` that saves conversations to the local filesystem.

- **`types.ts`**: Defines the data structures and types used throughout the conversations module, such as `Conversation`, `Message`, and `AgentContext`.

- **`phases.ts`**: Defines the different phases of a conversation, such as `CHAT`, `PLAN`, and `EXECUTE`.

- **`executionTime.ts`**: A utility for tracking the execution time of different parts of the conversation.
