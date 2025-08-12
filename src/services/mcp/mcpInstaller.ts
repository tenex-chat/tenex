import { configService } from "@/services/ConfigService";
import type { MCPServerConfig, TenexMCP } from "@/services/config/types";
import { logger } from "@/utils/logger";
import type { NDKMCPTool } from "@/events/NDKMCPTool";

/**
 * Installs an MCP server from an NDKMCPTool event into a project's configuration
 * @param projectPath The root project path (not the .tenex directory)
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

    // Build server config with event ID
    const serverConfig: MCPServerConfig = {
        command: cmd!,
        args,
        description: mcpTool.description,
        eventId: mcpTool.id, // Track the event ID
    };

    // Load existing MCP config from the project's .tenex directory
    const tenexPath = configService.getProjectPath(projectPath);
    const mcpConfig = await configService.loadTenexMCP(tenexPath);

    // Check if this event ID is already installed (only if we have an event ID)
    if (mcpTool.id && await isMCPToolInstalled(projectPath, mcpTool.id)) {
        logger.info(`MCP tool with event ID ${mcpTool.id} already installed`, { projectPath });
        return;
    }

    // Check if server with same name already exists
    if (mcpConfig.servers[serverName]) {
        // If it exists without an event ID and we're adding one with an event ID, update it
        if (!mcpConfig.servers[serverName].eventId && mcpTool.id) {
            logger.info(`Updating existing MCP server '${serverName}' with event ID`, { 
                projectPath, 
                eventId: mcpTool.id 
            });
        } else {
            logger.info(`MCP server '${serverName}' already exists`, { projectPath });
            return;
        }
    }

    // Add new server
    mcpConfig.servers[serverName] = serverConfig;

    // Save config (saveProjectMCP expects the project root path)
    await configService.saveProjectMCP(projectPath, mcpConfig);

    logger.info(`Auto-installed MCP server: ${serverName}`, {
        projectPath,
        command: cmd,
        args,
        eventId: mcpTool.id,
    });
}

/**
 * Checks if an MCP tool with a given event ID is already installed
 */
export async function isMCPToolInstalled(
    projectPath: string,
    eventId: string
): Promise<boolean> {
    // Load from the project's .tenex directory
    const tenexPath = configService.getProjectPath(projectPath);
    const mcpConfig = await configService.loadTenexMCP(tenexPath);
    
    // Check if any server has this event ID
    for (const serverConfig of Object.values(mcpConfig.servers)) {
        if (serverConfig.eventId === eventId) {
            return true;
        }
    }
    
    return false;
}

/**
 * Gets all installed MCP tool event IDs (only those that have event IDs)
 */
export async function getInstalledMCPEventIds(projectPath: string): Promise<Set<string>> {
    // Load from the project's .tenex directory
    const tenexPath = configService.getProjectPath(projectPath);
    const mcpConfig = await configService.loadTenexMCP(tenexPath);
    const eventIds = new Set<string>();
    
    for (const serverConfig of Object.values(mcpConfig.servers)) {
        // Only add if eventId exists (some MCP tools are manually installed without event IDs)
        if (serverConfig.eventId) {
            eventIds.add(serverConfig.eventId);
        }
    }
    
    return eventIds;
}

/**
 * Removes an MCP server by its event ID
 */
export async function removeMCPServerByEventId(
    projectPath: string,
    eventId: string
): Promise<void> {
    // Load from the project's .tenex directory
    const tenexPath = configService.getProjectPath(projectPath);
    const mcpConfig = await configService.loadTenexMCP(tenexPath);
    
    // Find and remove servers with this event ID
    let removed = false;
    for (const [serverName, serverConfig] of Object.entries(mcpConfig.servers)) {
        if (serverConfig.eventId === eventId) {
            delete mcpConfig.servers[serverName];
            removed = true;
            logger.info(`Removed MCP server '${serverName}' with event ID ${eventId}`);
        }
    }
    
    if (removed) {
        // Save updated config
        await configService.saveProjectMCP(projectPath, mcpConfig);
    } else {
        logger.warn(`No MCP server found with event ID ${eventId}`);
    }
}
