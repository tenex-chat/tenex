import type { AISdkTool } from "@/tools/types";
import { isStopExecutionSignal } from "@/services/ral/types";
import { logger } from "@/utils/logger";
import { createSdkMcpServer, tool, type SdkMcpServer, type Tool } from "ai-sdk-provider-codex-app-server";
import { z, type ZodRawShape } from "zod";

/**
 * Converts TENEX tools to Codex App Server SDK MCP server format.
 *
 * This adapter uses createSdkMcpServer which handles HTTP server lifecycle
 * automatically - the user API is identical to Claude Code's createSdkMcpServer.
 */
export class CodexAppServerToolsAdapter {
    /**
     * Create an SDK MCP server from TENEX tools
     * Pass the result directly to mcpServers in provider settings.
     */
    static createSdkMcpServer(
        tools: Record<string, AISdkTool>,
        context: { agentName?: string }
    ): SdkMcpServer | undefined {
        // Filter out tools that Codex has built-in
        const localTools = Object.entries(tools).filter(([name]) =>
            !name.startsWith("fs_") &&
            !name.startsWith("todo_")
        );

        logger.debug("[CodexAppServerToolsAdapter] Input tools analysis:", {
            totalTools: Object.keys(tools).length,
            localToolsCount: localTools.length,
            localToolNames: localTools.map(([name]) => name),
            agentName: context.agentName,
        });

        if (localTools.length === 0) {
            return undefined;
        }

        const codexTools = this.convertTools(localTools, tools);

        logger.info("[CodexAppServerToolsAdapter] Creating SDK MCP server:", {
            serverName: "tenex",
            toolCount: codexTools.length,
            toolNames: localTools.map(([name]) => name),
        });

        return createSdkMcpServer({
            name: "tenex",
            tools: codexTools,
        });
    }

    /**
     * Convert TENEX tools to Codex Tool format
     */
    private static convertTools(
        localTools: [string, AISdkTool][],
        allTools: Record<string, AISdkTool>
    ): Tool[] {
        return localTools.map(([name, tenexTool]) => {
            let zodSchema = z.object({});

            if (tenexTool.inputSchema) {
                const schema = tenexTool.inputSchema;
                if (schema && typeof schema === "object" && "shape" in schema) {
                    const shape = (schema as z.ZodObject<ZodRawShape>).shape;
                    zodSchema = z.object(shape);
                } else if (schema && typeof schema === "object" && !("_def" in schema)) {
                    zodSchema = z.object(schema as unknown as ZodRawShape);
                }
            }

            return tool({
                name,
                description: tenexTool.description || `Execute ${name}`,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                parameters: zodSchema as any,
                execute: async (args: unknown) => {
                    const executeTool = allTools[name];
                    if (!executeTool?.execute) {
                        throw new Error(`Tool ${name} not found or has no execute function`);
                    }

                    logger.debug(`[CodexAppServerToolsAdapter] Executing tool ${name}`);

                    const result = await executeTool.execute(args, {
                        abortSignal: new AbortController().signal,
                        toolCallId: "tool-call-" + Date.now(),
                        messages: [],
                    });

                    if (isStopExecutionSignal(result)) {
                        logger.debug(`[CodexAppServerToolsAdapter] Tool ${name} returned StopExecutionSignal`);
                        return { _tenexStopSignal: true, ...result };
                    }

                    return result;
                },
            });
        });
    }
}
