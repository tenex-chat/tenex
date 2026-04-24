/**
 * MCPManager - Official MCP SDK Integration
 *
 * Uses the official @modelcontextprotocol/sdk for full MCP spec compliance
 */

import * as path from "node:path";
import type { MCPServerConfig, TenexMCP } from "@/services/config/types";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import { config as configService } from "@/services/ConfigService";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js";
import { jsonSchema, tool } from "ai";
import type { Tool as CoreTool } from "ai";

type MCPToolSet = Record<string, CoreTool<Record<string, unknown>, string>>;

interface MCPClientEntry {
    client: Client;
    transport: StdioClientTransport;
    serverName: string;
    config: MCPServerConfig;
}

export class MCPManager {
    private clients: Map<string, MCPClientEntry> = new Map();
    private isInitialized = false;
    private metadataPath?: string;
    private workingDirectory?: string;
    private cachedTools: MCPToolSet = {};

    /** Deferred config: servers are started lazily on first access */
    private pendingConfig: TenexMCP | null = null;
    private serversStarted = false;
    private serverStartPromise: Promise<void> | null = null;

    /**
     * Convert an MCP tool (JSON Schema) to an AI SDK tool.
     * Uses `jsonSchema()` to pass the MCP JSON Schema directly to the AI SDK.
     */
    private convertMCPToolToAISdkTool(
        mcpTool: MCPTool,
        serverName: string,
        toolName: string
    ): CoreTool<Record<string, unknown>, string> {
        return tool<Record<string, unknown>, string>({
            description: mcpTool.description || `Tool ${toolName} from ${serverName}`,
            inputSchema: jsonSchema<Record<string, unknown>>(
                mcpTool.inputSchema as unknown as Parameters<typeof jsonSchema>[0]
            ),
            execute: async (args) => {
                const entry = this.clients.get(serverName);
                if (!entry) {
                    throw new Error(`MCP server '${serverName}' not found`);
                }

                try {
                    const callResult = await entry.client.callTool({
                        name: toolName,
                        arguments: args
                    });

                    // Extract text content from MCP CallToolResult
                    if (callResult.content && Array.isArray(callResult.content)) {
                        const textContent = callResult.content
                            .filter((c): c is { type: "text"; text: string } =>
                                typeof c === "object" && "text" in c
                            )
                            .map(c => c.text)
                            .join("\n");
                        return textContent || JSON.stringify(callResult);
                    }

                    return JSON.stringify(callResult);
                } catch (error) {
                    logger.error(
                        `Failed to call MCP tool '${toolName}':`,
                        formatAnyError(error)
                    );
                    throw error;
                }
            }
        });
    }

