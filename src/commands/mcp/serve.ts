/**
 * TENEX MCP Server - Exposes TENEX tools via MCP protocol over stdio
 *
 * This server is spawned by Codex CLI provider when executing agents.
 * It reads context from environment variables and exposes a filtered set of TENEX tools.
 *
 * Environment variables:
 * - TENEX_PROJECT_ID: Project identifier
 * - TENEX_AGENT_ID: Agent identifier/pubkey
 * - TENEX_CONVERSATION_ID: Conversation ID for conversation-scoped tools
 * - TENEX_WORKING_DIRECTORY: Project's working directory for file operations
 * - TENEX_CURRENT_BRANCH: Current git branch
 * - TENEX_TOOLS: Comma-separated list of tool names to expose
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    StdioServerTransport,
} from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
    CallToolRequest,
    CallToolResult,
    Tool as MCPTool,
} from "@modelcontextprotocol/sdk/types.js";
import type { AISdkTool } from "@/tools/types";
import { getToolsObject } from "@/tools/registry";
import { ConversationStore } from "@/conversations/ConversationStore";
import { logger } from "@/utils/logger";
import { isStopExecutionSignal } from "@/services/ral/types";
import { z } from "zod";
import type { ZodRawShape } from "zod";
import type { ToolRegistryContext, ToolExecutionContext } from "@/tools/types";

/**
 * Load context from environment variables
 */
function loadContextFromEnv(): {
    projectId: string;
    agentId: string;
    conversationId: string;
    workingDirectory: string;
    currentBranch: string;
    toolNames: string[];
} {
    const projectId = process.env.TENEX_PROJECT_ID;
    const agentId = process.env.TENEX_AGENT_ID;
    const conversationId = process.env.TENEX_CONVERSATION_ID;
    const workingDirectory = process.env.TENEX_WORKING_DIRECTORY;
    const currentBranch = process.env.TENEX_CURRENT_BRANCH;
    const toolNamesStr = process.env.TENEX_TOOLS;

    if (!projectId) throw new Error("TENEX_PROJECT_ID environment variable is required");
    if (!agentId) throw new Error("TENEX_AGENT_ID environment variable is required");
    if (!conversationId) throw new Error("TENEX_CONVERSATION_ID environment variable is required");
    if (!workingDirectory) throw new Error("TENEX_WORKING_DIRECTORY environment variable is required");
    if (!currentBranch) throw new Error("TENEX_CURRENT_BRANCH environment variable is required");
    if (!toolNamesStr) throw new Error("TENEX_TOOLS environment variable is required");

    return {
        projectId,
        agentId,
        conversationId,
        workingDirectory,
        currentBranch,
        toolNames: toolNamesStr.split(",").map((t) => t.trim()),
    };
}

/**
 * Convert Zod schema to MCP JSON Schema format
 */
function zodsToJsonSchema(
    rawShape: ZodRawShape
): { [x: string]: unknown; type: "object"; properties?: { [x: string]: object }; required?: string[] } {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, schema] of Object.entries(rawShape)) {
        // Extract basic type information from Zod schema
        if (schema && typeof schema === "object" && "_def" in schema) {
            const def = (schema as any)._def;
            const typeName = def.typeName ?? "ZodUnknown";

            // Map common Zod types to JSON Schema types
            if (typeName === "ZodString") {
                properties[key] = { type: "string" };
                required.push(key);
            } else if (typeName === "ZodNumber") {
                properties[key] = { type: "number" };
                required.push(key);
            } else if (typeName === "ZodBoolean") {
                properties[key] = { type: "boolean" };
                required.push(key);
            } else if (typeName === "ZodArray") {
                properties[key] = { type: "array", items: { type: "string" } };
                required.push(key);
            } else {
                // Fallback for other types
                properties[key] = { type: "string" };
            }
        }
    }

    const result: { [x: string]: unknown; type: "object"; properties?: { [x: string]: object }; required?: string[] } = {
        type: "object",
    };

    if (Object.keys(properties).length > 0) {
        result.properties = properties as { [x: string]: object };
    }

    if (required.length > 0) {
        result.required = required;
    }

    return result;
}

/**
 * Convert TENEX tool to MCP tool format
 */
