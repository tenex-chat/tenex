import type { AgentInstance } from "@/agents/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { formatLessonsForAgent } from "@/utils/lessonFormatter";
import { logger } from "@/utils/logger";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import { trace } from "@opentelemetry/api";

const lessonTracer = trace.getTracer("tenex.lessons");

// Retrieved lessons fragment - formats lessons from ProjectContext
interface RetrievedLessonsArgs {
    agent: AgentInstance;
    agentLessons: Map<string, NDKAgentLesson[]>;
}

export const retrievedLessonsFragment: PromptFragment<RetrievedLessonsArgs> = {
    id: "retrieved-lessons",
    priority: 24, // Before learn-tool-directive
    template: ({ agent, agentLessons }) => {
        // Add OTel span for lesson retrieval at prompt build time
        const span = lessonTracer.startSpan("tenex.lesson.prompt_fragment", {
            attributes: {
                "agent.name": agent.name,
                "agent.slug": agent.slug,
                "agent.pubkey": agent.pubkey.substring(0, 16),
                "agent.event_id": agent.eventId?.substring(0, 16) || "none",
                "lessons.map_size": agentLessons.size,
                "lessons.map_keys": JSON.stringify(
                    Array.from(agentLessons.keys()).map((k) => k.substring(0, 16))
                ),
            },
        });

        // Debug: Log what's being passed in
        logger.debug("📚 Retrieved lessons fragment called", {
            agentName: agent.name,
            agentPubkey: agent.pubkey,
            agentLessonsMapSize: agentLessons.size,
            hasLessonsForAgent: agentLessons.has(agent.pubkey),
        });

        // Get only this agent's lessons
        const myLessons = agentLessons.get(agent.pubkey) || [];
        span.setAttribute("lessons.for_agent_count", myLessons.length);
        span.setAttribute("lessons.has_lessons", myLessons.length > 0);

        if (myLessons.length === 0) {
            // Log all available lessons for debugging
            const allLessonsInfo: Array<{ pubkey: string; count: number; titles: string[] }> = [];
            for (const [pubkey, lessons] of agentLessons) {
                allLessonsInfo.push({
                    pubkey: pubkey.substring(0, 16),
                    count: lessons.length,
                    titles: lessons.slice(0, 3).map((l) => l.title || "untitled"),
                });
            }
            span.setAttribute("lessons.all_available", JSON.stringify(allLessonsInfo));
            span.addEvent("no_lessons_for_agent", {
                "agent.name": agent.name,
                "agent.pubkey": agent.pubkey.substring(0, 16),
                "lessons.map_size": agentLessons.size,
            });

            logger.debug("📚 No lessons available for this agent", {
                agent: agent.name,
                agentPubkey: agent.pubkey,
            });
            span.end();
            return ""; // No lessons learned yet
        }

        // Log lesson titles being included
        const lessonTitles = myLessons.map((l) => l.title || "untitled");
        span.setAttribute("lessons.titles", JSON.stringify(lessonTitles));
        span.addEvent("lessons_included_in_prompt", {
            "agent.name": agent.name,
            "lessons.count": myLessons.length,
            "lessons.titles": JSON.stringify(lessonTitles.slice(0, 5)),
        });

        // Use the formatter to create formatted lessons
        const formattedLessons = formatLessonsForAgent(myLessons);
        span.setAttribute("lessons.formatted_length", formattedLessons.length);
        span.end();

        // Add the lesson_learn tool reminder if lessons exist
        return `${formattedLessons}\n\nRemember to use the \`lesson_learn\` tool when you discover new insights or patterns.`;
    },
};

// Register the fragment
fragmentRegistry.register(retrievedLessonsFragment);
