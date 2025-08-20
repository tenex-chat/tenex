import { confirm } from "@inquirer/prompts";
import { Command } from "commander";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";

interface RemoveOptions {
  project?: boolean;
  global?: boolean;
  force?: boolean;
}

export const agentRemoveCommand = new Command("remove")
  .description("Remove an agent")
  .argument("<name>", "Agent name or slug to remove")
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
        // Default: try project first if in one, otherwise global
        useProject = isProject;
      }

      // Load the appropriate registry
      const registryPath = useProject
        ? projectPath
        : configService.getGlobalPath().replace("/.tenex", "");
      const registry = new AgentRegistry(registryPath, !useProject);
      await registry.loadFromProject();

      // Find the agent
      const agent = registry.getAgent(name) || registry.getAgentByName(name);
      if (!agent) {
        const location = useProject ? "project" : "global";
        logger.error(`Agent "${name}" not found in ${location} configuration`);

        // If we defaulted to project, suggest checking global
        if (useProject && !options.project) {
          logger.info("Try using --global flag to remove from global configuration");
        }
        process.exit(1);
      }

      // Check if it's a built-in agent
      if (agent.isBuiltIn) {
        logger.error("Cannot remove built-in agents");
        process.exit(1);
      }

      // Confirm deletion unless --force is used
      if (!options.force) {
        const confirmed = await confirm({
          message: `Are you sure you want to remove agent "${agent.name}" (${agent.slug})?`,
          default: false,
        });

        if (!confirmed) {
          logger.info("Removal cancelled");
          process.exit(0);
        }
      }

      // Remove the agent
      const removed = agent.eventId
        ? await registry.removeAgentByEventId(agent.eventId)
        : await registry.removeAgentBySlug(agent.slug);

      if (removed) {
        const location = useProject ? "project" : "global";
        logger.info(`✅ Agent "${agent.name}" removed from ${location} configuration`);
      } else {
        logger.error("Failed to remove agent");
        process.exit(1);
      }

      process.exit(0);
    } catch (error) {
      logger.error("Failed to remove agent:", error);
      process.exit(1);
    }
  });
