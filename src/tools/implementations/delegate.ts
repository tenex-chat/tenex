import { z } from "zod";
import { createToolDefinition, success, failure } from "../types";
import { DelegationService } from "@/services/DelegationService";
import { logger } from "@/utils/logger";

const delegateSchema = z.object({
    recipients: z
        .array(z.string())
        .describe("Array of agent slug(s) (e.g., ['architect']), name(s) (e.g., ['Architect']), npub(s), or hex pubkey(s) of the recipient agent(s)"),
    title: z
        .string()
        .describe("Brief title/summary of the task (e.g., 'Design authentication flow', 'Review database schema')"),
    fullRequest: z
        .string()
        .describe("The complete request or question to delegate to the recipient agent(s)"),
});

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
 * - Agent names (e.g., "Architect", "Planner") - resolved from project agents
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
export const delegateTool = createToolDefinition<z.input<typeof delegateSchema>, { success: boolean; recipientPubkeys: string[]; taskIds: string[] }>({
    name: "delegate",
    description: "Delegate a task or question to one or more agents by publishing a reply event with their p-tags",
    promptFragment: `DELEGATE TOOL:
Use this to communicate with other agents by delegating tasks or questions.
IMPORTANT: recipients must ALWAYS be an array, even for a single recipient.

Examples:
- delegate(["architect"], "Design a database schema for user authentication")
- delegate(["architect", "planner"], "Review and plan the new feature implementation")
- delegate(["npub1abc..."], "Review this implementation for security issues")
- delegate(["executor", "npub1xyz..."], "Implement and test this feature")

IMPORTANT: When you use delegate(), you are handing off work to other agents.
- DO NOT call complete() after delegating - you haven't completed the work yet
- The delegated agents will respond back to you
- Once all responses are received, you'll be invoked again to process them
- THEN you can call complete() with your final answer`,
    schema: delegateSchema as z.ZodType<z.input<typeof delegateSchema>>,
    execute: async (input, context) => {
        const { recipients, fullRequest, title } = input.value;
        
        // Recipients is always an array due to schema validation
        if (!Array.isArray(recipients)) {
            return failure({
                kind: "execution", 
                tool: "delegate",
                message: "Recipients must be an array of strings",
            });
        }
        
        try {
            // Use DelegationService to handle all delegation logic
            // But we'll need to modify it to return events instead of publishing
            const result = await DelegationService.createDelegationTasks(
                {
                    recipients,
                    title,
                    fullRequest
                },
                {
                    agent: context.agent,
                    conversationId: context.conversationId,
                    conversationManager: context.conversationManager
                }
            );
            
            // The agent will be reactivated when all tasks complete.
            // This is handled in the event handler when task completion events arrive.
            
            return success({
                success: true,
                recipientPubkeys: result.recipientPubkeys,
                taskIds: result.taskIds,
                batchId: result.batchId,
                toolType: 'delegate'
            });
        } catch (error) {
            logger.error("Failed to create delegation tasks", {
                fromAgent: context.agent.slug,
                toRecipients: recipients,
                error,
            });
            
            return failure({
                kind: "execution",
                tool: "delegate",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    },
});