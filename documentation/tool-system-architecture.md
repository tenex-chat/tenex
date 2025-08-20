# Tool System Architecture

## Overview

The TENEX tool system provides a type-safe, composable infrastructure for agent capabilities. It serves as the execution layer that bridges agent intentions with concrete actions, supporting both built-in tools and dynamically loaded MCP (Model Context Protocol) tools. The system follows functional programming principles with algebraic data types, explicit error handling through Result types, and strong type safety via Zod schemas.

## Core Philosophy

The tool system is built on several key principles:

1. **Type Safety First**: All tool inputs are validated through Zod schemas with compile-time type inference
2. **Explicit Error Handling**: Uses Result types (`ok: true | false`) for fallible operations
3. **Composability**: Tools can be composed and extended through adapters (e.g., MCP tools)
4. **Traceability**: Complete logging and metadata support for debugging and observability
5. **Security by Design**: Tool access is controlled at multiple levels (agent restrictions, validation, sandboxing)

## Architecture Components

### 1. Core Type System (`src/tools/core.ts`)

The foundation defines the algebraic data types that power the entire system:

#### Tool Interface
```typescript
interface Tool<Input = unknown, Output = unknown> {
    readonly name: string;
    readonly description: string;
    readonly parameters: ParameterSchema<Input>;
    readonly promptFragment?: string;  // LLM guidance
    readonly execute: (
        input: Validated<Input>,
        context: ExecutionContext
    ) => Promise<Result<ToolError, Output>>;
}
```

#### Result Type (Monadic Error Handling)
```typescript
type Result<E, A> =
    | { readonly ok: true; readonly value: A; readonly metadata?: ToolExecutionMetadata }
    | { readonly ok: false; readonly error: E };
```

This Result type ensures that:
- Success and failure are explicitly modeled
- Errors cannot be ignored (must be handled)
- Metadata can be attached to successful results for UI/logging

#### Control Flow Types
Tools can signal special control flow through termination types:
- `Complete`: Task completion, returns control to orchestrator
- `EndConversation`: Ends the entire conversation flow

These termination types enable tools to participate in the larger conversation lifecycle.

### 2. Parameter Validation System (`src/tools/zod-schema.ts`)

The system uses Zod for runtime validation with several layers:

#### Schema Conversion Pipeline
1. **Zod → SchemaShape**: Converts Zod schemas to a serializable format for LLM consumption
2. **MCP → Zod**: Adapts MCP tool schemas to Zod for unified validation
3. **Validation**: Runtime type checking with detailed error messages

The `SchemaShape` type provides a JSON-serializable representation:
```typescript
type SchemaShape =
    | { type: "string"; description: string; enum?: ReadonlyArray<string> }
    | { type: "number"; description: string; min?: number; max?: number }
    | { type: "boolean"; description: string }
    | { type: "array"; description: string; items: SchemaShape }
    | { type: "object"; description: string; properties: Record<string, SchemaShape> }
```

This dual representation allows:
- Type-safe validation at runtime
- Schema introspection for LLMs
- Dynamic tool discovery and documentation

### 3. Tool Executor (`src/tools/executor.ts`)

The executor handles the actual tool invocation with several responsibilities:

#### Execution Flow
1. **Input Validation**: Validates input against tool's parameter schema
2. **Execution**: Invokes tool with validated input and execution context
3. **Error Handling**: Catches and wraps errors in typed ToolError
4. **Metadata Extraction**: Preserves tool-provided metadata for UI/logging
5. **Duration Tracking**: Measures execution time for performance monitoring

Special handling exists for certain tools:
- `generate_inventory`: Bypasses validation for dynamic schema generation
- Terminal tool (`complete`): Triggers control flow changes

### 4. Tool Registry (`src/tools/registry.ts`)

A centralized registry manages all available tools:

```typescript
const toolsMap = new Map<string, Tool<any, any>>([
    ["read_path", readPathTool],
    ["write_context_file", writeContextFileTool],
    ["complete", completeTool],
    ["shell", shellTool],
    // ... more tools
]);
```

The registry provides:
- Tool lookup by name
- Batch tool retrieval for agent assignment
- Tool discovery for dynamic loading

### 5. Built-in Tool Implementations

#### File System Tools
- **read_path**: Reads files with project boundary validation
- **write_context_file**: Writes context files (PROJECT.md, etc.)

#### Control Flow Tools
- **complete**: Signals task completion, returns to orchestrator

#### Analysis Tools
- **analyze**: Code analysis with custom prompts
- **learn**: Records lessons learned for future reference

#### Execution Tools
- **shell**: Command execution (restricted to project-manager agent)
- **generate_inventory**: Creates project inventory dynamically

