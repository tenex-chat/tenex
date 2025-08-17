import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import { ExecutionConfig } from "../agents/execution/constants";
import type { ExecutionContext } from "../agents/execution/types";
import type { ConversationManager, Conversation, AgentState } from "../conversations";
import { NostrPublisher } from "../nostr";
import { getProjectContext } from "../services";
import type { AgentInstance } from "../agents/types";
import { formatAnyError } from "../utils/error-formatter";
import { logger } from "../utils/logger";

const logInfo = logger.info.bind(logger);

interface EventHandlerContext {
    conversationManager: ConversationManager;
    agentExecutor: AgentExecutor;
}

interface TaskCompletionResult {
    shouldReactivate: boolean;
    targetAgent?: AgentInstance;
}

/**
 * Main entry point for handling chat messages
 */
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

/**
 * Find the conversation for a reply event, handling task mappings
 */
async function findConversationForReply(
    event: NDKEvent,
    conversationManager: ConversationManager
): Promise<{ conversation: Conversation | undefined; claudeSessionId?: string }> {
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
                        mappedClaudeSessionId = claudeSession;
                    }
                }
            }
        }
    }

    return { conversation, claudeSessionId: mappedClaudeSessionId };
}

/**
 * Handle orphaned replies by creating a new conversation
 */
async function handleOrphanedReply(
    event: NDKEvent,
    conversationManager: ConversationManager,
    mentionedPubkeys: string[]
): Promise<Conversation | undefined> {
    if (event.tagValue("K") !== "11" || mentionedPubkeys.length === 0) {
        return undefined;
    }

    const projectCtx = getProjectContext();
    const isDirectedToAgent = mentionedPubkeys.some((pubkey) => 
        Array.from(projectCtx.agents.values()).some((a) => a.pubkey === pubkey)
    );
    
    if (!isDirectedToAgent) {
        return undefined;
    }

    const convRoot = event.tagValue("E") || event.tagValue("A");
    logInfo(chalk.yellow(`Creating new conversation for orphaned kTag 11 reply to conversation root: ${convRoot}`));
    
    // Create a synthetic root event based on the reply
    const syntheticRootEvent: NDKEvent = {
        ...event,
        id: convRoot || event.id, // Use conversation root if available, otherwise use the reply's ID
        content: `[Orphaned conversation - original root not found]\n\n${event.content}`,
        tags: event.tags.filter(tag => tag[0] !== "E" && tag[0] !== "e"), // Remove reply tags
    } as NDKEvent;
    
    const conversation = await conversationManager.createConversation(syntheticRootEvent);
    
    // Add the actual reply event to the conversation history
    if (conversation && event.id !== conversation.id) {
        await conversationManager.addEvent(conversation.id, event);
    }

    return conversation;
}

/**
 * Determine which agent should handle the event
 */
function determineTargetAgent(
    _event: NDKEvent,
    mentionedPubkeys: string[],
    projectManager: AgentInstance
): AgentInstance {
    let targetAgent = projectManager; // Default to PM for coordination

    // Check for p-tagged agents regardless of sender
    if (mentionedPubkeys.length > 0) {
        const projectCtx = getProjectContext();
        // Find the first p-tagged system agent
        for (const pubkey of mentionedPubkeys) {
            const agent = Array.from(projectCtx.agents.values()).find((a) => a.pubkey === pubkey);
            if (agent) {
                targetAgent = agent;
                break;
            }
        }
    }

    return targetAgent;
}

/**
 * Process a task completion event and update delegation state
 */
async function processTaskCompletion(
    event: NDKEvent,
    conversation: Conversation,
    conversationManager: ConversationManager
): Promise<TaskCompletionResult> {
    const taskId = event.tags.find(tag => tag[0] === "e" && tag[3] === "reply")?.[1];
    
    if (!taskId) {
        return { shouldReactivate: false };
    }

    const projectCtx = getProjectContext();
    
    // Check all agents for pending delegations that include this task
    for (const [agentSlug, agentState] of conversation.agentStates.entries()) {
        if (!agentState.pendingDelegation?.taskIds?.includes(taskId)) {
            continue;
        }

        // Update the task status
        const task = agentState.pendingDelegation.tasks?.get(taskId);
        if (task) {
            task.status = "complete";
            task.response = event.content;
        }
        
        // Check if all tasks are complete
        const allComplete = agentState.pendingDelegation.taskIds.every(tid => {
            const t = agentState.pendingDelegation?.tasks?.get(tid);
            return t?.status === "complete";
        });
        
        if (allComplete) {
            // Clear delegation state - no need to reactivate since
            // the complete() tool now properly tags the main conversation
            const result = await synthesizeAndReactivate(
                agentState,
                agentSlug,
                conversation,
                conversationManager,
                event,
                projectCtx
            );
            return result;
        } else {
            // Log progress
            const completedCount = agentState.pendingDelegation.taskIds.filter(tid => 
                agentState.pendingDelegation?.tasks?.get(tid)?.status === "complete"
            ).length;
            const remainingCount = agentState.pendingDelegation.taskIds.length - completedCount;
            
            logInfo(chalk.gray(`Task ${taskId} completed. Waiting for ${remainingCount} more tasks.`));
            return { shouldReactivate: false };
        }
    }

    return { shouldReactivate: false };
}

