import type { ExecutionContext } from "@/agents/execution/types";
import { RALRegistry } from "@/services/ral";
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

  // Find the delegation by event ID in RAL state
  const registry = RALRegistry.getInstance();

  // Search all active RALs for this agent+conversation
  const activeRALs = registry.getActiveRALs(context.agent.pubkey, context.conversationId);

  let previousDelegation: { recipientPubkey: string; recipientSlug?: string; responseEventId?: string } | undefined;

  for (const ral of activeRALs) {
    // Check completed delegations
    const completed = ral.completedDelegations.find(d => d.eventId === delegation_event_id);
    if (completed) {
      previousDelegation = completed;
      break;
    }

    // Also check pending delegations (for following up before completion)
    const pending = ral.pendingDelegations.find(d => d.eventId === delegation_event_id);
    if (pending) {
      previousDelegation = {
        recipientPubkey: pending.recipientPubkey,
        recipientSlug: pending.recipientSlug,
      };
      break;
    }
  }

  if (!previousDelegation) {
    throw new Error(
      `No delegation found with event ID ${delegation_event_id}. Check the delegationEventIds from your delegate call.`
    );
  }

  if (!context.agentPublisher) {
    throw new Error("AgentPublisher not available");
  }

  logger.info("[delegate_followup] Publishing follow-up", {
    fromAgent: context.agent.slug,
    delegationEventId: delegation_event_id,
    recipientPubkey: previousDelegation.recipientPubkey.substring(0, 8),
  });

  const eventId = await context.agentPublisher.delegateFollowup(
    {
      recipient: previousDelegation.recipientPubkey,
      content: message,
      delegationEventId: delegation_event_id,
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
        type: "followup" as const,
        eventId,
        recipientPubkey: previousDelegation.recipientPubkey,
        recipientSlug: previousDelegation.recipientSlug,
        prompt: message,
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
