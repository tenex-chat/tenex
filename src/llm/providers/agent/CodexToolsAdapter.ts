import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import {
    createSdkMcpServer,
    tool,
    type LocalTool as Tool,
    type LocalToolDefinition as ToolDefinition,
    type SdkMcpServer,
} from "ai-sdk-provider-codex-cli";
import { z, type ZodRawShape } from "zod";

export class CodexToolsAdapter {
    static createSdkMcpServer(
        tools: Record<string, AISdkTool>,
        context: { agentName?: string; serverName?: string }
    ): SdkMcpServer | undefined {
        const localTools = Object.entries(tools);
        const serverName = context.serverName ?? "tenex_local_tools";

        logger.debug("[CodexToolsAdapter] Input tools analysis:", {
            totalTools: Object.keys(tools).length,
            localToolsCount: localTools.length,
            localToolNames: localTools.map(([name]) => name),
            agentName: context.agentName,
            serverName,
        });

        if (localTools.length === 0) {
            return undefined;
        }

        const codexTools = this.convertTools(localTools, tools);

        logger.info("[CodexToolsAdapter] Creating SDK MCP server:", {
            serverName,
            toolCount: codexTools.length,
            toolNames: localTools.map(([name]) => name),
        });

        return createSdkMcpServer({
            name: serverName,
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
            let zodSchema: unknown = z.object({});

            if (tenexTool.inputSchema) {
                const schema = tenexTool.inputSchema;
                if (schema && typeof schema === "object" && "shape" in schema) {
                    const shape = (schema as z.ZodObject<ZodRawShape>).shape;
                    zodSchema = z.object(shape);
                } else if (schema && typeof schema === "object" && !("_def" in schema)) {
                    zodSchema = z.object(schema as unknown as ZodRawShape);
                }
            }

            return tool<unknown, unknown>({
                name,
                description: tenexTool.description || `Execute ${name}`,
                parameters: zodSchema as ToolDefinition<unknown, unknown>["parameters"],
                execute: async (args: unknown) => {
                    const executeTool = allTools[name];
                    if (!executeTool?.execute) {
                        throw new Error(`Tool ${name} not found or has no execute function`);
                    }

                    logger.debug(`[CodexToolsAdapter] Executing tool ${name}`);

                    const result = await executeTool.execute(args, {
                        abortSignal: new AbortController().signal,
                        toolCallId: "tool-call-" + Date.now(),
                        messages: [],
                    });

                    return result;
                },
            });
        });
    }
}
