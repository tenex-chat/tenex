import type { ExecutionContext } from "@/agents/execution/types";
import { getNDK } from "@/nostr/ndkClient";
import type { StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { normalizeNostrIdentifier, parseNostrUser } from "@/utils/nostr-entity-parser";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";

const delegateExternalSchema = z.object({
  content: z.string().describe("The content of the chat message to send"),
  recipient: z.string().describe("The recipient's pubkey or npub (will be p-tagged)"),
  projectId: z
    .string()
    .optional()
    .describe(
      "Optional project event ID (naddr1...) to reference in the message."
    ),
});

type DelegateExternalInput = z.infer<typeof delegateExternalSchema>;
type DelegateExternalOutput = StopExecutionSignal;

async function executeDelegateExternal(
  input: DelegateExternalInput,
  context: ExecutionContext
): Promise<DelegateExternalOutput> {
  const { content, recipient, projectId } = input;

  const pubkey = parseNostrUser(recipient);
  if (!pubkey) {
    throw new Error(`Invalid recipient format: ${recipient}`);
  }

  if (pubkey === context.agent.pubkey && !projectId) {
    throw new Error(
      "Self-delegation requires a projectId for cross-project delegation."
    );
  }

  const ndk = getNDK();
  const cleanProjectId = normalizeNostrIdentifier(projectId) ?? undefined;

  logger.info("[delegate_external] Publishing external delegation", {
    agent: context.agent.name,
    recipientPubkey: pubkey.substring(0, 8),
  });

  // Create delegation event
  const chatEvent = new NDKEvent(ndk);
  chatEvent.kind = 11;
  chatEvent.content = content;
  chatEvent.tags.push(["p", pubkey]);

  if (cleanProjectId) {
    const projectEvent = await ndk.fetchEvent(cleanProjectId);
    if (projectEvent) {
      chatEvent.tag(projectEvent.tagReference());
    }
  }

  await context.agent.sign(chatEvent);
  await chatEvent.publish();

  return {
    __stopExecution: true,
    pendingDelegations: [
      {
        type: "external" as const,
        eventId: chatEvent.id,
        recipientPubkey: pubkey,
        prompt: content,
        projectId: cleanProjectId,
      },
    ],
  };
}

export function createDelegateExternalTool(context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description: `Delegate a task to an external agent or user. Use this tool only to engage with agents in OTHER projects.

When using this tool, provide context to the recipient, introduce yourself and explain you are an agent and the project you are working on.`,
    inputSchema: delegateExternalSchema,
    execute: async (input: DelegateExternalInput) => {
      return await executeDelegateExternal(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: (args: unknown) => {
      if (!args || typeof args !== "object") {
        return "Delegating to external agent";
      }

      const { recipient, projectId } = args as Partial<DelegateExternalInput>;

      if (!recipient) {
        return "Delegating to external agent";
      }

      let message = `Delegating to external agent ${recipient}`;
      if (projectId) {
        message += ` in project ${projectId}`;
      }
      return message;
    },
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
