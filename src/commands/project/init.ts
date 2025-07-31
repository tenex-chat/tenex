import path from "node:path";
import { logger } from "@/utils/logger";
import { Command } from "commander";
import { ProjectManager } from "../../daemon/ProjectManager";
import { getNDK, initNDK, shutdownNDK } from "../../nostr/ndkClient";
import { formatError } from "../../utils/errors";

export const projectInitCommand = new Command("init")
    .description("Initialize a new TENEX project")
    .argument("<path>", "Path where the project will be created")
    .argument("<naddr>", "Project naddr from Nostr")
    .action(async (projectPath: string, naddr: string) => {
        try {
            const resolvedPath = path.resolve(projectPath);

            logger.info("Initializing project", { path: resolvedPath, naddr });

            // Initialize NDK and get singleton
            await initNDK();
            const ndk = getNDK();

            const projectManager = new ProjectManager();
            const projectData = await projectManager.initializeProject(resolvedPath, naddr, ndk);

            // Shutdown NDK
            await shutdownNDK();

            logger.success(`\nProject created successfully at ${resolvedPath}`);
            logger.info(
                JSON.stringify({
                    success: true,
                    projectPath: resolvedPath,
                    name: projectData.identifier,
                    configured: true,
                })
            );

            process.exit(0);
        } catch (err) {
            const errorMessage = formatError(err);
            logger.error(`Failed to create project: ${errorMessage}`);
            process.exit(1);
        }
    });
