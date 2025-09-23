import * as path from "node:path";
import { logger } from "@/utils/logger";
import { Command } from "commander";
import { ProjectManager } from "../../daemon/ProjectManager";
import { getNDK, initNDK, shutdownNDK, getTenexAnnouncementService } from "../../nostr/ndkClient";
import { handleCliError } from "../../utils/cli-error";
import { nip19 } from "nostr-tools";

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

      // Add project to TENEX announcement service
      const announcementService = getTenexAnnouncementService();
      if (announcementService) {
        try {
          // Decode naddr to get kind:pubkey:identifier format for 'a' tag
          const decoded = nip19.decode(naddr);
          if (decoded.type !== 'naddr') {
            logger.error(`Invalid naddr provided: ${naddr}`);
          } else {
            const { kind, pubkey, identifier } = decoded.data;
            const formattedId = `${kind}:${pubkey}:${identifier}`;
            const projectTag = ['a', formattedId];
            const changed = announcementService.addTag(projectTag);
            
            if (changed) {
              await announcementService.publish();
              logger.debug(`Published project announcement for ${formattedId}`);
            }
          }
        } catch (error) {
          logger.error("Failed to publish project announcement", error);
          // Don't fail the project creation if announcement fails
        }
      }

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
      handleCliError(err, "Failed to create project");
    }
  });
