import { z } from "zod";
import { createToolDefinition, success, failure } from "../types";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";
import { PHASES, type Phase } from "@/conversations/phases";
import type { DelegationIntent, PhaseUpdateIntent } from "@/nostr/AgentEventEncoder";

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
    recipient: z
        .string()
        .describe("Agent slug (e.g., 'architect'), name (e.g., 'Architect'), npub, or hex pubkey to delegate to in this phase"),
    title: z
        .string()
        .describe("Brief title/summary of the task (e.g., 'Design authentication flow', 'Review database schema')"),
    fullRequest: z
        .string()
        .describe("The complete request or question to delegate - this becomes the phase reason and delegation content"),
});

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
 * Recipient can be:
 * - Agent slug (e.g., "architect", "planner") - resolved from project agents
 * - Agent name (e.g., "Architect", "Planner") - resolved from project agents
 * - Npub (e.g., "npub1...") - decoded to hex pubkeys
 * - Hex pubkey (64 characters) - used directly
 * 
 * The PM will wait for the task completion before continuing.
 * The PM should NOT call complete() after delegating.
 * 
 * Each delegation creates a formal NDKTask (Nostr kind 1934) event that:
 * - Is assigned to specific agent(s) via p-tag
 * - Links to the conversation root via e-tag
 * - Tracks status (pending/complete)
 * - Enables parallel execution of sub-tasks
 */

interface DelegatePhaseOutput {
    delegation: DelegationIntent;
    phaseUpdate: PhaseUpdateIntent;
}

export const delegatePhaseTool = createToolDefinition<z.input<typeof delegatePhaseSchema>, DelegatePhaseOutput>({
    name: "delegate_phase",
    description: "Switch conversation phase and delegate work to specialist agents atomically. Only available to the Project Manager.",
    promptFragment: `DELEGATE PHASE TOOL:
Use this to switch phases AND delegate work to specialist agents in one atomic operation.
This ensures proper workflow coordination and phase leadership.

IMPORTANT: 
- recipient is a single agent string (not an array)
- The fullRequest serves as both the phase reason AND the delegation content
- DO NOT call complete() after delegating - wait for agents to respond

Examples:
- delegate_phase("PLAN", "planner", "Design authentication system", "Create implementation plan for user authentication with OAuth2 and JWT")
- delegate_phase("EXECUTE", "executor", "Implement password reset", "Implement the password reset functionality as planned")
- delegate_phase("VERIFICATION", "executor", "Verify deployment", "Verify the deployment pipeline works correctly")

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
        const { phase, recipient, fullRequest, title } = input.value;
        
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
        
        // Validate recipient is a string
        if (typeof recipient !== 'string' || !recipient.trim()) {
            return failure({
                kind: "execution", 
                tool: "delegate_phase",
                message: "Recipient must be a non-empty string",
            });
        }
        
        try {
            // Step 1: Log the phase switch intention
            logger.info("[delegate_phase] PM intending to switch phase", {
                fromPhase: context.phase,
                toPhase: phase,
                reason: fullRequest,
                agent: context.agent.name,
                conversationId: context.conversationId
            });
            
            // Step 2: Resolve recipient to pubkey
            const pubkey = resolveRecipientToPubkey(recipient);
            if (!pubkey) {
                return failure({
                    kind: "execution",
                    tool: "delegate_phase",
                    message: `Cannot resolve recipient to pubkey: ${recipient}. Must be valid agent slug, npub, or hex pubkey.`
                });
            }
            
            // Create phase update intent
            const phaseUpdate: PhaseUpdateIntent = {
                type: 'phase_update',
                phase: phase,
                reason: fullRequest,
                summary: `Switching to ${phase} phase: ${title}`
            };
            
            // Create delegation intent
            const delegation: DelegationIntent = {
                type: 'delegation',
                recipients: [pubkey],
                title: title,
                request: fullRequest,
                phase: phase  // Include phase in the intent
            };
            
            logger.debug("[delegate_phase() tool] Returning intents for phase update and delegation", {
                fromAgent: context.agent.slug,
                toRecipient: recipient,
                toPubkey: pubkey,
                phase: phase
            });
            
            // Return both intents
            return success({
                delegation,
                phaseUpdate
            });
        } catch (error) {
            logger.error("Failed to execute phase delegation", {
                phase: phase,
                fromAgent: context.agent.slug,
                toRecipient: recipient,
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