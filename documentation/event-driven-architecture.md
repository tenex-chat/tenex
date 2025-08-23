# Event-Driven Architecture Documentation

## Overview

The TENEX backend implements a sophisticated event-driven architecture built on the Nostr protocol. This architecture enables real-time, decentralized communication between agents, users, and system components through a publish-subscribe model. The system processes various event types, maintains conversation state, and coordinates multi-agent interactions through event flows.

## Core Components

### 1. Event Infrastructure

#### NDK Client (`src/nostr/ndkClient.ts`)
The system uses a singleton NDK (Nostr Development Kit) instance that manages connections to Nostr relays:

- **Singleton Pattern**: Ensures a single NDK instance throughout the application lifecycle
- **Relay Management**: Connects to multiple relays for redundancy and performance
- **Connection Lifecycle**: Handles initialization, connection, and graceful shutdown
- **Configuration**: Disables outbox model, enables auto-connection features

#### Event Types (`src/llm/types.ts`)
The system defines specific event kinds for different purposes:

```typescript
EVENT_KINDS = {
    METADATA: 0,                    // User/agent metadata
    NEW_CONVERSATION: 11,            // Start new conversation
    GENERIC_REPLY: 1111,            // Standard messages
    PROJECT: 17001,                 // Project configuration
    AGENT_CONFIG: 4199,             // Agent definitions
    TASK: 1934,                     // Task assignments
    PROJECT_STATUS: 24010,          // Heartbeat/status
    AGENT_REQUEST: 4133,            // Agent invocation
    TYPING_INDICATOR: 24111,        // Typing start
    TYPING_INDICATOR_STOP: 24112,  // Typing stop
    STREAMING_RESPONSE: 21111,      // Real-time streaming
    TENEX_LOG: 24015,              // System logs
    AGENT_CONFIG_UPDATE: 24020,    // Agent configuration updates
}
```

### 2. Event Processing Pipeline

#### EventHandler (`src/event-handler/index.ts`)
The central event processing hub that routes incoming events to appropriate handlers:

- **Event Discrimination**: Ignores specific event kinds (status, typing indicators) to prevent loops
- **Handler Routing**: Routes events based on kind to specialized handlers
- **Component Management**: Initializes and manages ConversationCoordinator and AgentExecutor
- **State Management**: Handles project update locking to prevent concurrent modifications
- **Configuration Updates**: Processes agent configuration updates dynamically

#### Specialized Event Handlers

**Reply Handler** (`src/event-handler/reply.ts`):
- Manages conversation continuity
- Finds existing conversations through E-tags
- Handles agent mentions via p-tags
- Prevents infinite loops by checking sender identity
- Manages phase transitions and handoffs

**New Conversation Handler** (`src/event-handler/newConversation.ts`):
- Initializes new conversation contexts
- Sets up initial conversation state
- Routes to orchestrator for initial processing

**Project Handler** (`src/event-handler/project.ts`):
- Updates project configuration
- Manages agent registry
- Synchronizes project state

### 3. Event Publishing System

#### NostrPublisher (`src/nostr/NostrPublisher.ts`)
The primary interface for publishing events to Nostr:

**Core Responsibilities**:
- **Response Publishing**: Publishes agent responses with metadata
- **Error Handling**: Publishes error notifications
- **TENEX Logging**: Publishes structured system logs
- **Typing Indicators**: Manages typing state notifications
- **Tool Execution Status**: Reports tool execution progress

**Key Features**:
- **Transactional Pattern**: Save-then-publish ensures consistency
- **Tag Management**: Adds project, phase, and execution tags
- **Voice Mode Propagation**: Maintains voice mode across events
- **Clean Routing**: Removes p-tags to prevent notification spam

#### StreamPublisher (Inner Class)
Handles real-time streaming of agent responses:

