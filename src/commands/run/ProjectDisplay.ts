import { logger } from "@/utils/logger";

const logInfo = logger.info.bind(logger);

import chalk from "chalk";
import type { AgentInstance } from "@/agents/types";
import { getProjectContext } from "@/services";

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
      this.displayAgentBySlug(slug, agent);
    }
  }

  private displayAgentBySlug(slug: string, agent: AgentInstance): void {
    // Display agent information
    logInfo(chalk.gray("\nAgent:       ") + chalk.yellow(agent.name));
    logInfo(chalk.gray("Slug:        ") + chalk.white(slug));
    logInfo(chalk.gray("Role:        ") + chalk.white(agent.role));
    logInfo(chalk.gray("LLM Config:  ") + chalk.magenta(agent.llmConfig || "default"));

    // Display tools - CRITICAL for debugging tool loading issues
    const toolNames = agent.tools.map((t) => t.name).join(", ");
    const toolCount = agent.tools.length;
    logInfo(chalk.gray("Tools:       ") + chalk.cyan(`[${toolCount}] ${toolNames || "none"}`));

    logInfo(chalk.gray("Pubkey:      ") + chalk.white(agent.pubkey));
    if (agent.isBuiltIn) {
      logInfo(chalk.gray("Built-in:    ") + chalk.green("✓"));
    }
    if (agent.eventId) {
      logInfo(chalk.gray("Event ID:    ") + chalk.gray(agent.eventId));
    }
  }
}
