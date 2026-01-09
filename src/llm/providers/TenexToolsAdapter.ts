import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { createSdkMcpServer, tool } from "ai-sdk-provider-claude-code";
import { z } from "zod";

// Infer the return type since SdkMcpServer is not exported
type SdkMcpServer = ReturnType<typeof createSdkMcpServer>;

/**
 * Converts TENEX tools to Claude Code SDK MCP tools
 * Follows Single Responsibility: Only handles tool conversion
 */
export class TenexToolsAdapter {
    /**
     * Convert TENEX tools to SDK MCP tools for Claude Code
     * Only converts non-MCP tools (MCP tools are handled separately)
     */
    static createSdkMcpServer(
        tools: Record<string, AISdkTool>,
        _context: { agentName?: string } // Execution context
    ): SdkMcpServer | undefined {
        // Filter out MCP tools - they're handled separately
        const localTools = Object.entries(tools).filter(([name]) => !name.startsWith("mcp__"));

        console.log("[TenexToolsAdapter] Input tools analysis:", {
            totalTools: Object.keys(tools).length,
            allToolNames: Object.keys(tools),
            localToolsCount: localTools.length,
            localToolNames: localTools.map(([name]) => name),
            mcpToolsCount: Object.keys(tools).filter(name => name.startsWith("mcp__")).length,
            agentName: _context.agentName,
        });

        if (localTools.length === 0) {
            console.log("[TenexToolsAdapter] No local tools to convert - returning undefined");
            return undefined;
        }

        // Convert each TENEX tool to an SDK MCP tool
        const sdkTools = localTools.map(([name, tenexTool]) => {
            // Convert the Zod schema or use a generic one if not available
            // Note: tenexTool.inputSchema is already a Zod schema compatible with tool()
            const schema = tenexTool.inputSchema || z.object({}); // Use empty object instead of record

            console.log("[TenexToolsAdapter] Converting tool:", {
                name,
                hasSchema: !!tenexTool.inputSchema,
                hasExecute: !!tenexTool.execute,
                description: tenexTool.description?.substring(0, 100),
            });

            // biome-ignore lint/suspicious/noExplicitAny: SDK type variance workaround
            return tool(name, tenexTool.description || `Execute ${name}`, schema as any, async (args, extra) => {
                try {
                    console.log(`[TenexToolsAdapter] Executing tool ${name}`, {
                        args: JSON.stringify(args).substring(0, 200),
                        hasExtra: !!extra,
                        extraType: typeof extra,
                    });

                    // Check if the tool has an execute method
                    if (!tenexTool.execute) {
                        throw new Error(`Tool ${name} does not have an execute function`);
                    }

                    // Execute the TENEX tool
                    // If extra contains execution context, pass it; otherwise use minimal fallback
                    let result;
                    if (extra && typeof extra === 'object') {
                        // Try to use the extra context from Claude Code
                        result = await tenexTool.execute(args, extra as any);
                    } else {
                        // Fallback to minimal context (should rarely happen)
                        result = await tenexTool.execute(args, {
                            abortSignal: new AbortController().signal,
                            toolCallId: "tool-call-" + Date.now(),
                            messages: [],
                        });
                    }

                    console.log(`[TenexToolsAdapter] Tool ${name} executed successfully`, {
                        resultType: typeof result,
                        resultLength: typeof result === "string" ? result.length : JSON.stringify(result).length,
                    });

                    // Convert result to MCP format
                    // CallToolResult expects: { content: [{ type: "text", text: string }], isError?: boolean }
                    if (typeof result === "string") {
                        return {
                            content: [{ type: "text", text: result }],
                        };
                    }
                    if (result && typeof result === "object") {
                        return {
                            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        };
                    }
                    return {
                        content: [{ type: "text", text: String(result) }],
                    };
                } catch (error) {
                    logger.error(`[TenexToolsAdapter] Error executing tool ${name}:`, error);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                            },
                        ],
                        isError: true,
                    };
                }
            });
        });

        console.log("[TenexToolsAdapter] Created SDK MCP server with tools:", {
            serverName: "tenex",
            toolCount: sdkTools.length,
            toolNames: localTools.map(([name]) => name),
        });

        // Create and return the SDK MCP server
        try {
            const server = createSdkMcpServer({
                name: "tenex",
                tools: sdkTools,
            });

            logger.info("[TenexToolsAdapter] SDK MCP server created successfully", {
                serverName: "tenex",
                toolCount: sdkTools.length,
            });

            return server;
        } catch (error) {
            logger.warn("[TenexToolsAdapter] Could not create SDK MCP server:", error);
            return undefined;
        }
    }
}