- **Content Buffering**: Accumulates content for efficient batching
- **Sentence Detection**: Flushes at natural boundaries
- **Network Optimization**: Balances latency vs. efficiency
- **Sequence Management**: Maintains ordered stream delivery
- **Finalization**: Publishes complete response with metadata


#### TypingIndicatorManager (`src/nostr/TypingIndicatorManager.ts`)
Sophisticated typing state management:

- **Minimum Duration**: Ensures 5-second minimum visibility
- **Debouncing**: Prevents flickering during rapid messages
- **Retry Logic**: Implements exponential backoff for failures
- **State Consistency**: Maintains typing state across interruptions

### 4. Event Subscription System

#### SubscriptionManager (`src/commands/run/SubscriptionManager.ts`)
Manages real-time event subscriptions:

**Subscription Types**:
1. **Project Updates**: Monitors project configuration changes
2. **Agent Lessons**: Collects agent learning events
3. **Project Events**: Subscribes to all project-tagged events

**Features**:
- **Duplicate Detection**: Tracks processed events to prevent reprocessing
- **Persistent Tracking**: Saves processed event IDs to disk
- **EOSE Handling**: Handles end-of-stored-events notifications
- **Graceful Shutdown**: Flushes pending saves before stopping

#### StatusPublisher (`src/commands/run/StatusPublisher.ts`)
Publishes periodic heartbeat events:

- **Periodic Publishing**: Sends status every 30 seconds
- **Agent Discovery**: Lists all project agents
- **Model Information**: Reports configured LLM models
- **Project Tagging**: Ensures proper project association

### 5. Event Monitoring (Daemon Mode)

#### EventMonitor (`src/daemon/EventMonitor.ts`)
Monitors events for daemon process management:

- **Whitelist Filtering**: Only processes events from authorized pubkeys
- **Project Detection**: Extracts project identifiers from a-tags
- **Process Spawning**: Starts project processes for incoming events
- **Duplicate Prevention**: Checks if project is already running

## Event Flow Patterns

### 1. Conversation Initiation Flow

```
User Event (kind: 11) 
    → EventHandler 
    → handleNewConversation 
    → ConversationCoordinator.createConversation
    → AgentExecutor.execute
    → NostrPublisher.publishResponse
```

### 2. Message Reply Flow

```
Reply Event (kind: 1111)
    → EventHandler
    → handleChatMessage
    → Find conversation via E-tag
    → Route to target agent (p-tag or orchestrator)
    → AgentExecutor.execute
    → Stream response via StreamPublisher
```

### 3. Task Assignment Flow

```
Task Event (kind: 1934)
    → EventHandler
    → Logged/skipped (handled via claude_code tool)
```

### 4. Streaming Response Flow

```
Agent Response Generation
    → StreamPublisher.addContent
    → Buffer and detect sentences
    → Flush at boundaries
    → Publish streaming events (kind: 21111)
    → Finalize with complete response (kind: 1111)
```

### 5. Configuration Update Flow

```
Agent Config Update (kind: 24020)
    → EventHandler.handleAgentConfigUpdate
    → Extract agent pubkey and model
    → Update AgentRegistry
    → Persist configuration
    → Update in-memory state
```

## Tagging System

The system uses Nostr tags for metadata and routing:

### Standard Tags
- **e**: Event references (replies, threads)
- **E**: Root event reference
- **p**: Pubkey mentions (routing)
- **a**: Replaceable event references (projects)
- **K**: Referenced event kind

### Custom Tags
- **project**: Project association (a-tag format)
- **phase**: Conversation phase state
- **net-time**: Total execution time
- **mode**: Voice mode indicator
- **claude-session**: Session continuity
- **streaming**: Streaming indicator
- **sequence**: Stream sequence number

### LLM Metadata Tags
- **llm-model**: Model identifier
- **llm-cost-usd**: Execution cost
- **llm-prompt-tokens**: Input token count
- **llm-completion-tokens**: Output token count
- **llm-total-tokens**: Total token usage

## State Management

