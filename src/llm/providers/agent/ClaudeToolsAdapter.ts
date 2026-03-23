import type { ModelMessage, ToolExecutionOptions } from "ai";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import {
    createSdkMcpServer,
    tool,
    type MinimalCallToolResult,
} from "ai-sdk-provider-claude-code";
import { z, type ZodRawShape } from "zod";

type ClaudeSdkMcpServer = ReturnType<typeof createSdkMcpServer>;

function isToolExecutionOptions(value: unknown): value is ToolExecutionOptions {
    return (
        typeof value === "object" &&
        value !== null &&
        "toolCallId" in value &&
        "messages" in value &&
        Array.isArray((value as { messages?: unknown }).messages)
    );
}

export class ClaudeToolsAdapter {
    static createSdkMcpServer(
        tools: Record<string, AISdkTool>,
        context: { agentName?: string }
    ): ClaudeSdkMcpServer | undefined {
        const localTools = Object.entries(tools);

        logger.debug("[ClaudeToolsAdapter] Input tools analysis", {
            totalTools: Object.keys(tools).length,
            localToolsCount: localTools.length,
            localToolNames: localTools.map(([name]) => name),
            agentName: context.agentName,
        });

        if (localTools.length === 0) {
            return undefined;
        }

        const claudeTools = this.convertTools(localTools, tools);

        logger.info("[ClaudeToolsAdapter] Creating SDK MCP server", {
            serverName: "tenex",
            toolCount: claudeTools.length,
            toolNames: localTools.map(([name]) => name),
        });

        return createSdkMcpServer({
            name: "tenex",
            tools: claudeTools,
        });
    }

    private static convertTools(
        localTools: [string, AISdkTool][],
        allTools: Record<string, AISdkTool>
    ): Array<ReturnType<typeof tool>> {
        return localTools.map(([name, tenexTool]) => {
            let rawShape: ZodRawShape = {};

            if (tenexTool.inputSchema) {
                const schema = tenexTool.inputSchema;
                if (schema && typeof schema === "object" && "shape" in schema) {
                    rawShape = (schema as z.ZodObject<ZodRawShape>).shape;
                } else if (schema && typeof schema === "object" && !("_def" in schema)) {
                    rawShape = schema as unknown as ZodRawShape;
                }
            }

            return tool<ZodRawShape>(
                name,
                tenexTool.description || `Execute ${name}`,
                rawShape,
                async (args, extra: unknown): Promise<MinimalCallToolResult> => {
                    const executeTool = allTools[name];
                    if (!executeTool?.execute) {
                        return ClaudeToolsAdapter.toErrorResult(
                            `Tool ${name} not found or has no execute function`
                        );
                    }

                    logger.debug(`[ClaudeToolsAdapter] Executing tool ${name}`);

                    try {
                        const executionOptions: ToolExecutionOptions = isToolExecutionOptions(extra)
                            ? extra
                            : {
                                abortSignal: new AbortController().signal,
                                toolCallId: `tool-call-${Date.now()}`,
                                messages: [] as ModelMessage[],
                            };

                        const result = await executeTool.execute(args, executionOptions);
                        return ClaudeToolsAdapter.toToolResult(result);
                    } catch (error) {
                        logger.error(`[ClaudeToolsAdapter] Error executing tool ${name}`, {
                            error: error instanceof Error ? error.message : String(error),
                        });
                        return ClaudeToolsAdapter.toErrorResult(
                            error instanceof Error ? error.message : String(error)
                        );
                    }
                }
            );
        });
    }

    private static toToolResult(result: unknown): MinimalCallToolResult {
        if (typeof result === "string") {
            return { content: [{ type: "text", text: result }] };
        }

        if (result && typeof result === "object") {
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }

        return { content: [{ type: "text", text: String(result) }] };
    }

    private static toErrorResult(message: string): MinimalCallToolResult {
        return {
            content: [{ type: "text", text: `Error: ${message}` }],
            isError: true,
        };
    }
}