function convertTenexToolToMCP(name: string, tool: AISdkTool): MCPTool {
    let inputSchema: { [x: string]: unknown; type: "object"; properties?: { [x: string]: object }; required?: string[] } = {
        type: "object",
    };

    // Extract schema if available
    if (tool.inputSchema) {
        const schema = tool.inputSchema;
        if (schema && typeof schema === "object" && "shape" in schema) {
            // It's a ZodObject - extract the raw shape
            const rawShape = (schema as z.ZodObject<ZodRawShape>).shape;
            inputSchema = zodsToJsonSchema(rawShape);
        } else if (schema && typeof schema === "object" && !("_def" in schema)) {
            // It might already be a raw shape object
            inputSchema = zodsToJsonSchema(schema as unknown as ZodRawShape);
        }
    }

    return {
        name,
        description: tool.description || `Execute ${name}`,
        inputSchema,
    };
}

/**
 * Start the MCP server
 */
export async function startServer(): Promise<void> {
    try {
        // Load context from environment
        const context = loadContextFromEnv();
        logger.info("[TenexMCP] Starting server with context:", {
            projectId: context.projectId,
            agentId: context.agentId,
            toolCount: context.toolNames.length,
            toolNames: context.toolNames,
        });

        // Build minimal ToolRegistryContext
        const conversationStore = await ConversationStore.getOrLoad(context.conversationId);

        // Create execution context stub
        const executionContext: Partial<ToolExecutionContext> = {
            conversationId: context.conversationId,
            projectBasePath: context.workingDirectory,
            workingDirectory: context.workingDirectory,
            currentBranch: context.currentBranch,
        };

        // Get tools from registry
        const toolsObject = getToolsObject(context.toolNames, {
            ...executionContext,
            conversationStore,
        } as ToolRegistryContext);

        logger.info("[TenexMCP] Loaded tools:", {
            count: Object.keys(toolsObject).length,
            names: Object.keys(toolsObject),
        });

        // Create MCP server
        const server = new Server({
            name: "tenex",
            version: "1.0.0",
        });

        // Register tools with server
        const mcpTools = Object.entries(toolsObject).map(([name, tool]) => {
            return convertTenexToolToMCP(name, tool);
        });

        // Register tools/list handler
        (server as any).setRequestHandler(
            { method: "tools/list" },
            async () => ({
                tools: mcpTools,
            })
        );

        // Register tools/call handler
        (server as any).setRequestHandler(
            { method: "tools/call" },
            async (request: CallToolRequest): Promise<CallToolResult> => {
                const { name, arguments: args } = request.params;

                try {
                    const tool = toolsObject[name];
                    if (!tool) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Tool ${name} not found`,
                                },
                            ],
                            isError: true,
                        };
                    }

                    if (!tool.execute) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Tool ${name} does not have an execute function`,
                                },
                            ],
                            isError: true,
                        };
                    }

                    logger.info(`[TenexMCP] Executing tool: ${name}`, {
                        args: JSON.stringify(args).substring(0, 200),
                    });

                    // Execute the tool
                    const result = await tool.execute(args as Record<string, unknown>, {
                        abortSignal: new AbortController().signal,
                        toolCallId: `tenex-mcp-${Date.now()}`,
                        messages: [],
                    });

                    // Handle StopExecutionSignal (from delegation tools)
                    if (isStopExecutionSignal(result)) {
                        logger.info(`[TenexMCP] Tool ${name} returned StopExecutionSignal`, {
                            hasPendingDelegations: !!result.pendingDelegations,
                        });

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(result, null, 2),
                                },
                            ],
                            _tenexOriginalResult: result,
                        } as CallToolResult & { _tenexOriginalResult: unknown };
                    }

                    // Format result
                    if (typeof result === "string") {
                        return {
                            content: [{ type: "text", text: result }],
                        };
                    }

                    if (result && typeof result === "object") {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(result, null, 2),
                                },
                            ],
                        };
                    }

                    return {
                        content: [{ type: "text", text: String(result) }],
                    };
                } catch (error) {
                    logger.error(`[TenexMCP] Error executing tool ${name}:`, error);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Error executing tool ${name}: ${error instanceof Error ? error.message : String(error)}`,
                            },
                        ],
                        isError: true,
                    };
                }
            }
        );

        // Connect stdio transport and start
        const transport = new StdioServerTransport();
        await server.connect(transport);

        logger.info("[TenexMCP] Server started and connected");
    } catch (error) {
        logger.error("[TenexMCP] Fatal error:", error);
        process.exit(1);
    }
}

