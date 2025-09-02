// Tool type and zod schema functions removed - using AI SDK tools only
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { z } from "zod";

// Export MCPPropertyDefinition type for use in MCPService
export interface MCPPropertyDefinition {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: MCPPropertyDefinition;
  properties?: Record<string, MCPPropertyDefinition>;
  required?: string[];
  minItems?: number;
  maxItems?: number;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, MCPPropertyDefinition>;
    required?: string[];
  };
}

/**
 * Create a simple AI SDK compatible tool from MCP tool
 */
export function adaptMCPTool(
  mcpTool: MCPTool,
  serverName: string,
  executeFn: (args: Record<string, unknown>) => Promise<unknown>
): any {
  const namespacedName = `mcp__${serverName}__${mcpTool.name}`;

  // Create AI SDK compatible tool object
  // Note: MCP tools use double underscore convention for namespacing
  return {
    name: namespacedName,
    description: mcpTool.description || `Tool from ${serverName}`,
    parameters: mcpTool.inputSchema ? mcpSchemaToAiSdk(mcpTool.inputSchema) : z.object({}),
    execute: async (args: Record<string, unknown>) => {
      try {
        logger.debug(`Executing MCP tool: ${namespacedName}`, {
          serverName,
          toolName: mcpTool.name,
          args,
        });

        const result = await executeFn(args);
        return result;
      } catch (error) {
        logger.error(`MCP tool execution failed: ${namespacedName}`, {
          serverName,
          toolName: mcpTool.name,
          error: formatAnyError(error),
        });
        throw error;
      }
    },
  };
}

/**
 * Convert MCP schema to AI SDK compatible Zod schema
 */
function mcpSchemaToAiSdk(inputSchema: MCPTool['inputSchema']): z.ZodSchema {
  if (!inputSchema?.properties) {
    return z.object({});
  }

  const shape: Record<string, z.ZodSchema> = {};
  
  for (const [key, prop] of Object.entries(inputSchema.properties)) {
    shape[key] = mcpPropertyToZod(prop);
  }

  const schema = z.object(shape);
  
  // Handle required fields
  if (inputSchema.required && inputSchema.required.length > 0) {
    return schema.partial().required(
      inputSchema.required.reduce((acc, field) => {
        acc[field] = true;
        return acc;
      }, {} as Record<string, true>)
    );
  }
  
  return schema.partial();
}

function mcpPropertyToZod(prop: MCPPropertyDefinition): z.ZodSchema {
  switch (prop.type) {
    case 'string':
      return z.string().describe(prop.description || '');
    case 'number':
      return z.number().describe(prop.description || '');
    case 'integer':
      return z.number().int().describe(prop.description || '');
    case 'boolean':
      return z.boolean().describe(prop.description || '');
    case 'array':
      const itemSchema = prop.items ? mcpPropertyToZod(prop.items) : z.unknown();
      return z.array(itemSchema).describe(prop.description || '');
    case 'object':
      if (prop.properties) {
        const shape: Record<string, z.ZodSchema> = {};
        for (const [key, subProp] of Object.entries(prop.properties)) {
          shape[key] = mcpPropertyToZod(subProp);
        }
        return z.object(shape).describe(prop.description || '');
      }
      return z.record(z.unknown()).describe(prop.description || '');
    default:
      return z.unknown().describe(prop.description || '');
  }
}

// TypedMCPTool removed - using simple AI SDK tools only
