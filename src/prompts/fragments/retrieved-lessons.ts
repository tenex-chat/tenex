import type { Agent } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { logger } from "@/utils/logger";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

// Retrieved lessons fragment - filters and formats relevant lessons from memory
interface RetrievedLessonsArgs {
    agent: Agent;
    phase: Phase;
    conversation: Conversation;
    agentLessons: Map<string, NDKAgentLesson[]>;
}

export const retrievedLessonsFragment: PromptFragment<RetrievedLessonsArgs> = {
    id: "retrieved-lessons",
    priority: 24, // Before learn-tool-directive
    template: ({ agent, phase, agentLessons, conversation }) => {
        // Get only this agent's lessons
        const myLessons = (agentLessons.get(agent.pubkey) || []).sort(
            (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)
        );

        if (myLessons.length === 0) {
            logger.debug("📚 No lessons available for this agent", {
                agent: agent.name,
                phase,
            });
            return ""; // No lessons learned yet
        }

        // Log lesson availability
        logger.debug("📚 Lesson retrieval context", {
            agent: agent.name,
            phase,
            conversationId: conversation.id,
            lessonsCount: myLessons.length,
        });

        // Select top 5 lessons to show
        const lessonsToShow = myLessons.slice(0, 5);

        // Format lessons for the prompt
        const formattedLessons = lessonsToShow
            .map((lesson) => {
                const title = lesson.title || "Untitled Lesson";
                const content = lesson.lesson || lesson.content || "";
                // Use first sentence as summary to save tokens
                const summary = content.split(".")[0]?.trim() || content.substring(0, 100);
                const phase = lesson.tags.find((tag) => tag[0] === "phase")?.[1];

                return `- **${title}**\n${lesson.pubkey}\n${phase ? ` (${phase} phase)` : ""}: ${summary}${!summary.endsWith(".") ? "." : ""}`;
            })
            .join("\n");

        return `## Key Lessons Learned

Review these lessons from past experiences to guide your actions:

${formattedLessons}

Remember to use the \`learn\` tool when you discover new insights or patterns.`;
    },
};

// Register the fragment
fragmentRegistry.register(retrievedLessonsFragment);
