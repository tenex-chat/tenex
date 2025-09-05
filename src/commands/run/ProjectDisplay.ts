import { logger } from "@/utils/logger";


import type { AgentInstance } from "@/agents/types";
import { getProjectContext, configService } from "@/services";
import chalk from "chalk";

export class ProjectDisplay {
  async displayProjectInfo(projectPath: string): Promise<void> {
    this.displayBasicInfo(projectPath);
    await this.displayAgentConfigurations();
    // Note: Documentation display moved to after subscription EOSE
    logger.info(chalk.blue("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));
  }

  private displayBasicInfo(projectPath: string): void {
    const projectCtx = getProjectContext();
    const project = projectCtx.project;
    const titleTag = project.tagValue("title") || "Untitled Project";
    const repoTag = project.tagValue("repo") || "No repository";

    logger.info(chalk.blue("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
    logger.info(chalk.cyan("📦 Project Information"));
    logger.info(chalk.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
    logger.info(chalk.gray("Title:      ") + chalk.white(titleTag));
    logger.info(chalk.gray("Repository: ") + chalk.white(repoTag));
    logger.info(chalk.gray("Path:       ") + chalk.white(projectPath));
    if (project.id) {
      logger.info(chalk.gray("Event ID:   ") + chalk.gray(project.id));
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

    logger.info(chalk.blue("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
    logger.info(chalk.cyan("🤖 Agent Configurations"));
    logger.info(chalk.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));

    if (agents.size === 0) {
      logger.info(chalk.yellow("No agent configurations found for this project."));
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
    logger.info(chalk.gray("\nAgent:       ") + chalk.yellow(agent.name));
    logger.info(chalk.gray("Slug:        ") + chalk.white(slug));
    logger.info(chalk.gray("Role:        ") + chalk.white(agent.role));
    
    // Resolve and display the actual model that will be used
    const modelString = agent.llmConfig || "default";
    try {
      const config = await configService.loadConfig();
      
      // Check if configuration exists
      const llmConfig = config.llms.configurations?.[modelString] || 
                       (modelString === "default" && config.llms.default ? config.llms.configurations?.[config.llms.default] : null);
      
      if (llmConfig) {
        logger.info(chalk.gray("Model:       ") + chalk.magenta(`${llmConfig.provider}:${llmConfig.model}`));
      } else {
        logger.info(chalk.gray("Model:       ") + chalk.red(`Configuration not found: ${modelString}`));
      }
    } catch {
      logger.info(chalk.gray("Model:       ") + chalk.red(`Error resolving model: ${modelString}`));
    }

    // Separate regular tools from MCP tools
    const regularTools = agent.tools.filter(t => !t.startsWith("mcp__"));
    const mcpTools = agent.tools.filter(t => t.startsWith("mcp__"));
    
    // Display regular tools
    const regularToolNames = regularTools.join(", ");
    const regularToolCount = regularTools.length;
    logger.info(chalk.gray("Tools:       ") + chalk.cyan(`[${regularToolCount}] ${regularToolNames || "none"}`));
    
    // Display MCP tools grouped by server
    if (mcpTools.length > 0) {
      // Group MCP tools by server
      const mcpByServer = new Map<string, string[]>();
      
      for (const tool of mcpTools) {
        // Extract server name from mcp__<server>__<tool>
        const parts = tool.split("__");
        if (parts.length >= 3) {
          const serverName = parts[1];
          const toolName = parts.slice(2).join("__");
          
          if (!mcpByServer.has(serverName)) {
            mcpByServer.set(serverName, []);
          }
          mcpByServer.get(serverName)!.push(toolName);
        }
      }
      
      // Try to get all available MCP tools to check if server has all tools enabled
      const serverSummaries: string[] = [];
      
      try {
        // Import mcpService to check available tools per server
        const { mcpService } = await import("@/services/mcp/MCPManager");
        const allMcpTools = mcpService.getCachedTools();
        
        // Count tools per server in the full set
        const allToolsByServer = new Map<string, number>();
        for (const tool of allMcpTools) {
          const parts = tool.name.split("__");
          if (parts.length >= 3) {
            const serverName = parts[1];
            allToolsByServer.set(serverName, (allToolsByServer.get(serverName) || 0) + 1);
          }
        }
        
        // Build server summaries
        for (const [serverName, tools] of mcpByServer) {
          const totalAvailable = allToolsByServer.get(serverName) || tools.length;
          
          if (tools.length === totalAvailable) {
            // All tools from this server are enabled - show just server name
            serverSummaries.push(`${serverName} (${tools.length})`);
          } else {
            // Partial tools - show count
            serverSummaries.push(`${serverName} (${tools.length}/${totalAvailable})`);
          }
        }
      } catch {
        // Fallback if we can't get MCP service info
        for (const [serverName, tools] of mcpByServer) {
          serverSummaries.push(`${serverName} (${tools.length})`);
        }
      }
      
      logger.info(chalk.gray("MCP Tools:   ") + chalk.cyan(`[${mcpTools.length}] ${serverSummaries.join(", ")}`));
    }

    logger.info(chalk.gray("Pubkey:      ") + chalk.white(agent.pubkey));
    if (agent.eventId) {
      logger.info(chalk.gray("Event ID:    ") + chalk.gray(agent.eventId));
    }
  }
}
