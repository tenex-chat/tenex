import type { ExecutionContext } from "@/agents/execution/types";
import { RALRegistry } from "@/services/ral";
import type { StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const delegateFollowupSchema = z.object({
  recipient: z
    .string()
    .describe(
      "Agent slug (e.g., 'architect'), name (e.g., 'Architect'), npub, or hex pubkey of the agent you delegated to"
    ),
  message: z.string().describe("Your follow-up question or clarification request"),
});

type DelegateFollowupInput = z.infer<typeof delegateFollowupSchema>;
type DelegateFollowupOutput = StopExecutionSignal;

async function executeDelegateFollowup(
  input: DelegateFollowupInput,
  context: ExecutionContext
): Promise<DelegateFollowupOutput> {
  const { recipient, message } = input;

  const recipientPubkey = resolveRecipientToPubkey(recipient);
  if (!recipientPubkey) {
    throw new Error(`Could not resolve recipient: ${recipient}`);
  }

  if (recipientPubkey === context.agent.pubkey) {
    throw new Error(`Self-delegation is not permitted with delegate_followup.`);
  }

  // Find previous delegation in RAL state
  const registry = RALRegistry.getInstance();
  const ralState = registry.getStateByAgent(context.agent.pubkey);

  const previousDelegation = ralState?.completedDelegations.find(
    (d) => d.recipientPubkey === recipientPubkey
  );

  if (!previousDelegation) {
    throw new Error(
      `No previous delegation found to ${recipient}. Use delegate first.`
    );
  }

  if (!context.agentPublisher) {
    throw new Error("AgentPublisher not available");
  }

  logger.info("[delegate_followup] Publishing follow-up", {
    fromAgent: context.agent.slug,
    toRecipient: recipient,
  });

  const eventId = await context.agentPublisher.delegateFollowup(
    {
      recipient: recipientPubkey,
      content: message,
      replyToEventId: previousDelegation.responseEventId,
    },
    {
      triggeringEvent: context.triggeringEvent,
      rootEvent: context.getConversation()?.history?.[0] || context.triggeringEvent,
      conversationId: context.conversationId,
    }
  );

  return {
    __stopExecution: true,
    pendingDelegations: [
      {
        eventId,
        recipientPubkey,
        recipientSlug: recipient,
        prompt: message,
        isFollowup: true,
      },
    ],
  };
}

export function createDelegateFollowupTool(context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description:
      "Send a follow-up question to an agent you previously delegated to. Use after delegate to ask clarifying questions about their response.",
    inputSchema: delegateFollowupSchema,
    execute: async (input: DelegateFollowupInput) => {
      return await executeDelegateFollowup(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: () => "Sending follow-up question",
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
