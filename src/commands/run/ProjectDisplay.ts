import { logger } from "@/utils/logger";
const logInfo = logger.info.bind(logger);
import type { Agent } from "@/agents/types";
import { getProjectContext } from "@/services";
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
            logInfo(chalk.gray("Event ID:   ") + chalk.gray(`${project.id.substring(0, 16)}...`));
        }
    }

    private async displayAgentConfigurations(): Promise<void> {
        const projectCtx = getProjectContext();
        const agents = projectCtx.agents;

        // Debug logging
        logger.debug("Displaying agent configurations", {
            agentsSize: agents.size,
            agentKeys: Array.from(agents.keys()),
            hasOrchestrator: !!projectCtx.orchestrator,
            orchestratorName: projectCtx.orchestrator?.name,
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

    private displayAgentBySlug(slug: string, agent: Agent): void {
        // Display agent information
        logInfo(chalk.gray("\nAgent:       ") + chalk.yellow(agent.name));
        logInfo(chalk.gray("Slug:        ") + chalk.white(slug));
        logInfo(chalk.gray("Role:        ") + chalk.white(agent.role));
        logInfo(chalk.gray("LLM Config:  ") + chalk.magenta(agent.llmConfig || "default"));
        logInfo(chalk.gray("Pubkey:      ") + chalk.white(agent.pubkey));
        if (agent.isOrchestrator) {
            logInfo(chalk.gray("Type:        ") + chalk.cyan("Orchestrator"));
        }
        if (agent.isBuiltIn) {
            logInfo(chalk.gray("Built-in:    ") + chalk.green("✓"));
        }
        if (agent.eventId) {
            logInfo(
                chalk.gray("Event ID:    ") + chalk.gray(`${agent.eventId.substring(0, 16)}...`)
            );
        }
    }

    private displayAgent(eventId: string, agents: Map<string, Agent>): void {
        // Find agent by eventId
        const agentEntry = Array.from(agents.entries()).find(
            ([, agent]) => agent.eventId === eventId
        );

        if (!agentEntry) {
            logInfo(chalk.red(`No agent instance found for event: ${eventId}`));
            return;
        }

        const [_agentKey, agent] = agentEntry;

        // Display agent information with instance pubkey
        logInfo(chalk.gray("\nAgent:       ") + chalk.yellow(agent.name));
        logInfo(chalk.gray("Role:        ") + chalk.white(agent.role));
        logInfo(chalk.gray("LLM Config:  ") + chalk.magenta(agent.llmConfig || "default"));
        logInfo(chalk.gray("Pubkey:      ") + chalk.white(agent.pubkey));
        logInfo(chalk.gray("Cached:      ") + chalk.green(`✓ ${eventId}.json`));
    }
}
