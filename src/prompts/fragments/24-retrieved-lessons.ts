import type { AgentInstance } from "@/agents/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { formatLessonsForAgent } from "@/utils/lessonFormatter";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

// Retrieved lessons fragment - formats lessons from ProjectContext
interface RetrievedLessonsArgs {
    agent: AgentInstance;
    agentLessons: Map<string, NDKAgentLesson[]>;
}

export const retrievedLessonsFragment: PromptFragment<RetrievedLessonsArgs> = {
    id: "retrieved-lessons",
    priority: 24, // Before learn-tool-directive
    template: ({ agent, agentLessons }) => {
        // Get only this agent's lessons
        const myLessons = agentLessons.get(agent.pubkey) || [];

        if (myLessons.length === 0) {
            return ""; // No lessons learned yet
        }

        // Use the formatter to create formatted lessons
        const formattedLessons = formatLessonsForAgent(myLessons);

        // Add the lesson_learn tool reminder if lessons exist
        return `${formattedLessons}\n\nRemember to use the \`lesson_learn\` tool when you discover new insights or patterns.`;
    },
};

// Register the fragment
fragmentRegistry.register(retrievedLessonsFragment);