    /**
     * Initialize MCP manager with project paths
     * @param metadataPath The project metadata path (~/.tenex/projects/{dTag}) for config loading
     * @param workingDirectory The project working directory (~/tenex/{dTag}) for MCP server CWD
     */
    async initialize(metadataPath?: string, workingDirectory?: string): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        try {
            this.metadataPath = metadataPath;
            this.workingDirectory = workingDirectory;

            // Load and merge global + project MCP configs
            const globalPath = configService.getGlobalPath();
            const globalMCP = await configService.loadTenexMCP(globalPath);
            const projectMCP = metadataPath
                ? await configService.loadTenexMCP(metadataPath)
                : { servers: {}, enabled: true };

            const mergedMCP: TenexMCP = {
                servers: { ...globalMCP.servers, ...projectMCP.servers },
                enabled: projectMCP.enabled !== undefined ? projectMCP.enabled : globalMCP.enabled,
            };

            if (!mergedMCP.enabled) {
                this.isInitialized = true;
                return;
            }

            // Store config for deferred startup — servers are spawned on first access
            if (mergedMCP.servers && Object.keys(mergedMCP.servers).length > 0) {
                this.pendingConfig = mergedMCP;
                logger.info("MCP servers configured (deferred startup)", {
                    servers: Object.keys(mergedMCP.servers),
                });
            }
            this.isInitialized = true;

            trace.getActiveSpan()?.addEvent("mcp.initialized", {
                "servers.configured": Object.keys(mergedMCP.servers).length,
            });
        } catch (error) {
            logger.error("Failed to initialize MCP manager:", error);
            // Don't throw - allow the system to continue without MCP
        }
    }

    /**
     * Ensure MCP servers are started. Called lazily on first access.
     * Concurrent calls share a single startup.
     */
    private async ensureServersStarted(): Promise<void> {
        while (!this.serversStarted && this.pendingConfig) {
            if (this.serverStartPromise) {
                await this.serverStartPromise;
                continue;
            }

            this.serverStartPromise = this.startDeferredServers();
            try {
                await this.serverStartPromise;
            } finally {
                this.serverStartPromise = null;
            }
        }
    }

    private async startDeferredServers(): Promise<void> {
        const config = this.pendingConfig;
        if (!config) return;

        this.pendingConfig = null;
        this.serversStarted = true;

        logger.info("Starting MCP servers (first access)");
        await this.startServers(config);
        await this.refreshToolCache();

        trace.getActiveSpan()?.addEvent("mcp.servers_started_lazy", {
            "servers.count": this.clients.size,
        });
    }

    private async startServers(mcpConfig: TenexMCP): Promise<void> {
        const startPromises = Object.entries(mcpConfig.servers)
            .filter(([name]) => {
                if (!name || name.trim() === "") {
                    logger.warn("Skipping MCP server with empty or invalid name");
                    return false;
                }
                return true;
            })
            .map(([name, config]) =>
                this.startServer(name, config).catch((error) => {
                    logger.error(`Failed to start MCP server '${name}':`, formatAnyError(error));
                    // Continue with other servers
                })
            );

        await Promise.all(startPromises);
    }

    private async startServer(name: string, config: MCPServerConfig): Promise<void> {
        if (this.clients.has(name)) {
            logger.warn(`MCP server '${name}' is already running`);
            return;
        }

        // SECURITY CHECK: Enforce allowedPaths
        if (config.allowedPaths && config.allowedPaths.length > 0 && this.workingDirectory) {
            const resolvedWorkingDir = path.resolve(this.workingDirectory);
            // Filter out undefined/null values from allowedPaths
            const validAllowedPaths = config.allowedPaths.filter(
                (p): p is string => typeof p === "string" && p.length > 0
            );
            const isAllowed = validAllowedPaths.some((allowedPath) => {
                const resolvedAllowedPath = path.resolve(allowedPath);
                return (
                    resolvedWorkingDir.startsWith(resolvedAllowedPath) ||
                    resolvedAllowedPath.startsWith(resolvedWorkingDir)
                );
            });

            if (!isAllowed) {
                logger.warn(
                    `Skipping MCP server '${name}' due to path restrictions. Working directory '${this.workingDirectory}' is not in allowedPaths: ${validAllowedPaths.join(", ")}`
                );
                return;
            }
        }

        const mergedEnv: Record<string, string> = {};
        // Only include defined environment variables
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
                mergedEnv[key] = value;
            }
        }
        // Override with config env
        if (config.env) {
            Object.assign(mergedEnv, config.env);
        }

        trace.getActiveSpan()?.addEvent("mcp.server_starting", {
            "server.name": name,
            "server.command": config.command,
        });

        // Create transport
        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: mergedEnv,
            cwd: this.workingDirectory,
        });

        try {
            // Create client
            const client = new Client(
                {
                    name: `tenex-${name}`,
                    version: "1.0.0"
                },
                {
                    capabilities: {}
                }
            );

            // Connect to server
            await client.connect(transport);

            // Health check - try listing tools with timeout
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Health check timeout")), 5000)
            );

            try {
                await Promise.race([client.listTools(), timeoutPromise]);
            } catch (error) {
                logger.error(`MCP server '${name}' failed health check:`, error);
                await client.close();
                return;
            }

            // Store client entry
            this.clients.set(name, {
                client,
                transport,
                serverName: name,
                config,
            });

            logger.info(`MCP server '${name}' started successfully`);

            // Emit telemetry
            trace.getActiveSpan()?.addEvent("mcp.server_started", {
                "server.name": name,
            });
        } catch (error) {
            logger.error(`Failed to start MCP server '${name}':`, formatAnyError(error));
            throw error;
        }
    }

    private async refreshToolCache(): Promise<void> {
        const tools: MCPToolSet = {};

        for (const [serverName, entry] of this.clients) {
            try {
                // List tools from MCP server (official SDK method)
                const { tools: mcpTools } = await entry.client.listTools();

                // Convert each MCP tool to AI SDK tool
                for (const mcpTool of mcpTools) {
                    const namespacedName = `mcp__${serverName}__${mcpTool.name}`;
                    tools[namespacedName] = this.convertMCPToolToAISdkTool(
                        mcpTool,
                        serverName,
                        mcpTool.name
                    );
                }

                trace.getActiveSpan()?.addEvent("mcp.tools_discovered", {
                    "server.name": serverName,
                    "tools.count": mcpTools.length,
                });
            } catch (error) {
                logger.error(
                    `Failed to get tools from MCP server '${serverName}':`,
                    formatAnyError(error)
                );
            }
        }

        this.cachedTools = tools;
        trace.getActiveSpan()?.addEvent("mcp.tools_cached", {
            "tools.total": Object.keys(tools).length,
            "servers.count": this.clients.size,
        });
    }

    /**
     * Refresh the tool cache
     */
    async refreshTools(): Promise<void> {
        await this.ensureServersStarted();
        await this.refreshToolCache();
    }

    /**
     * Get all cached MCP tools as an object keyed by tool name.
     * Returns only tools from servers that have already been started.
     * Does NOT trigger lazy server startup — callers that need tools
     * for agent execution should call ensureReady() first.
     */
    getCachedTools(): MCPToolSet {
        return this.cachedTools;
    }

    /**
     * Ensure MCP servers are started and tools are available.
     * Call this before getCachedTools() when tools are actually needed
     * for agent execution (not for telemetry/status reporting).
     */
    async ensureReady(): Promise<void> {
        await this.ensureServersStarted();
    }

    /**
     * Start only the MCP servers that provide the given tools.
     * Tool names follow the `mcp__{serverName}__{toolName}` convention.
     * Servers already running are skipped; servers not needed are not started.
     */
    async ensureServersForTools(mcpToolNames: string[]): Promise<void> {
        const neededServers = new Set<string>();
        for (const name of mcpToolNames) {
            const parts = name.split("__");
            if (parts.length >= 3 && parts[0] === "mcp") {
                neededServers.add(parts[1]);
            }
        }

        if (neededServers.size === 0) return;

        while (this.pendingConfig) {
            const missingServers = Array.from(neededServers).filter((name) => !this.clients.has(name));
            if (missingServers.length === 0) {
                return;
            }

            if (this.serverStartPromise) {
                await this.serverStartPromise;
                continue;
            }

            this.serverStartPromise = this.startDeferredServersForTools(missingServers);
            try {
                await this.serverStartPromise;
            } finally {
                this.serverStartPromise = null;
            }
        }
    }

    private async startDeferredServersForTools(serverNames: string[]): Promise<void> {
        const config = this.pendingConfig;
        if (!config) return;

        const serversToStart = Object.fromEntries(
            serverNames
                .filter((name) => !this.clients.has(name) && config.servers[name])
                .map((name) => [name, config.servers[name]])
        );

        if (Object.keys(serversToStart).length === 0) {
            return;
        }

        await this.startServers({
            enabled: config.enabled,
            servers: serversToStart,
        });

        const allServerNames = Object.keys(config.servers);
        if (allServerNames.every((name) => this.clients.has(name))) {
            this.pendingConfig = null;
            this.serversStarted = true;
        }

        await this.refreshToolCache();
    }

    async shutdown(): Promise<void> {
        const shutdownPromises: Promise<void>[] = [];

        for (const [name, entry] of this.clients) {
            shutdownPromises.push(this.shutdownServer(name, entry));
        }

        await Promise.all(shutdownPromises);
        this.clients.clear();
        this.cachedTools = {};
        this.pendingConfig = null;
        this.serversStarted = false;
        this.serverStartPromise = null;
        this.isInitialized = false;
    }

    private async shutdownServer(name: string, entry: MCPClientEntry): Promise<void> {
        try {
            // Official SDK: close() closes both client and transport
            await entry.client.close();

            trace.getActiveSpan()?.addEvent("mcp.server_shutdown", {
                "server.name": name,
            });
        } catch (error) {
            logger.error(`Error shutting down MCP server '${name}':`, formatAnyError(error));
        }
    }

    /**
     * Check if a server is running
     */
    isServerRunning(name: string): boolean {
        return this.clients.has(name);
    }

    /**
     * Get list of configured servers (running or pending lazy start).
     */
    getConfiguredServers(): string[] {
        const running = Array.from(this.clients.keys());
        if (this.pendingConfig) {
            const pending = Object.keys(this.pendingConfig.servers).filter(n => !this.clients.has(n));
            return [...running, ...pending];
        }
        return running;
    }

    /**
     * Start only the MCP servers matching the given slugs.
     * Servers already running are skipped; servers not in pending config are ignored.
     */
    async ensureServersForSlugs(slugs: string[]): Promise<void> {
        if (slugs.length === 0) return;

        const neededServers = new Set(slugs);

        while (this.pendingConfig) {
            const missingServers = Array.from(neededServers).filter((name) => !this.clients.has(name));
            if (missingServers.length === 0) {
                return;
            }

            if (this.serverStartPromise) {
                await this.serverStartPromise;
                continue;
            }

            this.serverStartPromise = this.startDeferredServersForTools(missingServers);
            try {
                await this.serverStartPromise;
            } finally {
                this.serverStartPromise = null;
            }
        }
    }

    /**
     * Get configuration for all MCP servers (running or pending).
     * Used to pass server configs to LLM providers with MCP support
     * that need to spawn their own instances of these servers.
     *
     * @returns Record of server name to server configuration
     */
    getServerConfigs(): Record<string, MCPServerConfig> {
        const configs: Record<string, MCPServerConfig> = {};
        if (this.pendingConfig) {
            Object.assign(configs, this.pendingConfig.servers);
        }
        for (const [name, entry] of this.clients) {
            configs[name] = entry.config;
        }
        return configs;
    }

    /**
     * Reload MCP service configuration and restart servers
     * @param metadataPath The project metadata path (~/.tenex/projects/{dTag})
     * @param workingDirectory The project working directory (~/tenex/{dTag})
     */
    async reload(metadataPath?: string, workingDirectory?: string): Promise<void> {
        trace.getActiveSpan()?.addEvent("mcp.reloading");

        // Shutdown existing servers
        await this.shutdown();

        // Re-initialize with the new configuration
        await this.initialize(
            metadataPath || this.metadataPath,
            workingDirectory || this.workingDirectory
        );

        trace.getActiveSpan()?.addEvent("mcp.reloaded", {
            "servers.running": this.getConfiguredServers().length,
            "tools.available": Object.keys(this.cachedTools).length,
        });
    }
}

// MCPManager is now per-project - create instances in ProjectRuntime
// No more singleton export
