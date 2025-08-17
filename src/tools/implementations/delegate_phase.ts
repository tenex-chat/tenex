import { z } from "zod";
import { createToolDefinition, success, failure } from "../types";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { NDKTask, NDKUser } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr/ndkClient";
import { PHASES, type Phase } from "@/conversations/phases";

const delegatePhaseSchema = z.object({
    phase: z.enum([
        PHASES.CHAT,
        PHASES.BRAINSTORM,
        PHASES.PLAN,
        PHASES.EXECUTE,
        PHASES.VERIFICATION,
        PHASES.CHORES,
        PHASES.REFLECTION
    ] as const).describe("The phase to switch to"),
    recipients: z
        .array(z.string())
        .describe("Array of agent slug(s) (e.g., ['architect']), name(s) (e.g., ['Architect']), npub(s), or hex pubkey(s) to delegate to in this phase"),
    title: z
        .string()
        .describe("Brief title/summary of the task (e.g., 'Design authentication flow', 'Review database schema')"),
    fullRequest: z
        .string()
        .describe("The complete request or question to delegate - this becomes the phase reason and delegation content"),
});

/**
 * Resolve a recipient string to a pubkey
 * @param recipient - Agent slug or npub/hex pubkey
 * @returns Pubkey hex string or null if not found
 */
function resolveRecipientToPubkey(recipient: string): string | null {
    // Trim whitespace
    recipient = recipient.trim();
    
    // Check if it's an npub
    if (recipient.startsWith("npub")) {
        try {
            return new NDKUser({ npub: recipient }).pubkey;
        } catch (error) {
            logger.debug("Failed to decode npub", { recipient, error });
        }
    }
    
    // Check if it's a hex pubkey (64 characters)
    if (/^[0-9a-f]{64}$/i.test(recipient)) {
        return recipient.toLowerCase();
    }
    
    // Try to resolve as agent slug or name (case-insensitive)
    try {
        const projectContext = getProjectContext();
        
        // Check project agents with case-insensitive matching for both slug and name
        const recipientLower = recipient.toLowerCase();
        for (const [slug, agent] of projectContext.agents.entries()) {
            if (slug.toLowerCase() === recipientLower || 
                agent.name.toLowerCase() === recipientLower) {
                return agent.pubkey;
            }
        }
        
        logger.debug("Agent slug or name not found", { recipient });
        return null;
    } catch (error) {
        logger.debug("Failed to resolve agent slug or name", { recipient, error });
        return null;
    }
}

/**
 * Delegate Phase tool - enables the Project Manager to atomically switch phases and delegate work
 * 
 * This tool combines phase switching with task delegation, ensuring the PM always:
 * 1. Switches to the appropriate phase for the work being done
 * 2. Delegates the task to the appropriate specialist agent(s)
 * 3. Sets up proper event-driven callbacks for task completion
 * 
 * The fullRequest serves dual purpose:
 * - Becomes the phase transition reason (context for all agents)
 * - Is the actual task delegated to the specified recipients
 * 
 * Recipients can be:
 * - Agent slugs (e.g., "architect", "planner") - resolved from project agents
 * - Agent names (e.g., "Architect", "Planner") - resolved from project agents
 * - Npubs (e.g., "npub1...") - decoded to hex pubkeys
 * - Hex pubkeys (64 characters) - used directly
 * 
 * When delegating to multiple recipients, the PM will wait for all task completions
 * before continuing. The PM should NOT call complete() after delegating.
 * 
 * Each delegation creates a formal NDKTask (Nostr kind 1934) event that:
 * - Is assigned to specific agent(s) via p-tag
 * - Links to the conversation root via e-tag
 * - Tracks status (pending/complete)
 * - Enables parallel execution of sub-tasks
 */
