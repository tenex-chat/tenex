import { tool } from 'ai';
import { PHASES } from "@/conversations/phases";
import { DelegationService, type DelegationResponses } from "@/services/DelegationService";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";

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
    .nullable()
    .describe("Title for this conversation (if not already set)"),
});

type DelegatePhaseInput = z.infer<typeof delegatePhaseSchema>;
type DelegatePhaseOutput = DelegationResponses;

// Core implementation - extracted from existing execute function
async function executeDelegatePhase(input: DelegatePhaseInput, context: ExecutionContext): Promise<DelegatePhaseOutput> {
  const { phase, recipient, fullRequest, title } = input;

  // Resolve recipient to pubkey
  const pubkey = resolveRecipientToPubkey(recipient);
  if (!pubkey) {
    throw new Error(`Could not resolve recipient: ${recipient}`);
  }

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
    phase, // Pass the new phase as context
    context.agentPublisher // Pass the shared AgentPublisher
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
  
  return responses;
}

// AI SDK tool factory
export function createDelegatePhaseTool(context: ExecutionContext) {
  return tool({
    description: "Switch conversation phase and delegate a task to a specific agent (Project Manager only)",
    inputSchema: delegatePhaseSchema,
    execute: async (input: DelegatePhaseInput) => {
      return await executeDelegatePhase(input, context);
    },
  });
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
 * Recipient can be:
 * - Agent slug (e.g., "architect", "planner") - resolved from project agents
 * - Agent name (e.g., "Architect", "Planner") - resolved from project agents
 * - Npub (e.g., "npub1...") - decoded to hex pubkey
 * - Hex pubkey (64 characters) - used directly
 *
 * If recipient cannot be resolved, the tool fails with an error.
 *
 * The agent should NOT complete after using delegate_phase.
 */
