# MCP (Model Context Protocol) Integration Architecture

## Executive Summary

The MCP integration system in TENEX provides a powerful, extensible mechanism for agents to interact with external tools and services through the Model Context Protocol. This system seamlessly bridges MCP servers with TENEX's type-safe tool system, allowing agents to leverage external capabilities while maintaining security, type safety, and proper error handling.

## Core Architecture

### System Overview

The MCP integration follows a layered architecture:

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Execution Layer                 │
│              (AgentExecutor, ReasonActLoop)              │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────────┐
│                  Tool Registry Layer                     │
│         (Native Tools + MCP-Adapted Tools)               │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────────┐
│                  MCP Service Layer                       │
│                    (MCPService)                          │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────────┐
│              MCP Server Processes                        │
│        (External processes via stdio transport)          │
└─────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. MCPService (Core Service)
**Location**: `src/services/mcp/MCPService.ts`

The singleton service that manages the lifecycle of MCP servers:

- **Server Management**: Starts, monitors, and stops MCP server processes
- **Tool Discovery**: Fetches available tools from connected servers
- **Tool Execution**: Routes tool calls to appropriate servers
- **Health Monitoring**: Validates server health through periodic checks
- **Security Enforcement**: Implements path restrictions and environment isolation

**Critical Implementation Details**:
- Uses StdioClientTransport for process communication
- Implements graceful shutdown with SIGTERM/SIGKILL fallback
- Maintains a tool cache for synchronous access during prompt generation
- Each server runs in an isolated subprocess with controlled environment

#### 2. MCPToolAdapter
**Location**: `src/services/mcp/MCPToolAdapter.ts`

Bridges the gap between MCP's JSON Schema-based tools and TENEX's Zod-based type system:

- **Schema Translation**: Converts MCP input schemas to Zod schemas
- **Type Safety**: Provides compile-time type checking for tool parameters
- **Namespacing**: Prefixes tool names with `mcp__<server>__<tool>`
- **Error Handling**: Wraps MCP tool execution with proper error boundaries

**Key Functions**:
- `adaptMCPTool()`: Converts raw MCP tools to TENEX Tool interface
- `mcpSchemaToZod()`: Translates JSON Schema to Zod schema
- `createTypedMCPTool()`: Creates strongly-typed tool wrappers

#### 3. Configuration System
**Location**: `src/services/config/types.ts`

Defines the configuration structure for MCP servers:

```typescript
interface MCPServerConfig {
    command: string;           // Executable command
    args: string[];            // Command arguments
    env?: Record<string, string>; // Environment variables
    description?: string;      // Human-readable description
    allowedPaths?: string[];   // Security: Path restrictions
}
```

Configuration is layered:
- **Global Config**: `~/.tenex/mcp.json` - Available to all projects
- **Project Config**: `.tenex/mcp.json` - Project-specific servers
- Servers from both layers are merged during initialization

## Execution Flow

### 1. Initialization Phase

When a TENEX project starts:

```typescript
// MCPService initialization sequence
1. Load configuration (global + project)
2. Filter servers by allowedPaths (security check)
3. Start each server process in parallel
4. Perform health check (5-second timeout)
5. Fetch available tools from each server
6. Cache tools for synchronous access
7. Register tools with the tool registry
```

### 2. Tool Discovery

MCP servers expose their tools through the `tools/list` RPC method:

```typescript
// Tool discovery flow
Server Process → tools/list → MCPService
                                  ↓
                          Parse & Validate
                                  ↓
                          Convert to TENEX Tool
                                  ↓
                          Cache & Register
```

Each tool is transformed:
- MCP tool name: `search_files`
- TENEX tool name: `mcp__filesystem__search_files`
- This namespacing prevents conflicts and identifies the source

### 3. Tool Execution

When an agent calls an MCP tool:

```typescript
// Execution pipeline
Agent calls tool → ToolStreamHandler
                        ↓
                  Tool Registry lookup
                        ↓
                  MCPToolAdapter.execute()
                        ↓
                  MCPService.executeTool()
                        ↓
                  RPC: tools/call to server
                        ↓
                  Parse response & extract text
                        ↓
                  Return to agent
```

**Error Handling**:
- Network failures result in execution errors
- Server crashes trigger automatic cleanup
- Malformed responses are logged and wrapped

### 4. Prompt Integration

MCP tools are injected into agent prompts through the fragment system:

```typescript
// Prompt building flow
buildSystemPrompt() → FragmentRegistry
                           ↓
                    mcpToolsFragment
                           ↓
                    MCPService.getCachedTools()
                           ↓
                    Generate markdown documentation
```

The fragment generates structured documentation:
- Groups tools by server
- Lists parameters with types and descriptions
- Provides usage instructions

