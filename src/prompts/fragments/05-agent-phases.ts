import type { AgentInstance } from "@/agents/types";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Phases awareness fragment for agents with defined phases.
 * Informs the agent about their phases and what instructions will be passed to delegated agents.
 */
interface AgentPhasesArgs {
  agent: AgentInstance;
}

export const agentPhasesFragment: PromptFragment<AgentPhasesArgs> = {
  id: "agent-phases",
  priority: 5, // After agent identity but before other context
  template: ({ agent }) => {
    // Only show if agent has phases defined
    if (!agent.phases || Object.keys(agent.phases).length === 0) {
      return "";
    }

    const parts: string[] = [];

    parts.push("## Your Defined Phases");
    parts.push("");
    parts.push("You have the following phases defined. When you use the delegate_phase tool, you must specify one of these phases:");
    parts.push("");

    // List all phases with their instructions
    for (const [phaseName, instructions] of Object.entries(agent.phases)) {
      parts.push(`### Phase: ${phaseName.toUpperCase()}`);
      parts.push(`**Instructions that will be provided to delegated agents:**`);
      parts.push(instructions);
      parts.push("");
    }

    parts.push("## Phase Management");
    parts.push("");
    parts.push("You can manage your phases dynamically using:");
    parts.push("- `add_phase`: Add a new phase with its instructions");
    parts.push("- `remove_phase`: Remove an existing phase");
    parts.push("");
    parts.push("When you delegate to a phase:");
    parts.push("1. The conversation switches to that phase");
    parts.push("2. The phase instructions are provided to ALL agents working in that phase");
    parts.push("3. The delegated agent receives both your request AND the phase instructions");
    parts.push("");
    parts.push("IMPORTANT: Choose phases carefully - they provide context and constraints for all work done in that phase.");

    return parts.join("\n");
  },
};

// Register the fragment
fragmentRegistry.register(agentPhasesFragment);