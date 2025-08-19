import { NDKTask, type NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import { ExecutionConfig } from "../agents/execution/constants";
import type { ExecutionContext } from "../agents/execution/types";
import type { ConversationManager, Conversation, AgentState } from "../conversations";
import { NostrPublisher } from "../nostr";
import { getProjectContext } from "../services";
import { DelegationService } from "../services/DelegationService";
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
 * Find the conversation for a reply event, handling task mappings
 */
async function findConversationForReply(
    event: NDKEvent,
    conversationManager: ConversationManager
): Promise<{ conversation: Conversation | undefined; claudeSessionId?: string }> {
    const convRoot = event.tagValue("E") || event.tagValue("A");
    
    let conversation = convRoot ? conversationManager.getConversationByEvent(convRoot) : undefined;
    let mappedClaudeSessionId: string | undefined;

    // Check if this is a task completion that should route to parent conversation
    if (event.tagValue("K") === "1934" && 
        event.tagValue("status") === "complete" && 
        event.tagValue("tool") === "complete") {
        const taskId = event.tagValue("E");
        if (taskId) {
            // Check if we have a task mapping to route to parent conversation
            const taskMapping = conversationManager.getTaskMapping(taskId);
            if (taskMapping) {
                const parentConversation = conversationManager.getConversation(taskMapping.conversationId);
                if (parentConversation) {
                    conversation = parentConversation;
                    mappedClaudeSessionId = taskMapping.claudeSessionId;
                    logInfo(chalk.cyan("Task completion routed to parent conversation: ") + 
                           chalk.yellow(taskMapping.conversationId.substring(0, 8)));
                }
            }
        }
    }
    
    // If no conversation found and this is a reply to an NDKTask (K tag = 1934)
    if (!conversation && event.tagValue("K") === "1934") {
        const taskId = event.tagValue("E");
        console.log(`[DEBUG] Checking task mapping for K=1934 event`, {
            hasConversation: !!conversation,
            taskId: taskId?.substring(0, 8),
            eventKind: event.kind,
            hasTool: event.tagValue("tool"),
            hasStatus: event.tagValue("status"),
        });
        
        if (taskId) {
            // First check if we have a task mapping for this task
            const taskMapping = conversationManager.getTaskMapping(taskId);
            console.log(`[DEBUG] Task mapping lookup result`, {
                taskId: taskId.substring(0, 8),
                hasMapping: !!taskMapping,
                mappedConversationId: taskMapping?.conversationId?.substring(0, 8),
            });
            
            if (taskMapping) {
                conversation = conversationManager.getConversation(taskMapping.conversationId);
                mappedClaudeSessionId = taskMapping.claudeSessionId;
                
                if (conversation) {
                    logInfo(chalk.gray("Found conversation via task mapping: ") + 
                           chalk.cyan(taskMapping.conversationId) + 
                           (mappedClaudeSessionId ? chalk.gray(" with session: ") + chalk.cyan(mappedClaudeSessionId) : ""));
                } else {
                    console.log(`[ERROR] Task mapping points to non-existent conversation`, {
                        taskId: taskId.substring(0, 8),
                        mappedConversationId: taskMapping.conversationId,
                    });
                }
            } else {
                console.log(`[DEBUG] No task mapping found, falling back to task as conversation root`);
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
 * Process a task completion event and update delegation state
 */
async function processTaskCompletion(
    event: NDKEvent,
    conversation: Conversation,
    conversationManager: ConversationManager
): Promise<TaskCompletionResult> {
    const taskId = event.tagValue("E");
    console.log('🔍 [processTaskCompletion] Task ID from E tag:', taskId?.substring(0, 8) || 'NONE');
    
    if (!taskId) {
        console.log('❌ [processTaskCompletion] No task ID found in E tag - aborting');
        return { shouldReactivate: false };
    }

    // Use DelegationService to find the parent conversation where delegation state lives
    let conversationToCheck = conversation;
    const parentConversationId = DelegationService.findParentConversationId(event, conversation);
    
    console.log(`[processTaskCompletion] Delegation context resolution`, {
        currentConversationId: conversation.id.substring(0, 8),
        parentConversationId: parentConversationId?.substring(0, 8) || 'none',
        willLoadParent: !!parentConversationId && parentConversationId !== conversation.id,
    });
    
    if (parentConversationId && parentConversationId !== conversation.id) {
        console.log('📍 [processTaskCompletion] Loading parent conversation for delegation state:', parentConversationId.substring(0, 8));
        const parentConversation = conversationManager.getConversation(parentConversationId);
        if (parentConversation) {
            conversationToCheck = parentConversation;
            console.log('✅ [processTaskCompletion] Successfully loaded parent conversation');
        } else {
            console.log('❌ [processTaskCompletion] Failed to load parent conversation');
        }
    }

    // Log what delegations exist in the conversation we're checking
    const delegationInfo = Array.from(conversationToCheck.agentStates.entries())
        .filter(([_, state]) => state.pendingDelegation)
        .map(([agentSlug, state]) => ({
            agent: agentSlug,
            taskCount: state.pendingDelegation?.taskIds?.length || 0,
            taskIds: state.pendingDelegation?.taskIds?.map(id => id.substring(0, 8)) || [],
            fullTaskIds: state.pendingDelegation?.taskIds || []
        }));
    
    console.log('🔍 [processTaskCompletion] Active delegations found:', delegationInfo.length);
    if (delegationInfo.length > 0) {
        console.log('📋 Active delegation details:', JSON.stringify(delegationInfo, null, 2));
        logInfo(chalk.cyan(`Processing task completion ${taskId.substring(0, 8)} for conversation ${conversationToCheck.id.substring(0, 8)}`));
        logInfo(chalk.cyan(`Active delegations:`), delegationInfo);
    } else {
        console.log('⚠️ [processTaskCompletion] NO active delegations found in conversation');
    }
    
    // Check all agents for pending delegations that include this task
    let foundMatchingAgent = false;
    for (const [agentSlug, agentState] of conversationToCheck.agentStates.entries()) {
        if (!agentState.pendingDelegation) {
            console.log(`  ↳ No pending delegation for ${agentSlug}`);
            continue;
        }
        
        console.log(`  ↳ ${agentSlug} has pending delegation with ${agentState.pendingDelegation.taskIds?.length || 0} tasks`);
        console.log(`  ↳ Task IDs:`, agentState.pendingDelegation.taskIds?.map(id => id.substring(0, 8)));
        
        const taskIncluded = agentState.pendingDelegation.taskIds?.includes(taskId);
        console.log(`  ↳ Does ${agentSlug} include task ${taskId.substring(0, 8)}? ${taskIncluded}`);
        
        if (!taskIncluded) {
            continue;
        }

        foundMatchingAgent = true;
        console.log(`✅ [processTaskCompletion] Found matching agent: ${agentSlug}`);

        // Update the task status
        const task = agentState.pendingDelegation.tasks?.get(taskId);
        console.log(`🔍 [processTaskCompletion] Task object exists in Map?`, task !== undefined);
        
        if (task) {
            console.log(`  ↳ Previous status: ${task.status}`);
            task.status = "complete";
            task.response = event.content;
            console.log(`  ↳ Updated status to: complete`);
        } else {
            console.log(`⚠️ Task ${taskId.substring(0, 8)} not found in tasks Map for ${agentSlug}`);
        }
        
        // Check if all tasks are complete
        console.log(`🔍 [processTaskCompletion] Checking if all tasks are complete for ${agentSlug}...`);
        const taskStatusDetails = agentState.pendingDelegation.taskIds.map(tid => {
            const t = agentState.pendingDelegation?.tasks?.get(tid);
            return {
                id: tid.substring(0, 8),
                status: t?.status || 'NOT_FOUND',
                hasTask: t !== undefined
            };
        });
        console.log(`  ↳ Task status details:`, JSON.stringify(taskStatusDetails, null, 2));
        
        const allComplete = agentState.pendingDelegation.taskIds.every(tid => {
            const t = agentState.pendingDelegation?.tasks?.get(tid);
            const isComplete = t?.status === "complete";
            console.log(`    - Task ${tid.substring(0, 8)}: ${isComplete ? 'COMPLETE' : `INCOMPLETE (status: ${t?.status || 'NOT_FOUND'})`}`);
            return isComplete;
        });
        
        console.log(`📊 [processTaskCompletion] All tasks complete for ${agentSlug}? ${allComplete}`);
        
        if (allComplete) {
            console.log(`🎉 [processTaskCompletion] All tasks complete! Calling synthesizeAndReactivate for ${agentSlug}`);
            // Clear delegation state - no need to reactivate since
            // the complete() tool now properly tags the main conversation
            const result = await synthesizeAndReactivate(
                agentState,
                agentSlug,
                conversationToCheck,  // Use the root conversation, not the task conversation
                conversationManager
            );
            console.log(`🔍 [processTaskCompletion] synthesizeAndReactivate returned:`, {
                shouldReactivate: result.shouldReactivate,
                targetAgent: result.targetAgent ? {
                    name: result.targetAgent.name,
                    pubkey: result.targetAgent.pubkey
                } : undefined,
                replyTarget: result.replyTarget?.id?.substring(0, 8)
            });
            return result;
        } else {
            // Log progress with detailed task information
            const completedCount = agentState.pendingDelegation.taskIds.filter(tid => 
                agentState.pendingDelegation?.tasks?.get(tid)?.status === "complete"
            ).length;
            const remainingCount = agentState.pendingDelegation.taskIds.length - completedCount;
            
            console.log(`⏳ [processTaskCompletion] Progress: ${completedCount}/${agentState.pendingDelegation.taskIds.length} tasks complete`);
            
            // Show detailed task status
            const taskStatuses = agentState.pendingDelegation.taskIds.map(tid => {
                const task = agentState.pendingDelegation?.tasks?.get(tid);
                return {
                    id: tid.substring(0, 8),
                    status: task?.status || 'unknown',
                    delegatedTo: task?.delegatedAgent || 'unknown'
                };
            });
            
            logInfo(chalk.gray(`Task ${taskId.substring(0, 8)} completed. Waiting for ${remainingCount} more tasks.`));
            logInfo(chalk.gray(`Task statuses for ${agentSlug}:`), taskStatuses);
            
            return { shouldReactivate: false };
        }
    }
    
    if (!foundMatchingAgent) {
        console.log(`❌ [processTaskCompletion] No agent found with task ${taskId.substring(0, 8)} in their pending delegation`);
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
    conversationManager: ConversationManager
): Promise<TaskCompletionResult> {
    console.log(`🔍 [synthesizeAndReactivate] START for agent ${agentSlug}`);
    
    if (!agentState.pendingDelegation) {
        console.log(`⚠️ [synthesizeAndReactivate] No pending delegation for ${agentSlug} - returning false`);
        return { shouldReactivate: false };
    }
    
    console.log(`📋 [synthesizeAndReactivate] Delegation details before clearing:`, {
        agent: agentSlug,
        taskCount: agentState.pendingDelegation.taskIds?.length,
        taskIds: agentState.pendingDelegation.taskIds?.map(id => id.substring(0, 8))
    });
    
    // Clear the pending delegation
    delete agentState.pendingDelegation;
    console.log(`✅ [synthesizeAndReactivate] Cleared pending delegation from agent state`);
    
    await conversationManager.updateAgentState(conversation.id, agentSlug, agentState);
    console.log(`✅ [synthesizeAndReactivate] Updated agent state in conversation manager`);
    
    // Find the original user request to use as reply target
    const projectCtx = getProjectContext();
    const agentPubkeys = new Set(
        Array.from(projectCtx.agents.values()).map(a => a.pubkey)
    );
    
    // Also exclude the project pubkey (which may not be in agents list)
    agentPubkeys.add(projectCtx.pubkey);
    
    // Find first non-agent event (the original user request)
    const originalUserEvent = conversation.history?.find(
        e => !agentPubkeys.has(e.pubkey)
    );
    
    if (originalUserEvent) {
        console.log(`📍 [synthesizeAndReactivate] Found original user event to reply to:`, {
            eventId: originalUserEvent.id?.substring(0, 8),
            userPubkey: originalUserEvent.pubkey?.substring(0, 8),
            content: originalUserEvent.content?.substring(0, 50)
        });
    } else {
        console.log(`⚠️ [synthesizeAndReactivate] No original user event found in conversation`, {
            conversationId: conversation.id.substring(0, 8),
            eventCount: conversation.history?.length || 0,
            agentPubkeys: Array.from(agentPubkeys).map(p => p.substring(0, 8))
        });
    }
    
    const targetAgent = projectCtx.getAgent(agentSlug);
    
    logInfo(chalk.green(`All tasks completed for ${agentSlug}. Delegation cleared.`));
    
    console.log(`🔍 [synthesizeAndReactivate] Returning shouldReactivate: true with reply target`);
    return { 
        shouldReactivate: true,
        targetAgent,
        replyTarget: originalUserEvent
    };
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