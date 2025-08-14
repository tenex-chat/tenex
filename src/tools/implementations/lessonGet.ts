import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { getNDK } from "@/nostr";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema } from "../types";
import type { NDKFilter } from "@nostr-dev-kit/ndk";

const lessonGetSchema = z.object({
    title: z.string().describe("Title of the lesson to retrieve"),
});

interface LessonGetInput {
    title: string;
}

interface LessonGetOutput {
    title: string;
    lesson: string;
    detailed?: string;
    category?: string;
    hashtags?: string[];
    hasDetailed: boolean;
}

export const lessonGetTool: Tool<LessonGetInput, LessonGetOutput> = {
    name: "lesson_get",
    description:
        "Retrieve the full version of a lesson by its title, including detailed explanation if available",

    promptFragment: `Use the lesson_get tool when you need to retrieve the full details of a lesson you've learned before. This is especially useful when:
- You need more context about a previously learned lesson
- The lesson summary mentions a detailed version is available
- You're working on something related to a past lesson and need the full context

The tool will return both the summary and detailed version (if available) of the lesson.`,

    parameters: createZodSchema(lessonGetSchema),

    execute: async (input, context) => {
        const { title } = input.value;

        logger.info("📖 Agent retrieving lesson by title", {
            agent: context.agent.name,
            agentPubkey: context.agent.pubkey,
            title,
            phase: context.phase,
            conversationId: context.conversationId,
        });

        const ndk = getNDK();
        if (!ndk) {
            const error = "NDK instance not available";
            logger.error("❌ lesson_get tool failed", {
                error,
                agent: context.agent.name,
                agentPubkey: context.agent.pubkey,
                title,
                phase: context.phase,
                conversationId: context.conversationId,
            });
            return {
                ok: false,
                error: {
                    kind: "execution" as const,
                    tool: "lesson_get",
                    message: error,
                },
            };
        }

        try {
            // Build filter to find lessons by title for this agent
            const filter: NDKFilter = {
                kinds: [NDKAgentLesson.kind],
                "#title": [title],
            };

            // Add agent filter if we have the agent's event ID
            if (context.agent.eventId) {
                filter["#e"] = [context.agent.eventId];
            }

            // Fetch matching lessons
            const events = await ndk.fetchEvents(filter);
            
            if (events.size === 0) {
                return {
                    ok: false,
                    error: {
                        kind: "execution" as const,
                        tool: "lesson_get",
                        message: `No lesson found with title: "${title}"`,
                    },
                };
            }

            // Get the most recent lesson if multiple matches
            const lessonEvents = Array.from(events).map(e => NDKAgentLesson.from(e));
            const lesson = lessonEvents.sort((a, b) => 
                (b.created_at ?? 0) - (a.created_at ?? 0)
            )[0];

            return {
                ok: true,
                value: {
                    title: lesson.title || title,
                    lesson: lesson.lesson || lesson.content,
                    detailed: lesson.detailed,
                    category: lesson.category,
                    hashtags: lesson.hashtags,
                    hasDetailed: !!lesson.detailed,
                },
            };
        } catch (error) {
            logger.error("❌ lesson_get tool failed", {
                error: formatAnyError(error),
                agent: context.agent.name,
                agentPubkey: context.agent.pubkey,
                title,
                phase: context.phase,
                conversationId: context.conversationId,
            });

            return {
                ok: false,
                error: {
                    kind: "execution" as const,
                    tool: "lesson_get",
                    message: formatAnyError(error),
                },
            };
        }
    },
};