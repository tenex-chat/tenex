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
        parts.push(
            "These phases describe the types of work you typically perform. They are **guidance**, not an immediate task list."
        );
        parts.push("");
        parts.push("**How to use phases:**");
        parts.push("1. First, understand what the user is actually asking for");
        parts.push("2. Determine which phases (if any) apply to this specific request");
        parts.push("3. Create your own todos based on the actual task, using phases as a framework");
        parts.push("4. Not every request requires all phases - use judgment");
        parts.push("");

        // List all phases with their instructions
        for (const [phaseName, instructions] of Object.entries(agent.phases)) {
            parts.push(`### Phase: ${phaseName.toUpperCase()}`);
            parts.push("**Instructions for this type of work:**");
            parts.push(instructions);
            parts.push("");
        }

        parts.push("## Delegating with Phases");
        parts.push("");
        parts.push("When delegating work, you can use the 'phase' parameter to pass phase instructions:");
        parts.push("- Use `{ recipient, prompt, phase }` in your delegation");
        parts.push("- The delegated agent receives both your request AND the phase instructions");

        return parts.join("\n");
    },
};

// Register the fragment
fragmentRegistry.register(agentPhasesFragment);
