import { tool } from 'ai';
import type { Tool } from 'ai';
import { DelegationService, type DelegationResponses } from "@/services/DelegationService";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";
import { NDKEventMetadata } from "@/events/NDKEventMetadata";
import { getNDK } from "@/nostr/ndkClient";
import type { TenexTool } from "@/tools/registry";

const delegatePhaseSchema = z.object({
  phase: z
    .string()
    .describe("The phase to switch to (must be defined in agent's phases configuration)"),
  recipient: z
    .string()
    .describe(
      "Agent slug (e.g., 'architect'), npub, or hex pubkey to delegate to in this phase."
    ),
  fullRequest: z
    .string()
    .describe(
      "The complete request or question to delegate - this becomes the phase reason and delegation content"
    ),
  title: z
    .string()
    .nullable()
    .describe("Title for this conversation (if not already set)."),
});

type DelegatePhaseInput = z.infer<typeof delegatePhaseSchema>;
type DelegatePhaseOutput = DelegationResponses;

// Core implementation - extracted from existing execute function
async function executeDelegatePhase(input: DelegatePhaseInput, context: ExecutionContext): Promise<DelegatePhaseOutput> {
  const { phase, recipient, fullRequest, title } = input;

  // Validate that the phase exists in the agent's phases configuration
  if (!context.agent.phases) {
    throw new Error(`Agent ${context.agent.name} does not have any phases defined. Cannot use delegate_phase tool.`);
  }

  // Case-insensitive phase matching
  const normalizedPhase = phase.toLowerCase();
  const phaseEntry = Object.entries(context.agent.phases).find(
    ([phaseName]) => phaseName.toLowerCase() === normalizedPhase
  );

  if (!phaseEntry) {
    const availablePhases = Object.keys(context.agent.phases).join(', ');
    throw new Error(`Phase '${phase}' not defined for agent ${context.agent.name}. Available phases: ${availablePhases}`);
  }

  // Use the actual phase name and instructions from configuration
  const [actualPhaseName, phase_instructions] = phaseEntry;

  // Resolve recipient to pubkey
  const pubkey = resolveRecipientToPubkey(recipient);
  if (!pubkey) {
    throw new Error(`Could not resolve recipient: ${recipient}`);
  }

  if (title) {
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
    phase: actualPhaseName,
    recipient: recipient,
    mode: "synchronous",
  });

  // First, update the conversation phase
  await context.conversationCoordinator.updatePhase(
    context.conversationId,
    actualPhaseName,
    fullRequest, // Use the fullRequest as the phase transition message
    context.agent.pubkey,
    context.agent.name,
    phase_instructions // Pass the phase instructions from configuration
  );

  // Use DelegationService to execute the delegation
  const delegationService = new DelegationService(
    context.agent,
    context.conversationId,
    context.conversationCoordinator,
    context.triggeringEvent,
    context.agentPublisher, // Pass the required AgentPublisher
    actualPhaseName // Pass the new phase as context
  );

  const responses = await delegationService.execute({
    recipients: [pubkey],
    request: fullRequest,
    phase: actualPhaseName, // Include phase in the delegation intent
  });

  logger.info("[delegate_phase() tool] ✅ SYNCHRONOUS COMPLETE: Received responses", {
    phase: actualPhaseName,
    recipient: recipient,
    responseCount: responses.responses.length,
    mode: "synchronous",
  });
  
  return responses;
}

// AI SDK tool factory
export function createDelegatePhaseTool(context: ExecutionContext): TenexTool {
    const toolInstance = tool({
        description:
            "Switch conversation phase and delegate a question or task to a specific agent.  Use for complex multi-step operations that require specialized expertise. Provide complete context in the request - agents have no visibility into your conversation.",
        inputSchema: delegatePhaseSchema,
        execute: async (input: DelegatePhaseInput) => {
            return await executeDelegatePhase(input, context);
        },
    });
    
    // Add human-readable content generation
    return Object.assign(toolInstance, {
        getHumanReadableContent: ({ phase, recipient, fullRequest }: DelegatePhaseInput) => {
            return `Switching to ${phase.toUpperCase()} phase and delegating to ${recipient}.`;
        }
    }) as TenexTool;
}

/**
 * Delegate Phase tool - enables agents with defined phases to atomically switch phases and delegate work
 *
 * This tool combines phase switching with task delegation for agents that have phases defined:
 * 1. Switches to the appropriate phase for the work being done
 * 2. Uses phase instructions from the agent's configuration
 * 3. Delegates the task to the appropriate specialist agent(s)
 * 4. Sets up proper event-driven callbacks for task completion
 *
 * Phase Requirements:
 * - Agent must have phases defined in their configuration
 * - Phase names are matched case-insensitively
 * - If phase doesn't exist, tool fails with list of available phases
 *
 * Phase Instructions:
 * - Loaded from the agent's phases configuration
 * - Each phase has predefined instructions
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
