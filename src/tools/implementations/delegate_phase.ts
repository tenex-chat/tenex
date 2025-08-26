import { PHASES } from "@/conversations/phases";
import { DelegationService, type DelegationResponses } from "@/services/DelegationService";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";
import { z } from "zod";
import { createToolDefinition, failure, success } from "../types";

const delegatePhaseSchema = z.object({
  phase: z
    .enum([
      PHASES.CHAT,
      PHASES.BRAINSTORM,
      PHASES.PLAN,
      PHASES.EXECUTE,
      PHASES.VERIFICATION,
      PHASES.CHORES,
      PHASES.REFLECTION,
    ] as const)
    .describe("The phase to switch to"),
  recipient: z
    .string()
    .describe(
      "Agent slug (e.g., 'architect'), name (e.g., 'Architect'), npub, or hex pubkey to delegate to in this phase"
    ),
  fullRequest: z
    .string()
    .describe(
      "The complete request or question to delegate - this becomes the phase reason and delegation content"
    ),
  title: z
    .string()
    .optional()
    .describe("Title for this conversation (if not already set)"),
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
 * - Npub (e.g., "npub1...") - decoded to hex pubkey
 * - Hex pubkey (64 characters) - used directly
 *
 * If recipient cannot be resolved, the tool fails with an error.
 *
 * The agent should NOT call complete() after using delegate_phase.
 */
export const delegatePhaseTool = createToolDefinition<
  z.input<typeof delegatePhaseSchema>,
  DelegationResponses
>({
  name: "delegate_phase",
  description:
    "Switch conversation phase and delegate a task to a specific agent (Project Manager only)",
  promptFragment: `DELEGATE_PHASE TOOL (Project Manager ONLY):
Use this to atomically switch phases and delegate work to specialist agents.
This tool combines phase transition with task delegation.

Examples:
- delegate_phase("PLAN", "planner", "Add user authentication system")
- delegate_phase("EXECUTE", "executor", "The API is returning 500 errors")
- delegate_phase("VERIFICATION", "qa-expert", "Verify the login flow works correctly")

IMPORTANT: When you use delegate_phase(), you are:
1. Switching the conversation to a new phase
2. Delegating work to a specialist agent
3. Setting up callbacks to be notified when the task completes
- DO NOT call complete() after delegating - wait for the response
- The delegated agent will handle the work and respond back`,
  schema: delegatePhaseSchema as z.ZodType<z.input<typeof delegatePhaseSchema>>,
  execute: async (input, context) => {
    const { phase, recipient, fullRequest, title } = input.value;

    try {
      // Resolve recipient to pubkey
      const pubkey = resolveRecipientToPubkey(recipient);
      if (!pubkey) {
        throw new Error(`Could not resolve recipient: ${recipient}`);
      }

      logger.info("[delegate_phase() tool] 🎯 Starting phase delegation", {
        fromAgent: context.agent.slug,
        phase: phase,
        recipient: recipient,
        mode: "synchronous",
      });

      // First, update the conversation phase
      await context.conversationCoordinator.updatePhase(
        context.conversationId,
        phase,
        fullRequest, // Use the fullRequest as the phase transition message
        context.agent.pubkey,
        context.agent.name
      );

      // Set title if provided
      if (title) {
        const { NDKEventMetadata } = await import("@/events/NDKEventMetadata");
        const { getNDK } = await import("@/nostr/ndkClient");
        const ndk = getNDK();
        
        const metadataEvent = new NDKEventMetadata(ndk);
        metadataEvent.kind = 513;
        metadataEvent.setConversationId(context.conversationId);
        metadataEvent.title = title;
        
        await metadataEvent.sign(context.agent.signer);
        await metadataEvent.publish();
        
        context.conversationCoordinator.setTitle(context.conversationId, title);
        logger.info(`Set conversation title: ${title}`);
      }

      logger.info("[delegate_phase() tool] 🔄 Phase updated, initiating synchronous delegation", {
        newPhase: phase,
        recipient: recipient,
        mode: "synchronous-wait",
      });

      // Use DelegationService to execute the delegation
      const delegationService = new DelegationService(
        context.agent,
        context.conversationId,
        context.conversationCoordinator,
        context.triggeringEvent,
        phase // Pass the new phase as context
      );
      
      const responses = await delegationService.execute({
        type: "delegation",
        recipients: [pubkey],
        request: fullRequest,
        phase: phase, // Include phase in the delegation intent
      });
      
      logger.info("[delegate_phase() tool] ✅ SYNCHRONOUS COMPLETE: Received responses", {
        phase: phase,
        recipient: recipient,
        responseCount: responses.responses.length,
        mode: "synchronous",
      });
      
      return success(responses);
    } catch (error) {
      logger.error("Failed to create phase delegation", {
        fromAgent: context.agent.slug,
        phase: phase,
        toRecipient: recipient,
        error,
      });

      return failure({
        kind: "execution",
        tool: "delegate_phase",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
});