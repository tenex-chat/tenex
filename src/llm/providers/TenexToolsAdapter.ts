import { tool, type SdkMcpServer, createSdkMcpServer } from "ai-sdk-provider-claude-code";
import type { AISdkTool } from "@/tools/registry";
import { z } from "zod";
import { logger } from "@/utils/logger";

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
        const localTools = Object.entries(tools).filter(
            ([name]) => !name.startsWith("mcp__")
        );

        if (localTools.length === 0) {
            return undefined;
        }

        // Convert each TENEX tool to an SDK MCP tool
        const sdkTools = localTools.map(([name, tenexTool]) => {
            // Convert the Zod schema or use a generic one if not available
            const schema = tenexTool.inputSchema || z.record(z.any());

            return tool(
                name,
                tenexTool.description || `Execute ${name}`,
                schema,
                async (args) => {
                    try {
                        // Execute the TENEX tool
                        const result = await tenexTool.execute(args, { abortSignal: new AbortController().signal });

                        // Convert result to MCP format
                        if (typeof result === "string") {
                            return {
                                content: [{ type: "text", text: result }]
                            };
                        } else if (result && typeof result === "object") {
                            return {
                                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
                            };
                        } else {
                            return {
                                content: [{ type: "text", text: String(result) }]
                            };
                        }
                    } catch (error) {
                        logger.error(`Error executing tool ${name}:`, error);
                        return {
                            content: [{
                                type: "text",
                                text: `Error: ${error instanceof Error ? error.message : String(error)}`
                            }],
                            isError: true
                        };
                    }
                }
            );
        });

        logger.debug("[TenexToolsAdapter] Created SDK MCP server with tools:", {
            tools: localTools.map(([name]) => name)
        });

        // Create and return the SDK MCP server
        try {
            return createSdkMcpServer({
                name: "tenex",
                tools: sdkTools
            });
        } catch (error) {
            logger.warn("[TenexToolsAdapter] Could not create SDK MCP server:", error);
            return undefined;
        }
    }
}