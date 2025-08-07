import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import { ExecutionConfig } from "../agents/execution/constants";
import type { ExecutionContext } from "../agents/execution/types";
import type { ConversationManager } from "../conversations";
import { NostrPublisher } from "../nostr";
import { isEventFromUser } from "../nostr/utils";
import { getProjectContext } from "../services";
import { formatAnyError } from "../utils/error-formatter";
import { logger } from "../utils/logger";

const logInfo = logger.info.bind(logger);

interface EventHandlerContext {
    conversationManager: ConversationManager;
    agentExecutor: AgentExecutor;
}

export const handleChatMessage = async (
    event: NDKEvent,
    context: EventHandlerContext
): Promise<void> => {
    logInfo(
        chalk.gray("Message: ") +
            chalk.white(event.content.substring(0, 100) + (event.content.length > 100 ? "..." : ""))
    );

    // Extract p-tags to identify mentioned agents
    const pTags = event.tags.filter((tag) => tag[0] === "p");
    const mentionedPubkeys = pTags
        .map((tag) => tag[1])
        .filter((pubkey): pubkey is string => !!pubkey);

    // Check if this message is directed to the system (project or agents)
    if (pTags.length > 0) {
        const projectCtx = getProjectContext();
        const systemPubkeys = new Set([
            projectCtx.pubkey,
            ...Array.from(projectCtx.agents.values()).map((a) => a.pubkey),
        ]);

        const isDirectedToSystem = mentionedPubkeys.some((pubkey) => systemPubkeys.has(pubkey));

        if (!isDirectedToSystem) return;
    }

    // This is a reply within an existing conversation
    try {
        await handleReplyLogic(event, context, mentionedPubkeys);
    } catch (error) {
        logInfo(chalk.red(`❌ Failed to route reply: ${formatAnyError(error)}`));
    }
};

async function handleReplyLogic(
    event: NDKEvent,
    { conversationManager, agentExecutor }: EventHandlerContext,
    mentionedPubkeys: string[]
): Promise<void> {
    // Find the conversation this reply belongs to
    let conversation = conversationManager.getConversationByEvent(event.tagValue("E") || "");

    // If no conversation found and this is a reply to an NDKTask (K tag = 1934)
    if (!conversation && event.tagValue("K") === "1934") {
        const taskId = event.tagValue("E");
        if (taskId) {
            // The task itself is the conversation root, so look for it directly
            conversation = conversationManager.getConversation(taskId);
            
            if (conversation) {
                const claudeSession = event.tagValue('claude-session');
                if (claudeSession) {
                    logInfo(chalk.gray("Found claude-session tag in kind:1111 event: ") + chalk.cyan(claudeSession));
                }
            }
        }
    }

    if (!conversation) {
        logger.error("No conversation found for reply", { 
            eventId: event.id,
            eTag: event.tagValue("E"),
            kTag: event.tagValue("K")
        });
        return;
    }

    // Add event to conversation history
    await conversationManager.addEvent(conversation.id, event);

    // Get PM agent directly from project context
    const projectCtx = getProjectContext();
    const orchestratorAgent = projectCtx.getProjectAgent();

    // Determine which agent should handle this event
    let targetAgent = orchestratorAgent; // Default to orchestrator agent

    // Check for p-tagged agents regardless of sender
    if (mentionedPubkeys.length > 0) {
        // Find the first p-tagged system agent
        for (const pubkey of mentionedPubkeys) {
            const agent = Array.from(projectCtx.agents.values()).find((a) => a.pubkey === pubkey);
            if (agent) {
                // For non-user events, skip if agent is the author (prevent loops)
                if (!isEventFromUser(event) && agent.pubkey === event.pubkey) {
                    continue;
                }
                targetAgent = agent;
                break;
            }
        }
    }

    // For non-user events without valid p-tags, skip processing
    if (
        !isEventFromUser(event) &&
        targetAgent === orchestratorAgent &&
        !mentionedPubkeys.includes(orchestratorAgent.pubkey)
    ) {
        return;
    }

    // Check for recent phase transition that might be a handoff for this agent
    let handoff = undefined;
    if (conversation.phaseTransitions.length > 0) {
        const recentTransition =
            conversation.phaseTransitions[conversation.phaseTransitions.length - 1];

        // If this transition was very recent (within last 30 seconds) and has handoff info
        if (
            recentTransition &&
            Date.now() - recentTransition.timestamp < ExecutionConfig.RECENT_TRANSITION_THRESHOLD_MS &&
            recentTransition.summary
        ) {
            handoff = recentTransition;
        }
    }

    // Extract claude-session from the event
    const claudeSessionId = event.tagValue('claude-session');
    if (claudeSessionId) {
        logInfo(chalk.gray("Passing claude-session to execution context: ") + chalk.cyan(claudeSessionId));
    }


    // Execute with the appropriate agent
    const executionContext: ExecutionContext = {
        agent: targetAgent,
        conversationId: conversation.id,
        phase: conversation.phase,
        projectPath: process.cwd(),
        triggeringEvent: event,
        publisher: new NostrPublisher({
            conversationId: conversation.id,
            agent: targetAgent,
            triggeringEvent: event,
            conversationManager,
        }),
        conversationManager,
        claudeSessionId,
        agentExecutor, // Pass the executor so continue() can use it
    };

    // Add handoff if available
    if (handoff) {
        executionContext.handoff = handoff;
    }

    // Don't pre-add user messages to agent context - let the agent executor handle this
    // to ensure proper bootstrapping for newly mentioned agents via p-tags

    try {
        await agentExecutor.execute(executionContext);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check if it's an insufficient credits error
        const isCreditsError =
            errorMessage.includes("Insufficient credits") || errorMessage.includes("402");

        const displayMessage = isCreditsError
            ? "⚠️ Unable to process your request: Insufficient credits. Please add more credits at https://openrouter.ai/settings/credits to continue."
            : "⚠️ Unable to process your request due to an error. Please try again later.";

        // Create NostrPublisher to publish error
        const publisher = new NostrPublisher({
            conversationId: conversation.id,
            agent: orchestratorAgent,
            triggeringEvent: event,
            conversationManager,
        });

        await publisher.publishError(displayMessage);

        logger.error(
            isCreditsError
                ? "Agent execution failed due to insufficient credits"
                : "Agent execution failed",
            {
                error: errorMessage,
                conversation: conversation.id,
            }
        );
    }
}
