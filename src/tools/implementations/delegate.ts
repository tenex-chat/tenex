import { z } from "zod";
import { createToolDefinition, success, failure } from "../types";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { nip19 } from "nostr-tools";
import { NDKTask } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr/ndkClient";

const delegateSchema = z.object({
    recipients: z
        .union([
            z.string().describe("Single recipient"),
            z.array(z.string()).describe("Multiple recipients")
        ])
        .transform((val) => Array.isArray(val) ? val : [val])
        .describe("Agent slug(s) (e.g., 'architect'), npub(s), or hex pubkey(s) of the recipient agent(s)"),
    fullRequest: z
        .string()
        .describe("The complete request or question to delegate to the recipient agent(s)"),
});

/**
 * Resolve a recipient string to a pubkey
 * @param recipient - Agent slug or npub/hex pubkey
 * @returns Pubkey hex string or null if not found
 */
function resolveRecipientToPubkey(recipient: string): string | null {
    // Check if it's an npub
    if (recipient.startsWith("npub")) {
        try {
            const decoded = nip19.decode(recipient);
            if (decoded.type === "npub") {
                return decoded.data;
            }
        } catch (error) {
            logger.debug("Failed to decode npub", { recipient, error });
        }
    }
    
    // Check if it's a hex pubkey (64 characters)
    if (/^[0-9a-f]{64}$/i.test(recipient)) {
        return recipient.toLowerCase();
    }
    
    // Try to resolve as agent slug
    try {
        const projectContext = getProjectContext();
        
        // Check project agents
        const agent = projectContext.getAgent(recipient);
        if (agent) {
            return agent.pubkey;
        }
        
        // Check built-in agents (already loaded in project context)
        // No need for separate check as they're included in projectContext.agents
        
        logger.debug("Agent slug not found", { recipient });
        return null;
    } catch (error) {
        logger.debug("Failed to resolve agent slug", { recipient, error });
        return null;
    }
}

/**
 * Delegate tool - enables agents to communicate with each other by publishing NDKTask events
 * 
 * This tool allows an agent to delegate a task or question to one or more agents by:
 * 1. Resolving each recipient (agent slug or pubkey) to a pubkey
 * 2. Publishing an NDKTask event for each recipient with p-tag assignment
 * 3. Setting up delegation state so the agent waits for all task completions
 * 
 * Recipients can be:
 * - A single recipient or array of recipients
 * - Agent slugs (e.g., "architect", "planner") - resolved from project agents
 * - Npubs (e.g., "npub1...") - decoded to hex pubkeys
 * - Hex pubkeys (64 characters) - used directly
 * 
 * If any recipient cannot be resolved, the tool fails with an error.
 * 
 * When delegating to multiple recipients, the agent will wait for all task completions
 * before continuing. The agent should NOT call complete() after delegating.
 * 
 * Each delegation creates a formal NDKTask (Nostr kind 1934) event that:
 * - Is assigned to a specific agent via p-tag
 * - Links to the conversation root via e-tag
 * - Tracks status (pending/complete)
 * - Enables parallel execution of sub-tasks
 */
export const delegateTool = createToolDefinition<z.input<typeof delegateSchema>, { success: boolean; recipientPubkeys: string[] }>({
    name: "delegate",
    description: "Delegate a task or question to one or more agents by publishing a reply event with their p-tags",
    promptFragment: `DELEGATE TOOL:
Use this to communicate with other agents by delegating tasks or questions.

Examples:
- delegate("architect", "Design a database schema for user authentication")
- delegate(["architect", "planner"], "Review and plan the new feature implementation")
- delegate("npub1abc...", "Review this implementation for security issues")
- delegate(["executor", "npub1xyz..."], "Implement and test this feature")

IMPORTANT: When you use delegate(), you are handing off work to other agents.
- DO NOT call complete() after delegating - you haven't completed the work yet
- The delegated agents will respond back to you
- Once all responses are received, you'll be invoked again to process them
- THEN you can call complete() with your final answer`,
    schema: delegateSchema as z.ZodType<z.input<typeof delegateSchema>>,
    execute: async (input, context) => {
        const { recipients, fullRequest } = input.value;
        
        // Resolve all recipients to pubkeys
        const resolvedPubkeys: string[] = [];
        const failedRecipients: string[] = [];
        
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
                tool: "delegate",
                message: `Cannot resolve recipient(s) to pubkey: ${failedRecipients.join(", ")}. Must be valid agent slug(s), npub(s), or hex pubkey(s).`,
            });
        }
        
        // If no valid recipients, return error
        if (resolvedPubkeys.length === 0) {
            return failure({
                kind: "execution",
                tool: "delegate",
                message: "No valid recipients provided.",
            });
        }
        
        try {
            // Create NDKTask events for each recipient
            const taskIds: string[] = [];
            const tasks = new Map<string, { recipientPubkey: string; status: string }>();
            
            for (const recipientPubkey of resolvedPubkeys) {
                // Create a new NDKTask for this specific recipient
                const task = new NDKTask(getNDK());
                task.content = fullRequest;
                task.tags = [
                    ["p", recipientPubkey],  // Assign to this agent
                    ["e", context.conversationId, "", "root"],  // Link to conversation (conversation ID is the root event ID)
                    ["status", "pending"],
                ];
                
                // Sign and publish the task
                await task.sign(context.agent.signer);
                await task.publish();
                
                // Track this task
                taskIds.push(task.id);
                tasks.set(task.id, {
                    recipientPubkey,
                    status: "pending"
                });
                
                logger.info("Published NDKTask for delegation", {
                    taskId: task.id,
                    fromAgent: context.agent.slug,
                    toAgent: recipientPubkey,
                });
            }
            
            // Update agent's state to track pending delegation with task IDs
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
                
                logger.info("Delegation state set - agent waiting for task completions", {
                    fromAgent: context.agent.slug,
                    waitingForTasks: taskIds.length,
                    taskIds: taskIds,
                });
            }
            
            logger.info("All NDKTask events published", {
                fromAgent: context.agent.slug,
                toRecipients: recipients,
                toPubkeys: resolvedPubkeys,
                taskCount: taskIds.length,
                requestLength: fullRequest.length,
            });
            
            // The agent will be reactivated when all tasks complete.
            // This is handled in the event handler when task completion events arrive.
            
            return success({
                success: true,
                recipientPubkeys: resolvedPubkeys,
            });
        } catch (error) {
            logger.error("Failed to publish NDKTask events", {
                fromAgent: context.agent.slug,
                toRecipients: recipients,
                error,
            });
            
            return failure({
                kind: "execution",
                tool: "delegate",
                message: `Failed to publish NDKTask events: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    },
});