import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { getNDK } from "@/nostr";
import { getProjectContext } from "@/services/ProjectContext";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema } from "../types";

const lessonLearnSchema = z.object({
    title: z.string().describe("Brief title/description of what this lesson is about"),
    lesson: z.string().describe("The key insight or lesson learned - be concise and actionable"),
    detailed: z.string().optional().describe("Detailed version with richer explanation when deeper context is needed"),
    category: z.string().optional().describe("Single category for filing this lesson (e.g., 'architecture', 'debugging', 'user-preferences')"),
    hashtags: z.array(z.string()).optional().describe("Hashtags for easier sorting and discovery (e.g., ['async', 'error-handling'])"),
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

    promptFragment: `When you encounter important insights or lessons during your work, use the lesson_learn tool to record them. These lessons will be available in future conversations to help improve your performance.

## Metacognition Check - Ask Yourself:
Before recording a lesson, engage in metacognition:
1. "Is this actually trivial or obvious?"
2. "Will my behavior genuinely improve if I remember this forever?"
3. "Is this specific to this codebase/context, or just general programming knowledge?"
4. "Would a competent developer already know this?"
5. "Does this represent a real insight that prevents future mistakes?"

## What NOT to learn:
- Generic programming practices (e.g., "always validate input")
- Obvious facts (e.g., "config files contain configuration")
- Basic tool usage (e.g., "grep searches for patterns")
- Standard conventions everyone follows
- Temporary workarounds that will be obsolete

## What TO learn:
- Non-obvious architectural decisions specific to this project
- Hidden dependencies or coupling that caused real issues
- Counter-intuitive behaviors that waste significant time
- Project-specific gotchas that violate normal expectations
- Patterns that repeatedly cause problems in THIS project
- Things that are within your domain of expertise.

Domain Boundaries: Only record lessons within your role's sphere of control and expertise. You have access to the list of agents working with you in this project; while pondering whether to record a lesson, think: "is this specific lesson better suited for the domain expertise of another agent?"

In <thinking> tags, perform the metacognition check and explain why this lesson passes the quality bar and is worth preserving permanently.

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

The detailed version is CRITICAL for human-replica agents to accurately model the user's personality and behavior.

## Categories:
Use one of these standard categories or create a specific one if needed:
- architecture: System design and structure decisions
- debugging: Problem-solving patterns and techniques  
- user-preferences: User-specific patterns and preferences
- performance: Optimization insights
- security: Security considerations
- workflow: Process and methodology insights
- domain-specific: Domain expertise insights`,

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

        const agentSigner = context.agent.signer;
        if (!agentSigner) {
            const error = "Agent signer not available";
            logger.error("❌ Learn tool failed", {
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
                    tool: "lesson_learn",
                    message: error,
                },
            };
        }

        const ndk = getNDK();
        if (!ndk) {
            const error = "NDK instance not available";
            logger.error("❌ Learn tool failed", {
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
                    tool: "lesson_learn",
                    message: error,
                },
            };
        }

        const projectCtx = getProjectContext();

        try {
            // Create the lesson event
            const lessonEvent = new NDKAgentLesson(ndk);
            lessonEvent.title = title;
            lessonEvent.lesson = lesson;
            
            // Add optional fields if provided
            if (detailed) {
                lessonEvent.detailed = detailed;
            }
            if (category) {
                lessonEvent.category = category;
            }
            if (hashtags && hashtags.length > 0) {
                lessonEvent.hashtags = hashtags;
            }

            // Add reference to the agent event if available
            const agentEventId = context.agent.eventId;
            if (agentEventId) {
                const agentEvent = await ndk.fetchEvent(agentEventId);

                if (agentEvent) {
                    lessonEvent.agent = agentEvent;
                } else {
                    logger.warn("Could not fetch agent event for lesson", {
                        agentEventId,
                    });
                }
            }

            // Add project tag for scoping
            lessonEvent.tag(projectCtx.project);

            // Sign and publish the event
            await lessonEvent.sign(agentSigner);
            await lessonEvent.publish();

            const message = `✅ Lesson recorded: "${title}"${detailed ? " (with detailed version)" : ""}\n\nThis lesson will be available in future conversations to help avoid similar issues.`;

            return {
                ok: true,
                value: {
                    message,
                    eventId: lessonEvent.encode(),
                    title,
                    hasDetailed: !!detailed,
                },
            };
        } catch (error) {
            logger.error("❌ Learn tool failed", {
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
                    tool: "lesson_learn",
                    message: formatAnyError(error),
                },
            };
        }
    },
};
