# Agent Execution Architecture

## Overview

The agent execution system in TENEX follows a **strategy pattern** where different execution backends implement the `ExecutionBackend` interface. Each backend provides a different execution strategy suited to specific agent types.

## Execution Backends

### 1. **RoutingBackend** (Orchestrator Only)
- Used exclusively by the orchestrator agent
- Handles message routing between agents
- No tool execution - pure routing decisions
- Returns structured JSON routing decisions

### 2. **ReasonActLoop** (Default)
- Standard execution backend for most agents
- Implements a reason-act loop with tool calling
- Handles streaming responses from LLMs
- Enforces proper termination with `complete()` tool

### 3. **ClaudeBackend** (Special Purpose)
- Direct integration with Claude Desktop
- Bypasses standard tool system
- Used for specialized Claude-native operations

## ReasonActLoop Architecture

The ReasonActLoop backend has been refactored into a clean, modular architecture following SRP (Single Responsibility Principle):

```
┌─────────────────────────────────────────────────────────┐
│                     ReasonActLoop                        │
│                   (Orchestrator - 426 lines)             │
│  - Manages execution flow                                │
│  - Coordinates handlers                                  │
│  - Implements retry logic                                │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┼────────────┬──────────────┐
        ▼            ▼            ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│StreamState   │ │ToolStream    │ │Termination   │ │Control Flow  │
│Manager       │ │Handler       │ │Handler       │ │Types         │
│(178 lines)   │ │(368 lines)   │ │(183 lines)   │ │(70 lines)    │
├──────────────┤ ├──────────────┤ ├──────────────┤ ├──────────────┤
│Manages       │ │Handles tool  │ │Enforces      │ │Type guards   │
│mutable state │ │start/complete│ │termination   │ │for routing   │
│during stream │ │events        │ │requirements  │ │decisions     │
│processing    │ │              │ │              │ │              │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

## Component Responsibilities

### **ReasonActLoop** (Main Orchestrator)
Primary responsibilities:
- Initialize and coordinate handlers
- Manage the main execution loop
- Handle retry attempts for termination
- Create and process LLM streams
- Delegate to specialized handlers

Key methods:
- `execute()` - Main entry point from ExecutionBackend interface
- `executeStreamingInternal()` - Core async generator loop
- `processStream()` - Routes stream events to appropriate handlers

### **StreamStateManager** 
Encapsulates all mutable state during stream processing:
- Tool execution results
- Accumulated content
- Continue flow decisions
- Termination state
- Stream publisher reference

Key methods:
- `appendContent()` - Add content to accumulated text
- `addToolResult()` - Store tool execution results
- `setContinueFlow()` - Record routing decisions
- `setTermination()` - Mark completion/end states
- `resetForRetry()` - Prepare state for retry attempts

### **ToolStreamHandler**
Manages all tool-related stream events:
- Process `tool_start` events
- Process `tool_complete` events
- Publish typing indicators
- Handle tool errors
- Generate human-readable tool descriptions

Key responsibilities:
- Tool lifecycle management
- Error handling and reporting
- Logging tool execution metrics
- Terminal tool detection

### **TerminationHandler**
Enforces proper agent termination:
- Check if termination is required
- Generate reminder messages
- Auto-complete when agents fail to terminate
- Manage retry logic

Key methods:
- `shouldRetryForTermination()` - Determine if retry needed
- `getReminderMessage()` - Generate context-appropriate reminders
- `prepareRetryMessages()` - Build message array for retry

### **Supporting Modules**

**control-flow-types.ts**
- Type guards for `ContinueFlow`, `Complete`, `EndConversation`
- Validates routing decisions and completion states

**constants.ts**
- `MAX_TERMINATION_ATTEMPTS` - Maximum retry attempts (2)
- `TOOL_INDICATOR_DELAY_MS` - Typing indicator delay (100ms)
- `DEFAULT_TOOL_DURATION_MS` - Default tool execution time (1000ms)

**error-formatter.ts**
- Formats various error types into readable strings
- Extracts meaningful error properties

## Execution Flow

### 1. **Initialization Phase**
```typescript
// Create handlers
const stateManager = new StreamStateManager();
const toolHandler = new ToolStreamHandler(stateManager, executionLogger);
const terminationHandler = new TerminationHandler(stateManager);
```

### 2. **Main Execution Loop**
```typescript
while (attempt < MAX_TERMINATION_ATTEMPTS) {
    // Create LLM stream
    const stream = createLLMStream(context, messages, tools);
    
    // Process events
    yield* processStream(stream, handlers...);
    
    // Check termination
    if (!terminationHandler.shouldRetryForTermination()) {
        break;
    }
    
    // Prepare retry with reminder
    messages = terminationHandler.prepareRetryMessages(messages);
}
```

### 3. **Stream Event Processing**
Each event type is routed to appropriate handler:
- `content` → Accumulate in StateManager
- `tool_start` → ToolStreamHandler
- `tool_complete` → ToolStreamHandler → Terminal check
- `done` → Store final response
- `error` → Error handling

### 4. **Termination Enforcement**
Non-chat/brainstorm agents MUST call terminal tools:
- **Orchestrator**: Must call `continue()` to route
- **Other agents**: Must call `complete()` to return control
- **Auto-completion**: After 2 failed attempts

## Key Design Decisions

### 1. **Orchestrator Routing Removed**
The original ReasonActLoop contained orchestrator-specific routing logic (executing target agents). This has been completely removed as it belongs in RoutingBackend.

### 2. **State Encapsulation**
All mutable state is encapsulated in StreamStateManager with controlled access through methods, preventing direct manipulation.

### 3. **Clear Separation of Concerns**
Each class has a single, well-defined responsibility:
- State management is isolated
- Tool handling is centralized
- Termination logic is extracted

### 4. **Testability**
Each component can be tested in isolation:
- StreamStateManager: Pure state transitions
- ToolStreamHandler: Tool event processing
- TerminationHandler: Termination logic

### 5. **No Over-Engineering**
- No unnecessary abstractions
- Direct method calls, no complex patterns
- Clear, linear flow

## Migration from Old Architecture

### Before (934 lines, single class):
- Mixed responsibilities
- Deep nesting
- Duplicated logic
- Orchestrator routing mixed in

### After (426 lines main + helpers):
- Single responsibility per class
- Flat structure
- Reusable components
- Clean separation of backends

## Testing Strategy

### Unit Tests
Each component should have isolated unit tests:
```typescript
// StreamStateManager tests
- State initialization
- Content accumulation
- Tool result storage
- Termination state transitions

// ToolStreamHandler tests
- Tool start event handling
- Tool complete event handling
- Error publishing
- Terminal tool detection

// TerminationHandler tests
- Retry logic
- Reminder message generation
- Auto-completion
```

### Integration Tests
Test the full ReasonActLoop with mock LLM service:
- Complete execution flow
- Retry behavior
- Terminal tool handling
- Error recovery

## Future Improvements

1. **Event-Driven Architecture**
   - Consider event emitter pattern for stream events
   - Would further decouple components

2. **Strategy Pattern for Tool Descriptions**
   - Extract tool description logic to separate registry
   - Make extensible for new tools

3. **Metrics Collection**
   - Add structured metrics for execution performance
   - Track retry rates and termination failures

4. **Configuration**
   - Make retry attempts configurable per agent
   - Allow custom termination enforcement rules