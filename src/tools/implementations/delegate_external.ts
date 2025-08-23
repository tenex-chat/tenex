import { AgentPublisher } from "@/nostr/AgentPublisher";
import { getNDK } from "@/nostr/ndkClient";
import { DelegationService, type DelegationResponses } from "@/services/DelegationService";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { NDKEvent, NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
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
    .describe("Optional project event ID (naddr1...) to reference in the message"),
});

interface DelegateExternalInput {
  content: string;
  parentEventId?: string;
  recipient: string;
  projectId?: string;
}

export const delegateExternalTool: Tool<DelegateExternalInput, DelegationResponses> = {
  name: "delegate_external",
  description: "Delegate a task to an external agent or user and wait synchronously for their response, optionally as a reply or referencing a project",

  promptFragment: `Delegate tasks to external agents or users on Nostr and wait synchronously for their response.

This tool allows you to:
- Send a delegation request (kind:11) by p-tagging a recipient
- Ask follow-up questions to an existing event (creates a proper kind:1111 reply)
- Reference a project in your delegation
- Wait synchronously for the recipient's response (blocking indefinitely until response)`,

  parameters: createZodSchema(delegateExternalSchema),

  execute: async (input, context) => {
    const { content, parentEventId, recipient, projectId } = input.value;

    logger.info("🚀 Delegating to external agent", {
      agent: context.agent.name,
      hasParent: !!parentEventId,
      hasProject: !!projectId,
      recipientPrefix: recipient.substring(0, 8),
      contentLength: content.length,
    });

    try {
      const ndk = getNDK();
      let chatEvent: NDKEvent;

      // Strip optional nostr: prefix from IDs
      const cleanParentId = parentEventId?.replace(/^nostr:/, "");
      const cleanProjectId = projectId?.replace(/^nostr:/, "");

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
        chatEvent.content = content;
        chatEvent.tags = chatEvent.tags.filter(t => t[0] !== 'p');
      } else {
        // Create a new kind:11 event for direct messaging
        chatEvent = new NDKEvent(ndk, {
          kind: 11,
          content,
          tags: [],
        });
      }

      let pubkey = recipient;

      if (recipient.startsWith('npub')) {
        pubkey = ndk.getUser({ npub: recipient }).pubkey;
      }
      
      // P-tag the recipient
      chatEvent.tags.push(["p", pubkey]);

      // Add project reference if provided
      if (cleanProjectId) {
        const projectEvent = await ndk.fetchEvent(cleanProjectId);
        if (projectEvent) {
          // Use the event's tagReference() method to properly tag it
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

      // Publish conversation status event
      try {
        const agentPublisher = new AgentPublisher(context.agent, context.conversationCoordinator);
        const conversation = context.conversationCoordinator.getConversation(context.conversationId);

        if (conversation?.history?.[0]) {
          const nostrReference = `nostr:${chatEvent.encode()}`;
          await agentPublisher.conversation(
            { type: "conversation", content: `🚀 External delegation sent: ${nostrReference}` },
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

      // Wait synchronously for response from the external agent (blocking execution)
      logger.info("⏳ Blocking execution to wait for external agent response", {
        eventId: chatEvent.id,
        recipientPubkey: pubkey.substring(0, 16),
        mode: "synchronous",
      });

      try {
        const response = await waitForExternalResponse({
          delegationEventId: chatEvent.id!,
          expectedSenderPubkey: pubkey,
        });

        logger.info("✅ Synchronous wait complete - received response from external agent", {
          eventId: chatEvent.id,
          responseLength: response.responses[0]?.response.length || 0,
          mode: "synchronous",
        });

        return success(response);
      } catch (error) {
        // Synchronous wait failed - this should only happen if there's a network issue
        logger.error("❌ Synchronous wait failed for external response", {
          eventId: chatEvent.id,
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

/**
 * Synchronously wait for a response from an external agent.
 * This function blocks execution indefinitely until:
 * - A response is received (kind:1111 reply event from the expected sender)
 * 
 * This ensures the delegate_external tool behaves synchronously like other delegation tools.
 */
async function waitForExternalResponse(params: {
  delegationEventId: string;
  expectedSenderPubkey: string;
}): Promise<DelegationResponses> {
  const { delegationEventId, expectedSenderPubkey } = params;
  const ndk = getNDK();

  return new Promise<DelegationResponses>((resolve, reject) => {
    let subscription: NDKSubscription | undefined;
    let resolved = false;

    // Cleanup function
    const cleanup = () => {
      if (subscription) {
        subscription.stop();
      }
      resolved = true;
    };

    // Set up subscription filter
    const filter: NDKFilter = {
      kinds: [1111], // Reply events
      authors: [expectedSenderPubkey],
      "#e": [delegationEventId], // Must be replying to our delegation
    };

    logger.debug("Setting up synchronous wait subscription for external response", {
      filter,
      delegationEventId: delegationEventId.substring(0, 8),
      expectedSender: expectedSenderPubkey.substring(0, 16),
      mode: "synchronous",
    });

    // Create subscription - will block indefinitely until response
    subscription = ndk.subscribe(filter, {
      closeOnEose: false, // Keep listening indefinitely until response
    });

    subscription.on("event", (event: NDKEvent) => {
      logger.info("📨 Synchronous wait successful - received response from external agent", {
        eventId: event.id,
        from: event.pubkey.substring(0, 16),
        contentLength: event.content.length,
        mode: "synchronous",
      });

      // Check if this is indeed a reply to our delegation
      const replyToTag = event.tags.find(
        (tag) => tag[0] === "e" && tag[1] === delegationEventId
      );

      if (replyToTag) {
        cleanup();

        // Extract summary if present
        const summaryTag = event.tags.find((tag) => tag[0] === "summary");
        const summary = summaryTag?.[1];

        // Build response
        const response: DelegationResponses = {
          type: "delegation_responses",
          responses: [{
            response: event.content,
            summary,
            from: event.pubkey,
          }],
        };

        resolve(response);
      }
    });

    subscription.on("eose", () => {
      logger.debug("End of stored events - continuing synchronous wait for new events", {
        mode: "synchronous",
      });
      // Continue synchronous blocking wait indefinitely for new events until response
    });
  });
}