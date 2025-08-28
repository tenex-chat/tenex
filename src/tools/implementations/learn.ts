import type { EventContext, LessonIntent } from "@/nostr/AgentEventEncoder";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema, failure, success } from "../types";

const lessonLearnSchema = z.object({
  title: z.string().describe("Brief title/description of what this lesson is about"),
  lesson: z.string().describe("The key insight or lesson learned - be concise and actionable"),
  detailed: z
    .string()
    .optional()
    .describe("Detailed version with richer explanation when deeper context is needed"),
  category: z
    .string()
    .optional()
    .describe(
      "Single category for filing this lesson (e.g., 'architecture', 'debugging', 'user-preferences')"
    ),
  hashtags: z
    .array(z.string())
    .optional()
    .describe("Hashtags for easier sorting and discovery (e.g., ['async', 'error-handling'])"),
});

interface LessonLearnInput {
  title: string;
  lesson: string;
  detailed?: string;
  category?: string;
  hashtags?: string[];
}

interface LessonLearnOutput {
  message: string;
  eventId: string;
  title: string;
  hasDetailed: boolean;
}

export const lessonLearnTool: Tool<LessonLearnInput, LessonLearnOutput> = {
  name: "lesson_learn",
  description:
    "Record an important lesson learned during execution that should be carried forward, with optional detailed version",

  promptFragment: `Record important lessons that will improve future performance.

## Quick Decision Checklist
| ✅ RECORD if... | ❌ SKIP if... |
|-----------------|---------------|
| Project-specific insight | Generic programming knowledge |
| Prevents future mistakes | Obvious/trivial fact |
| Non-obvious behavior | Standard convention |
| Hidden dependency/gotcha | Temporary workaround |
| Within your expertise domain | Better suited for another agent |

## Metacognition Questions (answer 2+ YES to record):
□ Will remembering this permanently improve my behavior?
□ Is it within my role's expertise?
□ Am I the right agent in the system to learn this or is there an agent better suited for this?
□ Is it absolutely obvious?

## Detailed Version Guidelines:
Only include a detailed version when:
- The lesson genuinely NEEDS deeper explanation that can't be captured in 3-4 paragraphs
- There are complex technical details or edge cases to document
- Multiple examples or scenarios need to be explained
- The context is critical for understanding why this matters

### Special Instructions for Human-Replica Agents:
When modeling the user, ALWAYS be especially keen to capture rich details in the detailed version about:
- User preferences and habits (work style, tool preferences, coding patterns)
- Communication styles and language patterns
- Personal context and background that affects their work
- Emotional patterns and triggers
- Decision-making patterns and priorities
- Specific examples of their behavior and choices
- Nuanced preferences that go beyond simple likes/dislikes

The detailed version is CRITICAL to avoid losing nuance and detail; you should write there all the important nuance that would be lost in the summary version.
`,

  parameters: createZodSchema(lessonLearnSchema),

  execute: async (input, context) => {
    const { title, lesson, detailed, category, hashtags } = input.value;

    logger.info("🎓 Agent recording new lesson", {
      agent: context.agent.name,
      agentPubkey: context.agent.pubkey,
      title,
      lessonLength: lesson.length,
      phase: context.phase,
      conversationId: context.conversationId,
    });

    try {
      // Create lesson intent
      const intent: LessonIntent = {
        type: "lesson",
        title,
        lesson,
        detailed,
        category,
        hashtags,
      };

      // Get conversation for the event context
      const conversation = context.conversationCoordinator.getConversation(context.conversationId);

      // Create event context
      const eventContext: EventContext = {
        triggeringEvent: context.triggeringEvent,
        rootEvent: conversation?.history[0] ?? context.triggeringEvent, // Use triggering event as fallback
        conversationId: context.conversationId,
      };

      // Use shared AgentPublisher instance from context to create and publish the lesson
      const lessonEvent = await context.agentPublisher.lesson(intent, eventContext);

      // Publish status message with the Nostr reference
      try {
        const conversation = context.conversationCoordinator.getConversation(context.conversationId);
        if (conversation?.history?.[0]) {
          const nostrReference = `nostr:${lessonEvent.encode()}`;
          await context.agentPublisher.conversation(
            { type: "conversation", content: `📚 Learning lesson: ${nostrReference}` },
            {
              triggeringEvent: context.triggeringEvent,
              rootEvent: conversation.history[0],
              conversationId: context.conversationId,
            }
          );
        }
      } catch (error) {
        // Don't fail the tool if we can't publish the status
        console.warn("Failed to publish learn status:", error);
      }

      const message = `✅ Lesson recorded: "${title}"${detailed ? " (with detailed version)" : ""}\n\nThis lesson will be available in future conversations to help avoid similar issues.`;

      return success({
        message,
        eventId: lessonEvent.encode(),
        title,
        hasDetailed: !!detailed,
      });
    } catch (error) {
      logger.error("❌ Learn tool failed", {
        error: formatAnyError(error),
        agent: context.agent.name,
        agentPubkey: context.agent.pubkey,
        title,
        phase: context.phase,
        conversationId: context.conversationId,
      });

      return failure({
        kind: "execution" as const,
        tool: "lesson_learn",
        message: formatAnyError(error),
      });
    }
  },
};
