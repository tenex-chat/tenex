/**
 * MCPManager - AI SDK Native MCP Integration
 *
 * Uses AI SDK's experimental MCP client for cleaner, more maintainable integration
 */

import * as path from "node:path";
import { configService } from "@/services/ConfigService";
import type { MCPServerConfig, TenexMCP } from "@/services/config/types";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import {
    type experimental_MCPClient,
    type experimental_MCPReadResourceResult,
    type experimental_MCPResource,
    type experimental_MCPResourceTemplate,
    experimental_createMCPClient,
} from "ai";
import type { CoreTool } from "ai";
import { Experimental_StdioMCPTransport } from "ai/mcp-stdio";

interface MCPClientEntry {
    client: experimental_MCPClient;
    transport: Experimental_StdioMCPTransport;
    serverName: string;
    config: MCPServerConfig;
}

export class MCPManager {
    private static instance: MCPManager;
    private clients: Map<string, MCPClientEntry> = new Map();
    private isInitialized = false;
    private projectPath?: string;
    private cachedTools: Record<string, CoreTool<unknown, unknown>> = {};
    private includeResourcesInTools = false;

    private constructor() {}

    static getInstance(): MCPManager {
        if (!MCPManager.instance) {
            MCPManager.instance = new MCPManager();
        }
        return MCPManager.instance;
    }

