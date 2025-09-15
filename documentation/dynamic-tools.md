# Dynamic Tool System

The Dynamic Tool System allows agents to create and load their own TypeScript tools at runtime without requiring a restart of the TENEX application.

## Overview

The system consists of:

1. **DynamicToolService** - A service that monitors the `src/tools/dynamic/` directory for TypeScript tool files and automatically loads them
2. **Tool Template** - A standardized template for creating dynamic tools that conform to the AI SDK's `CoreTool` interface
3. **Registry Integration** - Seamless integration with the existing tool registry to provide unified tool access
4. **create_dynamic_tool** - A built-in tool that agents can use to programmatically create new dynamic tools

## Architecture

### File Structure

```
src/
├── tools/
│   ├── dynamic/              # Directory for dynamic tools
│   │   └── agent_*.ts         # Dynamic tool files
│   ├── implementations/       # Static tool implementations
│   │   └── create_dynamic_tool.ts
│   ├── templates/
│   │   └── dynamic-tool-template.ts
│   └── registry.ts           # Unified tool registry
└── services/
    └── DynamicToolService.ts # Dynamic tool monitoring service
```

### Key Components

#### DynamicToolService

- Monitors the `src/tools/dynamic/` directory for changes
- Automatically loads new TypeScript files as they are created
- Supports hot-reloading when tool files are updated
- Uses Bun's native TypeScript support for direct module loading
- Implements cache-busting to ensure latest versions are loaded

#### Tool Template Structure

Dynamic tools must follow the AI SDK's `CoreTool` pattern:

```typescript
import { tool, type CoreTool } from 'ai';
import { z } from 'zod';
import type { ExecutionContext } from '@/agents/execution/types';
import type { AISdkTool } from '@/tools/registry';

const toolSchema = z.object({
    // Define input parameters using Zod
});

const createDynamicTool = (context: ExecutionContext): AISdkTool => {
    return tool({
        description: 'Tool description',
        inputSchema: toolSchema,
        execute: async (input) => {
            // Tool implementation
        }
    });
};

export default createDynamicTool;
```

## Usage

### Creating a Dynamic Tool Programmatically

Agents can use the `create_dynamic_tool` tool to create new tools:

```typescript
await create_dynamic_tool({
    name: "my_custom_tool",
    description: "Does something useful",
    inputSchema: "z.object({ text: z.string() })",
    implementation: `
        const result = input.text.toUpperCase();
        return { transformed: result };
    `,
    humanReadableFormat: "Processing: ${input.text}"
});
```

### Creating a Dynamic Tool Manually

1. Create a new TypeScript file in `src/tools/dynamic/`
2. Follow the naming convention: `agent_{agentId}_{toolName}.ts`
3. Use the template structure from `src/tools/templates/dynamic-tool-template.ts`
4. The tool will be automatically loaded and available to agents

### Using Dynamic Tools

Dynamic tools are integrated seamlessly with the existing tool system:

```typescript
// In agent configuration
{
    name: "my-agent",
    tools: [
        "read_path",           // Static tool
        "my_custom_tool",      // Dynamic tool
        "mcp__example__tool"   // MCP tool
    ]
}
```

## Features

### Hot Reloading

- Tools are automatically reloaded when their files are modified
- Uses file content hashing for cache busting
- Debounced file watching to handle partial writes

### Error Handling

- Graceful handling of malformed tool files
- Validation of tool factory functions
- Detailed error logging for debugging

### Integration

- Works alongside static tools and MCP tools
- Unified access through `getToolsObject()` function
- No changes required to agent execution logic

## Lifecycle

### Initialization

1. `DynamicToolService.initialize()` is called during application startup
2. Service scans `src/tools/dynamic/` for existing tools
3. File watcher is set up to monitor changes

### Tool Loading

1. File change detected (new/modified `.ts` file)
2. File content is hashed for cache busting
3. Module is dynamically imported using `import(path?cachebust=hash)`
4. Factory function is validated
5. Tool is registered in the service

### Tool Access

1. Agent requests tools through `getToolsObject()`
2. Registry checks static tools, dynamic tools, and MCP tools
3. Tools are instantiated with the execution context
4. Tools are returned as a unified collection

### Shutdown

1. `DynamicToolService.shutdown()` is called during graceful shutdown
2. File watcher is closed
3. Tool registry is cleared

## Best Practices

1. **Naming Convention**: Use descriptive names following the pattern `agent_{agentId}_{toolName}.ts`
2. **Error Handling**: Always include proper error handling in tool implementations
3. **Context Usage**: Leverage the `ExecutionContext` for accessing agent info, project path, and publishing status
4. **Schema Validation**: Use Zod schemas for robust input validation
5. **Human Readable Content**: Provide `getHumanReadableContent` for better tool call visibility

## Example: Calculator Tool

```typescript
import { tool } from 'ai';
import { z } from 'zod';
import type { ExecutionContext } from '@/agents/execution/types';
import type { AISdkTool } from '@/tools/registry';

const calculatorSchema = z.object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
    a: z.number(),
    b: z.number(),
});

const createCalculatorTool = (context: ExecutionContext): AISdkTool => {
    const aiTool = tool({
        description: 'Performs basic arithmetic operations',
        inputSchema: calculatorSchema,
        execute: async (input) => {
            let result: number;
            switch (input.operation) {
                case 'add': result = input.a + input.b; break;
                case 'subtract': result = input.a - input.b; break;
                case 'multiply': result = input.a * input.b; break;
                case 'divide': 
                    if (input.b === 0) throw new Error('Division by zero');
                    result = input.a / input.b; 
                    break;
            }
            return { result, message: `${input.a} ${input.operation} ${input.b} = ${result}` };
        },
    });
    
    Object.defineProperty(aiTool, 'getHumanReadableContent', {
        value: (input) => `Calculating: ${input.a} ${input.operation} ${input.b}`,
        enumerable: false,
        configurable: true
    });
    
    return aiTool;
};

export default createCalculatorTool;
```

## Limitations

- Tools must be TypeScript files (`.ts` extension)
- Tools are loaded in the same process (no sandboxing in MVP)
- File changes are debounced (300ms delay)
- Tool names must be unique across static and dynamic tools

## Future Enhancements

- [ ] Tool versioning and rollback
- [ ] Sandboxed execution using Worker threads
- [ ] Tool dependencies and shared utilities
- [ ] Tool testing framework
- [ ] Visual tool creator interface
- [ ] Tool marketplace/sharing