#### Special Tool: Learn (`src/tools/implementations/learn.ts`)
The learn tool demonstrates sophisticated tool design:
- Includes metacognition checks in prompt fragments
- Publishes lessons as Nostr events for persistence
- Validates lesson quality through guided reflection
- Scopes lessons to project context

### 6. MCP Tool Integration (`src/services/mcp/MCPToolAdapter.ts`)

The system seamlessly integrates MCP tools through adapters:

#### Adaptation Process
1. **Schema Translation**: MCP schemas → Zod schemas
2. **Namespacing**: Tools prefixed with `mcp__${server}__${tool}`
3. **Error Wrapping**: MCP errors → typed ToolError
4. **Execution Bridge**: Async execution with proper error boundaries

This allows:
- Dynamic tool loading from MCP servers
- Unified tool interface for agents
- Type safety across tool boundaries

### 7. Stream Integration (`src/agents/execution/ToolStreamHandler.ts`)

The ToolStreamHandler manages tool execution in the LLM streaming context:

#### Responsibilities
1. **Tool Start Events**: Publishes typing indicators with tool descriptions
2. **Tool Complete Events**: Processes results and updates state
3. **Missing Start Handling**: Reconstructs tool start for tools that skip the event
4. **Error Publishing**: Sends tool errors to conversation
5. **Terminal Detection**: Identifies control flow tools

#### Tool Descriptions
Generates human-readable descriptions for UI feedback:
```typescript
"📖 Reading file.ts"
"✏️ Editing config.json"
"🔧 Running git command"
"✅ Completing task and returning control"
```

### 8. Tool Logging (`src/tools/toolLogger.ts`)

Comprehensive logging system for tool execution:

#### Log Entry Structure
```typescript
interface ToolCallLogEntry {
    // Identification
    timestamp: string;
    requestId: string;
    
    // Context
    agentName: string;
    phase: string;
    conversationId: string;
    
    // Execution
    toolName: string;
    args: Record<string, unknown>;
    status: "success" | "error";
    output?: string;
    error?: string;
    
    // Performance
    durationMs: number;
    
    // Tracing
    trace: {
        callStack?: string[];
        batchId?: string;
    };
}
```

Logs are:
- Written to JSONL files for efficient streaming
- Organized by date for rotation
- Include full execution context for debugging

### 9. Agent Tool Assignment (`src/agents/constants.ts`)

Tools are assigned to agents based on capabilities:

#### Assignment Rules
1. **Orchestrator**: No tools (uses routing backend)
2. **Project Manager**: All tools including shell, inventory generation
3. **Other Built-in Agents**: Standard tools + complete
4. **Custom Agents**: Configurable tool sets

The assignment system ensures:
- Security through capability restriction
- Clear agent responsibilities
- Predictable tool availability

## Data Flow

### Tool Execution Lifecycle

1. **LLM Decision**: Agent decides to use a tool
2. **Stream Event**: `tool_start` event in LLM stream
3. **UI Feedback**: Typing indicator with tool description
4. **Validation**: Input validated against schema
5. **Execution**: Tool executed with context
6. **Result Processing**: Success/error handling
7. **State Update**: Control flow or data updates
8. **Stream Event**: `tool_complete` event
9. **Logging**: Execution logged for analysis

### Error Flow

1. **Validation Errors**: Caught before execution, returned as ValidationError
2. **Execution Errors**: Wrapped in ExecutionError with tool context
3. **System Errors**: Unexpected errors wrapped with stack traces
4. **Error Publishing**: Errors sent to conversation for visibility
5. **Error Logging**: Full error context preserved in logs

## Security Model

### Multi-Layer Security

1. **Agent Restrictions**: Tools restricted by agent type (e.g., shell only for project-manager)
2. **Input Validation**: All inputs validated against schemas
3. **Path Validation**: File operations restricted to project boundaries
4. **Command Filtering**: Dangerous commands blocked in shell tool
5. **Execution Context**: Tools receive limited, sandboxed context

### Security Boundaries

- **Project Boundary**: File operations confined to project directory
- **Agent Boundary**: Tools can only access their assigned capabilities
- **Schema Boundary**: Invalid inputs rejected before execution
- **Network Boundary**: MCP tools isolated in separate processes

## Extension Points

### Adding New Tools

1. **Define Schema**: Create Zod schema for parameters
2. **Implement Tool**: Use `createToolDefinition` helper
3. **Register Tool**: Add to registry in `registry.ts`
4. **Assign to Agents**: Update `getDefaultToolsForAgent`
5. **Add Descriptions**: Provide UI descriptions in ToolStreamHandler

