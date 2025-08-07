# Agent Execution Architecture

## Executive Summary

The Agent Execution Architecture forms the core runtime engine of TENEX, implementing a sophisticated streaming-based execution model that powers all agent interactions. This system manages the complete lifecycle of agent execution through a multi-layered architecture comprising execution backends, stream processing, tool handling, and termination enforcement. The architecture uniquely combines direct LLM streaming with type-safe tool execution, state management, and automatic recovery mechanisms to ensure reliable and consistent agent behavior across diverse execution contexts.

## Core Architecture

### System Overview

The execution system implements a layered, pluggable architecture:

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Request                         │
│              (Conversation Event/Trigger)                │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                  AgentExecutor                           │
│            (Orchestration & Coordination)                │
│         • Message building with context                  │
│         • Backend selection by agent type                │
│         • Execution time tracking                        │
│         • Session management                             │
└─────────────────────┬───────────────────────────────────┘
                      │
         ┌────────────┼────────────┬──────────────┐
         ▼            ▼            ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ReasonActLoop │ │RoutingBackend│ │ClaudeBackend │
│  (Default)   │ │(Orchestrator)│ │  (Claude)    │
└──────┬───────┘ └──────────────┘ └──────────────┘
        │
┌───────▼────────────────────────────────────────────────┐
│              Stream Processing Pipeline                 │
│  • StreamStateManager: State tracking                   │
│  • ToolStreamHandler: Tool execution                    │
│  • TerminationHandler: Completion enforcement           │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                  Tool Execution Layer                    │
│         • ToolExecutor: Type-safe execution              │
│         • ToolPlugin: LLM integration adapter            │
│         • Result serialization/deserialization           │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                   Output Publishing                      │
│         • StreamPublisher: Nostr event streaming         │
│         • Typing indicators                             │
│         • Error propagation                             │
└─────────────────────────────────────────────────────────┘
```

## Key Components

### 1. AgentExecutor
**Location**: `src/agents/execution/AgentExecutor.ts`

The top-level orchestrator for agent execution, responsible for:

**Core Responsibilities**:
- **Backend Selection**: Chooses appropriate execution backend based on agent configuration
- **Message Building**: Constructs conversation context with proper agent perspective
- **Session Management**: Maintains Claude session continuity across executions
- **Execution Coordination**: Manages the complete execution lifecycle
- **Time Tracking**: Records execution duration for performance monitoring

**Backend Selection Logic**:
```typescript
private getBackend(agent: Agent): ExecutionBackend {
    const backendType = agent.backend || "reason-act-loop";
    
    switch (backendType) {
        case "claude":      // Direct Claude passthrough
            return new ClaudeBackend();
        case "routing":     // Orchestrator routing logic
            return new RoutingBackend(...);
        case "reason-act-loop":  // Standard tool-using agents
        default:
            return new ReasonActLoop(...);
    }
}
```

**Message Building Strategy**:

The executor builds different message formats based on agent type:

1. **Standard Agents**: Receive full conversation transcript with context
2. **Orchestrator**: Receives structured JSON routing context
3. **All Agents**: Get system prompt with project context, available agents, and tools

**Session Continuity**:

Claude sessions are maintained through:
- Retrieval from conversation state
- Preservation across multiple turns
- Association with specific agent instances

### 2. ReasonActLoop
**Location**: `src/agents/execution/ReasonActLoop.ts`

The primary execution backend implementing the core streaming loop:

**Architecture**:

The ReasonActLoop implements a sophisticated retry mechanism with termination enforcement:

```typescript
// Core execution flow
while (attempt < MAX_TERMINATION_ATTEMPTS) {
    1. Create LLM stream
    2. Process stream events
    3. Handle tool executions
    4. Check for termination
    5. Retry with reminder if needed
}
```

**Stream Event Processing**:

The loop processes five distinct event types:

1. **content**: Text chunks from LLM response
   - Accumulated in state manager
   - Published to Nostr (except for orchestrator)
   - Reasoning extraction for thinking blocks

2. **tool_start**: Tool execution beginning
   - Flush existing content
   - Publish typing indicator with tool description
   - Track tool start for duplicate detection

3. **tool_complete**: Tool execution finished
   - Parse and validate result
   - Check for termination signals
   - Handle missing tool_start events
   - Publish errors if tool failed

4. **done**: Stream completion
   - Store final response
   - Prepare for finalization

5. **error**: Stream-level errors
   - Log and propagate
   - Append to content stream

**Termination Enforcement**:

A critical feature ensuring agents properly complete their work:

```
Attempt 1 → Execute normally
    ↓ (no termination)
