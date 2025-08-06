import { configService } from "@/services/ConfigService";
import type { MCPServerConfig } from "@/services/config/types";
import { logger } from "@/utils/logger";
import chalk from "chalk";
import { Command } from "commander";

interface ListOptions {
    project?: boolean;
    global?: boolean;
    all?: boolean;
}

export const listCommand = new Command("list")
    .description("List configured MCP servers")
    .option("--project", "Show only project servers")
    .option("--global", "Show only global servers")
    .option("--all", "Show all servers (default)")
    .action(async (options: ListOptions) => {
        try {
            const projectPath = process.cwd();
            const isProject = await configService.projectConfigExists(projectPath, "config.json");

            // Default to showing all servers
            const showAll = options.all || (!options.project && !options.global);
            const showProject = options.project || showAll;
            const showGlobal = options.global || showAll;

            // Validate options
            if (options.project && !isProject) {
                logger.error(
                    "Not in a TENEX project directory. Remove --project flag or run from a project."
                );
                process.exit(1);
            }

            // Load configurations
            const globalPath = configService.getGlobalPath();
            const globalMCP = await configService.loadTenexMCP(globalPath);
            const projectMCP = isProject
                ? await configService.loadTenexMCP(configService.getProjectPath(projectPath))
                : { servers: {}, enabled: true };

            // Check if any servers exist
            const hasGlobalServers = Object.keys(globalMCP.servers).length > 0;
            const hasProjectServers = Object.keys(projectMCP.servers).length > 0;

            if (!hasGlobalServers && !hasProjectServers) {
                logger.info("No MCP servers configured");
                process.exit(0);
            }

            logger.info(chalk.bold("Configured MCP Servers:"));
            logger.info(chalk.gray("─".repeat(60)));

            // Display global servers
            if (showGlobal && hasGlobalServers) {
                logger.info(chalk.yellow("\nGlobal servers:"));
                for (const [name, server] of Object.entries(globalMCP.servers)) {
                    const isOverridden = hasProjectServers && projectMCP.servers[name];
                    displayServer(name, server, !!isOverridden);
                }
            }

            // Display project servers
            if (showProject && isProject && hasProjectServers) {
                logger.info(chalk.blue("\nProject servers:"));

                // Categorize servers
                const projectOnlyServers: [string, MCPServerConfig][] = [];
                const overriddenServers: [string, MCPServerConfig][] = [];

                for (const [name, server] of Object.entries(projectMCP.servers)) {
                    if (globalMCP.servers[name]) {
                        overriddenServers.push([name, server]);
                    } else {
                        projectOnlyServers.push([name, server]);
                    }
                }

                // Show project-specific servers first
                for (const [name, server] of projectOnlyServers) {
                    displayServer(name, server);
                }

                // Show overridden servers
                if (overriddenServers.length > 0) {
                    logger.info(chalk.blue("\n  Overriding global servers:"));
                    for (const [name, server] of overriddenServers) {
                        displayServer(name, server, false, true);
                    }
                }
            }

            // Display status summary
            logger.info(chalk.gray("\n─".repeat(60)));

            // Load merged config to show final status
            const mergedConfig = await configService.loadConfig(
                isProject ? projectPath : undefined
            );
            logger.info(
                `MCP enabled: ${mergedConfig.mcp.enabled ? chalk.green("yes") : chalk.red("no")}`
            );
            logger.info(`Total active servers: ${Object.keys(mergedConfig.mcp.servers).length}`);

            process.exit(0);
        } catch (error) {
            logger.error("Failed to list MCP servers:", error);
            process.exit(1);
        }
    });

function displayServer(
    name: string,
    server: MCPServerConfig,
    isOverridden = false,
    isOverriding = false
): void {
    let serverName = name;
    if (isOverridden) {
        serverName = `${name} ${chalk.gray("(overridden by project)")}`;
    } else if (isOverriding) {
        serverName = `${name} ${chalk.gray("(overrides global)")}`;
    }

    logger.info(`\n  ${chalk.bold(serverName)}`);
    logger.info(`    Command: ${chalk.cyan(`${server.command} ${server.args.join(" ")}`)}`);

    if (server.description) {
        logger.info(`    Description: ${server.description}`);
    }

    if (server.allowedPaths && server.allowedPaths.length > 0) {
        logger.info(`    Allowed paths: ${server.allowedPaths.join(", ")}`);
    }

    if (server.env && Object.keys(server.env).length > 0) {
        logger.info(`    Environment: ${Object.keys(server.env).join(", ")}`);
    }
}
