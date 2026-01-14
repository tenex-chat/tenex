import type { AISdkTool } from "@/tools/types";
import { isStopExecutionSignal } from "@/services/ral/types";
import { logger } from "@/utils/logger";
import { createSdkMcpServer, tool } from "ai-sdk-provider-claude-code";
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
        tools: Record<string, AISdkTool>,
        _context: { agentName?: string } // Execution context
    ): SdkMcpServer | undefined {
        // Filter out tools that Claude Code has its own version of:
        // - fs_* (Claude Code has Read, Write, Edit, Glob, Grep)
        // - todo_* (Claude Code has TodoWrite)
        // - web_fetch (Claude Code has WebFetch)
        // - shell (Claude Code has Bash)
        // - web_search (Claude Code has WebSearch)
        const claudeCodeBuiltinTools = new Set([
            "web_fetch",
            "shell",
            "web_search",
        ]);
        const localTools = Object.entries(tools).filter(([name]) =>
            !name.startsWith("fs_") &&
            !name.startsWith("todo_") &&
            !claudeCodeBuiltinTools.has(name)
        );

        console.log("[ClaudeCodeToolsAdapter] Input tools analysis:", {
            totalTools: Object.keys(tools).length,
            allToolNames: Object.keys(tools),
            localToolsCount: localTools.length,
            localToolNames: localTools.map(([name]) => name),
            mcpToolsCount: Object.keys(tools).filter(name => name.startsWith("mcp__")).length,
            agentName: _context.agentName,
        });

        if (localTools.length === 0) {
            console.log("[ClaudeCodeToolsAdapter] No local tools to convert - returning undefined");
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

            console.log("[ClaudeCodeToolsAdapter] Converting tool:", {
                name,
                hasSchema: !!tenexTool.inputSchema,
                hasExecute: !!tenexTool.execute,
                description: tenexTool.description?.substring(0, 100),
                extractedShapeKeys: Object.keys(rawShape),
            });

            return tool(name, tenexTool.description || `Execute ${name}`, rawShape, async (args, extra) => {
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
                    if (extra && typeof extra === "object") {
                        // Try to use the extra context from Claude Code
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
                    //
                    // IMPORTANT: For StopExecutionSignal results (from delegation tools like ask, delegate),
                    // we need to preserve the pendingDelegations structure so that ToolExecutionTracker
                    // can extract the delegation event IDs for q-tags. We do this by returning the
                    // original result object directly instead of wrapping it in MCP format.
                    // The Claude Code SDK handles this appropriately.
                    if (isStopExecutionSignal(result)) {
                        console.log(`[TenexToolsAdapter] Tool ${name} returned StopExecutionSignal, preserving structure`, {
                            hasPendingDelegations: !!result.pendingDelegations,
                            delegationCount: result.pendingDelegations?.length ?? 0,
                        });
                        // Return the original result so ToolExecutionTracker can extract pendingDelegations
                        // for q-tags. The MCP format wrapping will show a text message to the LLM.
                        return {
                            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                            // Attach the original result for ToolExecutionTracker to access
                            _tenexOriginalResult: result,
                        };
                    }
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

        console.log("[ClaudeCodeToolsAdapter] Created SDK MCP server with tools:", {
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