    async initialize(projectPath?: string): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        try {
            this.projectPath = projectPath;
            const config = await configService.loadConfig(projectPath);

            if (!config.mcp || !config.mcp.enabled) {
                logger.info("MCP is disabled");
                return;
            }

            // Enable resources as tools globally
            this.includeResourcesInTools = true;

            await this.startServers(config.mcp);
            await this.refreshToolCache();
            this.isInitialized = true;

            logger.info("MCP manager initialized with resources as tools enabled");
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
                    logger.error(`Failed to start MCP server '${name}':`, error);
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
        if (config.allowedPaths && config.allowedPaths.length > 0 && this.projectPath) {
            const resolvedProjectPath = path.resolve(this.projectPath);
            // Filter out undefined/null values from allowedPaths
            const validAllowedPaths = config.allowedPaths.filter(
                (p): p is string => typeof p === "string" && p.length > 0
            );
            const isAllowed = validAllowedPaths.some((allowedPath) => {
                const resolvedAllowedPath = path.resolve(allowedPath);
                return (
                    resolvedProjectPath.startsWith(resolvedAllowedPath) ||
                    resolvedAllowedPath.startsWith(resolvedProjectPath)
                );
            });

            if (!isAllowed) {
                logger.warn(
                    `Skipping MCP server '${name}' due to path restrictions. Project path '${this.projectPath}' is not in allowedPaths: ${validAllowedPaths.join(", ")}`
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

        logger.debug(
            `Starting MCP server '${name}' with command: ${config.command} ${config.args.join(" ")}`
        );

        const transport = new Experimental_StdioMCPTransport({
            command: config.command,
            args: config.args,
            env: mergedEnv,
            cwd: this.projectPath,
        });

        try {
            const client = await experimental_createMCPClient({
                transport,
                name: `tenex-${name}`,
                version: "1.0.0",
            });

            // Perform health check - try to get tools
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Health check timeout")), 5000)
            );

            try {
                await Promise.race([client.tools(), timeoutPromise]);
            } catch (error) {
                logger.error(`MCP server '${name}' failed health check:`, error);
                await transport.close();
                return;
            }

            this.clients.set(name, {
                client,
                transport,
                serverName: name,
                config,
            });

            logger.info(`Started MCP server '${name}'`);
        } catch (error) {
            logger.error(`Failed to create MCP client for '${name}':`, formatAnyError(error));
            try {
                await transport.close();
            } catch {
                // Ignore close errors
            }
        }
    }

    private async refreshToolCache(): Promise<void> {
        const tools: Record<string, CoreTool<unknown, unknown>> = {};

        for (const [serverName, entry] of this.clients) {
            try {
                const serverTools = await entry.client.tools({
                    includeResources: this.includeResourcesInTools,
                });

                // Namespace the tools with server name
                for (const [toolName, tool] of Object.entries(serverTools)) {
                    const namespacedName = `mcp__${serverName}__${toolName}`;

                    // The tools from experimental_MCPClient are already CoreTool instances
                    // We just need to ensure they have the correct structure
                    // CoreTool should have: description, parameters (as zod schema), and execute function

                    // Store the tool directly - it's already a proper CoreTool
                    tools[namespacedName] = tool;

                    // Log the tool structure for debugging
                    logger.debug(`MCP tool '${namespacedName}' registered`, {
                        hasDescription: !!tool.description,
                        hasInputSchema: !!tool.inputSchema,
                        hasExecute: typeof tool.execute === "function",
                        inputSchemaType: tool.inputSchema ? typeof tool.inputSchema : "undefined",
                        isResourceTool: toolName.startsWith("resource_"),
                    });
                }

                logger.debug(
                    `Discovered ${Object.keys(serverTools).length} tools from MCP server '${serverName}'`
                );
            } catch (error) {
                logger.error(
                    `Failed to get tools from MCP server '${serverName}':`,
                    formatAnyError(error)
                );
            }
        }

        this.cachedTools = tools;
        logger.info(
            `Cached ${Object.keys(tools).length} MCP tools from ${this.clients.size} servers`
        );
    }

    /**
     * Set whether to include MCP resources as tools
     * @param include - Whether to include resources as tools
     */
    setIncludeResourcesInTools(include: boolean): void {
        this.includeResourcesInTools = include;
    }

    /**
     * Refresh the tool cache with current includeResources setting
     */
    async refreshTools(): Promise<void> {
        await this.refreshToolCache();
    }

    /**
     * Get all cached MCP tools as an object keyed by tool name
     */
    getCachedTools(): Record<string, CoreTool<unknown, unknown>> {
        return this.cachedTools;
    }

    /**
     * Get tools for a specific agent based on their configuration
     * @param requestedTools - Array of tool names the agent wants
     * @param mcpEnabled - Whether the agent has MCP access
     */
    async getToolsForAgent(
        requestedTools: string[],
        mcpEnabled = true
    ): Promise<Record<string, CoreTool<unknown, unknown>>> {
        const tools: Record<string, CoreTool<unknown, unknown>> = {};

        if (!mcpEnabled) {
            return tools;
        }

        // Filter requested MCP tools
        const requestedMcpTools = requestedTools.filter((name) => name.startsWith("mcp__"));

        if (requestedMcpTools.length > 0) {
            // Return only requested MCP tools
            for (const toolName of requestedMcpTools) {
                if (this.cachedTools[toolName]) {
                    tools[toolName] = this.cachedTools[toolName];
                } else {
                    logger.debug(`Requested MCP tool '${toolName}' not found`);
                }
            }
        } else if (mcpEnabled) {
            // Return all MCP tools if none specifically requested but MCP is enabled
            Object.assign(tools, this.cachedTools);
        }

        return tools;
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
            await entry.transport.close();
            logger.info(`Shut down MCP server '${name}'`);
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
     * Reload MCP service configuration and restart servers
     */
    async reload(projectPath?: string): Promise<void> {
        logger.info("Reloading MCP manager configuration");

        // Shutdown existing servers
        await this.shutdown();

        // Re-initialize with the new configuration
        await this.initialize(projectPath || this.projectPath);

        logger.info("MCP manager reloaded successfully", {
            runningServers: this.getRunningServers(),
            availableTools: Object.keys(this.cachedTools).length,
        });
    }

    /**
     * List resources from a specific MCP server
     * @param serverName - Name of the MCP server
     * @returns Array of resources from that server
     */
    async listResources(serverName: string): Promise<experimental_MCPResource[]> {
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
    async listAllResources(): Promise<Map<string, experimental_MCPResource[]>> {
        const resourcesMap = new Map<string, experimental_MCPResource[]>();

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
    async listResourceTemplates(serverName: string): Promise<experimental_MCPResourceTemplate[]> {
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
    async listAllResourceTemplates(): Promise<Map<string, experimental_MCPResourceTemplate[]>> {
        const templatesMap = new Map<string, experimental_MCPResourceTemplate[]>();

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
    ): Promise<experimental_MCPReadResourceResult> {
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
            return await entry.client.readResource(uri);
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
            throw new Error(`MCP server '${serverName}' not found or not running. ${serverList}`);
        }

        try {
            await entry.client.subscribeResource(resourceUri);
            logger.debug(`Subscribed to resource '${resourceUri}' from server '${serverName}'`);
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
            throw new Error(`MCP server '${serverName}' not found or not running. ${serverList}`);
        }

        try {
            await entry.client.unsubscribeResource(resourceUri);
            logger.debug(`Unsubscribed from resource '${resourceUri}' from server '${serverName}'`);
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
     * @param serverName - Name of the MCP server
     * @param handler - Callback to handle resource updates
     */
    onResourceNotification(
        serverName: string,
        handler: (notification: { uri: string }) => void | Promise<void>
    ): void {
        const entry = this.clients.get(serverName);
        if (!entry) {
            const validServers = this.getRunningServers();
            const serverList =
                validServers.length > 0
                    ? `Valid servers: ${validServers.join(", ")}`
                    : "No MCP servers are currently running";
            throw new Error(`MCP server '${serverName}' not found or not running. ${serverList}`);
        }

        entry.client.onResourceUpdated(handler);
        logger.debug(`Registered resource update handler for server '${serverName}'`);
    }
}

export const mcpManager = MCPManager.getInstance();
// Export as mcpService for compatibility with existing code
export const mcpService = mcpManager;
