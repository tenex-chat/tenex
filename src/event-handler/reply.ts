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
    const convRoot = event.tagValue("E") || event.tagValue("A");
    
    let conversation = convRoot ? conversationManager.getConversationByEvent(convRoot) : undefined;
    let mappedClaudeSessionId: string | undefined;

    // If no conversation found and this is a reply to an NDKTask (K tag = 1934)
    if (!conversation && event.tagValue("K") === "1934") {
        const taskId = event.tagValue("E");
        if (taskId) {
            // First check if we have a task mapping for this task
            const taskMapping = conversationManager.getTaskMapping(taskId);
            if (taskMapping) {
                conversation = conversationManager.getConversation(taskMapping.conversationId);
                mappedClaudeSessionId = taskMapping.claudeSessionId;
                
                if (conversation) {
                    logInfo(chalk.gray("Found conversation via task mapping: ") + 
                           chalk.cyan(taskMapping.conversationId) + 
                           (mappedClaudeSessionId ? chalk.gray(" with session: ") + chalk.cyan(mappedClaudeSessionId) : ""));
                }
            } else {
                // Fallback: The task itself might be the conversation root
                conversation = conversationManager.getConversation(taskId);
                
                if (conversation) {
                    const claudeSession = event.tagValue('claude-session');
                    if (claudeSession) {
                        logInfo(chalk.gray("Found claude-session tag in kind:1111 event: ") + chalk.cyan(claudeSession));
                    }
                }
            }
        }
    }

    // If no conversation found and this is a kTag 11 reply that p-tags an agent
    if (!conversation && event.tagValue("K") === "11" && mentionedPubkeys.length > 0) {
        const projectCtx = getProjectContext();
        const isDirectedToAgent = mentionedPubkeys.some((pubkey) => 
            Array.from(projectCtx.agents.values()).some((a) => a.pubkey === pubkey)
        );
        
        if (isDirectedToAgent) {
            // Create a new conversation for this orphaned reply
            logInfo(chalk.yellow(`Creating new conversation for orphaned kTag 11 reply to conversation root: ${convRoot}`));
            
            // Create a synthetic root event based on the reply
            const syntheticRootEvent: NDKEvent = {
                ...event,
                id: convRoot || event.id, // Use conversation root if available, otherwise use the reply's ID
                content: `[Orphaned conversation - original root not found]\n\n${event.content}`,
                tags: event.tags.filter(tag => tag[0] !== "E" && tag[0] !== "e"), // Remove reply tags
            } as NDKEvent;
            
            conversation = await conversationManager.createConversation(syntheticRootEvent);
            
            // Add the actual reply event to the conversation history
            if (conversation && event.id !== conversation.id) {
                await conversationManager.addEvent(conversation.id, event);
            }
        }
    }

    if (!conversation) {
        logger.error("No conversation found for reply", { 
            eventId: event.id,
            convRoot,
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

    // Check if orchestrator is waiting for agents to complete
    // Skip orchestrator invocation if there's an active (incomplete) turn
    if (targetAgent === orchestratorAgent && !conversationManager.isCurrentTurnComplete(conversation.id)) {
        // Get detailed information about the current turn
        const currentTurn = conversationManager.getCurrentTurn(conversation.id);
        if (currentTurn) {
            const completedAgents = new Set(currentTurn.completions.map(c => c.agent));
            const pendingAgents = currentTurn.agents.filter(agent => !completedAgents.has(agent));
            const completionStatus = currentTurn.agents.map(agent => {
                const completed = completedAgents.has(agent);
                return `${agent}: ${completed ? '✓' : 'pending'}`;
            });
            
            logInfo(chalk.gray(
                `Orchestrator has active routing - skipping invocation while waiting for agents to complete\n` +
                `  Turn ID: ${currentTurn.turnId}\n` +
                `  Phase: ${currentTurn.phase}\n` +
                `  Agents: [${completionStatus.join(', ')}]\n` +
                `  Pending: [${pendingAgents.join(', ')}]\n` +
                `  Completions: ${currentTurn.completions.length}/${currentTurn.agents.length}`
            ));
        } else {
            logInfo(chalk.gray("Orchestrator has active routing - skipping invocation while waiting for agents to complete"));
        }
        return;
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

    // Extract claude-session from the event or use mapped session
    const claudeSessionId = mappedClaudeSessionId || event.tagValue('claude-session');
    if (claudeSessionId) {
        logInfo(chalk.gray("Passing claude-session to execution context: ") + chalk.cyan(claudeSessionId) +
               (mappedClaudeSessionId ? chalk.gray(" (from task mapping)") : ""));
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
        const errorMessage = formatAnyError(error);

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
