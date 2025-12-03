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

        if (localTools.length === 0) {
            return undefined;
        }

        // Convert each TENEX tool to an SDK MCP tool
        const sdkTools = localTools.map(([name, tenexTool]) => {
            // Convert the Zod schema or use a generic one if not available
            const schema = tenexTool.inputSchema || z.record(z.string(), z.any());

            return tool(name, tenexTool.description || `Execute ${name}`, schema as Record<string, z.ZodTypeAny>, async (args) => {
                try {
                    // Execute the TENEX tool
                    if (!tenexTool.execute) {
                        throw new Error(`Tool ${name} does not have an execute function`);
                    }
                    const result = await tenexTool.execute(args, {
                        abortSignal: new AbortController().signal,
                        toolCallId: "tool-call-" + Date.now(),
                        messages: [],
                    });

                    // Convert result to MCP format
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
                    logger.error(`Error executing tool ${name}:`, error);
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

        logger.debug("[TenexToolsAdapter] Created SDK MCP server with tools:", {
            tools: localTools.map(([name]) => name),
        });

        // Create and return the SDK MCP server
        try {
            return createSdkMcpServer({
                name: "tenex",
                tools: sdkTools,
            });
        } catch (error) {
            logger.warn("[TenexToolsAdapter] Could not create SDK MCP server:", error);
            return undefined;
        }
    }
}
