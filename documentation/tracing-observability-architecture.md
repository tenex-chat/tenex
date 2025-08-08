# Tracing and Observability Architecture

## Overview

The TENEX tracing and observability system provides comprehensive execution flow tracking, debugging capabilities, and structured logging throughout the application lifecycle. It implements a hierarchical context propagation pattern that follows the execution flow from conversations through agents, phases, and tool executions, enabling detailed insight into system behavior and performance.

## Core Components

### 1. TracingContext

The `TracingContext` interface serves as the foundation for all tracing operations, carrying execution metadata through the system's various layers.

**Structure:**
```typescript
interface TracingContext {
    conversationId: string;  // ID of the conversation (from Nostr event)
    executionId: string;     // Unique ID for this specific execution/request
    currentAgent?: string;   // Current agent name for debugging
    currentPhase?: string;   // Current phase for debugging
    currentTool?: string;    // Current tool being executed
}
```

**Key Characteristics:**
- **Immutable propagation**: Contexts are never mutated; new contexts are created with updated fields
- **Hierarchical composition**: Child contexts inherit parent properties while adding their own
- **Unique execution tracking**: Each execution gets a unique ID combining timestamp and random bytes

### 2. TracingLogger

The `TracingLogger` class provides context-aware logging that automatically includes tracing information in all log entries.

**Key Features:**
- **Module-specific verbosity**: Different log levels per module (agent, conversation, llm, nostr, tools)
- **Context enrichment**: Automatically includes tracing context in log output
- **Conditional tracing**: Only includes detailed tracing for modules with verbose/debug levels
- **Operation tracking**: Specialized methods for tracking operation lifecycle

### 3. ExecutionLogger

The `ExecutionLogger` extends tracing capabilities with structured event logging using discriminated unions for type safety.

**Event Types:**
- `tool_call`: Tool invocation with arguments
- `tool_result`: Tool execution results with status and duration
- `phase_transition`: Phase changes with reasons
- `routing`: Agent routing decisions
- `conversation_start`: New conversation initiation
- `conversation_complete`: Conversation completion with metrics
- `execution_start`: Agent execution beginning
- `execution_complete`: Agent execution completion

## Architecture Patterns

### Context Propagation Flow

```
Conversation Creation
    ├─> createTracingContext(conversationId)
    │
    ├─> Phase Execution
    │   └─> createPhaseExecutionContext(parent, phase)
    │
    ├─> Agent Execution
    │   └─> createAgentExecutionContext(parent, agentName)
    │       │
    │       └─> Tool Execution
    │           └─> createToolExecutionContext(parent, toolName)
```

### Execution Flow Tracking

1. **Conversation Level**
   - Created when a new conversation starts
   - Persists throughout the conversation lifecycle
   - Stored in `ConversationManager.conversationContexts` map

2. **Phase Level**
   - Created during phase transitions
   - Inherits conversation context
   - Tracks phase-specific operations

3. **Agent Level**
   - Created when an agent begins execution
   - Propagates through all agent operations
   - Includes agent-specific metadata

4. **Tool Level**
   - Created for each tool invocation
   - Tracks tool-specific execution details
   - Includes timing and result information

## Integration Points

### 1. ConversationManager Integration

The `ConversationManager` creates and maintains tracing contexts for conversations:

```typescript
// During conversation creation
const tracingContext = createTracingContext(id);
this.conversationContexts.set(id, tracingContext);

// During phase transitions
const phaseContext = createPhaseExecutionContext(tracingContext, phase);
const executionLogger = createExecutionLogger(phaseContext, "conversation");
```

### 2. AgentExecutor Integration

The `AgentExecutor` propagates tracing through agent executions:

```typescript
// Create agent-specific context
const tracingContext = parentTracingContext
    ? createAgentExecutionContext(parentTracingContext, context.agent.name)
    : createAgentExecutionContext(
          createTracingContext(context.conversationId),
          context.agent.name
      );

// Create execution logger for structured events
const executionLogger = createExecutionLogger(tracingContext, "agent");
```

### 3. Tool Execution Integration

The `ToolStreamHandler` manages tool-specific tracing:

```typescript
// Log tool start
this.executionLogger.toolStart(context.agent.name, toolName, toolArgs);

// Log tool completion with timing
this.executionLogger.toolComplete(
    context.agent.name,
    toolName,
    toolResult.success ? "success" : "error",
    duration,
    { result, error }
);
```

## Logging System Architecture

### Module-Based Verbosity Control

The system supports fine-grained control over logging verbosity through environment variables:

- `LOG_LEVEL`: Sets default verbosity (silent|normal|verbose|debug)
- `TENEX_LOG`: Module-specific settings (e.g., `agent:debug,llm:verbose`)

**Available Modules:**
- `agent`: Agent execution and behavior
- `conversation`: Conversation management
- `llm`: LLM interactions
- `nostr`: Nostr protocol operations
- `tools`: Tool execution
- `general`: General/miscellaneous logging

### Verbosity Levels and Tracing

Tracing context is only included when modules are set to `verbose` or `debug` levels:

