import { tool } from 'ai';
import { getNDK } from "@/nostr/ndkClient";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import type { DelegationResponses } from "@/services/DelegationService";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { parseNostrUser, normalizeNostrIdentifier } from "@/utils/nostr-entity-parser";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";

const delegateExternalSchema = z.object({
  content: z.string().describe("The content of the chat message to send"),
  parentEventId: z
    .string()
    .nullable()
    .describe("Optional parent event ID to reply to. If provided, will create a reply (kind:1111)"),
  recipient: z.string().describe("The recipient's pubkey or npub (will be p-tagged)"),
  projectId: z
    .string()
    .nullable()
    .describe("Optional project event ID (naddr1...) to reference in the message. This should be the project the agent you are delegating TO works on (if you know it)"),
});

type DelegateExternalInput = z.infer<typeof delegateExternalSchema>;
type DelegateExternalOutput = DelegationResponses;

// Core implementation - extracted from existing execute function
async function executeDelegateExternal(input: DelegateExternalInput, context: ExecutionContext): Promise<DelegateExternalOutput> {
  const { content, parentEventId, recipient, projectId } = input;

  const ndk = getNDK();
  
  // Parse recipient using the utility function
  const pubkey = parseNostrUser(recipient, ndk);
  if (!pubkey) {
    throw new Error(`Invalid recipient format: ${recipient}`);
  }

  logger.info("🚀 Delegating to external agent", {
    agent: context.agent.name,
    hasParent: !!parentEventId,
    hasProject: !!projectId,
    recipientPubkey: pubkey.substring(0, 8),
    contentLength: content.length,
  });

  let chatEvent: NDKEvent;

  // Normalize optional IDs
  const cleanParentId = normalizeNostrIdentifier(parentEventId);
  const cleanProjectId = normalizeNostrIdentifier(projectId);

  logger.debug("Processing recipient", { pubkey });

  if (cleanParentId) {
    // Fetch the parent event and create a reply
    const parentEvent = await ndk.fetchEvent(cleanParentId);
    if (!parentEvent) {
      throw new Error(`Parent event not found: ${cleanParentId}`);
    }

    // Use the parent event's reply() method to create the reply event
    chatEvent = await parentEvent.reply();
    chatEvent.tags = chatEvent.tags.filter(t => t[0] !== 'p');
  } else {
    // Create a new kind:11 event for starting a thread
    chatEvent = new NDKEvent(ndk);
    chatEvent.kind = 11;
    
    // Add phase and tool tags
  }
  
  if (context.phase) chatEvent.tags.push(["phase", context.phase]);
  chatEvent.tags.push(["tool", "delegate_external"]);
  chatEvent.content = content;
  chatEvent.tags.push(["p", pubkey]);

  // Add project reference if provided
  if (cleanProjectId) {
    const projectEvent = await ndk.fetchEvent(cleanProjectId);
    if (projectEvent) {
      const tagRef = projectEvent.tagReference();
      if (tagRef) {
        chatEvent.tags.push(tagRef);
      }
    } else {
      logger.warn("Project event not found, skipping project tag", {
        projectId: cleanProjectId,
      });
    }
  }

  logger.debug("Chat event details", { eventId: chatEvent.id, kind: chatEvent.kind });
  
  // Sign and publish the event
  await chatEvent.sign(context.agent.signer);
  chatEvent.publish();

  logger.info("✅ External delegation published, waiting synchronously for response", {
    eventId: chatEvent.id,
    kind: chatEvent.kind,
    agent: context.agent.name,
    mode: "synchronous",
  });

  const registry = DelegationRegistry.getInstance();
  const batchId = await registry.registerDelegation({
    delegationEventId: chatEvent.id,
    recipients: [{
      pubkey: pubkey,
      request: content,
      phase: context.phase,
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
        { type: "conversation", content: `🚀 External delegation sent: nostr:${chatEvent.encode()}` },
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
      mode: "synchronous",
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
      mode: "synchronous",
      error,
    });

    throw new Error(`Failed to wait for response: ${formatAnyError(error)}`);
  }
}

// AI SDK tool factory
export function createDelegateExternalTool(context: ExecutionContext): ReturnType<typeof tool> {
  return tool({
    description: "Delegate a task to an external agent or user and wait synchronously for their response, optionally as a reply or referencing a project",
    inputSchema: delegateExternalSchema,
    execute: async (input: DelegateExternalInput) => {
      return await executeDelegateExternal(input, context);
    },
  });
}


