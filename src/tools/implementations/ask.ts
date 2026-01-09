import type { ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import { getPubkeyService } from "@/services/PubkeyService";
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
    "Background information the user needs to understand and answer the questions. " +
    "CRITICAL: The user has NO access to your conversation history - include ALL relevant details, " +
    "prior decisions, constraints, and reasoning. Be comprehensive but concise. " +
    "DO NOT include the questions themselves in this field - questions go ONLY in the 'questions' array below. " +
    "This field is for context/background ONLY."
  ),
  questions: z.array(questionSchema).min(1).describe(
    "Array of questions to ask. Use 'question' type for single-select, 'multiselect' type for multi-select. " +
    "Can mix types. Keep to 1-4 questions per ask event. " +
    "Questions are rendered separately from the context - do NOT duplicate them in the context field."
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

  // Get human-readable name for the recipient
  const pubkeyService = getPubkeyService();
  const recipientName = await pubkeyService.getName(ownerPubkey);

  logger.info("[ask] Publishing ask event", {
    fromAgent: context.agent.slug,
    toUser: recipientName,
    toUserPubkey: ownerPubkey.substring(0, 8),
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
    description: `Ask questions to a human user (the project owner) and wait for their response.

PURPOSE: Use this tool ONLY to ask questions to humans. Do NOT use it for any other purpose.

When to use:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices
4. Offer choices about what direction to take

CRITICAL - Structure your input correctly:
- "context": Background information ONLY. Do NOT put questions here.
- "questions": Array of actual questions. Questions are rendered separately by the UI.

BAD example (questions in context):
  context: "I found X and Y. Which do you prefer? Also, should I use Z?"
  questions: [...]

GOOD example (context is just background):
  context: "I found X and Y while investigating the issue. Here's what each does: ..."
  questions: [{type: "question", title: "Preference", question: "Which approach do you prefer?", suggestions: ["X", "Y"]}]

The user sees the context field as explanatory text, then sees each question rendered as a separate UI element.
DO NOT duplicate questions in the context - they will appear twice to the user.

Question types:
- "question": Single-select. User picks one option or provides their own answer.
- "multiselect": Multi-select. User can pick multiple options.

Tips:
- If you recommend an option, make it first and add "(Recommended)" suffix
- Keep titles short (max 12 chars) for clean display
- Group related questions in a single ask event (1-4 questions)
- The user has NO access to your conversation history - include all relevant context`,
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
