import { tool } from "ai";
import { DelegationService, type DelegationResponses } from "@/services/DelegationService";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/registry";

const delegateSchema = z.object({
  recipients: z
    .array(z.string())
    .describe(
      "Array of agent slug(s) (e.g., ['architect']), name(s) (e.g., ['Architect']), npub(s), or hex pubkey(s) of the recipient agent(s)"
    ),
  fullRequest: z
    .string()
    .describe("The complete request or question to delegate to the recipient agent(s)"),
});

type DelegateInput = z.infer<typeof delegateSchema>;
type DelegateOutput = DelegationResponses;

// Core implementation - extracted from existing execute function
async function executeDelegate(input: DelegateInput, context: ExecutionContext): Promise<DelegateOutput> {
  const { recipients, fullRequest } = input;

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

  // Check for self-delegation (not allowed in regular delegate tool)
  const selfDelegationAttempts = resolvedPubkeys.filter(
    pubkey => pubkey === context.agent.pubkey
  );
  
  if (selfDelegationAttempts.length > 0) {
    throw new Error(
      "Self-delegation is not permitted with the delegate tool. " +
      `Agent "${context.agent.slug}" cannot delegate to itself. ` +
      "Use the delegate_phase tool if you need to transition phases within the same agent."
    );
  }

  // Use DelegationService to execute the delegation
  const delegationService = new DelegationService(
    context.agent,
    context.conversationId,
    context.conversationCoordinator,
    context.triggeringEvent,
    context.agentPublisher, // Pass the required AgentPublisher
    context.phase
  );
  
  return await delegationService.execute({
    recipients: resolvedPubkeys,
    request: fullRequest,
  });
}

// AI SDK tool factory
export function createDelegateTool(context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description: "Delegate a task or question to one or more agents and wait for their responses. Use for complex multi-step operations that require specialized expertise. Provide complete context in the request - agents have no visibility into your conversation. Can delegate to multiple agents in parallel by providing array of recipients. Recipients can be agent slugs (e.g., 'architect'), names (e.g., 'Architect'), npubs, or hex pubkeys. Responses are returned synchronously - the tool waits for all agents to complete.",
    inputSchema: delegateSchema,
    execute: async (input: DelegateInput) => {
      return await executeDelegate(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: (args: unknown) => {
      // Defensive: handle cases where args might not be properly typed
      if (!args || typeof args !== "object" || !("recipients" in args)) {
        return "Delegating to agent(s)";
      }

      const { recipients } = args as DelegateInput;

      if (!recipients || !Array.isArray(recipients)) {
        return "Delegating to agent(s)";
      }

      if (recipients.length === 1) {
        return `Delegating to ${recipients[0]}`;
      } else {
        return `Delegating to ${recipients.length} recipients`;
      }
    },
    enumerable: false,
    configurable: true
  });

  return aiTool;
}

/**
 * Delegate tool - enables agents to communicate with each other via kind:1111 conversation events
 *
 * This tool allows an agent to delegate a request or question to one or more agents by:
 * 1. Resolving each recipient (agent slug or pubkey) to a pubkey
 * 2. Publishing a kind:1111 conversation event for each recipient with p-tag assignment
 * 3. Setting up delegation state so the agent waits for all responses
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
 * When delegating to multiple recipients, the agent will wait for all responses
 * before continuing. The agent should NOT complete after delegating.
 *
 * Each delegation creates a kind:1111 conversation event (following NIP-22) that:
 * - Is addressed to a specific agent via p-tag
 * - Maintains conversation threading via E/e tags
 * - Enables natural agent-to-agent communication
 * - Supports parallel execution when delegating to multiple agents
 */