Attempt 2 → Add reminder message → Re-execute
    ↓ (still no termination)
Auto-complete with system message
```

**Reasoning Extraction**:

The system extracts and processes `<thinking>` blocks:
- Parses structured reasoning format
- Tracks processed blocks to avoid duplicates
- Logs decision-making process for debugging

### 3. StreamStateManager
**Location**: `src/agents/execution/StreamStateManager.ts`

Centralized state management for stream processing:

**State Structure**:
```typescript
interface StreamingState {
    allToolResults: ToolExecutionResult[];      // Tool execution history
    termination: Complete | EndConversation;    // Terminal signal
    finalResponse: CompletionResponse;          // LLM final response
    fullContent: string;                        // Accumulated text
    streamPublisher: StreamPublisher;           // Nostr publisher
    startedTools: Set<string>;                  // Tool start tracking
    loggedThinkingBlocks: Set<string>;         // Reasoning deduplication
}
```

**Key Features**:

1. **Stateful Accumulation**: Builds complete response from chunks
2. **Tool Tracking**: Maintains execution history
3. **Retry Support**: Selective state reset for retry attempts
4. **Custom State**: Extensible key-value storage for handlers
5. **State Summary**: Debugging snapshots of current state

**Reset Strategies**:

- **Full Reset**: Clears everything for new execution
- **Retry Reset**: Preserves stream publisher for continuity

### 4. ToolStreamHandler
**Location**: `src/agents/execution/ToolStreamHandler.ts`

Manages tool-related events and execution:

**Tool Start Processing**:

1. Generate unique tool call ID
2. Log execution start
3. Flush existing stream content
4. Publish descriptive typing indicator
5. Track tool start for deduplication

**Tool Complete Processing**:

Complex flow handling various edge cases:

```typescript
async handleToolCompleteEvent(...) {
    1. Parse tool result
    2. Check for missing tool_start
       → Publish retroactive indicator if needed
    3. Add result to state
    4. Log completion metrics
    5. Publish errors if failed
    6. Process control flow results
    7. Check for termination
}
```

**Missing Tool Start Recovery**:

When tools skip the start event:
1. Detect missing start by checking tool call pattern
2. Extract metadata from result if available
3. Generate appropriate typing indicator
4. Brief delay to ensure visibility
5. Continue with normal completion flow

**Tool Description Generation**:

Human-readable descriptions for typing indicators:
- File operations: "📖 Reading config.json"
- Git commands: "🔧 Running git command: git status"
- Web operations: "🌐 Fetching content from https://..."
- MCP tools: "🔌 Using filesystem to search files"

### 5. TerminationHandler
**Location**: `src/agents/execution/TerminationHandler.ts`

Enforces proper task completion:

**Termination Requirements**:

Different phases have different requirements:
- **CHAT/BRAINSTORM**: No termination required (conversational)
- **Other Phases**: Must call complete() or end_conversation()
- **Orchestrator**: Must always provide routing (never auto-completes)

**Retry Logic**:

```typescript
shouldRetryForTermination(context, attempt) {
    if (terminated || !required) return false;
    if (attempt < MAX_ATTEMPTS) {
        // Generate reminder and retry
        return true;
    }
    // Auto-complete for non-orchestrators
    autoCompleteTermination();
    return false;
}
```

**Reminder Messages**:

Context-aware reminders:
- **Orchestrator**: "You haven't provided routing instructions yet..."
- **Standard Agent**: "You haven't used the 'complete' tool yet..."

**Auto-Completion**:

Safety mechanism when agents fail to terminate:
1. Log the failure
2. Generate completion from accumulated content
3. Route back to orchestrator
4. Mark as system-generated

### 6. ToolExecutor
**Location**: `src/tools/executor.ts`

Type-safe tool execution engine:

**Execution Pipeline**:

```typescript
async execute(tool, input) {
    1. Start timing
    2. Validate input (skip for special tools)
    3. Execute tool with context
    4. Process result with metadata
    5. Return typed result
}
```

**Special Cases**:

- **generate_inventory**: Skips validation for dynamic schemas
- **Error Handling**: Wraps all errors in typed format
- **Metadata Propagation**: Preserves tool-provided metadata

**Result Structure**:
```typescript
interface ToolExecutionResult {
    success: boolean;
    output?: T;                           // Typed output
    error?: ToolError;                    // Typed error
    duration: number;                     // Execution time
    metadata?: ToolExecutionMetadata;     // UI hints
}
```

### 7. ToolPlugin
**Location**: `src/llm/ToolPlugin.ts`

Bridges TENEX tools with multi-llm-ts framework:

**Adapter Pattern**:

Converts between type systems:
1. TENEX Tool → multi-llm-ts Plugin
2. Zod schemas → Plugin parameters
3. Typed results → Serialized format

**Execution Flow**:

```typescript
async execute(context, parameters) {
    1. Execute via ToolExecutor
    2. Serialize typed result
    3. Extract human-readable output
    4. Format errors if present
    5. Log execution metrics
    6. Return hybrid result structure
}
```

**Result Serialization**:

Dual-format results:
- **Human-readable**: For LLM consumption
- **Typed**: For system processing via __typedResult

**Control Flow Handling**:

Special processing for termination tools:
- Extracts response from complete() results
- Formats end_conversation messages
- Preserves metadata for system use

## Execution Flow

### 1. Initialization Phase

When an agent execution begins:

```typescript
// AgentExecutor.execute()
1. Create tracing context
2. Build messages with context
3. Retrieve Claude session ID
4. Initialize publisher
5. Start execution timing
6. Select appropriate backend
7. Begin streaming execution
```

### 2. Message Construction

Different strategies based on agent type:

**Standard Agents**:
```typescript
buildAgentMessages() → 
    Historical messages +
    New messages since last seen +
    "MESSAGES WHILE YOU WERE AWAY" blocks
