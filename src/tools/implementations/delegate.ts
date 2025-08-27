import { DelegationService, type DelegationResponses } from "@/services/DelegationService";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";
import { z } from "zod";
import { createToolDefinition, failure, success } from "../types";

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
export const delegateTool = createToolDefinition<
  z.input<typeof delegateSchema>,
  DelegationResponses
>({
  name: "delegate",
  description:
    "Delegate a task or question to one or more agents and wait for their responses",
  promptFragment: `DELEGATE TOOL:
Use this to communicate with other agents by delegating tasks or questions.
IMPORTANT: recipients must ALWAYS be an array, even for a single recipient.
IMPORTANT: NEVER Delegate to yourself.

Examples:
- delegate(["architect"], "Design a database schema for user authentication")
- delegate(["architect", "planner"], "Review and plan the new feature implementation")
- delegate(["npub1abc..."], "Review this implementation for security issues")
- delegate(["executor", "npub1xyz..."], "Implement and test this feature")

The delegate() tool will wait for all responses and return them to you.
You can then process the responses and continue with your task.`,
  schema: delegateSchema as z.ZodType<z.input<typeof delegateSchema>>,
  execute: async (input, context) => {
    const { recipients, fullRequest } = input.value;

    // Recipients is always an array due to schema validation
    if (!Array.isArray(recipients)) {
      return failure({
        kind: "execution",
        tool: "delegate",
        message: "Recipients must be an array of strings",
      });
    }

    try {
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

      logger.info("[delegate() tool] 🎯 Starting synchronous delegation", {
        fromAgent: context.agent.slug,
        recipientCount: resolvedPubkeys.length,
        mode: "synchronous",
      });

      // Use DelegationService to execute the delegation
      const delegationService = new DelegationService(
        context.agent,
        context.conversationId,
        context.conversationCoordinator,
        context.triggeringEvent,
        context.phase,
        context.agentPublisher // Pass the shared AgentPublisher
      );
      
      const responses = await delegationService.execute({
        type: "delegation",
        recipients: resolvedPubkeys,
        request: fullRequest,
      });
      
      return success(responses);
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