export const delegatePhaseTool = createToolDefinition<z.input<typeof delegatePhaseSchema>, { 
    success: boolean; 
    phase: Phase;
    recipientPubkeys: string[]; 
    taskIds: string[] 
}>({
    name: "delegate_phase",
    description: "Switch conversation phase and delegate work to specialist agents atomically. Only available to the Project Manager.",
    promptFragment: `DELEGATE PHASE TOOL:
Use this to switch phases AND delegate work to specialist agents in one atomic operation.
This ensures proper workflow coordination and phase leadership.

IMPORTANT: 
- recipients must ALWAYS be an array, even for a single recipient
- The fullRequest serves as both the phase reason AND the delegation content
- DO NOT call complete() after delegating - wait for agents to respond

Examples:
- delegate_phase("PLAN", ["planner"], "Design authentication system", "Create implementation plan for user authentication with OAuth2 and JWT")
- delegate_phase("EXECUTE", ["executor"], "Implement password reset", "Implement the password reset functionality as planned")
- delegate_phase("VERIFICATION", ["executor", "architect"], "Verify deployment", "Verify the deployment pipeline works correctly")

Phase Leadership Pattern:
- PLAN phase → delegate to planner
- EXECUTE phase → delegate to executor  
- VERIFICATION phase → delegate to executor or QA specialist
- REFLECTION phase → you handle this yourself

After delegating:
- You go dormant and wait for responses
- When all tasks complete, you're reactivated
- Then decide the next phase transition`,
    schema: delegatePhaseSchema as z.ZodType<z.input<typeof delegatePhaseSchema>>,
    execute: async (input, context) => {
        const { phase, recipients, fullRequest, title } = input.value;
        
        // Verify this is the PM (belt and suspenders - should already be restricted by toolset)
        if (context.agent.slug !== "project-manager") {
            logger.warn("[delegate_phase] Non-PM agent attempted to use delegate_phase", {
                agent: context.agent.name,
                slug: context.agent.slug
            });
            return failure({
                kind: "execution",
                tool: "delegate_phase",
                message: "Only the Project Manager can use delegate_phase"
            });
        }
        
        // Recipients is always an array due to schema validation
        if (!Array.isArray(recipients)) {
            return failure({
                kind: "execution", 
                tool: "delegate_phase",
                message: "Recipients must be an array of strings",
            });
        }
        
        // Resolve all recipients to pubkeys
        const resolvedPubkeys: string[] = [];
        const failedRecipients: string[] = [];

        console.log('tool delegate_phase', { ...input.value, recipients })
        
        for (const recipient of recipients) {
            const pubkey = resolveRecipientToPubkey(recipient);
            if (pubkey) {
                resolvedPubkeys.push(pubkey);
            } else {
                failedRecipients.push(recipient);
            }
        }
        
        // If any recipients failed to resolve, return error
        if (failedRecipients.length > 0) {
            return failure({
                kind: "execution",
                tool: "delegate_phase",
                message: `Cannot resolve recipient(s) to pubkey: ${failedRecipients.join(", ")}. Must be valid agent slug(s), npub(s), or hex pubkey(s).`,
            });
        }
        
        // If no valid recipients, return error
        if (resolvedPubkeys.length === 0) {
            return failure({
                kind: "execution",
                tool: "delegate_phase",
                message: "No valid recipients provided.",
            });
        }
        
        try {
            // Step 1: Switch the phase
            logger.info("[delegate_phase] PM switching phase", {
                fromPhase: context.phase,
                toPhase: phase,
                reason: fullRequest,
                agent: context.agent.name,
                conversationId: context.conversationId
            });

            // Update conversation phase through ConversationManager
            const updateResult = await context.conversationManager.updatePhase(
                context.conversationId,
                phase,
                fullRequest, // The delegation request becomes the phase transition message
                context.agent.pubkey,
                context.agent.name,
                fullRequest, // Also store as the reason
                `Switching to ${phase} phase: ${title}` // Summary for history
            );

            if (!updateResult) {
                return failure({
                    kind: "execution",
                    tool: "delegate_phase",
                    message: `Failed to switch to ${phase} phase`
                });
            }
            
            // Step 2: Create and publish NDKTask events for each recipient
            const taskIds: string[] = [];
            const tasks = new Map<string, { recipientPubkey: string; status: string }>();
            
            for (const recipientPubkey of resolvedPubkeys) {
                // Create a new NDKTask for this specific recipient
                const task = new NDKTask(getNDK());
                task.content = fullRequest;
                task.tags = [
                    ["p", recipientPubkey],  // Assign to this agent
                    ["e", context.conversationId, "", "root"],  // Link to conversation (conversation ID is the root event ID)
                    ["title", title],  // Task title for better organization
                    ["phase", phase],  // Include phase context
                ];
                
                // Sign and publish immediately
                await task.sign(context.agent.signer);
                await task.publish();
                
                // Track this task
                taskIds.push(task.id);
                tasks.set(task.id, {
                    recipientPubkey,
                    status: "pending"
                });
                
                logger.debug("Published NDKTask in phase context", {
                    taskId: task.id,
                    phase: phase,
                    fromAgent: context.agent.slug,
                    toAgent: recipientPubkey,
                });
            }
            
            // Step 3: Update agent's state to track pending delegation with task IDs
            if (context.conversationManager) {
                await context.conversationManager.updateAgentState(
                    context.conversationId,
                    context.agent.slug,
                    {
                        pendingDelegation: {
                            taskIds: taskIds,
                            tasks: tasks,
                            originalRequest: fullRequest,
                            timestamp: Date.now(),
                        }
                    }
                );
                
                logger.info("Phase delegation complete - PM waiting for task completions", {
                    phase: phase,
                    fromAgent: context.agent.slug,
                    waitingForTasks: taskIds.length,
                    taskIds: taskIds,
                });
            }
            
            logger.info("Phase switch and delegation complete", {
                phase: phase,
                fromAgent: context.agent.slug,
                toRecipients: recipients,
                toPubkeys: resolvedPubkeys,
                taskCount: taskIds.length,
                requestLength: fullRequest.length,
            });
            
            // The PM will be reactivated when all tasks complete.
            // This is handled in the event handler when task completion events arrive.
            
            // Return success with phase and delegation info
            return success({
                success: true,
                phase: phase,
                recipientPubkeys: resolvedPubkeys,
                taskIds: taskIds,
            });
        } catch (error) {
            logger.error("Failed to execute phase delegation", {
                phase: phase,
                fromAgent: context.agent.slug,
                toRecipients: recipients,
                error,
            });
            
            return failure({
                kind: "execution",
                tool: "delegate_phase",
                message: `Failed to execute phase delegation: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    },
});