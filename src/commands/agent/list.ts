import { agentStorage } from "@/agents/AgentStorage";
import { configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { Command } from "commander";
import { getNDK } from "@/nostr";
import { initNDK } from "@/nostr/ndkClient";

export const agentListCommand = new Command("list")
  .description("List agents for current project")
  .action(async () => {
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

      // Get agents for this project
      const agents = await agentStorage.getProjectAgents(project.dTag);

      if (agents.length === 0) {
        logger.info("No agents found for this project.");
        logger.info("");
        logger.info("To add an agent, use: tenex agent add <event-id>");
        process.exit(0);
      }

      // Get first agent eventId from project tags to identify PM
      const firstAgentEventId = project.tags
        .find(t => t[0] === "agent" && t[1])?.[1];

      logger.info(`Agents for project "${project.tagValue("title") || project.dTag}":`);
      logger.info("");

      for (const agent of agents) {
        const isPM = agent.eventId === firstAgentEventId;

        logger.info(`  ${agent.slug}: ${agent.name}${isPM ? " [PM]" : ""}`);
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
        logger.info("");
      }

      process.exit(0);
    } catch (error) {
      logger.error("Failed to list agents:", error);
      process.exit(1);
    }
  });