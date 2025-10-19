import { agentStorage } from "@/agents/AgentStorage";
import { logger } from "@/utils/logger";
import { Command } from "commander";

export const agentListCommand = new Command("list")
  .description("List all globally installed agents")
  .option("--project <dTag>", "Filter agents by project d-tag")
  .action(async (options) => {
    try {
      // Initialize agent storage
      await agentStorage.initialize();

      // Get agents (filtered by project if specified)
      const agents = options.project
        ? await agentStorage.getProjectAgents(options.project)
        : await agentStorage.getAllAgents();

      if (agents.length === 0) {
        const message = options.project
          ? `No agents found for project ${options.project}`
          : "No agents found";
        logger.info(message);
        logger.info("");
        logger.info("To add an agent, use: tenex agent add <event-id>");
        process.exit(0);
      }

      // Display header
      if (options.project) {
        logger.info(`Agents for project "${options.project}":`);
      } else {
        logger.info("All installed agents:");
      }
      logger.info("");

      for (const agent of agents) {
        logger.info(`  ${agent.slug}: ${agent.name}`);
        logger.info(`    Role: ${agent.role}`);
        if (agent.description) {
          logger.info(`    Description: ${agent.description}`);
        }
        if (agent.eventId) {
          logger.info(`    Event ID: ${agent.eventId}`);
        }
        if (agent.llmConfig) {
          logger.info(`    LLM Config: ${agent.llmConfig}`);
        }
        if (agent.tools && agent.tools.length > 0) {
          logger.info(`    Tools: ${agent.tools.length} tool(s)`);
        }
        if (agent.projects && agent.projects.length > 0) {
          logger.info(`    Projects: ${agent.projects.join(", ")}`);
        }
        logger.info("");
      }

      process.exit(0);
    } catch (error) {
      logger.error("Failed to list agents:", error);
      process.exit(1);
    }
  });