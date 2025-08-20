import type { AgentInstance } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { formatLessonsForAgent } from "@/utils/lessonFormatter";
import { logger } from "@/utils/logger";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

// Retrieved lessons fragment - formats lessons from ProjectContext
interface RetrievedLessonsArgs {
  agent: AgentInstance;
  phase: Phase;
  conversation: Conversation;
  agentLessons: Map<string, NDKAgentLesson[]>;
}

export const retrievedLessonsFragment: PromptFragment<RetrievedLessonsArgs> = {
  id: "retrieved-lessons",
  priority: 24, // Before learn-tool-directive
  template: ({ agent, agentLessons }) => {
    // Debug: Log what's being passed in
    logger.debug("📚 Retrieved lessons fragment called", {
      agentName: agent.name,
      agentPubkey: agent.pubkey,
      agentLessonsMapSize: agentLessons.size,
      hasLessonsForAgent: agentLessons.has(agent.pubkey),
    });

    // Get only this agent's lessons
    const myLessons = agentLessons.get(agent.pubkey) || [];

    if (myLessons.length === 0) {
      logger.debug("📚 No lessons available for this agent", {
        agent: agent.name,
        agentPubkey: agent.pubkey,
      });
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
