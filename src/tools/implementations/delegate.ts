import { z } from "zod";
import { createToolDefinition, success, failure } from "../types";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { nip19 } from "nostr-tools";

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
 * Delegate tool - enables agents to communicate with each other by publishing reply events with p-tags
 * 
 * This tool allows an agent to delegate a task or question to one or more agents by:
 * 1. Resolving each recipient (agent slug or pubkey) to a pubkey
 * 2. Publishing a reply event with all recipients' pubkeys as p-tags
 * 3. Setting up delegation state so the agent waits for all responses
 * 
 * Recipients can be:
 * - A single recipient or array of recipients
 * - Agent slugs (e.g., "architect", "planner") - resolved from project agents
 * - Npubs (e.g., "npub1...") - decoded to hex pubkeys
 * - Hex pubkeys (64 characters) - used directly
 * 
 * If any recipient cannot be resolved, the tool fails with an error.
 * 
 * When delegating to multiple recipients, the agent will wait for all responses
 * before continuing. The agent should NOT call complete() after delegating.
 */
export const delegateTool = createToolDefinition<z.infer<typeof delegateSchema>, { success: boolean; recipientPubkeys: string[] }>({
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
    schema: delegateSchema,
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
            // Publish delegation event using the publisher from context
            await context.publisher.publishResponse({
                content: fullRequest,
                destinationPubkeys: resolvedPubkeys,
            });
            
            // Update agent's state to track pending delegation
            if (context.conversationManager) {
                await context.conversationManager.updateAgentState(
                    context.conversationId,
                    context.agent.slug,
                    {
                        pendingDelegation: {
                            expectedFrom: resolvedPubkeys,
                            receivedResponses: new Map(),
                            originalRequest: fullRequest,
                            timestamp: Date.now(),
                        }
                    }
                );
                
                logger.info("Delegation state set - agent waiting for responses", {
                    fromAgent: context.agent.slug,
                    waitingFor: resolvedPubkeys.length,
                    recipients: recipients,
                });
            }
            
            logger.info("Delegation event published", {
                fromAgent: context.agent.slug,
                toRecipients: recipients,
                toPubkeys: resolvedPubkeys,
                recipientCount: resolvedPubkeys.length,
                requestLength: fullRequest.length,
            });
            
            // TODO: Handle delegation timeouts
            // Problem: If a delegated agent never responds, the delegating agent 
            // will wait forever. Need a mechanism to:
            // - Check age of pendingDelegation.timestamp
            // - Decide when to proceed with partial responses
            // - Or re-delegate/give up after timeout
            
            return success({
                success: true,
                recipientPubkeys: resolvedPubkeys,
            });
        } catch (error) {
            logger.error("Failed to publish delegation event", {
                fromAgent: context.agent.slug,
                toRecipients: recipients,
                error,
            });
            
            return failure({
                kind: "execution",
                tool: "delegate",
                message: `Failed to publish delegation event: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    },
});