/**
 * Clear pending delegation after all tasks complete
 */
async function synthesizeAndReactivate(
    agentState: AgentState,
    agentSlug: string,
    conversation: Conversation,
    conversationManager: ConversationManager,
    event: NDKEvent,
    projectCtx: ReturnType<typeof getProjectContext>
): Promise<TaskCompletionResult> {
    if (!agentState.pendingDelegation) {
        return { shouldReactivate: false };
    }
    
    // Clear the pending delegation
    delete agentState.pendingDelegation;
    await conversationManager.updateAgentState(conversation.id, agentSlug, agentState);
    
    // No need for synthetic events anymore - the complete() tool now properly
    // tags both the task and the root conversation, so the delegating agent
    // will naturally see the completion in the main thread
    logInfo(chalk.green(`All tasks completed for ${agentSlug}. Delegation cleared.`));
    
    return { shouldReactivate: false };
}

/**
 * Check for recent phase transitions that might be handoffs
 */
function getRecentHandoff(conversation: Conversation) {
    if (conversation.phaseTransitions.length === 0) {
        return undefined;
    }

    const recentTransition = conversation.phaseTransitions[conversation.phaseTransitions.length - 1];

    // If this transition was very recent (within last 30 seconds) and has handoff info
    if (
        recentTransition &&
        Date.now() - recentTransition.timestamp < ExecutionConfig.RECENT_TRANSITION_THRESHOLD_MS &&
        recentTransition.summary
    ) {
        return recentTransition;
    }

    return undefined;
}

/**
 * Execute the agent with proper error handling
 */
async function executeAgent(
    executionContext: ExecutionContext,
    agentExecutor: AgentExecutor,
    conversation: Conversation,
    conversationManager: ConversationManager,
    projectManager: AgentInstance,
    event: NDKEvent
): Promise<void> {
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
            agent: projectManager,
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

/**
 * Main reply handling logic - orchestrates all the helper functions
 */
async function handleReplyLogic(
    event: NDKEvent,
    { conversationManager, agentExecutor }: EventHandlerContext,
    mentionedPubkeys: string[]
): Promise<void> {
    // Find the conversation this reply belongs to
    let { conversation, claudeSessionId: mappedClaudeSessionId } = await findConversationForReply(
        event,
        conversationManager
    );

    // Handle orphaned replies if no conversation found
    if (!conversation) {
        conversation = await handleOrphanedReply(event, conversationManager, mentionedPubkeys);
    }

    if (!conversation) {
        logger.error("No conversation found for reply", { 
            eventId: event.id,
            convRoot: event.tagValue("E") || event.tagValue("A"),
            kTag: event.tagValue("K")
        });
        return;
    }

    // Add event to conversation history
    await conversationManager.addEvent(conversation.id, event);

    // Get project context and PM
    const projectCtx = getProjectContext();
    const projectManager = projectCtx.getAgent("project-manager");
    if (!projectManager) {
        throw new Error("Project Manager agent not found - required for conversation coordination");
    }

    // Determine which agent should handle this event
    let targetAgent = determineTargetAgent(event, mentionedPubkeys, projectManager);
    let processedEvent = event;

    // Skip if the target agent is the same as the sender (prevent self-reply loops)
    if (targetAgent.pubkey === event.pubkey) {
        logInfo(chalk.gray(`Skipping self-reply: ${targetAgent.name} would process its own message`));
        logInfo(chalk.yellow(`[DEBUG] Self-reply prevention triggered`), {
            targetAgent: targetAgent.name,
            targetPubkey: targetAgent.pubkey.substring(0, 8),
            eventPubkey: event.pubkey.substring(0, 8),
            eventContent: event.content.substring(0, 50),
            hasToolTag: event.tags.some(t => t[0] === "tool"),
            toolTag: event.tagValue("tool"),
        });
        return;
    }

    // Check if this is a task completion event
    const isTaskCompletion = event.tagValue("status") === "complete" && 
                             event.tags.some(tag => tag[0] === "e" && tag[3] === "reply");
    
    if (isTaskCompletion) {
        const result = await processTaskCompletion(event, conversation, conversationManager);
        
        if (!result.shouldReactivate) {
            // Still waiting for more completions or all complete
            return;
        }
        
        if (result.targetAgent) {
            targetAgent = result.targetAgent;
        }
    }
    
    // Check for recent phase transition handoffs
    const handoff = getRecentHandoff(conversation);

    // Extract claude-session from the event or use mapped session
    const claudeSessionId = mappedClaudeSessionId || processedEvent.tagValue('claude-session');
    if (claudeSessionId) {
        logInfo(chalk.gray("Passing claude-session to execution context: ") + chalk.cyan(claudeSessionId) +
               (mappedClaudeSessionId ? chalk.gray(" (from task mapping)") : ""));
    }

    // Build execution context
    const executionContext: ExecutionContext = {
        agent: targetAgent,
        conversationId: conversation.id,
        phase: conversation.phase,
        projectPath: process.cwd(),
        triggeringEvent: processedEvent,
        publisher: new NostrPublisher({
            conversationId: conversation.id,
            agent: targetAgent,
            triggeringEvent: processedEvent,
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

    // Execute with proper error handling
    await executeAgent(
        executionContext,
        agentExecutor,
        conversation,
        conversationManager,
        projectManager,
        processedEvent
    );
}