```

**Orchestrator**:
```typescript
buildOrchestratorRoutingContext() →
    {
        user_request: string,
        routing_history: RoutingEntry[],
        current_routing: RoutingEntry | null
    }
```

### 3. Streaming Loop

The core execution cycle:

```
Start Stream → Process Events → Check Termination
      ↑                                    ↓
      └──────── Retry if needed ←─────────┘
```

**Event Processing Pipeline**:

Each event flows through:
1. Event type detection
2. State update
3. Handler invocation
4. Result processing
5. Publishing if needed

### 4. Tool Execution

When a tool is invoked:

```typescript
// Full tool lifecycle
tool_start event
    → ToolStreamHandler.handleToolStartEvent()
    → Publish typing indicator
    → Execute tool via ToolExecutor
    → Validate and process result
tool_complete event
    → ToolStreamHandler.handleToolCompleteEvent()
    → Check for termination
    → Publish result/error
    → Update state
```

### 5. Completion Flow

Task completion sequence:

```typescript
complete() tool called
    → handleAgentCompletion()
    → Determine next agent (orchestrator)
    → Create termination object
    → Signal stream termination
    → Finalize stream
    → Stop execution timing
```

## State Management

### Conversation State Integration

The execution system maintains state at multiple levels:

**Agent-Level State**:
```typescript
interface AgentState {
    lastProcessedMessageIndex: number;  // Message tracking
    claudeSessionId?: string;           // Session continuity
}
```

**Execution-Level State**:
```typescript
interface ExecutionContext {
    conversationId: string;
    agent: Agent;
    phase: Phase;
    triggeringEvent: NDKEvent;
    handoff?: HandoffContext;
    publisher: NostrPublisher;
    conversationManager: ConversationManager;
    agentExecutor: AgentExecutor;
    claudeSessionId?: string;
}
```

**Stream-Level State**:
Managed by StreamStateManager (see component details above)

### State Persistence

State persists across:
1. **Multiple Executions**: Via conversation manager
2. **Retry Attempts**: Selective preservation
3. **Agent Handoffs**: Context passing
4. **Session Continuity**: Claude session IDs

## Error Handling and Recovery

### Multi-Level Error Strategy

**Level 1: Tool Validation**
```typescript
// In ToolExecutor
if (!validationResult.ok) {
    return {
        success: false,
        error: validationResult.error,
        duration: elapsed
    };
}
```

**Level 2: Tool Execution**
```typescript
// In ToolPlugin
try {
    const result = await executor.execute(tool, parameters);
    // Process result
} catch (error) {
    // Create typed error result
    return errorResult;
}
```

**Level 3: Stream Processing**
```typescript
// In ReasonActLoop
try {
    yield* processStream(...);
} catch (error) {
    yield* handleError(error, ...);
    throw error;
}
```

**Level 4: Termination Recovery**
```typescript
// Automatic retry with reminder
if (!terminated && attempt < MAX_ATTEMPTS) {
    messages.push(reminderMessage);
    // Retry execution
}
```

### Error Propagation

Errors flow through multiple channels:

1. **Tool Results**: Typed error in result object
2. **Stream Events**: Error events in stream
3. **Nostr Publishing**: Error messages to conversation
4. **Logging**: Structured logging with context
5. **Tracing**: Full error traces for debugging

### Recovery Mechanisms

**Missing Tool Start**:
- Detect and generate retroactive indicator
- Use metadata from result if available
- Continue processing normally

**Failed Termination**:
- Retry with explicit reminder
- Auto-complete after max attempts
- Route to orchestrator for recovery

**Stream Errors**:
- Finalize partial streams
- Stop typing indicators
- Propagate error to caller

## Performance Characteristics

### Streaming Optimization

**Chunked Processing**:
- Immediate content streaming to user
- Parallel tool execution where possible
- Lazy message building
- Incremental state updates

**Memory Management**:
- Bounded state accumulation
- Selective state reset for retries
- Efficient string concatenation
- Tool result caching

### Execution Timing

**Tracked Metrics**:
```typescript
interface ExecutionTimeTracking {
    startTime: number;
    endTime?: number;
    duration?: number;
    toolExecutions: ToolExecution[];
}
```

**Performance Points**:
- Stream initialization: ~50-100ms
- Tool execution: Variable (tracked individually)
- Termination retry: Adds ~1-2s per attempt
- Total execution: Typically 2-10s depending on complexity

### Resource Management

**Process Limits**:
- Maximum 3 termination attempts
- Bounded content accumulation
- Tool timeout handling
- Stream finalization guarantee

**Concurrency Control**:
- Sequential tool execution
- Parallel event processing where safe
- Async publisher operations
- Non-blocking stream processing

## Integration Points

### LLM Service Integration

The execution system integrates with LLM service through:

**Stream Creation**:
```typescript
llmService.stream({
    messages,
    options: { configName, agentName },
    tools,
    toolContext
})
```

**Tool Registration**:
- Tools wrapped in ToolPlugin adapter
- Dynamic parameter extraction
- Schema translation (Zod → Plugin format)

### Nostr Publishing

**StreamPublisher Integration**:
- Real-time content streaming
- Typing indicator management
- Error message publishing
- Metadata attachment

**Event Types Published**:
- Content chunks (kind 9003)
- Tool starts/completes
- Typing indicators
- Error messages
- Completion signals

### Tool System Integration

**Tool Discovery**:
- Native tools from registry
- MCP tools if enabled
- Dynamic tool filtering based on agent

**Tool Execution Context**:
```typescript
// Full context passed to tools
{
    conversationId,
    agent,
    phase,
    publisher,
    conversationManager,
    agentExecutor,  // For continue() tool
    triggeringEvent
}
```

## Common Patterns

### Execution Patterns

**Simple Response**:
```
User → Agent → Stream content → Complete → End
```

**Tool-Using Agent**:
```
User → Agent → Content → Tool executions → More content → Complete
```

**Retry Pattern**:
```
Agent response (no complete) → Reminder → Complete
```

**Error Recovery**:
```
Tool error → Continue execution → Error in output → Complete
```

### State Patterns

**Accumulation Pattern**:
```typescript
// Build up state through stream
stateManager.appendContent(chunk);
stateManager.addToolResult(result);
stateManager.setTermination(complete);
```

**Reset Pattern**:
```typescript
// Selective reset for retry
stateManager.resetForRetry();  // Keeps publisher
stateManager.reset();           // Full reset
```

**Tracking Pattern**:
```typescript
// Track processed elements
stateManager.markToolStarted(toolId);
stateManager.markThinkingBlockLogged(content);
```

## Testing Considerations

### Unit Testing Focus

**Critical Areas**:
1. Stream event processing logic
2. Tool execution and result handling
3. Termination detection and enforcement
4. Error handling and recovery
5. State management and reset

**Mock Requirements**:
- LLM service stream generation
- Tool execution results
- Nostr publisher operations
- Conversation manager methods

### Integration Testing

**Key Flows**:
1. Complete execution lifecycle
2. Tool execution with errors
3. Termination retry mechanism
4. Session continuity
5. Multi-backend execution

**Test Patterns**:
```typescript
// Stream simulation
const mockStream = createMockStream([
    { type: "content", content: "Hello" },
    { type: "tool_start", tool: "complete", args: {} },
    { type: "tool_complete", tool: "complete", result: {...} },
    { type: "done", response: {...} }
]);
```

## Performance Monitoring

### Key Metrics

**Execution Metrics**:
- Total execution duration
- Tool execution times
- Retry attempt counts
- Stream processing latency
- Error rates by type

**Resource Metrics**:
- Memory usage (content accumulation)
- Active stream count
- Tool execution concurrency
- Publisher queue depth

### Monitoring Points

**Logging Integration**:
```typescript
// ExecutionLogger tracks
- Execution start/complete
- Tool start/complete with duration
- Decision points
- Error occurrences
```

**Tracing Context**:
```typescript
// Hierarchical tracing
Root Context
  → Agent Execution Context
    → Tool Execution Context
      → Individual operation traces
