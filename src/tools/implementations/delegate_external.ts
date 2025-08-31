import { getNDK } from "@/nostr/ndkClient";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import type { DelegationResponses } from "@/services/DelegationService";
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
    .describe("Optional project event ID (naddr1...) to reference in the message. This should be the project the agent you are delegating TO works on (if you know it)"),
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
- Start a thread (kind:11) by p-tagging a recipient
- Ask follow-up questions to an existing event (creates a proper kind:1111 reply)
- Reference a project in your delegation
- Wait synchronously for the recipient's response (blocking indefinitely until response)

IMPORTANT Communication Guidelines:
- When delegating to agents from other projects, recontextualize the message from YOUR perspective
- Replace ambiguous pronouns like "we" with specific context (e.g., "the [YourProject] project" or "I")
- Identify yourself and your project when initiating cross-project communication
- Don't assume the recipient shares your context - provide necessary background
- Focus on what the recipient knows about; don't mention internal project details unless essential

Example transformations:
BAD: "We need to fix our authentication system, how did you solve this?"
GOOD: "I'm working on the Authentication project and need to fix an authentication issue. How did the TENEX project solve this?"

BAD: "The agent lesson kind we're using is incorrect"
GOOD: "In my project (Agents Web), I have an incorrect agent lesson kind implementation"`,

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

      logger.debug("Processing recipient", { cleanRecipient });

      // Convert npub to hex pubkey if needed
      let pubkey = cleanRecipient;
      if (cleanRecipient.startsWith('npub')) {
        pubkey = ndk.getUser({ npub: cleanRecipient }).pubkey;
      } else {
        // Validate it's a proper hex pubkey (64 hex characters)
        if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
          return failure({
            kind: "execution" as const,
            tool: "delegate_external",
            message: `Invalid pubkey format: ${pubkey.substring(0, 16)}... (must be 64 hex characters or npub)`,
          });
        }
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

