import type { ExecutionContext } from "@/agents/execution/types";
import { getProjectContext } from "@/services/projects";
import type { StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/utils/phase-utils";
import { tool } from "ai";
import { z } from "zod";

const askSchema = z.object({
  tldr: z.string().describe(
    "A brief one-liner summary of what you're asking. This helps the user quickly understand the question at a glance."
  ),
  context: z.string().describe(
    "Full background and all information the user needs to make a decision. CRITICAL: The user has NO access to your conversation history - include ALL relevant details, prior decisions, constraints, and reasoning. Be comprehensive."
  ),
  suggestions: z
    .array(z.string())
    .optional()
    .describe(
      "Optional suggestions for response. Empty/not provided for open-ended questions, ['Yes', 'No'] for yes/no questions, or any custom list for multiple choice"
    ),
});

type AskInput = z.infer<typeof askSchema>;
type AskOutput = StopExecutionSignal;

async function executeAsk(input: AskInput, context: ExecutionContext): Promise<AskOutput> {
  const { tldr, context: askContext, suggestions } = input;

  const projectCtx = getProjectContext();
  const ownerPubkey = projectCtx?.project?.pubkey;

  if (!ownerPubkey) {
    throw new Error("No project owner configured - cannot determine who to ask");
  }

  if (!context.agentPublisher) {
    throw new Error("AgentPublisher not available");
  }

  logger.info("[ask] Publishing ask event", {
    fromAgent: context.agent.slug,
    hasSuggestions: !!suggestions,
  });

  const eventContext = createEventContext(context);
  const eventId = await context.agentPublisher.ask(
    {
      recipient: ownerPubkey,
      tldr,
      context: askContext,
      suggestions,
    },
    eventContext
  );

  return {
    __stopExecution: true,
    pendingDelegations: [
      {
        type: "ask" as const,
        delegationConversationId: eventId,
        recipientPubkey: ownerPubkey,
        senderPubkey: context.agent.pubkey,
        prompt: `${tldr}\n\n${askContext}`,
        suggestions,
        ralNumber: context.ralNumber!,
      },
    ],
  };
}

export function createAskTool(context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description:
      "Ask a question to the project owner and wait for their response. " +
      "IMPORTANT: This creates a completely new conversation - the user has ZERO context from your current work. " +
      "You MUST provide comprehensive context in the 'context' field including all background information, " +
      "prior decisions, constraints, and reasoning needed for the user to understand and answer your question. " +
      "The 'tldr' should be a brief one-liner so they can quickly grasp what's being asked. " +
      "After asking, you can use delegate_followup with the returned delegationConversationId to send follow-up questions if needed.",
    inputSchema: askSchema,
    execute: async (input: AskInput) => {
      return await executeAsk(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: ({ tldr, suggestions }: AskInput) => {
      if (suggestions && suggestions.length > 0) {
        return `Asking: "${tldr}" [${suggestions.join(", ")}]`;
      }
      return `Asking: "${tldr}"`;
    },
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
