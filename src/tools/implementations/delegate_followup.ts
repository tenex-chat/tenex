import type { ExecutionContext } from "@/agents/execution/types";
import { getNDK } from "@/nostr";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/utils/phase-utils";
import { tool } from "ai";
import { z } from "zod";

const delegateFollowupSchema = z.object({
  delegation_conversation_id: z
    .string()
    .describe(
      "The conversation ID of the delegation you want to follow up on (returned in delegationConversationIds from the delegate tool)"
    ),
  message: z.string().describe("Your follow-up question or clarification request"),
});

type DelegateFollowupInput = z.infer<typeof delegateFollowupSchema>;
type DelegateFollowupOutput = StopExecutionSignal;

async function executeDelegateFollowup(
  input: DelegateFollowupInput,
  context: ExecutionContext
): Promise<DelegateFollowupOutput> {
  const { delegation_conversation_id, message } = input;

  // First, try to find the delegation in the local RALRegistry (faster and more reliable)
  // Check both pending and completed delegations (followup may happen after first response)
  const ralRegistry = RALRegistry.getInstance();
  const ralState = ralRegistry.findStateWaitingForDelegation(delegation_conversation_id);

  // Look in pending delegations first
  let delegation = ralState?.pendingDelegations.find(
    (d) => d.delegationConversationId === delegation_conversation_id
  );

  // Also check completed delegations (followup after a response)
  const completedDelegation = ralState?.completedDelegations.find(
    (d) => d.delegationConversationId === delegation_conversation_id
  );

  let recipientPubkey = delegation?.recipientPubkey ?? completedDelegation?.recipientPubkey;

  // Fall back to NDK fetch if not found locally (e.g., external delegations or stale state)
  if (!recipientPubkey) {
    const ndk = getNDK();
    const delegationEvent = await ndk.fetchEvent(delegation_conversation_id);

    if (!delegationEvent) {
      throw new Error(
        `Could not fetch delegation conversation ${delegation_conversation_id}. Check the delegationConversationIds from your delegate call.`
      );
    }

    recipientPubkey = delegationEvent.tagValue("p") ?? undefined;
  }

  if (!recipientPubkey) {
    throw new Error(
      `Delegation conversation ${delegation_conversation_id} has no recipient. Cannot determine who to send follow-up to.`
    );
  }

  if (!context.agentPublisher) {
    throw new Error("AgentPublisher not available");
  }

  logger.info("[delegate_followup] Publishing follow-up", {
    fromAgent: context.agent.slug,
    delegationConversationId: delegation_conversation_id,
    recipientPubkey: recipientPubkey.substring(0, 8),
  });

  const eventContext = createEventContext(context);
  const followupEventId = await context.agentPublisher.delegateFollowup({
    recipient: recipientPubkey,
    content: message,
    delegationEventId: delegation_conversation_id,
  }, eventContext);

  // Return the ORIGINAL delegation conversation ID, not the new followup event ID.
  // This ensures routing back to the same RAL when the followup response arrives.
  // We also include followupEventId so it can be mapped for response routing.
  return {
    __stopExecution: true,
    pendingDelegations: [
      {
        type: "followup" as const,
        delegationConversationId: delegation_conversation_id,
        recipientPubkey,
        senderPubkey: context.agent.pubkey,
        prompt: message,
        followupEventId,
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
