import type { ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import type { StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/utils/event-context";
import { tool } from "ai";
import { z } from "zod";

/**
 * Schema for a single-select question.
 * User picks one option from suggestions, or provides their own answer.
 */
const singleSelectQuestionSchema = z.object({
  type: z.literal("question"),
  title: z.string().describe("Short title for the question (displayed as header, max 12 chars recommended)"),
  question: z.string().describe("Full question text with all necessary context"),
  suggestions: z.array(z.string()).optional().describe(
    "Optional suggestions for single-select. If you recommend a specific option, make it the first in the list and add '(Recommended)' suffix. Omit for fully open-ended questions."
  ),
});

/**
 * Schema for a multi-select question.
 * User can pick multiple options, or provide their own answer.
 */
const multiSelectQuestionSchema = z.object({
  type: z.literal("multiselect"),
  title: z.string().describe("Short title for the question (displayed as header, max 12 chars recommended)"),
  question: z.string().describe("Full question text with all necessary context"),
  options: z.array(z.string()).optional().describe(
    "Optional options for multi-select. User can select multiple. Omit for fully open-ended questions."
  ),
});

/**
 * Union schema for all question types.
 */
const questionSchema = z.discriminatedUnion("type", [
  singleSelectQuestionSchema,
  multiSelectQuestionSchema,
]);

/**
 * Main schema for the ask tool.
 * Supports multiple questions of different types in a single ask event.
 */
const askSchema = z.object({
  title: z.string().describe(
    "A brief title that encompasses all questions being asked (3-5 words). This helps the user quickly understand the topic at a glance."
  ),
  context: z.string().describe(
    "Full background and all information the user needs to understand and answer the questions. " +
    "CRITICAL: The user has NO access to your conversation history - include ALL relevant details, " +
    "prior decisions, constraints, and reasoning. Be comprehensive but concise."
  ),
  questions: z.array(questionSchema).min(1).describe(
    "Array of questions to ask. Use 'question' type for single-select, 'multiselect' type for multi-select. " +
    "Can mix types. Keep to 1-4 questions per ask event."
  ),
});

type AskInput = z.infer<typeof askSchema>;
type AskOutput = StopExecutionSignal;

async function executeAsk(input: AskInput, context: ToolExecutionContext): Promise<AskOutput> {
  const { title, context: askContext, questions } = input;

  const projectCtx = getProjectContext();
  const ownerPubkey = projectCtx?.project?.pubkey;

  if (!ownerPubkey) {
    throw new Error("No project owner configured - cannot determine who to ask");
  }

  logger.info("[ask] Publishing ask event", {
    fromAgent: context.agent.slug,
    questionCount: questions.length,
    questionTypes: questions.map(q => q.type),
  });

  const eventContext = createEventContext(context);
  const eventId = await context.agentPublisher.ask(
    {
      recipient: ownerPubkey,
      title,
      context: askContext,
      questions,
    },
    eventContext
  );

  // Build prompt summary for delegation tracking
  const promptSummary = questions.map(q => `[${q.title}] ${q.question}`).join("\n");

  return {
    __stopExecution: true,
    pendingDelegations: [
      {
        type: "ask" as const,
        delegationConversationId: eventId,
        recipientPubkey: ownerPubkey,
        senderPubkey: context.agent.pubkey,
        prompt: `${title}\n\n${askContext}\n\n---\n\n${promptSummary}`,
        ralNumber: context.ralNumber,
      },
    ],
  };
}

export function createAskTool(context: ToolExecutionContext): AISdkTool {
  const aiTool = tool({
    description: `Ask questions to the project owner and wait for their response.

Use this tool when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices
4. Offer choices about what direction to take

IMPORTANT: This creates a completely new conversation - the user has ZERO context from your current work.
You MUST provide comprehensive context including all background information, prior decisions, constraints,
and reasoning needed for the user to understand and answer your questions.

Question types:
- "question": Single-select. User picks one option or provides their own answer.
- "multiselect": Multi-select. User can pick multiple options or provide their own answer.

Note: All questions are inherently open-ended - users can always respond with whatever they want.
The suggestions/options you provide are helpful hints, not constraints.

Tips:
- If you recommend a specific option, make it the first in the list and add "(Recommended)" suffix
- Keep titles short (max 12 chars) for clean display
- Group related questions in a single ask event (1-4 questions)
- Be comprehensive in the context field - the user sees ONLY what you provide`,
    inputSchema: askSchema,
    execute: async (input: AskInput) => {
      return await executeAsk(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: ({ title, questions }: AskInput) => {
      const questionSummary = questions.map(q => q.title).join(", ");
      return `Asking: "${title}" [${questionSummary}]`;
    },
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
