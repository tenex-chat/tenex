import { getNDK } from "@/nostr/ndkClient";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import type { DelegationResponses } from "@/services/DelegationService";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { NDKEvent, type NDKFilter, type NDKSubscription } from "@nostr-dev-kit/ndk";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema, failure, success } from "../types";

const delegateExternalSchema = z.object({
  content: z.string().describe("The content of the chat message to send"),
  parentEventId: z
    .string()
    .optional()
    .describe("Optional parent event ID to reply to. If provided, will create a reply (kind:1111)"),
  recipient: z.string().describe("The recipient's pubkey or npub (will be p-tagged)"),
  projectId: z
    .string()
    .optional()
    .describe("Optional project event ID (naddr1...) to reference in the message. This should be the project the agent you are delegating TO works on (if you know it)"),
});

interface DelegateExternalInput {
  content: string;
  parentEventId?: string;
  recipient: string;
  projectId?: string;
}

export const delegateExternalTool: Tool<DelegateExternalInput, DelegationResponses> = {
  name: "delegate-external",
  description: "Delegate a task to an external agent or user and wait synchronously for their response, optionally as a reply or referencing a project",

  promptFragment: `Delegate tasks to external agents or users on Nostr and wait synchronously for their response.

This tool allows you to:
- Start a thread (kind:11) by p-tagging a recipient
- Ask follow-up questions to an existing event (creates a proper kind:1111 reply)
- Reference a project in your delegation
- Wait synchronously for the recipient's response (blocking indefinitely until response)`,

  parameters: createZodSchema(delegateExternalSchema),

  execute: async (input, context) => {
    const { content, parentEventId, recipient, projectId } = input.value;

    // Clean the recipient - strip nostr: prefix if present
    const cleanRecipient = recipient.replace(/^nostr:/, "");

    logger.info("🚀 Delegating to external agent", {
      agent: context.agent.name,
      hasParent: !!parentEventId,
      hasProject: !!projectId,
      recipientPrefix: cleanRecipient.substring(0, 8),
      contentLength: content.length,
    });

    try {
      const ndk = getNDK();
      let chatEvent: NDKEvent;

      // Strip optional nostr: prefix from IDs
      const cleanParentId = parentEventId?.replace(/^nostr:/, "");
      const cleanProjectId = projectId?.replace(/^nostr:/, "");

      // Convert npub to hex pubkey if needed
      let pubkey = cleanRecipient;
      if (cleanRecipient.startsWith('npub')) {
        pubkey = ndk.getUser({ npub: cleanRecipient }).pubkey;
      }

      if (cleanParentId) {
        // Fetch the parent event and create a reply
        const parentEvent = await ndk.fetchEvent(cleanParentId);
        if (!parentEvent) {
          return failure({
            kind: "execution" as const,
            tool: "delegate_external",
            message: `Parent event not found: ${cleanParentId}`,
          });
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

      // Sign and publish the event
      await chatEvent.sign(context.agent.signer);
      await chatEvent.publish();

      logger.info("✅ External delegation published, waiting synchronously for response", {
        eventId: chatEvent.id,
        kind: chatEvent.kind,
        agent: context.agent.name,
        mode: "synchronous",
      });

      // Register the delegation using the new unified interface
      const registry = DelegationRegistry.getInstance();
      logger.info("📦 Registering single-recipient delegation", {
        eventId: chatEvent.id.substring(0, 8),
        recipient: pubkey.substring(0, 16),
        kind: chatEvent.kind,
      });
      
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

      logger.info("✅ Single-recipient delegation registered via unified approach", {
        batchId,
        eventId: chatEvent.id.substring(0, 8),
        conversationId: context.conversationId.substring(0, 8),
        recipient: pubkey.substring(0, 16),
        usingUnifiedApproach: true,
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

      // Wait synchronously for response using the batch completion mechanism
      logger.info("⏳ Blocking execution to wait for external agent response", {
        eventId: chatEvent.id,
        recipientPubkey: pubkey.substring(0, 16),
        batchId,
        mode: "synchronous",
      });

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

        return success(response);
      } catch (error) {
        // Synchronous wait failed - this should only happen if there's a network issue
        logger.error("❌ Synchronous wait failed for external response", {
          eventId: chatEvent.id,
          batchId,
          mode: "synchronous",
          error,
        });

        return failure({
          kind: "execution" as const,
          tool: "delegate_external",
          message: `Failed to wait for response: ${formatAnyError(error)}`,
        });
      }
    } catch (error) {
      logger.error("❌ External delegation tool failed", {
        error: formatAnyError(error),
        agent: context.agent.name,
        phase: context.phase,
        conversationId: context.conversationId,
      });

      return failure({
        kind: "execution" as const,
        tool: "delegate_external",
        message: formatAnyError(error),
      });
    }
  },
};

