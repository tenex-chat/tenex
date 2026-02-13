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
     * Check if a tool is an external MCP tool (from external MCP servers).
     * External MCP tools have JSON Schema format (not Zod), so they cannot be
     * wrapped with the Claude SDK's tool() function which expects Zod schemas.
     * These tools are passed directly to Claude Code as MCP servers instead.
     *
     * Detection is metadata-based (checking for Zod schema characteristics)
     * rather than name-based, to avoid collisions if a user names their
     * external MCP server "tenex".
     */
    private static isExternalMcpTool(toolName: string, tool: AISdkTool): boolean {
        // External MCP tools follow the pattern: mcp__<servername>__<toolname>
        if (!toolName.startsWith("mcp__")) {
            return false;
        }

        // Use metadata-based detection: check if the schema is a Zod object (has safeParseAsync)
        // External MCP tools have JSON Schema format, TENEX tools have Zod schemas
        const schema = tool.inputSchema;
        if (schema && typeof schema === "object" && "safeParseAsync" in schema) {
            // Has Zod schema - this is a TENEX tool (not external)
            return false;
        }

        // No Zod schema detected - treat as external MCP tool
        return true;
    }

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
        // CRITICAL: Filter out external MCP tools - they have JSON Schema format (no .safeParseAsync())
        // and will crash if we try to wrap them with tool() from Claude SDK.
        // External MCP servers are passed directly to Claude Code via mcpConfig.servers instead.
        const localTools = Object.entries(tools).filter(([name, tool]) =>
            !name.startsWith("fs_") &&
            !claudeCodeBuiltinTools.has(name) &&
            !this.isExternalMcpTool(name, tool)
        );

        // Log external MCP tools that were filtered out (for debugging)
        const externalMcpTools = Object.entries(tools)
            .filter(([name, tool]) => this.isExternalMcpTool(name, tool))
            .map(([name]) => name);

        if (externalMcpTools.length > 0) {
            logger.debug("[ClaudeCodeToolsAdapter] Filtered out external MCP tools (passed directly to Claude Code):", {
                count: externalMcpTools.length,
                tools: externalMcpTools,
            });
        }

        if (localTools.length === 0) {
            logger.debug("[ClaudeCodeToolsAdapter] No local tools to wrap after filtering", {
                totalTools: Object.keys(tools).length,
                externalMcpCount: externalMcpTools.length,
                builtinFilteredCount: Object.keys(tools).filter(name =>
                    name.startsWith("fs_") || claudeCodeBuiltinTools.has(name)
                ).length,
            });
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
                } else if (schema !== null && typeof schema === "object") {
                    // DEFENSIVE GUARD: Log warning if we encounter an unexpected schema type
                    // This helps catch future regressions where non-Zod schemas slip through
                    logger.warn(`[ClaudeCodeToolsAdapter] Tool '${name}' has unexpected schema type - using empty schema`, {
                        hasShape: "shape" in schema,
                        hasDef: "_def" in schema,
                        hasSafeParseAsync: typeof (schema as { safeParseAsync?: unknown }).safeParseAsync === "function",
                    });
                } else {
                    // Primitive schema (e.g., z.string()) - log warning but don't crash
                    logger.warn(`[ClaudeCodeToolsAdapter] Tool '${name}' has primitive or non-object schema type - using empty schema`, {
                        schemaType: typeof schema,
                    });
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
