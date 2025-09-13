import { tool } from 'ai';
import { z } from 'zod';
import { DelegationService, type DelegationResponses } from "@/services/DelegationService";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import type { ExecutionContext } from "@/agents/execution/types";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";

const delegateFollowupSchema = z.object({
  recipient: z.string()
    .describe("Agent slug (e.g., 'architect'), name (e.g., 'Architect'), npub, or hex pubkey of the agent you delegated to"),
  message: z.string()
    .describe("Your follow-up question or clarification request"),
});

type DelegateFollowupInput = z.infer<typeof delegateFollowupSchema>;

// Core implementation
async function executeDelegateFollowup(
  input: DelegateFollowupInput,
  context: ExecutionContext
): Promise<DelegationResponses> {
  const { recipient, message } = input;
  
  // Resolve recipient to pubkey
  const recipientPubkey = resolveRecipientToPubkey(recipient);
  if (!recipientPubkey) {
    throw new Error(`Could not resolve recipient: ${recipient}`);
  }
  
  // Get delegation record from registry
  const registry = DelegationRegistry.getInstance();
  const delegationRecord = registry.getDelegationByConversationKey(
    context.conversationId,
    context.agent.pubkey,
    recipientPubkey
  );
  
  if (!delegationRecord) {
    throw new Error(
      `No recent delegation found to ${recipient}. Use delegate or delegate_phase first, then use delegate_followup to ask clarifying questions.`
    );
  }
  
  if (!delegationRecord.completion?.event) {
    throw new Error(
      `Delegation to ${recipient} has not completed yet or did not return a response event.`
    );
  }
  
  const responseEvent = delegationRecord.completion.event;
  
  logger.info("[delegate_followup] 🔄 Creating follow-up delegation", {
    fromAgent: context.agent.slug,
    toPubkey: recipientPubkey.substring(0, 8),
    responseEventId: responseEvent.id?.substring(0, 8),
    message: message.substring(0, 100),
  });
  
  // Create DelegationService with the response event as context
  const delegationService = new DelegationService(
    context.agent,
    context.conversationId,
    context.conversationCoordinator,
    responseEvent, // This becomes the triggering event for threading
    context.agentPublisher,
    context.phase
  );
  
  // Execute as a follow-up delegation
  const responses = await delegationService.execute({
    type: "delegation_followup",
    recipients: [recipientPubkey],
    request: message,
  });
  
  logger.info("[delegate_followup] ✅ Follow-up complete", {
    fromAgent: context.agent.slug,
    recipient: recipient,
    responseCount: responses.responses.length,
  });
  
  return responses;
}

// AI SDK tool factory
export function createDelegateFollowupTool(context: ExecutionContext): ReturnType<typeof tool> {
  const toolInstance = tool({
    description: "Send a follow-up question to an agent you previously delegated to. Use after delegate or delegate_phase to ask clarifying questions about their response. The tool will wait for their response before continuing.",
    inputSchema: delegateFollowupSchema,
    execute: async (input: DelegateFollowupInput) => {
      return await executeDelegateFollowup(input, context);
    },
  });

  // Add human-readable content generation
  return Object.assign(toolInstance, {
    getHumanReadableContent: () => `Sending follow-up question`,
  });
}

/**
 * Delegate Follow-up tool - enables multi-turn conversations during delegations
 * 
 * This tool allows an agent to ask follow-up questions after receiving a delegation response:
 * 1. Takes a recipient parameter to identify which delegation to follow up on
 * 2. Looks up the delegation in DelegationRegistry using agent+conversation+recipient
 * 3. Creates a reply to the stored response event
 * 4. Waits synchronously for the response (just like delegate)
 * 5. Can be chained for multiple follow-ups
 * 
 * Example flow:
 * - Agent1 delegates to architect: "Design auth system"
 * - Architect responds: "I suggest OAuth2..."
 * - Agent1 uses delegate_followup(recipient: "architect", message: "What about refresh tokens?")
 * - Architect responds: "Use rotating tokens with 7-day expiry"
 * - Agent1 can continue with more follow-ups or proceed
 */