import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import {
    createLocalMcpServer,
    tool,
    type LocalMcpServer,
    type LocalTool as Tool,
    type LocalToolDefinition as ToolDefinition,
    type SdkMcpServer,
} from "ai-sdk-provider-codex-cli";
import { z, type ZodRawShape } from "zod";

const SDK_MCP_SERVER_MARKER = Symbol.for("ai-sdk-provider-codex-cli.sdkMcpServer");

export function createSdkMcpServer(
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

    const codexTools = convertTools(localTools, tools);

    logger.info("[CodexToolsAdapter] Creating SDK MCP server:", {
        serverName,
        toolCount: codexTools.length,
        toolNames: localTools.map(([name]) => name),
    });

    return createHttpHeaderAuthenticatedSdkServer({
        name: serverName,
        tools: codexTools,
    });
}

function createHttpHeaderAuthenticatedSdkServer(options: {
    name: string;
    tools: Tool[];
}): SdkMcpServer {
    let server: LocalMcpServer | undefined;
    let startPromise: Promise<LocalMcpServer> | undefined;
    let stopPromise: Promise<void> | undefined;
    const toHttpHeaderConfig = (localServer: LocalMcpServer): LocalMcpServer["config"] => {
        const authorizationHeader = localServer.config.bearerToken
            ? { Authorization: `Bearer ${localServer.config.bearerToken}` }
            : undefined;

        return {
            transport: "http",
            url: localServer.config.url,
            httpHeaders: authorizationHeader,
        };
    };

    return {
        [SDK_MCP_SERVER_MARKER]: true,
        name: options.name,
        tools: options.tools,
        get _server() {
            return server;
        },
        set _server(nextServer: LocalMcpServer | undefined) {
            server = nextServer;
        },
        async _start() {
            while (true) {
                if (server) {
                    return toHttpHeaderConfig(server);
                }

                if (startPromise) {
                    const started = await startPromise;
                    return toHttpHeaderConfig(started);
                }

                if (stopPromise) {
                    await stopPromise;
                    continue;
                }

                const startup = (async () => {
                    const created = await createLocalMcpServer({
                        name: options.name,
                        tools: options.tools,
                    });
                    server = created;
                    return created;
                })();

                startPromise = startup;
                try {
                    const started = await startup;
                    return toHttpHeaderConfig(started);
                } finally {
                    if (startPromise === startup) {
                        startPromise = undefined;
                    }
                }
            }
        },
        async _stop() {
            if (stopPromise) {
                await stopPromise;
                return;
            }

            const stopping = (async () => {
                if (startPromise) {
                    await startPromise.catch(() => undefined);
                }

                const serverToStop = server;
                server = undefined;
                if (serverToStop) {
                    await serverToStop.stop();
                }
            })();

            stopPromise = stopping;
            try {
                await stopping;
            } finally {
                if (stopPromise === stopping) {
                    stopPromise = undefined;
                }
                startPromise = undefined;
            }
        },
    } as unknown as SdkMcpServer;
}

/**
 * Convert TENEX tools to Codex Tool format
 */
function convertTools(
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
                    toolCallId: `tool-call-${Date.now()}`,
                    messages: [],
                });

                return result;
            },
        });
    });
}
