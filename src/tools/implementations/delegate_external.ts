import { tool } from 'ai';
import { getNDK } from "@/nostr/ndkClient";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import type { DelegationResponses } from "@/services/DelegationService";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { parseNostrUser, normalizeNostrIdentifier } from "@/utils/nostr-entity-parser";
import { NDKEvent, NDKUser } from "@nostr-dev-kit/ndk";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";

const delegateExternalSchema = z.object({
  content: z.string().describe("The content of the chat message to send"),
  recipient: z.string().describe("The recipient's pubkey or npub (will be p-tagged)"),
  projectId: z
    .string()
    .optional()
    .describe("Optional project event ID (naddr1...) to reference in the message. This should be the project the agent you are delegating TO works on (if you know it)"),
});

type DelegateExternalInput = z.infer<typeof delegateExternalSchema>;
type DelegateExternalOutput = DelegationResponses;

// Core implementation - extracted from existing execute function
async function executeDelegateExternal(input: DelegateExternalInput, context: ExecutionContext): Promise<DelegateExternalOutput> {
  const { content, recipient, projectId } = input;

  const ndk = getNDK();
  
  // Parse recipient using the utility function
  const pubkey = parseNostrUser(recipient);
  if (!pubkey) {
    throw new Error(`Invalid recipient format: ${recipient}`);
  }

  logger.info("🚀 Delegating to external agent", {
    agent: context.agent.name,
    hasProject: !!projectId,
    recipientPubkey: pubkey.substring(0, 8),
    contentLength: content.length,
  });

  // Normalize optional IDs
  const cleanProjectId = normalizeNostrIdentifier(projectId);

  logger.debug("Processing recipient", { pubkey });

  // Check for previous delegations to the same recipient in this conversation
  const registry = DelegationRegistry.getInstance();
  const previousDelegation = registry.getDelegationByConversationKey(
    context.conversationId,
    context.agent.pubkey,
    pubkey
  );

  // Create a new kind:11 event for starting a thread
  const chatEvent = new NDKEvent(ndk);
  chatEvent.kind = 11;

  chatEvent.content = content;
  chatEvent.tags.push(["p", pubkey]);

  // If there was a previous delegation to this recipient, make this a reply to maintain thread continuity
  if (previousDelegation) {
    chatEvent.kind = 1111;
    chatEvent.tags.push(["E", previousDelegation.delegationEventId]);
    chatEvent.tags.push(["e", previousDelegation.delegationEventId]);
    logger.info("🔗 Creating threaded delegation - replying to previous delegation", {
      previousDelegationId: previousDelegation.delegationEventId.substring(0, 8),
      recipient: pubkey.substring(0, 8),
    });
  }

  // Add project reference if provided
  if (cleanProjectId) {
    const projectEvent = await ndk.fetchEvent(cleanProjectId);
    if (projectEvent) {
        chatEvent.tag(projectEvent.tagReference());
    } else {
      logger.warn("Project event not found, skipping project tag", {
        projectId: cleanProjectId,
      });
    }
  }

  logger.debug("Chat event details", { eventId: chatEvent.id, kind: chatEvent.kind });

  // Sign and publish the event
  await context.agent.sign(chatEvent);
  chatEvent.publish();

  const batchId = await registry.registerDelegation({
    delegationEventId: chatEvent.id,
    recipients: [{
      pubkey: pubkey,
      request: content,
    }],
    delegatingAgent: context.agent,
    rootConversationId: context.conversationId,
    originalRequest: content,
  });

  // Publish conversation status event
  try {
    // Use shared AgentPublisher instance from context (guaranteed to be present)
    const conversation = context.conversationCoordinator.getConversation(context.conversationId);

    if (conversation?.history?.[0]) {
      await context.agentPublisher.conversation(
        { content: `🚀 External delegation sent: nostr:${chatEvent.encode()}` },
        {
          triggeringEvent: context.triggeringEvent,
          rootEvent: conversation.history[0],
          conversationId: context.conversationId,
        }
      );
    }
  } catch (statusError) {
    // Don't fail the tool if we can't publish the status
    console.warn("Failed to publish delegation status:", statusError);
  }

  try {
    // Wait for batch completion (will be triggered when response is received and processed)
    const completions = await registry.waitForBatchCompletion(batchId);

    logger.info("✅ Synchronous wait complete - received response from external agent", {
      eventId: chatEvent.id,
      batchId,
      completionCount: completions.length,
    });

    // Convert to DelegationResponses format
    const response: DelegationResponses = {
      type: "delegation_responses",
      responses: completions.map(c => ({
        response: c.response,
        summary: c.summary,
        from: c.assignedTo,
      })),
    };

    return response;
  } catch (error) {
    // Synchronous wait failed - this should only happen if there's a network issue
    logger.error("❌ Synchronous wait failed for external response", {
      eventId: chatEvent.id,
      batchId,
      error,
    });

    throw new Error(`Failed to wait for response: ${formatAnyError(error)}`);
  }
}

// AI SDK tool factory
export function createDelegateExternalTool(context: ExecutionContext) {
  const aiTool = tool({
    description: `Delegate a task to an external agent or user and wait for their response. Use this tool only to engage with agents in OTHER projects. If you don't know their pubkey you can use nostr_projects tools.

When using this tool, provide context to the recipient, introduce yourself and explain you are an agent and the project you are working on. It's important for the recipient to understand where you're coming from.

`,
    inputSchema: delegateExternalSchema,
    execute: async (input: DelegateExternalInput) => {
      return await executeDelegateExternal(input, context);
    },
  });

  Object.defineProperty(aiTool, 'getHumanReadableContent', {
    value: ({ recipient, projectId }: DelegateExternalInput) => {
      let message = `Delegating to external agent ${recipient}`;
      if (projectId) {
        message += ` in project ${projectId}`;
      }
      return message;
    },
    enumerable: false,
    configurable: true
  });

  return aiTool;
}


