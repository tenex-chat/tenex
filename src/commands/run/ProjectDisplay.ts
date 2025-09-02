import { logger } from "@/utils/logger";

const logInfo = logger.info.bind(logger);

import type { AgentInstance } from "@/agents/types";
import { getProjectContext, configService } from "@/services";
import { getLLMService } from "@/llm/service";
import chalk from "chalk";

export class ProjectDisplay {
  async displayProjectInfo(projectPath: string): Promise<void> {
    this.displayBasicInfo(projectPath);
    await this.displayAgentConfigurations();
    // Note: Documentation display moved to after subscription EOSE
    logInfo(chalk.blue("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));
  }

  private displayBasicInfo(projectPath: string): void {
    const projectCtx = getProjectContext();
    const project = projectCtx.project;
    const titleTag = project.tagValue("title") || "Untitled Project";
    const repoTag = project.tagValue("repo") || "No repository";

    logInfo(chalk.blue("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
    logInfo(chalk.cyan("📦 Project Information"));
    logInfo(chalk.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
    logInfo(chalk.gray("Title:      ") + chalk.white(titleTag));
    logInfo(chalk.gray("Repository: ") + chalk.white(repoTag));
    logInfo(chalk.gray("Path:       ") + chalk.white(projectPath));
    if (project.id) {
      logInfo(chalk.gray("Event ID:   ") + chalk.gray(project.id));
    }
  }

  private async displayAgentConfigurations(): Promise<void> {
    const projectCtx = getProjectContext();
    const agents = projectCtx.agents;

    // Debug logging
    logger.debug("Displaying agent configurations", {
      agentsSize: agents.size,
      agentKeys: Array.from(agents.keys()),
    });

    logInfo(chalk.blue("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
    logInfo(chalk.cyan("🤖 Agent Configurations"));
    logInfo(chalk.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));

    if (agents.size === 0) {
      logInfo(chalk.yellow("No agent configurations found for this project."));
      return;
    }

    for (const [slug, agent] of agents) {
      logger.debug(`Checking agent for display: ${slug}`, {
        name: agent.name,
        hasEventId: !!agent.eventId,
        eventId: agent.eventId,
        pubkey: agent.pubkey,
      });
      await this.displayAgentBySlug(slug, agent);
    }
  }

  private async displayAgentBySlug(slug: string, agent: AgentInstance): Promise<void> {
    // Display agent information
    logInfo(chalk.gray("\nAgent:       ") + chalk.yellow(agent.name));
    logInfo(chalk.gray("Slug:        ") + chalk.white(slug));
    logInfo(chalk.gray("Role:        ") + chalk.white(agent.role));
    
    // Resolve and display the actual model that will be used
    const modelString = agent.llmConfig || "default";
    try {
      const config = await configService.loadConfig();
      
      // Check if configuration exists
      const llmConfig = config.llms.configurations?.[modelString] || 
                       (modelString === "default" && config.llms.default ? config.llms.configurations?.[config.llms.default] : null);
      
      if (llmConfig) {
        logInfo(chalk.gray("Model:       ") + chalk.magenta(`${llmConfig.provider}:${llmConfig.model}`));
      } else {
        logInfo(chalk.gray("Model:       ") + chalk.red(`Configuration not found: ${modelString}`));
      }
    } catch (error) {
      logInfo(chalk.gray("Model:       ") + chalk.red(`Error resolving model: ${modelString}`));
    }

    // Display tools - CRITICAL for debugging tool loading issues
    const toolNames = agent.tools.join(", ");
    const toolCount = agent.tools.length;
    logInfo(chalk.gray("Tools:       ") + chalk.cyan(`[${toolCount}] ${toolNames || "none"}`));

    logInfo(chalk.gray("Pubkey:      ") + chalk.white(agent.pubkey));
    if (agent.eventId) {
      logInfo(chalk.gray("Event ID:    ") + chalk.gray(agent.eventId));
    }
  }
}
