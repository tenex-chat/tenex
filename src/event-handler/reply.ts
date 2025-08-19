import { NDKTask, type NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import { ExecutionConfig } from "../agents/execution/constants";
import type { ExecutionContext } from "../agents/execution/types";
import type { ConversationManager, Conversation } from "../conversations";
import { NostrPublisher } from "../nostr";
import { getProjectContext } from "../services";
import { DelegationRegistry } from "../services/DelegationRegistry";
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
    replyTarget?: NDKEvent;
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
 * Find the conversation for a reply event
 */
async function findConversationForReply(
    event: NDKEvent,
    conversationManager: ConversationManager
): Promise<{ conversation: Conversation | undefined; claudeSessionId?: string }> {
    const convRoot = event.tagValue("E") || event.tagValue("A");
    
    let conversation = convRoot ? conversationManager.getConversationByEvent(convRoot) : undefined;
    let mappedClaudeSessionId: string | undefined;

    // Check if this is a task completion - use registry to find parent conversation
    if (event.tagValue("K") === "1934" && 
        event.tagValue("status") === "complete" && 
        event.tagValue("tool") === "complete") {
        const taskId = event.tagValue("E");
        if (taskId) {
            // Use DelegationRegistry to find the parent conversation
            const registry = DelegationRegistry.getInstance();
            const delegationContext = registry.getDelegationContext(taskId);
            if (delegationContext) {
                const parentConversation = conversationManager.getConversation(delegationContext.delegatingAgent.conversationId);
                if (parentConversation) {
                    conversation = parentConversation;
                    logInfo(chalk.cyan("Task completion routed to parent conversation: ") + 
                           chalk.yellow(delegationContext.delegatingAgent.conversationId.substring(0, 8)));
                }
            }
        }
    }
    
    // If no conversation found and this is a reply to an NDKTask (K tag = 1934)
    if (!conversation && event.tagValue("K") === "1934") {
        const taskId = event.tagValue("E");
        logger.debug(`Checking for conversation for K=1934 event`, {
            hasConversation: !!conversation,
            taskId: taskId?.substring(0, 8),
            eventKind: event.kind,
            hasTool: event.tagValue("tool"),
            hasStatus: event.tagValue("status"),
        });
        
        if (taskId) {
            // Use DelegationRegistry to find the parent conversation
            const registry = DelegationRegistry.getInstance();
            const delegationContext = registry.getDelegationContext(taskId);
            
            if (delegationContext) {
                conversation = conversationManager.getConversation(delegationContext.delegatingAgent.conversationId);
                
                if (conversation) {
                    logInfo(chalk.gray("Found conversation via delegation registry: ") + 
                           chalk.cyan(delegationContext.delegatingAgent.conversationId));
                } else {
                    logger.error(`Delegation context points to non-existent conversation`, {
                        taskId: taskId.substring(0, 8),
                        conversationId: delegationContext.delegatingAgent.conversationId,
                    });
                }
            } else {
                logger.debug(`No delegation context found, falling back to task as conversation root`);
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
    event: NDKEvent,
    mentionedPubkeys: string[],
    projectManager: AgentInstance
): AgentInstance | null {
    const projectCtx = getProjectContext();
    
    // Check if the event author is an agent in the system
    const isAuthorAnAgent = Array.from(projectCtx.agents.values()).some(
        (agent) => agent.pubkey === event.pubkey
    );

    // Check for p-tagged agents regardless of sender
    if (mentionedPubkeys.length > 0) {
        // Find the first p-tagged system agent
        for (const pubkey of mentionedPubkeys) {
            const agent = Array.from(projectCtx.agents.values()).find((a) => a.pubkey === pubkey);
            if (agent) {
                return agent;
            }
        }
    }

    // If no p-tags and the author is an agent, don't route it anywhere
    if (mentionedPubkeys.length === 0 && isAuthorAnAgent) {
        logInfo(chalk.gray(`Agent event from ${event.pubkey.substring(0, 8)} without p-tags - not routing`));
        return null;
    }

    // Default to PM for coordination only if it's from a user (not an agent)
    return projectManager;
}

/**
 * Process a task completion event using the DelegationRegistry
 */
async function processTaskCompletion(
    event: NDKEvent,
    conversation: Conversation,
    conversationManager: ConversationManager
): Promise<TaskCompletionResult> {
    const taskId = event.tagValue("E");
    logger.debug('[processTaskCompletion] Task ID from E tag:', taskId?.substring(0, 8) || 'NONE');
    
    if (!taskId) {
        logger.debug('[processTaskCompletion] No task ID found in E tag - aborting');
        return { shouldReactivate: false };
    }

    // Use DelegationRegistry to get context directly
    const registry = DelegationRegistry.getInstance();
    const delegationContext = registry.getDelegationContext(taskId);
    
    if (!delegationContext) {
        logger.warn('[processTaskCompletion] No delegation context found for task', { 
            taskId: taskId.substring(0, 8) 
        });
        return { shouldReactivate: false };
    }
    
    logger.debug('[processTaskCompletion] Found delegation context', {
        taskId: taskId.substring(0, 8),
        delegatingAgent: delegationContext.delegatingAgent.slug,
        status: delegationContext.status,
        batchId: delegationContext.delegationBatchId
    });
    
    // Record the completion in the registry
    try {
        const result = await registry.recordTaskCompletion({
            taskId,
            completionEventId: event.id,
            response: event.content,
            summary: event.tagValue("summary"),
            completedBy: event.pubkey
        });
        
        logger.info('[processTaskCompletion] Task completion recorded', {
            taskId: taskId.substring(0, 8),
            batchComplete: result.batchComplete,
            remainingTasks: result.remainingTasks,
            batchId: result.batchId
        });
        
        if (result.batchComplete) {
            logger.info('[processTaskCompletion] All tasks complete, reactivating agent', {
                agent: result.delegatingAgentSlug,
                batchId: result.batchId
            });
            
            // Get all completions for synthesis
            const completions = registry.getBatchCompletions(result.batchId);
            
            // Find the target agent
            const targetAgent = getProjectContext().getAgent(result.delegatingAgentSlug);
            if (!targetAgent) {
                logger.error('[processTaskCompletion] Could not find delegating agent', {
                    agentSlug: result.delegatingAgentSlug
                });
                return { shouldReactivate: false };
            }
            
            // Find the original user request to use as reply target
            const delegatingConversation = conversationManager.getConversation(result.conversationId);
            if (!delegatingConversation) {
                logger.warn('[processTaskCompletion] Could not find delegating conversation', {
                    conversationId: result.conversationId.substring(0, 8)
                });
                return { shouldReactivate: true, targetAgent };
            }
            
            // Find first non-agent event (the original user request)
            const projectCtx = getProjectContext();
            const agentPubkeys = new Set([
                projectCtx.pubkey,
                ...Array.from(projectCtx.agents.values()).map(a => a.pubkey)
            ]);
            
            const originalUserEvent = delegatingConversation.history?.find(
                e => !agentPubkeys.has(e.pubkey)
            );
            
            if (originalUserEvent) {
                logger.debug('[processTaskCompletion] Found original user event to reply to', {
                    eventId: originalUserEvent.id?.substring(0, 8),
                    userPubkey: originalUserEvent.pubkey?.substring(0, 8)
                });
            }
            
            return {
                shouldReactivate: true,
                targetAgent,
                replyTarget: originalUserEvent
            };
        } else {
            logInfo(chalk.gray(`Task ${taskId.substring(0, 8)} completed. Waiting for ${result.remainingTasks} more tasks.`));
            return { shouldReactivate: false };
        }
    } catch (error) {
        logger.error('[processTaskCompletion] Failed to record task completion', {
            taskId: taskId.substring(0, 8),
            error
        });
        return { shouldReactivate: false };
    }
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

        // Use AgentPublisher to publish error
        const { AgentPublisher } = await import("@/nostr/AgentPublisher");
        const agentPublisher = new AgentPublisher(projectManager);
        
        await agentPublisher.error(
            {
                type: 'error',
                message: displayMessage,
                errorType: isCreditsError ? 'insufficient_credits' : 'execution_error'
            },
            {
                agent: projectManager,
                triggeringEvent: event,
                conversationId: conversation.id
            }
        );

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
    const processedEvent = event;

    // If no target agent (e.g., agent event without p-tags), skip processing
    if (!targetAgent) {
        return;
    }

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
    const isTaskCompletion = (
        event.tagValue("status") === "complete" && 
        event.tags.some(tag => tag[0] === "e" && tag[3] === "reply")
    ) || (
        // if it's an event p-tagging the author of the root event and the root event is a task
        event.tagValue("K") === NDKTask.kind.toString() && event.tagValue("P") === event.tagValue("p")
    )

    console.log({ isTaskCompletion });
    console.log(event.inspect);
    
    let replyTarget: NDKEvent | undefined;
    let taskCompletionResult: TaskCompletionResult | undefined;
    
    if (isTaskCompletion) {
        taskCompletionResult = await processTaskCompletion(event, conversation, conversationManager);
        
        if (!taskCompletionResult.shouldReactivate) {
            console.log("Still waiting for more completions or all complete", taskCompletionResult);
            // Still waiting for more completions or all complete
            return;
        }
        
        if (taskCompletionResult.targetAgent) {
            targetAgent = taskCompletionResult.targetAgent;
        }
        
        if (taskCompletionResult.replyTarget) {
            replyTarget = taskCompletionResult.replyTarget;
            logInfo(chalk.cyan(`Task completion will reply to original user event: ${replyTarget.id?.substring(0, 8)}`));
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
        replyTarget: replyTarget,  // Pass the reply target if we have one
        publisher: new NostrPublisher({
            conversationId: conversation.id,
            agent: targetAgent,
            triggeringEvent: processedEvent,  // Keep the actual triggering event
            replyTarget: replyTarget,  // Pass the reply target separately
            conversationManager,
        }),
        conversationManager,
        claudeSessionId,
        agentExecutor, // Pass the executor so continue() can use it
        // Add flag to indicate this is a reactivation after task completion
        isTaskCompletionReactivation: isTaskCompletion && taskCompletionResult?.shouldReactivate,
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