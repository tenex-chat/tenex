import type { ToolExecutionContext } from "@/tools/types";
import { getNDK } from "@/nostr";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { AISdkTool } from "@/tools/types";
import { truncateConversationId } from "@/utils/delegation-chain";
import { logger } from "@/utils/logger";
import { isHexPrefix, resolvePrefixToId } from "@/utils/nostr-entity-parser";
import { createEventContext } from "@/utils/event-context";
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

interface DelegateFollowupOutput {
  success: boolean;
  message: string;
  delegationConversationId: string;
  followupEventId: string;
}

async function executeDelegateFollowup(
  input: DelegateFollowupInput,
  context: ToolExecutionContext
): Promise<DelegateFollowupOutput> {
  const { delegation_conversation_id: inputConversationId, message } = input;

  // Resolve prefix to full delegation conversation ID if needed
  let delegation_conversation_id = inputConversationId;
  if (isHexPrefix(inputConversationId)) {
    const resolved = await resolvePrefixToId(inputConversationId);
    if (!resolved) {
      throw new Error(
        `Could not resolve prefix "${inputConversationId}" to a delegation conversation ID. The prefix may be ambiguous or no matching delegation was found.`
      );
    }
    delegation_conversation_id = resolved;
  }

  // Find the delegation in conversation storage (persists even after RAL is cleared)
  const ralRegistry = RALRegistry.getInstance();
  const delegationInfo = ralRegistry.findDelegation(delegation_conversation_id);

  let recipientPubkey = delegationInfo?.pending?.recipientPubkey ?? delegationInfo?.completed?.recipientPubkey;

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

  // Always use the CURRENT RAL number from context.
  // The delegation's stored ralNumber refers to the RAL that created it, which may have
  // been cleared since then. We need to register on the CURRENT RAL so it resumes correctly.
  const effectiveRalNumber = context.ralNumber;

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

  // Register the followup as a pending delegation for response routing
  // but DON'T return StopExecutionSignal - agent can continue and acknowledge to user
  const newDelegation = {
    type: "followup" as const,
    delegationConversationId: delegation_conversation_id,
    recipientPubkey,
    senderPubkey: context.agent.pubkey,
    prompt: message,
    followupEventId,
    ralNumber: effectiveRalNumber,
  };

  // Merge with existing pending delegations
  const existingDelegations = ralRegistry.getConversationPendingDelegations(
    context.agent.pubkey,
    context.conversationId,
    effectiveRalNumber
  );

  const mergedDelegations = [...existingDelegations];
  if (!mergedDelegations.some(d => d.delegationConversationId === delegation_conversation_id)) {
    mergedDelegations.push(newDelegation);
  }

  ralRegistry.setPendingDelegations(
    context.agent.pubkey,
    context.conversationId,
    effectiveRalNumber,
    mergedDelegations
  );

  // Return normal result - agent continues without blocking
  return {
    success: true,
    message: "Follow-up sent. The agent will respond when ready.",
    delegationConversationId: truncateConversationId(delegation_conversation_id),
    followupEventId, // Keep full event ID - this is a Nostr event ID, not a conversation ID
  };
}

export function createDelegateFollowupTool(context: ToolExecutionContext): AISdkTool {
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
