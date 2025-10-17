import { agentStorage } from "@/agents/AgentStorage";
import { configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { confirm } from "@inquirer/prompts";
import { Command } from "commander";
import { getNDK } from "@/nostr";
import { initNDK } from "@/nostr/ndkClient";

export const agentRemoveCommand = new Command("remove")
  .description("Remove an agent from current project")
  .argument("<slug>", "Agent slug to remove")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async (slug: string, options: { force?: boolean }) => {
    try {
      const projectPath = process.cwd();

      // Check if we're in a project
      const isProject = await configService.projectConfigExists(projectPath, "config.json");
      if (!isProject) {
        logger.error("Not in a TENEX project directory. Run this command from within a project.");
        process.exit(1);
      }

      // Load project config to get projectNaddr
      const { config } = await configService.loadConfig(projectPath);
      if (!config.projectNaddr) {
        logger.error("Project configuration missing projectNaddr");
        process.exit(1);
      }

      // Initialize NDK and fetch project
      await initNDK();
      const ndk = getNDK();
      const project = await ndk.fetchEvent(config.projectNaddr);

      if (!project || !project.dTag) {
        logger.error("Could not fetch project from Nostr");
        process.exit(1);
      }

      // Initialize agent storage
      await agentStorage.initialize();

      // Find the agent by slug
      const agent = await agentStorage.getAgentBySlug(slug);
      if (!agent) {
        logger.error(`Agent "${slug}" not found`);
        process.exit(1);
      }

      // Check if agent is in this project
      if (!agent.projects.includes(project.dTag)) {
        logger.error(`Agent "${slug}" is not associated with this project`);
        process.exit(1);
      }

      // Get pubkey from nsec for removal
      const { NDKPrivateKeySigner } = await import("@nostr-dev-kit/ndk");
      const signer = new NDKPrivateKeySigner(agent.nsec);
      const pubkey = signer.pubkey;

      // Confirm deletion unless --force is used
      if (!options.force) {
        const otherProjects = agent.projects.filter(p => p !== project.dTag);
        let message = `Are you sure you want to remove agent "${agent.name}" (${slug}) from this project?`;

        if (otherProjects.length > 0) {
          message += `\n  The agent will remain in ${otherProjects.length} other project(s).`;
        } else {
          message += "\n  ⚠️  This is the agent's last project - it will be deleted completely.";
        }

        const confirmed = await confirm({
          message,
          default: false,
        });

        if (!confirmed) {
          logger.info("Removal cancelled");
          process.exit(0);
        }
      }

      // Remove agent from project
      await agentStorage.removeAgentFromProject(pubkey, project.dTag);

      const otherProjects = agent.projects.filter(p => p !== project.dTag);
      if (otherProjects.length > 0) {
        logger.info(`✅ Agent "${agent.name}" removed from this project`);
        logger.info(`   Agent remains in ${otherProjects.length} other project(s)`);
      } else {
        logger.info(`✅ Agent "${agent.name}" completely removed (was only in this project)`);
      }

      process.exit(0);
    } catch (error) {
      logger.error("Failed to remove agent:", error);
      process.exit(1);
    }
  });