### Integrating External Tools

1. **MCP Integration**: Use MCPToolAdapter for MCP servers
2. **Custom Adapters**: Implement Tool interface for other protocols
3. **Dynamic Loading**: Tools can be loaded at runtime
4. **Schema Mapping**: Convert external schemas to Zod

## Performance Considerations

### Optimization Strategies

1. **Lazy Validation**: Validation only on execution
2. **Metadata Skipping**: Tools can skip start events with metadata
3. **Batch Execution**: Multiple tools can execute in parallel
4. **Result Caching**: Tool results cached in stream state
5. **Efficient Logging**: JSONL format for streaming writes

### Performance Metrics

- Tool execution duration tracked
- Input/output sizes measured
- Error rates monitored
- Batch performance analyzed

## Integration with Agent System

### Execution Context

Tools receive comprehensive context:
```typescript
interface ExecutionContext {
    agent: Agent;           // Executing agent
    conversationId: string; // Current conversation
    phase: Phase;          // Conversation phase
    projectPath: string;   // Project root
    publisher?: NostrPublisher;
    conversationManager?: ConversationCoordinator;
    triggeringEvent?: NostrEvent;
}
```

This context enables:
- Agent-aware execution
- Phase-appropriate behavior
- Project-scoped operations
- Event publishing
- State management

### Tool-Agent Interaction Patterns

1. **Direct Execution**: Agent calls tool, processes result
2. **Control Transfer**: Tool signals completion, orchestrator routes
3. **State Mutation**: Tool updates conversation state
4. **Event Publishing**: Tool publishes events (lessons, artifacts)
5. **Error Recovery**: Tool errors trigger agent error handling

## Best Practices

### Tool Design

1. **Single Responsibility**: Each tool does one thing well
2. **Explicit Schemas**: Clear, documented parameter schemas
3. **Error Context**: Include relevant context in errors
4. **Metadata Support**: Provide UI hints via metadata
5. **Prompt Fragments**: Guide LLM usage with examples

### Security

1. **Validate Everything**: Never trust input
2. **Principle of Least Privilege**: Minimal tool access
3. **Audit Logging**: Log all tool executions
4. **Error Sanitization**: Don't leak sensitive data in errors
5. **Boundary Enforcement**: Respect project/agent boundaries

### Performance

1. **Fail Fast**: Validate early to avoid wasted work
2. **Async Everything**: Non-blocking execution
3. **Batch When Possible**: Group related operations
4. **Cache Wisely**: Cache expensive computations
5. **Monitor Duration**: Track and optimize slow tools

## Future Enhancements

### Planned Improvements

1. **Tool Composition**: Combine tools into workflows
2. **Conditional Execution**: Tools that execute based on conditions
3. **Parallel Execution**: Official support for parallel tool calls
4. **Tool Versioning**: Version management for tool schemas
5. **Tool Discovery**: Dynamic tool discovery protocol

### Research Areas

1. **Automatic Tool Generation**: Generate tools from API specs
2. **Tool Learning**: Learn new tools from examples
3. **Tool Optimization**: Automatic performance optimization
4. **Tool Testing**: Automated tool testing framework
5. **Tool Marketplace**: Share and discover community tools

## Questions and Uncertainties

### Architectural Questions

1. **Tool Composition**: Should tools be composable at the type level, or is runtime composition sufficient?
2. **Schema Evolution**: How should tool schemas evolve without breaking existing agents?
3. **Error Recovery**: Should tools have built-in retry mechanisms, or leave it to agents?
4. **State Management**: Should tools have access to persistent state beyond the conversation?
5. **Resource Management**: How should long-running tools handle resource cleanup?

### Implementation Uncertainties

1. **Generate Inventory Special Case**: Why does `generate_inventory` bypass validation? Is this a design decision or technical debt?
2. **Tool Metadata**: The metadata system seems underutilized - are there plans to expand its use?
3. **MCP Error Handling**: MCP errors are wrapped generically - should there be more specific error types?
4. **Tool Timeouts**: There's no consistent timeout mechanism across tools - is this intentional?
5. **Batch Execution**: The system hints at batch execution but doesn't fully implement it - what's the roadmap?

### Integration Concerns

1. **Tool-Agent Coupling**: Some tools seem tightly coupled to specific agents - how to maintain modularity?
2. **Context Propagation**: The ExecutionContext is large - should it be broken down?
3. **Event System Integration**: Tools publish events directly - should this go through an abstraction?
4. **Stream State Management**: The relationship between tools and stream state seems complex - can it be simplified?
5. **Logging Granularity**: Is the current logging level appropriate for production systems?