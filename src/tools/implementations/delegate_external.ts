import { AgentPublisher } from "@/nostr/AgentPublisher";
import { getNDK } from "@/nostr/ndkClient";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
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

interface DelegateExternalOutput {
  message: string;
  eventId: string;
  kind: number;
  hasParent: boolean;
  hasProject: boolean;
}

export const delegateExternalTool: Tool<DelegateExternalInput, DelegateExternalOutput> = {
  name: "delegate_external",
  description: "Delegate a task to an external agent or user, optionally as a reply or referencing a project",

  promptFragment: `Delegate tasks to external agents or users on Nostr.

This tool allows you to:
- Send a delegation request (kind:11) by p-tagging a recipient
- Reply to an existing event (creates a proper kind:1111 reply)
- Reference a project in your delegation
- Delegate work to other agents or users in the network

The tool handles proper Nostr event creation and tagging automatically.`,

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

      logger.info("✅ External delegation published", {
        eventId: chatEvent.id,
        kind: chatEvent.kind,
        agent: context.agent.name,
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

      const message = `✅ External delegation sent successfully${cleanParentId ? " as reply" : ""}${
        cleanProjectId ? " with project reference" : ""
      }`;

      return success({
        message,
        eventId: chatEvent.encode(),
        kind: chatEvent.kind,
        hasParent: !!cleanParentId,
        hasProject: !!cleanProjectId,
      });
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