import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import type { ConversationManager } from "../conversations";
import { getProjectContext } from "../services";
import { formatAnyError } from "../utils/error-formatter";
import { logger } from "../utils/logger";
import { createNostrPublisher } from "../nostr/factory";

const logInfo = logger.info.bind(logger);

interface EventHandlerContext {
    conversationManager: ConversationManager;
    agentExecutor: AgentExecutor;
}

export const handleNewConversation = async (
    event: NDKEvent,
    context: EventHandlerContext
): Promise<void> => {
    try {
        // Create conversation
        const conversation = await context.conversationManager.createConversation(event);

        // Get orchestrator agent directly from project context
        const projectCtx = getProjectContext();
        const orchestratorAgent = projectCtx.getProjectAgent();

        // Check for p-tags to determine target agent
        const pTags = event.tags.filter((tag) => tag[0] === "p");
        const mentionedPubkeys = pTags
            .map((tag) => tag[1])
            .filter((pubkey): pubkey is string => !!pubkey);

        let targetAgent = orchestratorAgent; // Default to orchestrator agent

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
        });

        logInfo(chalk.green("✅ Conversation routed successfully"));
    } catch (error) {
        logInfo(chalk.red(`❌ Failed to route conversation: ${formatAnyError(error)}`));
    }
};
