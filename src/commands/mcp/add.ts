import { which } from "@/lib/shell";
import { configService } from "@/services/ConfigService";
import type { MCPServerConfig } from "@/services/config/types";
import { logger } from "@/utils/logger";
import { Command } from "commander";

interface AddOptions {
    project?: boolean;
    global?: boolean;
}

interface AddOptionsWithPaths extends AddOptions {
    paths?: string;
    env?: string[];
}

export const addCommand = new Command("add")
    .description("Add a new MCP server")
    .argument("<name>", "Name for the MCP server")
    .argument("<command...>", "Command and arguments to run the MCP server")
    .option("--project", "Add to project configuration (default if in project)")
    .option("--global", "Add to global configuration")
    .option("-p, --paths <paths>", "Allowed paths (comma-separated)")
    .option("-e, --env <vars...>", "Environment variables (KEY=VALUE format)")
    .allowUnknownOption()
    .action(async (name: string, commandArgs: string[], options: AddOptionsWithPaths) => {
        try {
            // Parse command and args from the array
            if (commandArgs.length === 0) {
                logger.error("No command provided");
                logger.info("Usage: tenex mcp add <name> <command> [args...]");
                logger.info("Example: tenex mcp add nostrbook npx -y xjsr @nostrbook/mcp");
                process.exit(1);
            }

            const command = commandArgs[0] as string; // Safe because we checked length above
            const args = commandArgs.slice(1);

            // Validate name
            if (!/^[a-zA-Z0-9-_]+$/.test(name)) {
                logger.error("Name can only contain letters, numbers, hyphens, and underscores");
                process.exit(1);
            }

            // Validate command exists (skip for npx, npm, etc.)
            const skipValidation = [
                "npx",
                "npm",
                "node",
                "python",
                "python3",
                "ruby",
                "sh",
                "bash",
            ];
            if (!skipValidation.includes(command)) {
                try {
                    const commandPath = await which(command);
                    if (!commandPath) {
                        logger.error(`Command not found: ${command}`);
                        logger.info("Make sure the command is installed and in your PATH");
                        process.exit(1);
                    }
                } catch {
                    logger.error(`Command not found: ${command}`);
                    logger.info("Make sure the command is installed and in your PATH");
                    process.exit(1);
                }
            }

            // Parse allowed paths if provided
            const allowedPaths = options.paths
                ? options.paths
                      .split(",")
                      .map((p) => p.trim())
                      .filter((p) => p.length > 0)
                : [];

            // Parse environment variables if provided
            const envVars: Record<string, string> = {};
            if (options.env && options.env.length > 0) {
                for (const envVar of options.env) {
                    const [key, ...valueParts] = envVar.split("=");
                    if (!key || valueParts.length === 0) {
                        logger.error(`Invalid environment variable format: ${envVar}`);
                        logger.info("Environment variables must be in KEY=VALUE format");
                        process.exit(1);
                    }
                    envVars[key] = valueParts.join("=");
                }
            }

            // Create server config
            const serverConfig: MCPServerConfig = {
                command,
                args,
                ...(allowedPaths.length > 0 && { allowedPaths }),
                ...(Object.keys(envVars).length > 0 && { env: envVars }),
            };

            // Determine where to save
            const projectPath = process.cwd();
            const isProject = await configService.projectConfigExists(projectPath, "config.json");

            let useProject = false;
            if (options.global && options.project) {
                logger.error("Cannot use both --global and --project flags");
                process.exit(1);
            } else if (options.global) {
                useProject = false;
            } else if (options.project) {
                if (!isProject) {
                    logger.error(
                        "Not in a TENEX project directory. Use --global flag or run from a project."
                    );
                    process.exit(1);
                }
                useProject = true;
            } else {
                // Default: use project if in one, otherwise global
                useProject = isProject;
            }

            // Load existing MCP config
            const basePath = useProject
                ? configService.getProjectPath(projectPath)
                : configService.getGlobalPath();
            const existingMCP = await configService.loadTenexMCP(basePath);

            // Check if server name already exists
            if (existingMCP.servers[name]) {
                logger.error(`MCP server '${name}' already exists`);
                process.exit(1);
            }

            // Add new server
            existingMCP.servers[name] = serverConfig;

            // Save config
            if (useProject) {
                await configService.saveProjectMCP(projectPath, existingMCP);
                logger.info(`Added MCP server '${name}' to project configuration`);
            } else {
                await configService.saveGlobalMCP(existingMCP);
                logger.info(`Added MCP server '${name}' to global configuration`);
            }

            logger.info(`Command: ${command} ${args.join(" ")}`);
            if (allowedPaths.length > 0) {
                logger.info(`Allowed paths: ${allowedPaths.join(", ")}`);
            }
            if (Object.keys(envVars).length > 0) {
                logger.info(`Environment variables: ${Object.keys(envVars).join(", ")}`);
            }

            // Exit successfully
            process.exit(0);
        } catch (error) {
            logger.error("Failed to add MCP server:", error);
            process.exit(1);
        }
    });
