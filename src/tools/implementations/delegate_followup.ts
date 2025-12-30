import type { ExecutionContext } from "@/agents/execution/types";
import { getNDK } from "@/nostr";
import type { StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const delegateFollowupSchema = z.object({
  delegation_event_id: z
    .string()
    .describe(
      "The event ID of the delegation you want to follow up on (returned in delegationEventIds from the delegate tool)"
    ),
  message: z.string().describe("Your follow-up question or clarification request"),
});

type DelegateFollowupInput = z.infer<typeof delegateFollowupSchema>;
type DelegateFollowupOutput = StopExecutionSignal;

async function executeDelegateFollowup(
  input: DelegateFollowupInput,
  context: ExecutionContext
): Promise<DelegateFollowupOutput> {
  const { delegation_event_id, message } = input;

  // Fetch the original delegation event to get the recipient p-tag
  const ndk = getNDK();
  const delegationEvent = await ndk.fetchEvent(delegation_event_id);

  if (!delegationEvent) {
    throw new Error(
      `Could not fetch delegation event ${delegation_event_id}. Check the delegationEventIds from your delegate call.`
    );
  }

  // Get the recipient from the p-tag of the delegation event
  const recipientPubkey = delegationEvent.tagValue("p");
  if (!recipientPubkey) {
    throw new Error(
      `Delegation event ${delegation_event_id} has no p-tag. Cannot determine recipient.`
    );
  }

  if (!context.agentPublisher) {
    throw new Error("AgentPublisher not available");
  }

  logger.info("[delegate_followup] Publishing follow-up", {
    fromAgent: context.agent.slug,
    delegationEventId: delegation_event_id,
    recipientPubkey: recipientPubkey.substring(0, 8),
  });

  const eventId = await context.agentPublisher.delegateFollowup({
    recipient: recipientPubkey,
    content: message,
    delegationEventId: delegation_event_id,
  });

  return {
    __stopExecution: true,
    pendingDelegations: [
      {
        type: "followup" as const,
        eventId,
        recipientPubkey,
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