```

## Security Considerations

### Input Validation

**Tool Parameter Validation**:
- Zod schema validation
- Type checking
- Boundary validation
- Special case handling (generate_inventory)

### Output Sanitization

**Content Filtering**:
- Reasoning block extraction
- Orchestrator silence enforcement
- Error message sanitization
- Metadata validation

### Context Isolation

**Execution Context**:
- Separate context per execution
- No shared mutable state
- Controlled tool access
- Publisher isolation

## Future Considerations

### Potential Enhancements

1. **Parallel Tool Execution**: Execute independent tools concurrently
2. **Stream Multiplexing**: Multiple output streams for different consumers
3. **Progressive Termination**: Gradual completion with partial results
4. **Adaptive Retry**: Dynamic retry strategies based on failure type
5. **Tool Composition**: Pipeline tools together for complex operations

### Architectural Improvements

1. **Plugin System**: Extensible handlers for custom event types
2. **Middleware Pipeline**: Composable stream processors
3. **State Persistence**: Checkpoint and resume capability
4. **Distributed Execution**: Split execution across multiple nodes
5. **Performance Profiling**: Built-in execution profiling

## Questions and Uncertainties

### Architectural Questions

1. **Stream Buffer Management**: There's no explicit buffering or backpressure handling in the stream processing. Should there be flow control for very large responses?

2. **Tool Execution Order**: Tools execute sequentially even when they could run in parallel. Is this intentional for predictability or a performance limitation?

3. **Retry Backoff**: Termination retries happen immediately. Should there be exponential backoff or delay between attempts?

4. **State Size Limits**: No limits on accumulated content size. Should there be bounds to prevent memory issues with very long conversations?

5. **Session Recovery**: Claude session IDs are retrieved but never validated. What happens if a session expires or becomes invalid?

### Implementation Uncertainties

1. **Thinking Block Extraction**: The regex pattern for `<thinking>` blocks may not handle nested tags correctly. Edge cases with malformed blocks?

2. **Tool Start Tracking**: Uses timestamp-based IDs which could theoretically collide. Should use UUIDs or sequential IDs?

3. **Auto-Complete Routing**: Auto-completed tasks always route to orchestrator. Should this be configurable or context-aware?

4. **Error Event Handling**: Error events append to content stream. Should they be handled differently (e.g., separate error stream)?

5. **Metadata Propagation**: Tool metadata is optional and inconsistently used. Should there be standard metadata requirements?

6. **Stream Finalization**: Multiple checks for `isFinalized()` suggest potential double-finalization issues. Is this defensive programming or indicating a problem?

7. **Reasoning Parser**: The structured reasoning parser expects specific format but falls back to raw content. Should format be enforced?

8. **Tool Description Fallback**: Generic descriptions for unknown tools may not be helpful. Should require tools to provide descriptions?

### Behavioral Uncertainties

1. **Partial Stream Recovery**: If stream breaks mid-execution, partial results are lost. Should there be checkpointing?

2. **Tool Timeout Handling**: No explicit timeouts on tool execution. Should tools have maximum execution time?

3. **Concurrent Executions**: Multiple agents could execute simultaneously. How are resource conflicts handled?

4. **Publisher Cleanup**: Publisher cleanup happens even on error. Could this lose important error context?

5. **Message Building Cost**: Full message history is built for each execution. Should use incremental updates for efficiency?

6. **Backend Selection**: Backend type is string-based with fallback. Should use enum or registry pattern?

7. **Typing Indicator Race**: Brief delay (100ms) for missing tool_start might not be sufficient. Optimal timing?

8. **Stream Event Ordering**: Assumes events arrive in order. What if tool_complete arrives before tool_start?

## Conclusion

The Agent Execution Architecture represents a sophisticated streaming-based execution engine that successfully balances multiple complex requirements: real-time user interaction, type-safe tool execution, reliable task completion, and robust error recovery. Its layered design with pluggable backends enables different execution strategies while maintaining consistent behavior guarantees.

The architecture excels at:
- **Streaming Performance**: Real-time content delivery with minimal latency
- **Type Safety**: Full type checking from tool definition to execution
- **Reliability**: Automatic retry and recovery mechanisms
- **Flexibility**: Pluggable backends for different agent types
- **Observability**: Comprehensive logging and tracing
- **User Experience**: Typing indicators and progressive updates

The termination enforcement mechanism is particularly noteworthy, ensuring agents properly complete their work while providing escape hatches for conversational interactions. The integration of reasoning extraction, session management, and state tracking creates a robust foundation for complex agent behaviors.

This execution engine forms the beating heart of TENEX, enabling agents to reliably process requests, execute tools, and collaborate effectively while maintaining the system's core principles of type safety, streaming interaction, and distributed operation.