## Security Architecture

### Path Restrictions

MCP servers can access the filesystem, making security critical:

```typescript
// Path validation logic
if (config.allowedPaths && config.allowedPaths.length > 0) {
    const resolvedProjectPath = path.resolve(projectPath);
    const isAllowed = config.allowedPaths.some(allowedPath => {
        const resolved = path.resolve(allowedPath);
        return resolvedProjectPath.startsWith(resolved) ||
               resolved.startsWith(resolvedProjectPath);
    });
    
    if (!isAllowed) {
        // Server is skipped - not started
    }
}
```

This bidirectional check ensures:
- Servers can only operate within allowed directories
- Project paths and allowed paths can overlap safely

### Process Isolation

Each MCP server runs in an isolated subprocess:
- Separate process space
- Controlled environment variables
- No shared memory with TENEX
- Graceful termination on shutdown

### Environment Variable Management

```typescript
// Environment merging strategy
1. Start with current process.env (filtered)
2. Override with server-specific env from config
3. Pass merged environment to subprocess
```

This allows:
- Servers to inherit necessary system variables
- Configuration to override or add specific variables
- Sensitive variables to be isolated per server

## Type System Integration

### Schema Translation Pipeline

MCP uses JSON Schema, TENEX uses Zod. The translation preserves:

```typescript
// JSON Schema → Zod mapping
{
    "type": "string",           → z.string()
    "minLength": 5,             → z.string().min(5)
    "enum": ["a", "b"]          → z.enum(["a", "b"])
}

{
    "type": "object",           → z.object({
    "properties": {                 name: z.string(),
        "name": {...}                age: z.number().optional()
        "age": {...}               })
    },
    "required": ["name"]
}
```

### Type Safety Guarantees

The adapter system provides:
- **Compile-time validation**: Tool parameters are type-checked
- **Runtime validation**: Zod validates all inputs before execution
- **Error type safety**: Execution errors follow TENEX patterns

## Nostr Integration

### NDKMCPTool Events

MCP tools can be shared via Nostr as kind 4200 events:

```typescript
class NDKMCPTool extends NDKEvent {
    static kind = 4200;
    
    // Tags structure:
    // ["name", "filesystem-tools"]
    // ["description", "File system operations"]
    // ["command", "npx -y @mcptools/filesystem"]
    // ["image", "https://..."] // optional icon
}
```

### Auto-Installation Flow

When an MCP tool event is discovered:

```typescript
1. Parse NDKMCPTool event
2. Extract command and arguments
3. Check if already installed
4. Add to project configuration
5. Restart MCP service to load new tool
```

This enables:
- Tool sharing across the Nostr network
- Automatic tool discovery
- One-click installation from events

## Lifecycle Management

### Startup Sequence

```typescript
// Detailed startup flow
async initialize(projectPath?: string) {
    1. Check if already initialized (singleton)
    2. Load configuration files
    3. Check if MCP is enabled
    4. Start all configured servers:
       - Spawn subprocess
       - Connect client
       - Perform health check
       - Handle failures gracefully
    5. Refresh tool cache
    6. Mark as initialized
}
```

### Shutdown Sequence

```typescript
// Graceful shutdown flow
async shutdown() {
    for (each server) {
        1. Close client connection
        2. Send SIGTERM to process
        3. Wait up to 5 seconds
        4. Send SIGKILL if needed
        5. Clean up resources
    }
    Clear all caches
    Mark as uninitialized
}
```

### Error Recovery

The system handles various failure modes:

- **Server crash**: Detected via process exit, server marked as unavailable
- **Network timeout**: 5-second timeout on all RPC calls
- **Malformed response**: Logged and wrapped in execution error
- **Missing tools**: Gracefully handled, empty tool list returned

## Performance Considerations

### Tool Caching

Tools are cached after discovery to avoid synchronous RPC calls:

```typescript
// Cache strategy
1. On startup: Fetch all tools, populate cache
2. On server add: Refresh cache for new tools
3. On prompt build: Use cached tools synchronously
4. On server failure: Remove tools from cache
```

This ensures:
- Fast prompt generation (no blocking I/O)
- Consistent tool availability
- Graceful degradation on failures

### Parallel Initialization

Servers start in parallel to minimize startup time:

```typescript
// Parallel startup
await Promise.all(
    servers.map(async server => {
        try {
            await startServer(server);
        } catch (error) {
            // Log but don't fail entire initialization
        }
    })
);
```

### Resource Management

- **Process limits**: Each server is one subprocess
- **Memory isolation**: No shared memory between servers
- **File descriptor management**: Proper cleanup on shutdown

## Configuration Examples

### Basic Server Configuration

