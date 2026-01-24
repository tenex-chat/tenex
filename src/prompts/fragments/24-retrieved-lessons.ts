import type { AgentInstance } from "@/agents/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { formatLessonsWithReminder } from "@/utils/lessonFormatter";
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

        // Use centralized formatter (handles empty case and adds reminder)
        return formatLessonsWithReminder(myLessons);
    },
};

// Register the fragment
fragmentRegistry.register(retrievedLessonsFragment);
