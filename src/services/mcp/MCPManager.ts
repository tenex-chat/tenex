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
import type {
    Tool as MCPTool,
    ReadResourceResult,
    Resource,
    ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { jsonSchema, tool } from "ai";
import type { Tool as CoreTool } from "ai";

type MCPToolSet = Record<string, CoreTool<Record<string, unknown>, string>>;

interface CachedListEntry<T> {
    value: T[];
    expiresAt: number;
}

export interface MCPListOptions {
    timeoutMs?: number;
    preferCache?: boolean;
    allowStale?: boolean;
}

const MCP_METADATA_CACHE_TTL_MS = 30_000;

interface MCPClientEntry {
    client: Client;
    transport: StdioClientTransport;
    serverName: string;
    config: MCPServerConfig;
}

type ResourceNotificationHandler = (notification: { uri: string }) => void | Promise<void>;

export class MCPManager {
    private clients: Map<string, MCPClientEntry> = new Map();
    private isInitialized = false;
    private metadataPath?: string;
    private workingDirectory?: string;
    private cachedTools: MCPToolSet = {};
    private resourceListCache = new Map<string, CachedListEntry<Resource>>();
    private resourceTemplateCache = new Map<string, CachedListEntry<ResourceTemplate>>();
    private resourceListInFlight = new Map<string, Promise<Resource[]>>();
    private resourceTemplateInFlight = new Map<string, Promise<ResourceTemplate[]>>();
    /** Per-server list of notification handlers (dispatcher pattern to avoid clobbering) */
    private resourceNotificationHandlers: Map<string, ResourceNotificationHandler[]> = new Map();

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
        this.resourceListCache.clear();
        this.resourceTemplateCache.clear();
        this.resourceListInFlight.clear();
        this.resourceTemplateInFlight.clear();
        // Clear notification handlers so reload() re-registers them on new clients
        this.resourceNotificationHandlers.clear();
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

    /**
     * List resources from a specific MCP server
     * @param serverName - Name of the MCP server
     * @returns Array of resources from that server
     */
    async listResources(serverName: string): Promise<Resource[]> {
        return this.listResourcesWithOptions(serverName);
    }

    /**
     * List all resources from all connected MCP servers
     * @returns Map of server names to their resources
     */
    async listAllResources(): Promise<Map<string, Resource[]>> {
        const resourcesMap = new Map<string, Resource[]>();

        for (const [serverName] of this.clients) {
            try {
                const resources = await this.listResources(serverName);
                resourcesMap.set(serverName, resources);
            } catch (error) {
                logger.error(
                    `Failed to list resources from '${serverName}':`,
                    formatAnyError(error)
                );
                // Continue with other servers
            }
        }

        return resourcesMap;
    }

    /**
     * List resource templates from a specific MCP server
     * @param serverName - Name of the MCP server
     * @returns Array of resource templates from that server
     */
    async listResourceTemplates(serverName: string): Promise<ResourceTemplate[]> {
        return this.listResourceTemplatesWithOptions(serverName);
    }

    async listResourcesWithOptions(
        serverName: string,
        options: MCPListOptions = {}
    ): Promise<Resource[]> {
        await this.ensureServersStarted();
        return this.fetchCachedMetadata<Resource>(
            serverName,
            this.resourceListCache,
            this.resourceListInFlight,
            async (entry) => {
                const result = await entry.client.listResources();
                return result.resources;
            },
            "resources",
            options
        );
    }

    async listResourceTemplatesWithOptions(
        serverName: string,
        options: MCPListOptions = {}
    ): Promise<ResourceTemplate[]> {
        await this.ensureServersStarted();
        return this.fetchCachedMetadata<ResourceTemplate>(
            serverName,
            this.resourceTemplateCache,
            this.resourceTemplateInFlight,
            async (entry) => {
                const result = await entry.client.listResourceTemplates();
                return result.resourceTemplates;
            },
            "resource_templates",
            options
        );
    }

    /**
     * List all resource templates from all connected MCP servers
     * @returns Map of server names to their resource templates
     */
    async listAllResourceTemplates(): Promise<Map<string, ResourceTemplate[]>> {
        const templatesMap = new Map<string, ResourceTemplate[]>();

        for (const [serverName] of this.clients) {
            try {
                const templates = await this.listResourceTemplates(serverName);
                templatesMap.set(serverName, templates);
            } catch (error) {
                logger.error(
                    `Failed to list resource templates from '${serverName}':`,
                    formatAnyError(error)
                );
                // Continue with other servers
            }
        }

        return templatesMap;
    }

    /**
     * Read a resource from a specific MCP server
     * @param serverName - Name of the MCP server
     * @param uri - URI of the resource to read
     * @returns Resource content
     */
    async readResource(
        serverName: string,
        uri: string
    ): Promise<ReadResourceResult> {
        await this.ensureServersStarted();
        const entry = this.getClientEntry(serverName);

        try {
            return await entry.client.readResource({ uri });
        } catch (error) {
            logger.error(
                `Failed to read resource '${uri}' from '${serverName}':`,
                formatAnyError(error)
            );
            throw error;
        }
    }

    /**
     * Get resource context as a formatted string for RAG pattern
     * @param serverName - Name of the MCP server
     * @param resourceUris - Array of resource URIs to fetch
     * @returns Formatted context string
     */
    async getResourceContext(serverName: string, resourceUris: string[]): Promise<string> {
        const contents: string[] = [];

        for (const uri of resourceUris) {
            try {
                const result = await this.readResource(serverName, uri);

                for (const content of result.contents) {
                    if ("text" in content) {
                        contents.push(`Resource: ${uri}\n${content.text}`);
                    } else if ("blob" in content) {
                        contents.push(
                            `Resource: ${uri}\n[Binary content: ${content.blob.length} bytes]`
                        );
                    }
                }
            } catch (error) {
                logger.error(`Failed to read resource '${uri}':`, formatAnyError(error));
                // Continue with other resources
            }
        }

        return contents.join("\n\n---\n\n");
    }

    /**
     * Subscribe to resource updates from an MCP server
     * @param serverName - Name of the MCP server
     * @param resourceUri - URI of the resource to subscribe to
     */
    async subscribeToResource(serverName: string, resourceUri: string): Promise<void> {
        const entry = this.getClientEntry(serverName);

        try {
            // Official SDK method - properly supported
            await entry.client.subscribeResource({ uri: resourceUri });

            trace.getActiveSpan()?.addEvent("mcp.resource_subscribed", {
                "server.name": serverName,
                "resource.uri": resourceUri,
            });
        } catch (error) {
            logger.error(
                `Failed to subscribe to resource '${resourceUri}' from '${serverName}':`,
                formatAnyError(error)
            );
            throw error;
        }
    }

    /**
     * Unsubscribe from resource updates
     * @param serverName - Name of the MCP server
     * @param resourceUri - URI of the resource to unsubscribe from
     */
    async unsubscribeFromResource(serverName: string, resourceUri: string): Promise<void> {
        const entry = this.getClientEntry(serverName);

        try {
            // Official SDK method - properly supported
            await entry.client.unsubscribeResource({ uri: resourceUri });

            trace.getActiveSpan()?.addEvent("mcp.resource_unsubscribed", {
                "server.name": serverName,
                "resource.uri": resourceUri,
            });
        } catch (error) {
            logger.error(
                `Failed to unsubscribe from resource '${resourceUri}' from '${serverName}':`,
                formatAnyError(error)
            );
            throw error;
        }
    }

    /**
     * Add a handler for resource update notifications on a server.
     * Multiple handlers can be registered per server (dispatcher pattern).
     * Must be called BEFORE subscribeToResource.
     *
     * @returns A removal function to unregister this specific handler
     */
    addResourceNotificationHandler(
        serverName: string,
        handler: ResourceNotificationHandler
    ): () => void {
        const entry = this.clients.get(serverName);
        if (!entry) {
            throw new Error(`MCP server '${serverName}' not found`);
        }

        // Initialize handler list for this server if needed
        if (!this.resourceNotificationHandlers.has(serverName)) {
            this.resourceNotificationHandlers.set(serverName, []);

            // Register the SDK-level notification handler ONCE per server.
            // This dispatcher fans out to all registered handlers.
            entry.client.setNotificationHandler(
                ResourceUpdatedNotificationSchema,
                async (notification) => {
                    const uri = notification.params.uri;
                    if (!uri) return;

                    const handlers = this.resourceNotificationHandlers.get(serverName) ?? [];
                    for (const h of handlers) {
                        try {
                            await h({ uri });
                        } catch (error) {
                            logger.error("Resource notification handler error", {
                                server: serverName,
                                uri,
                                error: error instanceof Error ? error.message : String(error),
                            });
                        }
                    }
                }
            );
        }

        const handlers = this.resourceNotificationHandlers.get(serverName);
        if (!handlers) throw new Error(`Resource notification handlers missing for server '${serverName}'`);
        handlers.push(handler);

        trace.getActiveSpan()?.addEvent("mcp.resource_handler_registered", {
            "server.name": serverName,
            "handlers.count": handlers.length,
        });

        // Return removal function
        return () => {
            const currentHandlers = this.resourceNotificationHandlers.get(serverName);
            if (currentHandlers) {
                const index = currentHandlers.indexOf(handler);
                if (index !== -1) {
                    currentHandlers.splice(index, 1);
                }
            }
        };
    }

    private getClientEntry(serverName: string): MCPClientEntry {
        const entry = this.clients.get(serverName);
        if (!entry) {
            const validServers = this.getConfiguredServers();
            const serverList =
                validServers.length > 0
                    ? `Valid servers: ${validServers.join(", ")}`
                    : "No MCP servers are currently running";
            throw new Error(`MCP server '${serverName}' not found. ${serverList}`);
        }

        return entry;
    }

    private getCachedListValue<T>(
        cache: Map<string, CachedListEntry<T>>,
        serverName: string,
        allowStale = false
    ): T[] | undefined {
        const cached = cache.get(serverName);
        if (!cached) {
            return undefined;
        }

        if (allowStale || cached.expiresAt > Date.now()) {
            return cached.value;
        }

        return undefined;
    }

    private setCachedListValue<T>(
        cache: Map<string, CachedListEntry<T>>,
        serverName: string,
        value: T[]
    ): void {
        cache.set(serverName, {
            value,
            expiresAt: Date.now() + MCP_METADATA_CACHE_TTL_MS,
        });
    }

    private async withOptionalTimeout<T>(
        operation: Promise<T>,
        timeoutMs?: number
    ): Promise<T> {
        if (!timeoutMs || timeoutMs <= 0) {
            return await operation;
        }

        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<T>((_, reject) => {
            timeoutHandle = setTimeout(
                () => reject(new Error(`Request timed out after ${timeoutMs}ms`)),
                timeoutMs
            );
        });

        try {
            return await Promise.race([operation, timeoutPromise]);
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    private async fetchCachedMetadata<T>(
        serverName: string,
        cache: Map<string, CachedListEntry<T>>,
        inFlight: Map<string, Promise<T[]>>,
        fetcher: (entry: MCPClientEntry) => Promise<T[]>,
        metadataKind: "resources" | "resource_templates",
        options: MCPListOptions = {}
    ): Promise<T[]> {
        const { timeoutMs, preferCache = false, allowStale = false } = options;
        const cachedValue = preferCache
            ? this.getCachedListValue(cache, serverName)
            : undefined;
        if (cachedValue) {
            this.addMetadataTelemetryEvent("mcp.metadata_cache_hit", {
                "server.name": serverName,
                "mcp.metadata.kind": metadataKind,
                "mcp.cache.prefer": preferCache,
                "mcp.cache.allow_stale": allowStale,
                "mcp.fetch.source": "cache",
                "mcp.result.count": cachedValue.length,
                ...(timeoutMs ? { "mcp.timeout_ms": timeoutMs } : {}),
            });
            return cachedValue;
        }

        const existingInFlight = inFlight.get(serverName);
        const requestPromise = existingInFlight ?? (async () => {
            const entry = this.getClientEntry(serverName);
            this.addMetadataTelemetryEvent("mcp.metadata_fetch_started", {
                "server.name": serverName,
                "mcp.metadata.kind": metadataKind,
                "mcp.cache.prefer": preferCache,
                "mcp.cache.allow_stale": allowStale,
                "mcp.fetch.source": "network",
                ...(timeoutMs ? { "mcp.timeout_ms": timeoutMs } : {}),
            });

            try {
                const value = await fetcher(entry);
                this.setCachedListValue(cache, serverName, value);
                this.addMetadataTelemetryEvent("mcp.metadata_fetch_succeeded", {
                    "server.name": serverName,
                    "mcp.metadata.kind": metadataKind,
                    "mcp.cache.prefer": preferCache,
                    "mcp.cache.allow_stale": allowStale,
                    "mcp.fetch.source": "network",
                    "mcp.result.count": value.length,
                    ...(timeoutMs ? { "mcp.timeout_ms": timeoutMs } : {}),
                });
                return value;
            } catch (error) {
                this.addMetadataTelemetryEvent("mcp.metadata_fetch_failed", {
                    "server.name": serverName,
                    "mcp.metadata.kind": metadataKind,
                    "mcp.cache.prefer": preferCache,
                    "mcp.cache.allow_stale": allowStale,
                    "mcp.fetch.source": "network",
                    "mcp.error": formatAnyError(error),
                    ...(timeoutMs ? { "mcp.timeout_ms": timeoutMs } : {}),
                });
                logger.error(
                    `Failed to list ${metadataKind} from '${serverName}':`,
                    formatAnyError(error)
                );
                throw error;
            } finally {
                inFlight.delete(serverName);
            }
        })();

        if (!existingInFlight) {
            inFlight.set(serverName, requestPromise);
        }

        try {
            return await this.withOptionalTimeout(requestPromise, timeoutMs);
        } catch (error) {
            const formattedError = formatAnyError(error);
            if (formattedError.includes("Request timed out after")) {
                this.addMetadataTelemetryEvent("mcp.metadata_fetch_failed", {
                    "server.name": serverName,
                    "mcp.metadata.kind": metadataKind,
                    "mcp.cache.prefer": preferCache,
                    "mcp.cache.allow_stale": allowStale,
                    "mcp.fetch.source": "network",
                    "mcp.error": formattedError,
                    ...(timeoutMs ? { "mcp.timeout_ms": timeoutMs } : {}),
                });
            }

            const staleValue = this.getCachedListValue(cache, serverName, allowStale);
            if (staleValue) {
                this.addMetadataTelemetryEvent("mcp.metadata_stale_cache_fallback", {
                    "server.name": serverName,
                    "mcp.metadata.kind": metadataKind,
                    "mcp.cache.prefer": preferCache,
                    "mcp.cache.allow_stale": allowStale,
                    "mcp.fetch.source": "stale_cache_fallback",
                    "mcp.result.count": staleValue.length,
                    "mcp.error": formattedError,
                    ...(timeoutMs ? { "mcp.timeout_ms": timeoutMs } : {}),
                });
                logger.warn(
                    `Using stale cached ${metadataKind} for MCP server '${serverName}' after fetch failure`,
                    {
                        error: formattedError,
                        timeoutMs,
                    }
                );
                return staleValue;
            }

            throw error;
        }
    }

    private addMetadataTelemetryEvent(
        eventName: string,
        attributes: Record<string, string | number | boolean>
    ): void {
        trace.getActiveSpan()?.addEvent(eventName, attributes);
    }
}

// MCPManager is now per-project - create instances in ProjectRuntime
// No more singleton export
