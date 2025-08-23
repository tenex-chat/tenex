import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import { configService } from "@/services/ConfigService";
import type { MCPServerConfig, TenexMCP } from "@/services/config/types";
import type { Tool } from "@/tools/types";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { adaptMCPTool, type MCPTool as MCPToolInterface, type MCPPropertyDefinition } from "./MCPToolAdapter";

interface MCPClient {
  client: Client;
  process?: ChildProcess;
  serverName: string;
  config: MCPServerConfig;
}

// Define Zod schemas for MCP responses
const MCPToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z
    .object({
      properties: z.record(z.unknown()).optional(),
      required: z.array(z.string()).optional(),
    })
    .optional(),
});

const MCPToolsListResponseSchema = z.object({
  tools: z.array(MCPToolSchema),
});


const MCPContentSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});

const MCPToolExecuteResponseSchema = z.object({
  content: z.array(MCPContentSchema).optional(),
});

type MCPContent = z.infer<typeof MCPContentSchema>;

interface StdioTransportWithProcess extends StdioClientTransport {
  process?: ChildProcess;
  subprocess?: ChildProcess;
}

export class MCPService {
  private static instance: MCPService;
  private clients: Map<string, MCPClient> = new Map();
  private isInitialized = false;
  private cachedTools: Tool[] = [];
  private projectPath?: string;

  private constructor() {}

