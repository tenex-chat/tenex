import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { createSdkMcpServer, tool } from "ai-sdk-provider-claude-code";
import type { ToolExecutionOptions } from "@ai-sdk/provider-utils";
import { z, type ZodRawShape } from "zod";

// Infer the return type since SdkMcpServer is not exported
type SdkMcpServer = ReturnType<typeof createSdkMcpServer>;

/**
 * Converts TENEX tools to Claude Code SDK MCP server format.
 *
 * This adapter is EXCLUSIVE to Claude Code - it uses createSdkMcpServer from
 * the Claude Agent SDK which creates in-process MCP servers that only Claude Code
 * can consume. Other providers (like Codex CLI) require different MCP formats.
 */
export class ClaudeCodeToolsAdapter {
    /**
     * Convert TENEX tools to SDK MCP tools for Claude Code
     * Only converts non-MCP tools (MCP tools are handled separately)
     */
    static createSdkMcpServer(
        tools: Record<string, AISdkTool>
    ): SdkMcpServer | undefined {
        // Filter out tools that Claude Code has its own version of:
        // - fs_* (Claude Code has Read, Write, Edit, Glob, Grep)
        // - web_fetch (Claude Code has WebFetch)
        // - shell (Claude Code has Bash)
        // - web_search (Claude Code has WebSearch)
        // Note: todo_* tools are now exposed via MCP to give Claude Code agents access to TENEX todo functionality
        const claudeCodeBuiltinTools = new Set([
            "web_fetch",
            "shell",
            "web_search",
        ]);
        const localTools = Object.entries(tools).filter(([name]) =>
            !name.startsWith("fs_") &&
            !claudeCodeBuiltinTools.has(name)
        );

        if (localTools.length === 0) {
            return undefined;
        }

        // Convert each TENEX tool to an SDK MCP tool
        const sdkTools = localTools.map(([name, tenexTool]) => {
            // The Claude SDK's tool() function expects a ZodRawShape (plain object like { a: z.number() })
            // NOT a ZodObject (result of z.object({...})). We need to extract the .shape property.
            // tenexTool.inputSchema from AI SDK is a ZodObject, so we extract its shape.
            let rawShape: ZodRawShape = {};

            if (tenexTool.inputSchema) {
                // Check if it's a ZodObject with a shape property
                const schema = tenexTool.inputSchema;
                if (schema && typeof schema === "object" && "shape" in schema) {
                    // It's a ZodObject - extract the raw shape
                    rawShape = (schema as z.ZodObject<ZodRawShape>).shape;
                } else if (schema && typeof schema === "object" && !("_def" in schema)) {
                    // It might already be a raw shape object (plain object with Zod types)
                    rawShape = schema as unknown as ZodRawShape;
                }
                // If it's some other Zod type, leave rawShape as empty object
            }

            return tool(name, tenexTool.description || `Execute ${name}`, rawShape, async (args: Record<string, unknown>, extra: unknown) => {
                try {
                    // Check if the tool has an execute method
                    if (!tenexTool.execute) {
                        throw new Error(`Tool ${name} does not have an execute function`);
                    }

                    // Execute the TENEX tool
                    // If extra contains execution context, pass it; otherwise use minimal fallback
                    const isToolExecutionOptions = (value: unknown): value is ToolExecutionOptions =>
                        typeof value === "object" &&
                        value !== null &&
                        "toolCallId" in value &&
                        "messages" in value &&
                        Array.isArray((value as { messages?: unknown }).messages);

                    let result;
                    if (isToolExecutionOptions(extra)) {
                        // Try to use the extra context from Claude Code
                        result = await tenexTool.execute(args, extra);
                    } else {
                        // Fallback to minimal context (should rarely happen)
                        result = await tenexTool.execute(args, {
                            abortSignal: new AbortController().signal,
                            toolCallId: "tool-call-" + Date.now(),
                            messages: [],
                        });
                    }

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
                    logger.error(`[ClaudeCodeToolsAdapter] Error executing tool ${name}:`, error);
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

        // Create and return the SDK MCP server
        try {
            const server = createSdkMcpServer({
                name: "tenex",
                tools: sdkTools,
            });

            logger.info("[ClaudeCodeToolsAdapter] SDK MCP server created successfully", {
                serverName: "tenex",
                toolCount: sdkTools.length,
            });

            return server;
        } catch (error) {
            logger.warn("[ClaudeCodeToolsAdapter] Could not create SDK MCP server:", error);
            return undefined;
        }
    }
}
