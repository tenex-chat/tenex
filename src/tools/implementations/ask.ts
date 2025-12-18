import type { ExecutionContext } from "@/agents/execution/types";
import { getProjectContext } from "@/services/ProjectContext";
import type { StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const askSchema = z.object({
  content: z.string().describe("The question to ask the project manager or human user"),
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
  const { content, suggestions } = input;

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

  const eventId = await context.agentPublisher.ask(
    {
      recipient: ownerPubkey,
      content,
      suggestions,
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
        type: "ask" as const,
        eventId,
        recipientPubkey: ownerPubkey,
        prompt: content,
        suggestions,
      },
    ],
  };
}

export function createAskTool(context: ExecutionContext): AISdkTool {
  const aiTool = tool({
    description:
      "Ask a question to the project owner and wait for their response. Supports open-ended questions (no suggestions), yes/no questions (suggestions=['Yes', 'No']), or multiple choice questions (custom suggestions list). Use criteria: ONLY use this tool when you need clarification or help FROM A HUMAN, do not use this to ask questions to other agents.",
    inputSchema: askSchema,
    execute: async (input: AskInput) => {
      return await executeAsk(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: ({ content, suggestions }: AskInput) => {
      if (suggestions && suggestions.length > 0) {
        return `Asking: "${content}" [${suggestions.join(", ")}]`;
      }
      return `Asking: "${content}"`;
    },
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