  static getInstance(): MCPService {
    if (!MCPService.instance) {
      MCPService.instance = new MCPService();
    }
    return MCPService.instance;
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

      await this.startServers(config.mcp);
      await this.refreshToolCache();
      this.isInitialized = true;
    } catch (error) {
      logger.error("Failed to initialize MCP service:", error);
      // Don't throw - allow the system to continue without MCP
    }
  }

  private async startServers(mcpConfig: TenexMCP): Promise<void> {
    const startPromises = Object.entries(mcpConfig.servers).map(([name, config]) =>
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
      const isAllowed = config.allowedPaths.some((allowedPath) => {
        const resolvedAllowedPath = path.resolve(allowedPath);
        return (
          resolvedProjectPath.startsWith(resolvedAllowedPath) ||
          resolvedAllowedPath.startsWith(resolvedProjectPath)
        );
      });

      if (!isAllowed) {
        logger.warn(
          `Skipping MCP server '${name}' due to path restrictions. Project path '${this.projectPath}' is not in allowedPaths: ${config.allowedPaths.join(", ")}`
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

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: mergedEnv,
    });

    const client = new Client(
      {
        name: `tenex-${name}`,
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    try {
      await client.connect(transport);
    } catch (error) {
      logger.error(`Failed to connect to MCP server '${name}':`, error);
      throw error;
    }

    // Perform health check
    try {
      await Promise.race([
        client.request({ method: "tools/list" }, MCPToolsListResponseSchema),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Health check timeout")), 5000)
        ),
      ]);
    } catch (error) {
      logger.error(`MCP server '${name}' failed health check:`, error);
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
      return;
    }

    // Store the client with the transport's subprocess
    const transportWithProcess = transport as StdioTransportWithProcess;
    this.clients.set(name, {
      client,
      process: transportWithProcess.process || transportWithProcess.subprocess,
      serverName: name,
      config,
    });

    logger.info(`Started MCP server '${name}'`);

    // Refresh tool cache when a new server is started
    await this.refreshToolCache();
  }

  private async refreshToolCache(): Promise<void> {
    this.cachedTools = await this.fetchAvailableTools();
  }

  // Synchronous method to get cached tools
  getCachedTools(): Tool[] {
    return this.cachedTools;
  }

  private async fetchAvailableTools(): Promise<Tool[]> {
    const tools: Tool[] = [];

    for (const [serverName, mcpClient] of this.clients) {
      try {
        const result = await mcpClient.client.request(
          { method: "tools/list" },
          MCPToolsListResponseSchema
        );

        if (result && "tools" in result && Array.isArray(result.tools)) {
          for (const mcpTool of result.tools) {
            tools.push(this.convertMCPToolToTenexTool(serverName, mcpTool));
          }
        }
      } catch (error) {
        logger.error(`Failed to get tools from MCP server '${serverName}':`, error);
      }
    }

    return tools;
  }

  private convertMCPToolToTenexTool(serverName: string, mcpTool: any): Tool {
    // Use the adapter to create a type-safe tool with Zod schemas
    // Cast mcpTool to MCPTool interface for the adapter
    const typedTool: MCPToolInterface = {
      name: mcpTool.name,
      description: mcpTool.description,
      inputSchema: mcpTool.inputSchema ? {
        properties: mcpTool.inputSchema.properties as Record<string, MCPPropertyDefinition>,
        required: mcpTool.inputSchema.required
      } : undefined
    };
    return adaptMCPTool(typedTool, serverName, (args) =>
      this.executeTool(serverName, mcpTool.name, args)
    ) as Tool;
  }

  async executeTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const mcpClient = this.clients.get(serverName);
    if (!mcpClient) {
      throw new Error(`MCP server '${serverName}' not found`);
    }

    if (!this.isServerRunning(serverName)) {
      throw new Error(`MCP server '${serverName}' is not running`);
    }

    try {
      const result = await mcpClient.client.request(
        {
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
        },
        MCPToolExecuteResponseSchema
      );

      // Extract text content from the response
      if (result?.content && Array.isArray(result.content)) {
        const textContent = result.content
          .filter((item: MCPContent) => item.type === "text")
          .map((item: MCPContent) => item.text || "")
          .join("");
        return textContent;
      }

      return result;
    } catch (error) {
      logger.error(
        `Failed to execute tool '${toolName}' on server '${serverName}':`,
        formatAnyError(error)
      );
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    const shutdownPromises: Promise<void>[] = [];

    for (const [name, mcpClient] of this.clients) {
      shutdownPromises.push(this.shutdownServer(name, mcpClient));
    }

    await Promise.all(shutdownPromises);
    this.clients.clear();
    this.isInitialized = false;
  }

  private async shutdownServer(name: string, mcpClient: MCPClient): Promise<void> {
    try {
      // Close the client connection
      await mcpClient.client.close();

      // Kill the process if it exists
      if (mcpClient.process) {
        mcpClient.process.kill("SIGTERM");

        // Give it some time to shut down gracefully
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            if (mcpClient.process) {
              mcpClient.process.kill("SIGKILL");
            }
            resolve(undefined);
          }, 5000);

          mcpClient.process?.once("exit", () => {
            clearTimeout(timeout);
            resolve(undefined);
          });
        });
      }

      logger.info(`Shut down MCP server '${name}'`);
    } catch (error) {
      logger.error(`Error shutting down MCP server '${name}':`, formatAnyError(error));
      // Force kill if graceful shutdown fails
      try {
        if (mcpClient.process) {
          mcpClient.process.kill("SIGKILL");
        }
      } catch {
        // Process already terminated, ignore error
      }
    }
  }

  // Check if a server is running
  isServerRunning(name: string): boolean {
    const mcpClient = this.clients.get(name);
    return mcpClient ? !mcpClient.process?.killed : false;
  }

  // Get list of running servers
  getRunningServers(): string[] {
    return Array.from(this.clients.keys()).filter((name) => this.isServerRunning(name));
  }

  /**
   * Reload MCP service configuration and restart servers
   * This is called when MCP tools are added/removed dynamically
   */
  async reload(projectPath?: string): Promise<void> {
    logger.info("Reloading MCP service configuration");

    // Shutdown existing servers
    await this.shutdown();

    // Re-initialize with the new configuration
    await this.initialize(projectPath || this.projectPath);

    logger.info("MCP service reloaded successfully", {
      runningServers: this.getRunningServers(),
      availableTools: this.cachedTools.length,
    });
  }
}

export const mcpService = MCPService.getInstance();
