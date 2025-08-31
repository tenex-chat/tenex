import { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import { configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { Command } from "commander";

interface ListOptions {
  project?: boolean;
  global?: boolean;
  all?: boolean;
}

export const agentListCommand = new Command("list")
  .description("List available agents")
  .option("--project", "Show only project agents")
  .option("--global", "Show only global agents")
  .option("--all", "Show all agents (default)")
  .action(async (options: ListOptions) => {
    try {
      const projectPath = process.cwd();
      const isProject = await configService.projectConfigExists(projectPath, "config.json");

      // Default to showing all agents
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

      logger.info("Available agents:");
      logger.info("");

      // Load and display global agents
      if (showGlobal) {
        try {
          const globalPath = configService.getGlobalPath().replace("/.tenex", "");
          const globalRegistry = new AgentRegistry(globalPath, true);
          await globalRegistry.loadFromProject();

          const globalAgents = globalRegistry.getAllAgents();
          if (globalAgents.length > 0) {
            logger.info("Global agents:");
            for (const agent of globalAgents) {
              logger.info(`  - ${agent.slug}: ${agent.name}`);
              logger.info(`    Role: ${agent.role}`);
              if (agent.description) {
                logger.info(`    Description: ${agent.description}`);
              }
              if (agent.eventId) {
                logger.info(`    Event ID: ${agent.eventId}`);
              }
            }
            logger.info("");
          } else {
            logger.info("No global agents found.");
            logger.info("");
          }
        } catch (error) {
          logger.error("Failed to load global agents", { error });
          if (showGlobal && !showProject) {
            process.exit(1);
          }
        }
      }

      // Load and display project agents
      if (showProject && isProject) {
        try {
          // Load global agents to check for overrides
          const globalPath = configService.getGlobalPath().replace("/.tenex", "");
          const globalRegistry = new AgentRegistry(globalPath, true);
          await globalRegistry.loadFromProject();
          const globalAgentSlugs = new Set(globalRegistry.getAllAgents().map((a) => a.slug));

          // Load project registry
          const projectRegistry = new AgentRegistry(projectPath, false);
          await projectRegistry.loadFromProject();

          const projectAgents = projectRegistry.getAllAgents();
          const projectOnlyAgents: AgentInstance[] = [];
          const overriddenAgents: AgentInstance[] = [];

          // Categorize agents
          for (const agent of projectAgents) {
            if (globalAgentSlugs.has(agent.slug)) {
              overriddenAgents.push(agent);
            } else {
              projectOnlyAgents.push(agent);
            }
          }

          if (projectOnlyAgents.length > 0 || overriddenAgents.length > 0) {
            logger.info("Project agents:");

            // Show project-specific agents first
            for (const agent of projectOnlyAgents) {
              logger.info(`  - ${agent.slug}: ${agent.name}`);
              logger.info(`    Role: ${agent.role}`);
              if (agent.description) {
                logger.info(`    Description: ${agent.description}`);
              }
              if (agent.eventId) {
                logger.info(`    Event ID: ${agent.eventId}`);
              }
            }

            // Show overridden agents
            if (overriddenAgents.length > 0) {
              logger.info("");
              logger.info("  Overriding global agents:");
              for (const agent of overriddenAgents) {
                logger.info(`  - ${agent.slug}: ${agent.name} (overrides global)`);
                logger.info(`    Role: ${agent.role}`);
                if (agent.description) {
                  logger.info(`    Description: ${agent.description}`);
                }
                if (agent.eventId) {
                  logger.info(`    Event ID: ${agent.eventId}`);
                }
              }
            }
          } else {
            logger.info("No project-specific agents found.");
          }
        } catch (error) {
          logger.error("Failed to load project agents", { error });
          if (showProject && !showGlobal) {
            process.exit(1);
          }
        }
      }

      process.exit(0);
    } catch (error) {
      logger.error("Failed to list agents:", error);
      process.exit(1);
    }
  });
