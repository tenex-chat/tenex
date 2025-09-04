import { tool } from 'ai';
import type { Tool } from 'ai';
import { DelegationService, type DelegationResponses } from "@/services/DelegationService";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";

const delegatePhaseSchema = z.object({
  phase: z
    .string()
    .describe("The phase to switch to (can be any string, including custom phases)"),
  phase_instructions: z
    .string()
    .describe(
      "Detailed instructions and goals for this phase - what should be accomplished and how. Other agents are not aware of what phases mean; so you must provide clear and complete instructions of the goal, what to do, what not to do and phase constrains."
    ),
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
  const { phase, phase_instructions, recipient, fullRequest, title } = input;

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
    context.agent.name,
    phase_instructions // Pass the custom phase instructions
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
    context.agentPublisher, // Pass the required AgentPublisher
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
  
  return responses;
}

// AI SDK tool factory
export function createDelegatePhaseTool(context: ExecutionContext): Tool<any, any> {
    return tool({
        description:
            "Switch conversation phase and delegate to a specific agent",
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
 * 2. Provides custom phase instructions to guide agent behavior
 * 3. Delegates the task to the appropriate specialist agent(s)
 * 4. Sets up proper event-driven callbacks for task completion
 *
 * Phase can be:
 * - Standard phases: CHAT, BRAINSTORM, PLAN, EXECUTE, VERIFICATION, CHORES, REFLECTION
 * - Custom phases: Any string that represents a project-specific phase
 *
 * Phase Instructions:
 * - Detailed instructions that define what should be accomplished in this phase
 * - These instructions override standard phase definitions for custom phases
 * - Agents receive these instructions as part of their execution context
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