```json
{
    "servers": {
        "filesystem": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem"],
            "description": "File system operations",
            "allowedPaths": ["/Users/project"]
        }
    },
    "enabled": true
}
```

### Advanced Configuration with Environment

```json
{
    "servers": {
        "github": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-github"],
            "env": {
                "GITHUB_TOKEN": "ghp_xxx"
            },
            "description": "GitHub API access"
        }
    }
}
```

## Common Patterns

### Tool Namespacing

All MCP tools follow the pattern: `mcp__<server>__<tool>`

Benefits:
- Prevents naming conflicts
- Identifies tool source
- Enables server-specific filtering

### Error Wrapping

All MCP errors are wrapped in TENEX error types:

```typescript
{
    ok: false,
    error: {
        kind: "execution",
        tool: "mcp__server__tool",
        message: "Detailed error message",
        cause: originalError
    }
}
```

### Typing Indicator Integration

MCP tools integrate with the typing indicator system:

```typescript
// Tool execution flow with indicators
1. tool_start event → Show "Using filesystem: searching files..."
2. During execution → Indicator remains visible
3. tool_complete → Hide indicator
4. If no tool_start → Generate indicator from metadata
```

## Testing Considerations

### Unit Testing

Key areas requiring testing:
- Schema translation accuracy
- Error handling paths
- Process lifecycle management
- Configuration validation

### Integration Testing

Critical flows to test:
- Server startup/shutdown
- Tool discovery and caching
- Tool execution with various inputs
- Error recovery scenarios

### Mock Strategies

For testing without real MCP servers:
- Mock the Client class from MCP SDK
- Stub subprocess spawning
- Provide fake tool definitions
- Simulate server failures

## Future Improvements

### Potential Enhancements

1. **Dynamic Tool Reloading**: Refresh tools without restart
2. **Tool Versioning**: Support multiple versions of same tool
3. **Performance Metrics**: Track tool execution times
4. **Circuit Breaker**: Disable failing servers temporarily
5. **Tool Composition**: Combine multiple tools into workflows

### Architectural Considerations

1. **Event-Driven Updates**: Use events for tool availability changes
2. **Plugin Architecture**: Allow custom tool adapters
3. **Distributed Servers**: Support remote MCP servers
4. **Tool Marketplace**: Integrated discovery and installation

## Questions and Uncertainties

### Open Questions

1. **Tool Timeout Strategy**: Currently no per-tool timeout configuration. Should this be added at the server or tool level?

2. **Resource Limits**: No current limits on number of servers or tools. Should there be configurable limits?

3. **Tool Versioning**: How should tool version conflicts be handled when multiple servers provide similar tools?

4. **Credential Management**: Current env-based credentials are in plaintext config. Should there be integration with secret managers?

5. **Health Check Frequency**: Health checks only occur at startup. Should there be periodic health monitoring?

6. **Tool Discovery Caching**: Tools are cached indefinitely after startup. Should the cache have a TTL or refresh mechanism?

7. **Server Dependencies**: No current mechanism to express dependencies between servers. Is this needed?

8. **Error Recovery Granularity**: Failed servers are completely disabled. Should individual tool failures be handled separately?

### Implementation Uncertainties

1. **StdioTransport Process Access**: The code attempts to access `transport.process` or `transport.subprocess`, but the actual property name may vary by SDK version.

2. **Zod Schema Completeness**: The mcpSchemaToZod translation may not cover all JSON Schema features. Edge cases need investigation.

3. **Typing Indicator Timing**: The 100ms delay for missing tool_start events is arbitrary. Optimal timing needs research.

4. **Parallel Startup Limits**: No limit on parallel server startups. System resource constraints need consideration.

5. **Method Naming Inconsistency**: The codebase references `getAvailableTools()` in multiple places (AgentExecutor, tests) but MCPService only exposes `getCachedTools()`. This suggests either:
   - A missing public async method that should wrap `fetchAvailableTools()`
   - Incorrect usage throughout the codebase that should use `getCachedTools()`
   - An interface change that wasn't fully propagated

## Conclusion

The MCP integration system provides a robust, secure, and type-safe bridge between TENEX agents and external tools. Its layered architecture ensures proper separation of concerns, while the caching and error handling strategies provide reliability and performance. The system's integration with Nostr for tool discovery and its careful security considerations make it suitable for both local development and distributed agent networks.

The architecture successfully balances:
- **Flexibility**: Easy to add new MCP servers
- **Security**: Path restrictions and process isolation
- **Performance**: Caching and parallel initialization
- **Reliability**: Comprehensive error handling
- **Type Safety**: Full Zod integration
- **Extensibility**: Clean interfaces for future enhancements

This design enables TENEX agents to leverage the growing ecosystem of MCP tools while maintaining the system's core principles of type safety, security, and distributed operation.