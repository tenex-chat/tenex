import { configService } from "@/services/ConfigService";
import type { MCPServerConfig } from "@/services/config/types";
import { logger } from "@/utils/logger";
import type { NDKMCPTool } from "@/events/NDKMCPTool";

/**
 * Installs an MCP server from an NDKMCPTool event into a project's configuration
 */
export async function installMCPServerFromEvent(
    projectPath: string,
    mcpTool: NDKMCPTool
): Promise<void> {
    const serverName = mcpTool.slug;
    const command = mcpTool.command;

    if (!command) {
        throw new Error(`MCP tool event ${mcpTool.id} is missing command tag`);
    }

    // Parse command and args
    const [cmd, ...args] = command.split(" ");

    // Build server config
    const serverConfig: MCPServerConfig = {
        command: cmd,
        args,
        description: mcpTool.description,
    };

    // Load existing MCP config
    const mcpConfig = await configService.loadTenexMCP(projectPath);

    // Check if server already exists
    if (mcpConfig.servers[serverName]) {
        logger.info(`MCP server '${serverName}' already installed`, { projectPath });
        return;
    }

    // Add new server
    mcpConfig.servers[serverName] = serverConfig;

    // Save config
    await configService.saveProjectMCP(projectPath, mcpConfig);

    logger.info(`Auto-installed MCP server: ${serverName}`, {
        projectPath,
        command: cmd,
        args,
    });
}