### Conversation State
- Maintained by ConversationCoordinator
- Persisted to filesystem
- Synchronized with Nostr events
- Tracks phase transitions

### Processed Events Tracking
- Prevents duplicate processing
- Persisted to disk periodically
- Loaded on startup
- Cleared on shutdown

### Typing State
- Managed per conversation
- Minimum duration enforcement
- Automatic cleanup on completion

## Error Handling Patterns

### Publisher Error Recovery
1. Capture and format errors
2. Publish error notification events
3. Log with context
4. Continue processing

### Stream Failure Recovery
1. Buffer failed content
2. Retry with backoff
3. Prepend to pending buffer
4. Roll back sequence numbers

### Subscription Resilience
1. Automatic reconnection
2. Event deduplication
3. Persistent state recovery
4. Graceful degradation

## Performance Optimizations

### Batching Strategies
- Stream content buffering
- Sentence-boundary flushing
- Debounced typing indicators
- Batch event processing

### Network Efficiency
- Ephemeral events for typing/streaming
- Tag-based routing (no unnecessary p-tags)
- Relay connection pooling
- Event deduplication

### Memory Management
- Singleton NDK instance
- Event ID tracking with periodic flush
- Conversation state pruning
- Limited buffer sizes

## Security Considerations

### Event Validation
- Signature verification via NDK
- Pubkey whitelist checking
- Project association validation
- Agent authentication

### Loop Prevention
- Ignore self-authored events
- Skip typing/status events
- Check sender identity
- Rate limiting consideration

### Access Control
- Project-based isolation
- Agent pubkey verification
- Whitelisted event authors
- Signed event requirements

## Integration Points

### With Agent System
- AgentExecutor receives events
- Agents publish via NostrPublisher
- Agent configuration via events
- Agent lessons via NDKAgentLesson

### With Conversation Management
- Events create/update conversations
- Conversation state drives routing
- Phase transitions via events
- History tracked as NDKEvents

### With LLM System
- LLM metadata in event tags
- Dynamic configuration updates
- Cost tracking in events
- Model selection via events

### With Tool System
- Tool execution status events
- Tool results in responses
- Terminal tools publish directly
- Progress updates via events

## Monitoring and Observability

### Event Metrics
- Event processing counts
- Handler execution times
- Publication success rates
- Subscription health

### System Logs
- TENEX log events (kind: 24015)
- Structured logging with context
- Error event publication
- Debug event tracking

### Status Monitoring
- Periodic status events
- Agent availability
- Model configuration
- Project health

## Future Considerations

### Scalability
- Event sharding strategies
- Relay federation patterns
- Horizontal scaling approaches
- Event archive strategies

### Reliability
- Event replay mechanisms
- State reconstruction
- Checkpoint systems
- Disaster recovery

### Extensions
- Custom event kinds
- Plugin event handlers
- Event transformation pipelines
- Cross-project communication

## Questions and Uncertainties

1. **Event Ordering**: How does the system handle out-of-order event delivery from different relays? Is there a mechanism for event ordering beyond timestamps?

2. **Rate Limiting**: What happens under high event load? Are there rate limiting mechanisms to prevent event flooding?

3. **Relay Failover**: How does the system handle relay failures? Is there automatic failover to backup relays?

4. **Event Retention**: How long are events retained in the processed events cache? Is there a cleanup mechanism for old events?

5. **Subscription Recovery**: If a subscription is interrupted, how does the system recover missed events? Is there a catch-up mechanism?

6. **Event Prioritization**: Are certain event types prioritized over others? How does the system handle event queue management?

7. **Cross-Project Events**: Can events be shared between projects? What are the isolation boundaries?

8. **Event Validation**: Beyond signature verification, what additional validation is performed on incoming events?

9. **Performance Limits**: What are the practical limits on event throughput? Has the system been load tested?

10. **Event Migration**: How would the system handle changes to event formats or kinds? Is there a versioning strategy?