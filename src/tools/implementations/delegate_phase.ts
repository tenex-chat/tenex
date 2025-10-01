import { tool } from 'ai';
import { DelegationService, type DelegationResponses } from "@/services/DelegationService";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/registry";
import { NDKEventMetadata } from "@/events/NDKEventMetadata";
import { getNDK } from "@/nostr/ndkClient";

const delegatePhaseSchema = z.object({
  phase: z
    .string()
    .describe("The phase to switch to (must be defined in agent's phases configuration)"),
  recipients: z
    .array(z.string())
    .describe(
      "Array of agent slug(s) (e.g., ['architect']), name(s) (e.g., ['Architect']), npub(s), or hex pubkey(s) to delegate to in this phase."
    ),
  prompt: z
    .string()
    .describe(
      "The request or question to delegate - this will be what the recipient processes."
    ),
  title: z
    .string()
    .optional()
    .describe("Title for this conversation (if not already set)."),
});

type DelegatePhaseInput = z.infer<typeof delegatePhaseSchema>;
type DelegatePhaseOutput = DelegationResponses;

// Core implementation - extracted from existing execute function
async function executeDelegatePhase(input: DelegatePhaseInput, context: ExecutionContext): Promise<DelegatePhaseOutput> {
  const { phase, recipients, prompt, title } = input;

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

  // Recipients is always an array due to schema validation
  if (!Array.isArray(recipients)) {
    throw new Error("Recipients must be an array of strings");
  }

  // Resolve recipients to pubkeys
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

  if (failedRecipients.length > 0) {
    logger.warn("Some recipients could not be resolved", {
      failed: failedRecipients,
      resolved: resolvedPubkeys.length,
    });
  }

  if (resolvedPubkeys.length === 0) {
    throw new Error("No valid recipients provided.");
  }

  if (title) {
    const ndk = getNDK();

    const metadataEvent = new NDKEventMetadata(ndk);
    metadataEvent.kind = 513;
    metadataEvent.setConversationId(context.conversationId);
    metadataEvent.title = title;
    // metadataEvent.created_at = Math.floor(Date.now())-1;

    await context.agent.sign(metadataEvent);
    await metadataEvent.publish();

    context.conversationCoordinator.setTitle(context.conversationId, title);
    logger.info(`Set conversation title: ${title}`);
  }

  logger.info("[delegate_phase() tool] 🎯 Starting phase delegation", {
    fromAgent: context.agent.slug,
    phase: actualPhaseName,
    recipients: recipients,
    recipientCount: resolvedPubkeys.length,
    mode: "synchronous",
  });

  // Use DelegationService to execute the delegation
  // Phase instructions are now passed through the delegation intent via event tags
  const delegationService = new DelegationService(
    context.agent,
    context.conversationId,
    context.conversationCoordinator,
    context.triggeringEvent,
    context.agentPublisher, // Pass the required AgentPublisher
    actualPhaseName // Pass the new phase as context
  );

  const responses = await delegationService.execute({
    recipients: resolvedPubkeys,
    request: prompt,
    phase: actualPhaseName, // Include phase in the delegation intent
    phaseInstructions: phase_instructions, // Pass phase instructions to be included in event tags
  });

  logger.info("[delegate_phase() tool] ✅ SYNCHRONOUS COMPLETE: Received responses", {
    phase: actualPhaseName,
    recipientCount: resolvedPubkeys.length,
    responseCount: responses.responses.length,
    mode: "synchronous",
  });
  
  return responses;
}

// AI SDK tool factory
export function createDelegatePhaseTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Switch conversation phase and delegate a question or task to one or more agents. Delegated agents will have full context of the history of the conversation, so no summarization is needed, just directly ask what's required from them.",
        inputSchema: delegatePhaseSchema,
        execute: async (input: DelegatePhaseInput) => {
            return await executeDelegatePhase(input, context);
        },
    });

    Object.defineProperty(aiTool, 'getHumanReadableContent', {
        value: ({ phase, recipients }: DelegatePhaseInput) => {
            if (!phase) {
                return 'Switching phase';
            }
            if (!recipients || recipients.length === 0) {
                return `Switching to ${phase.toUpperCase()} phase`;
            }
            return `Switching to ${phase.toUpperCase()} phase and delegating to ${recipients.join(', ')}`;
        },
        enumerable: false,
        configurable: true
    });

    return aiTool;
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
 * The prompt serves dual purpose:
 * - Becomes the phase transition reason (context for all agents)
 * - Is the actual task delegated to the specified recipients
 *
 * Recipients can be:
 * - A single recipient or array of recipients
 * - Agent slugs (e.g., "architect", "planner") - resolved from project agents
 * - Agent names (e.g., "Architect", "Planner") - resolved from project agents
 * - Npubs (e.g., "npub1...") - decoded to hex pubkeys
 * - Hex pubkeys (64 characters) - used directly
 * - The agent itself (self-delegation) - allows phase transitions without external delegation
 *
 * If any recipient cannot be resolved, the tool fails with an error.
 *
 * When delegating to multiple recipients, the agent will wait for all responses
 * before continuing. The agent should NOT complete after delegating.
 *
 * The agent should NOT complete after using delegate_phase.
 */
