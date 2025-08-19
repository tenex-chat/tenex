import type { NDKTask } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import type { ConversationCoordinator } from "../conversations";
import { getProjectContext } from "../services";
import { formatAnyError } from "../utils/error-formatter";
import { logger } from "../utils/logger";
import { AgentInstance } from "@/agents";
import { createNostrPublisher } from "../nostr/factory";

const logInfo = logger.info.bind(logger);

interface EventHandlerContext {
    conversationManager: ConversationCoordinator;
    agentExecutor: AgentExecutor;
}

export const handleTask = async (event: NDKTask, context: EventHandlerContext): Promise<void> => {
    const title = event.title;
    logInfo(chalk.gray("Task:    ") + chalk.yellow(title));
    logInfo(
        chalk.gray("Content: ") +
            chalk.white(event.content.substring(0, 100) + (event.content.length > 100 ? "..." : ""))
    );

    // Extract p-tags to identify mentioned agents
    const pTags = event.tags.filter((tag) => tag[0] === "p");
    const mentionedPubkeys = pTags.map((tag) => tag[1]).filter((pubkey): pubkey is string => !!pubkey);

    if (mentionedPubkeys.length > 0) {
        logInfo(
            chalk.gray("P-tags:  ") + chalk.cyan(`${mentionedPubkeys.length} pubkeys mentioned`)
        );
    }

    try {
        // Create conversation from NDKTask
        const conversation = await context.conversationManager.createConversation(event);
        
        // Log the claude-session tag if present
        const claudeSession = event.tagValue('claude-session');
        if (claudeSession) {
            logInfo(chalk.gray("Claude Session: ") + chalk.cyan(claudeSession));
        }

        // Get project context
        const projectCtx = getProjectContext();
        
        // Get Project Manager as default coordinator
        const projectManager = projectCtx.getAgent("project-manager");
        if (!projectManager) {
            throw new Error("Project Manager agent not found - required for task coordination");
        }

        let targetAgent: AgentInstance | undefined;

        // If there are p-tags, check if any match system agents
        if (mentionedPubkeys.length > 0) {
            for (const pubkey of mentionedPubkeys) {
                const agent = Array.from(projectCtx.agents.values()).find(
                    (a) => a.pubkey === pubkey
                );
                if (agent) {
                    targetAgent = agent;
                    break;
                }
            }
        } else {
            // Default to PM for task coordination
            targetAgent = projectManager;
        }

        if (!targetAgent) {
            logger.warn("No target agent found for task", { taskId: event.id });
            return;
        }

        // Execute with the appropriate agent
        await context.agentExecutor.execute({
            agent: targetAgent,
            conversationId: conversation.id,
            phase: conversation.phase,
            projectPath: process.cwd(),
            triggeringEvent: event,
            publisher: await createNostrPublisher({
                conversationId: conversation.id,
                agent: targetAgent,
                triggeringEvent: event,
                conversationManager: context.conversationManager,
            }),
            conversationManager: context.conversationManager,
            claudeSessionId: claudeSession,
        });
    } catch (error) {
        logInfo(chalk.red(`❌ Failed to create task conversation: ${formatAnyError(error)}`));
    }
};
