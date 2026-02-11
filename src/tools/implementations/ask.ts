import type { ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import { getPubkeyService } from "@/services/PubkeyService";
import type { StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { createEventContext } from "@/utils/event-context";
import { resolveRecipientToPubkey } from "@/services/agents";
import { config as configService } from "@/services/ConfigService";
import { ConversationStore } from "@/conversations/ConversationStore";
import { wouldCreateCircularDelegation } from "@/utils/delegation-chain";
import { agentStorage } from "@/agents/AgentStorage";
import { createAgentInstance } from "@/agents/agent-loader";
import { tool } from "ai";
import { z } from "zod";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

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

/**
 * Helper: Format questions with their full details for escalation prompt
 */
function formatQuestions(questions: AskInput["questions"]): string {
  return questions.map((q, idx) => {
    let formatted = `${idx + 1}. [${q.type}] ${q.title}\n   Question: ${q.question}\n`;
    if (q.type === "question" && q.suggestions) {
      formatted += `   Suggestions: ${q.suggestions.join(", ")}\n`;
    } else if (q.type === "multiselect" && q.options) {
      formatted += `   Options: ${q.options.join(", ")}\n`;
    } else {
      formatted += `   Type: Open-ended\n`;
    }
    return formatted;
  }).join("\n");
}

/**
 * Helper: Build escalation prompt for delegating ask to escalation agent
 */
function buildEscalationPrompt(
  input: AskInput,
  context: ToolExecutionContext,
  agentRole: string,
  delegationChain?: Array<{ displayName: string; pubkey: string }>
): string {
  const { title, context: askContext, questions } = input;

  let chainDisplay = "";
  if (delegationChain && delegationChain.length > 0) {
    chainDisplay = `\n## Delegation Chain\n${delegationChain.map(e => `- ${e.displayName} (${e.pubkey.substring(0, 8)})`).join("\n")}\n`;
  }

  const formattedQuestions = formatQuestions(questions);

  return `# Question Escalation Request

## Source
- Agent: ${context.agent.slug}
- Role: ${agentRole}
- Conversation: ${context.conversationId}
${chainDisplay}
## Questions Requiring Response

### ${title}
**Context:**
${askContext}

**Questions:**
${formattedQuestions}

## Your Task
You are acting as the project owner's proxy. Either:
1. Answer directly if you can make the decision
2. Use ask() to escalate to the actual human if you need their input

When responding, provide your answers in a clear format that addresses each question.`;
}

/**
 * Helper: Build prompt summary for delegation tracking
 */
function buildPromptSummary(input: AskInput): string {
  const { title, context: askContext, questions } = input;
  const questionSummary = questions.map(q => `[${q.title}] ${q.question}`).join("\n");
  return `${title}\n\n${askContext}\n\n---\n\n${questionSummary}`;
}

/**
 * Helper: Get escalation target (agent slug) from config, with validation and auto-add
 *
 * If the escalation agent exists in global storage but is not part of the current project,
 * it will be automatically added to the project.
 *
 * Returns null if no escalation agent configured, config not loaded, or agent doesn't exist
 */
async function getEscalationTarget(): Promise<string | null> {
  try {
    const config = configService.getConfig();
    const escalationAgentSlug = config.escalation?.agent;

    if (!escalationAgentSlug) {
      return null;
    }

    // First check if agent is already in the current project
    const pubkey = resolveRecipientToPubkey(escalationAgentSlug);
    if (pubkey) {
      // Agent is already in the project, nothing to do
      return escalationAgentSlug;
    }

    // Agent not in project - check if it exists in global storage
    const storedAgent = await agentStorage.getAgentBySlug(escalationAgentSlug);
    if (!storedAgent) {
      logger.warn("[ask] Escalation agent configured but not found in system", {
        escalationAgentSlug,
      });
      return null;
    }

    // Agent exists in storage but not in project - auto-add it
    logger.info("[ask] Auto-adding escalation agent to project", {
      escalationAgentSlug,
      agentName: storedAgent.name,
    });

    const projectCtx = getProjectContext();
    const projectDTag = projectCtx.agentRegistry.getProjectDTag();

    if (!projectDTag) {
      logger.warn("[ask] Cannot auto-add escalation agent: no project dTag available");
      return null;
    }

    // Get the agent's pubkey from its nsec
    const signer = new NDKPrivateKeySigner(storedAgent.nsec);
    const agentPubkey = signer.pubkey;

    // Add agent to project in storage
    await agentStorage.addAgentToProject(agentPubkey, projectDTag);

    // Reload the agent to get fresh state with the project association
    const freshAgent = await agentStorage.loadAgent(agentPubkey);
    if (!freshAgent) {
      logger.error("[ask] Failed to reload escalation agent after adding to project");
      return null;
    }

    // Create agent instance and add to registry
    const agentInstance = createAgentInstance(freshAgent, projectCtx.agentRegistry);
    projectCtx.agentRegistry.addAgent(agentInstance);

    // Notify the Daemon about the new agent for routing
    projectCtx.notifyAgentAdded(agentInstance);

    logger.info("[ask] Successfully auto-added escalation agent to project", {
      escalationAgentSlug,
      agentPubkey: agentPubkey.substring(0, 8),
      projectDTag,
    });

    return escalationAgentSlug;
  } catch (error) {
    // Config not loaded or other error - this is fine, just means no escalation agent configured
    logger.debug("[ask] Error getting escalation target, no escalation routing", { error });
    return null;
  }
}

async function executeAsk(input: AskInput, context: ToolExecutionContext): Promise<AskOutput> {
  const { title, context: askContext, questions } = input;

  const projectCtx = getProjectContext();
  const ownerPubkey = projectCtx?.project?.pubkey;

  if (!ownerPubkey) {
    throw new Error("No project owner configured - cannot determine who to ask");
  }

  // Check for escalation agent configuration using helper
  // This will auto-add the agent to the project if it exists in storage but not in project
  const escalationAgentSlug = await getEscalationTarget();

  // If escalation agent is configured AND current agent is not the escalation agent,
  // route through escalation agent instead of directly to user
  if (escalationAgentSlug && context.agent.slug !== escalationAgentSlug) {
    const escalationAgentPubkey = resolveRecipientToPubkey(escalationAgentSlug);

    if (!escalationAgentPubkey) {
      // This shouldn't happen since getEscalationTarget() validates it,
      // but handle gracefully just in case
      logger.warn("[ask] Escalation agent not found, falling back to direct ask", {
        escalationAgentSlug,
        fromAgent: context.agent.slug,
      });
      // Fall through to normal ask flow
    } else {
      // Get delegation chain for circular delegation check
      const conversationStore = ConversationStore.get(context.conversationId);
      const delegationChain = conversationStore?.metadata?.delegationChain;

      // Check for circular delegation using stored chain
      if (delegationChain && wouldCreateCircularDelegation(delegationChain, escalationAgentPubkey)) {
        const chainDisplay = delegationChain.map(e => e.displayName).join(" → ");

        logger.warn("[ask] Circular delegation detected, falling back to direct ask", {
          escalationAgent: escalationAgentSlug,
          targetPubkey: escalationAgentPubkey.substring(0, 8),
          chain: chainDisplay,
        });

        // Fall through to normal ask flow instead of throwing
        // This allows the question to still be asked directly to the user
      } else {
        // Route through escalation agent
        logger.info("[ask] Routing ask through escalation agent", {
          fromAgent: context.agent.slug,
          escalationAgent: escalationAgentSlug,
          toUser: ownerPubkey.substring(0, 8),
          questionCount: questions.length,
        });

        // Get full agent info for role
        const fullAgent = projectCtx.getAgentByPubkey(context.agent.pubkey);
        const agentRole = fullAgent?.role || "N/A";

        // Build escalation prompt using helper
        const escalationPrompt = buildEscalationPrompt(input, context, agentRole, delegationChain);

        // Delegate to escalation agent
        const eventContext = createEventContext(context);
        const eventId = await context.agentPublisher.delegate({
          recipient: escalationAgentPubkey,
          content: escalationPrompt,
        }, eventContext);

        // Build prompt summary for delegation tracking using helper
        const promptSummary = buildPromptSummary(input);

        return {
          __stopExecution: true,
          pendingDelegations: [
            {
              type: "ask" as const,
              delegationConversationId: eventId,
              recipientPubkey: escalationAgentPubkey,
              senderPubkey: context.agent.pubkey,
              prompt: promptSummary,
              ralNumber: context.ralNumber,
            },
          ],
        };
      }
    }
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

  // Build prompt summary for delegation tracking using helper
  const promptSummary = buildPromptSummary(input);

  return {
    __stopExecution: true,
    pendingDelegations: [
      {
        type: "ask" as const,
        delegationConversationId: eventId,
        recipientPubkey: ownerPubkey,
        senderPubkey: context.agent.pubkey,
        prompt: promptSummary,
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
