import { configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { handleCliError } from "@/utils/cli-error";
import { confirm } from "@inquirer/prompts";
import { Command } from "commander";

interface RemoveOptions {
    project?: boolean;
    global?: boolean;
    force?: boolean;
}

export const removeCommand = new Command("remove")
    .description("Remove an MCP server")
    .argument("<name>", "MCP server name to remove")
    .option("--project", "Remove from project configuration")
    .option("--global", "Remove from global configuration")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (name: string, options: RemoveOptions) => {
        try {
            const projectPath = process.cwd();
            const isProject = await configService.projectConfigExists(projectPath, "config.json");

            // Determine where to remove from
            let useProject = false;
            if (options.global && options.project) {
                handleCliError("Cannot use both --global and --project flags");
            } else if (options.global) {
                useProject = false;
            } else if (options.project) {
                if (!isProject) {
                    handleCliError(
                        "Not in a TENEX project directory. Use --global flag or run from a project."
                    );
                }
                useProject = true;
            } else {
                // Default: try project first if in one, otherwise global
                useProject = isProject;
            }

            // Load existing MCP config
            const basePath = useProject
                ? configService.getProjectPath(projectPath)
                : configService.getGlobalPath();
            const existingMCP = await configService.loadTenexMCP(basePath);

            // Check if server exists
            if (!existingMCP.servers[name]) {
                const location = useProject ? "project" : "global";
                // If we defaulted to project, suggest checking global
                if (useProject && !options.project) {
                    logger.info("Try using --global flag to remove from global configuration");
                }
                handleCliError(`MCP server "${name}" not found in ${location} configuration`);
            }

            // Confirm deletion unless --force is used
            if (!options.force) {
                const serverConfig = existingMCP.servers[name];
                const confirmed = await confirm({
                    message: `Are you sure you want to remove MCP server "${name}" (${serverConfig.command} ${serverConfig.args.join(" ")})?`,
                    default: false,
                });

                if (!confirmed) {
                    logger.info("Removal cancelled");
                    process.exit(0);
                }
            }

            // Remove the server
            delete existingMCP.servers[name];

            // Save updated config
            if (useProject) {
                await configService.saveProjectMCP(projectPath, existingMCP);
                logger.info(`✅ MCP server "${name}" removed from project configuration`);
            } else {
                await configService.saveGlobalMCP(existingMCP);
                logger.info(`✅ MCP server "${name}" removed from global configuration`);
            }

            process.exit(0);
        } catch (error) {
            handleCliError(error, "Failed to remove MCP server");
        }
    });
