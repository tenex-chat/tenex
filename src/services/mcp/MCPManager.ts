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
import { tool } from "ai";
import type { Tool as CoreTool } from "ai";
import { z } from "zod";

type MCPToolSet = Record<string, CoreTool<unknown, unknown>>;

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

    /**
     * Convert an MCP tool (JSON Schema) to an AI SDK tool (Zod)
     * Uses Zod's built-in fromJSONSchema converter
     */
    private convertMCPToolToAISdkTool(
        mcpTool: MCPTool,
        serverName: string,
        toolName: string
    ): CoreTool<unknown, unknown> {
        // Convert JSON Schema to Zod schema
        // The inputSchema from MCP is compatible with JSONSchema type
        const inputSchema = z.fromJSONSchema(mcpTool.inputSchema as any) as z.ZodTypeAny;

        const result = tool({
            description: mcpTool.description || `Tool ${toolName} from ${serverName}`,
            parameters: inputSchema,
            execute: async (args: any) => {
                const entry = this.clients.get(serverName);
                if (!entry) {
                    throw new Error(`MCP server '${serverName}' not found`);
                }

                try {
                    const callResult = await entry.client.callTool({
                        name: toolName,
                        arguments: args as Record<string, unknown>
                    });

                    // Extract text content from MCP CallToolResult
                    if (callResult.content && Array.isArray(callResult.content)) {
                        const textContent = callResult.content
                            .filter((c): c is { type: 'text'; text: string } =>
                                typeof c === 'object' && 'text' in c
                            )
                            .map(c => c.text)
                            .join('\n');
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

        return result as CoreTool<unknown, unknown>;
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

            if (mergedMCP.servers && Object.keys(mergedMCP.servers).length > 0) {
                await this.startServers(mergedMCP);
                await this.refreshToolCache();
            }
            this.isInitialized = true;

            trace.getActiveSpan()?.addEvent("mcp.initialized", {
                "servers.count": this.clients.size,
            });
        } catch (error) {
            logger.error("Failed to initialize MCP manager:", error);
            // Don't throw - allow the system to continue without MCP
        }
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
                    version: '1.0.0'
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
        await this.refreshToolCache();
    }

    /**
     * Get all cached MCP tools as an object keyed by tool name
     */
    getCachedTools(): MCPToolSet {
        return this.cachedTools;
    }

    async shutdown(): Promise<void> {
        const shutdownPromises: Promise<void>[] = [];

        for (const [name, entry] of this.clients) {
            shutdownPromises.push(this.shutdownServer(name, entry));
        }

        await Promise.all(shutdownPromises);
        this.clients.clear();
        this.cachedTools = {};
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
     * Get list of running servers
     */
    getRunningServers(): string[] {
        return Array.from(this.clients.keys());
    }

    /**
     * Get configuration for all running MCP servers.
     * Used to pass server configs to LLM providers (like Claude Code)
     * that need to spawn their own instances of these servers.
     *
     * @returns Record of server name to server configuration
     */
    getServerConfigs(): Record<string, MCPServerConfig> {
        const configs: Record<string, MCPServerConfig> = {};
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
            "servers.running": this.getRunningServers().length,
            "tools.available": Object.keys(this.cachedTools).length,
        });
    }

    /**
     * List resources from a specific MCP server
     * @param serverName - Name of the MCP server
     * @returns Array of resources from that server
     */
    async listResources(serverName: string): Promise<Resource[]> {
        const entry = this.clients.get(serverName);
        if (!entry) {
            const validServers = this.getRunningServers();
            const serverList =
                validServers.length > 0
                    ? `Valid servers: ${validServers.join(", ")}`
                    : "No MCP servers are currently running";
            throw new Error(`MCP server '${serverName}' not found. ${serverList}`);
        }

        try {
            const result = await entry.client.listResources();
            return result.resources;
        } catch (error) {
            logger.error(`Failed to list resources from '${serverName}':`, formatAnyError(error));
            throw error;
        }
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
        const entry = this.clients.get(serverName);
        if (!entry) {
            const validServers = this.getRunningServers();
            const serverList =
                validServers.length > 0
                    ? `Valid servers: ${validServers.join(", ")}`
                    : "No MCP servers are currently running";
            throw new Error(`MCP server '${serverName}' not found. ${serverList}`);
        }

        try {
            const result = await entry.client.listResourceTemplates();
            return result.resourceTemplates;
        } catch (error) {
            logger.error(
                `Failed to list resource templates from '${serverName}':`,
                formatAnyError(error)
            );
            throw error;
        }
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
        const entry = this.clients.get(serverName);
        if (!entry) {
            const validServers = this.getRunningServers();
            const serverList =
                validServers.length > 0
                    ? `Valid servers: ${validServers.join(", ")}`
                    : "No MCP servers are currently running";
            throw new Error(`MCP server '${serverName}' not found. ${serverList}`);
        }

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
        const entry = this.clients.get(serverName);
        if (!entry) {
            const validServers = this.getRunningServers();
            const serverList =
                validServers.length > 0
                    ? `Valid servers: ${validServers.join(", ")}`
                    : "No MCP servers are currently running";
            throw new Error(`MCP server '${serverName}' not found. ${serverList}`);
        }

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
        const entry = this.clients.get(serverName);
        if (!entry) {
            const validServers = this.getRunningServers();
            const serverList =
                validServers.length > 0
                    ? `Valid servers: ${validServers.join(", ")}`
                    : "No MCP servers are currently running";
            throw new Error(`MCP server '${serverName}' not found. ${serverList}`);
        }

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
     * Register a handler for resource update notifications
     * Must be called BEFORE subscribeToResource
     */
    onResourceNotification(
        serverName: string,
        handler: (notification: { uri: string }) => void | Promise<void>
    ): void {
        const entry = this.clients.get(serverName);
        if (!entry) {
            throw new Error(`MCP server '${serverName}' not found`);
        }

        // Register notification handler with the MCP client
        entry.client.setNotificationHandler(
            ResourceUpdatedNotificationSchema,
            async (notification) => {
                // Extract URI from notification params
                const uri = notification.params.uri;
                if (uri) {
                    await handler({ uri });
                }
            }
        );

        trace.getActiveSpan()?.addEvent("mcp.resource_handler_registered", {
            "server.name": serverName,
        });
    }
}

// MCPManager is now per-project - create instances in ProjectRuntime
// No more singleton export