```typescript
// In TracingLogger constructor
const moduleVerbosity = module
    ? verbosityConfig.modules?.[module] || verbosityConfig.default
    : verbosityConfig.default;

this.isTracingEnabled = moduleVerbosity === "verbose" || moduleVerbosity === "debug";
```

## Performance Considerations

### 1. Context Creation Overhead

- **Lightweight objects**: TracingContext objects are simple POJOs with minimal memory footprint
- **Lazy evaluation**: Context formatting only occurs when actually logging
- **Conditional inclusion**: Tracing data excluded for non-verbose modules

### 2. Memory Management

- **Context lifecycle**: Contexts are garbage collected with their parent objects
- **Map storage**: ConversationManager maintains a map of active contexts
- **Cleanup**: Contexts removed when conversations complete

### 3. Execution ID Generation

- **Unique identifiers**: Combines timestamp (base36) with 8 random bytes
- **Collision resistance**: Extremely low probability of ID collision
- **Format**: `{prefix}_{timestamp}_{random}` (e.g., `exec_lm5w3k_a1b2c3d4e5f6g7h8`)

## Observability Features

### 1. Execution Flow Visualization

The structured logging enables reconstruction of complete execution flows:

```
🗣️  NEW CONVERSATION [abc12345]
    User: "Help me analyze this code"
    
🔄 PHASE TRANSITION [abc12345]
    ├─ CHAT → PLAN
    ├─ Agent: Orchestrator
    └─ Reason: User request requires planning
    
📍 ROUTING [Orchestrator]
    ├─ Target agents: Planner
    ├─ Target phase: PLAN
    └─ Reason: Complex task requiring planning
    
🔧 TOOL CALL [Planner]
    ├─ Tool: analyze
    └─ Arguments: path="src/", depth=2
    
✅ TOOL RESULT [Planner]
    ├─ Tool: analyze → SUCCESS
    ├─ Duration: 1.23s
    └─ Result: Analysis complete
```

### 2. Performance Metrics

The system tracks:
- Tool execution durations
- Conversation completion times
- Phase transition patterns
- Agent execution times

### 3. Error Tracking

Comprehensive error context capture:
- Error location (agent, tool, phase)
- Execution state at error time
- Full tracing context for debugging

## Future Integration Opportunities

### 1. OpenTelemetry Integration

The current architecture is well-positioned for OpenTelemetry integration:

- **Span mapping**: TracingContext maps naturally to OTel spans
- **Trace propagation**: Execution IDs can serve as trace IDs
- **Attribute enrichment**: Context fields become span attributes

### 2. Metrics Collection

Potential metrics that could be extracted:
- Tool execution success rates
- Phase transition frequencies
- Agent utilization patterns
- Conversation duration distributions

### 3. Distributed Tracing

For future distributed deployments:
- Context serialization for network propagation
- Parent-child span relationships
- Cross-service correlation

## Best Practices

### 1. Context Creation

Always create contexts at system boundaries:
```typescript
// Good: Create at conversation start
const context = createTracingContext(conversationId);

// Good: Create child context for new scope
const agentContext = createAgentExecutionContext(parentContext, agentName);
```

### 2. Logger Usage

Use appropriate logger methods for different scenarios:
```typescript
// Operation lifecycle
logger.startOperation("data processing");
logger.completeOperation("data processing");

// Event tracking
logger.logEventPublished(eventId, eventType);
logger.logLLMRequest(model);
```

### 3. Error Handling

Always include tracing context in error scenarios:
```typescript
try {
    // operation
} catch (error) {
    logger.failOperation("operation name", error, {
        additionalContext: value
    });
}
```

## Limitations and Considerations

### 1. Current Limitations

- **No persistent storage**: Tracing data is not persisted beyond application lifecycle
- **No aggregation**: No built-in metrics aggregation or analysis
- **Limited correlation**: No automatic correlation with external systems
- **Memory-only**: All tracing data held in memory

### 2. Design Trade-offs

- **Simplicity over features**: Focused on essential tracing rather than full APM
- **Performance over completeness**: Conditional tracing to minimize overhead
- **Type safety**: Discriminated unions for events vs. flexible schemas

## Questions and Uncertainties

### 1. Persistence Strategy
- Should tracing data be persisted for historical analysis?
- What retention policies would be appropriate?
- How would persistence impact performance?

### 2. External Integration
- Is OpenTelemetry integration planned for the future?
- Should the system support custom trace exporters?
- How would distributed tracing work with Nostr events?

### 3. Performance Monitoring
- Should the system track more detailed performance metrics?
- Would real-time performance dashboards be valuable?
- How to balance comprehensive tracking with system overhead?

### 4. Error Recovery Tracing
- How should the system track error recovery attempts?
- Should failed execution paths be preserved for analysis?
- What level of detail is needed for debugging production issues?

### 5. Metrics Aggregation
- Should the system provide built-in metrics aggregation?
- What time windows would be most useful for aggregation?
- How to handle high-cardinality data like conversation IDs?

### 6. Security and Privacy
- How should sensitive data in traces be handled?
- What PII scrubbing mechanisms are needed?
- Should there be role-based access to tracing data?