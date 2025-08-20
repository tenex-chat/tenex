import type { Phase } from "@/conversations/phases";
import { PHASE_DEFINITIONS } from "@/conversations/phases";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

// Phase constraints fragment - used by AgentExecutor
interface PhaseConstraintsArgs {
  phase: string;
}

export const phaseConstraintsFragment: PromptFragment<PhaseConstraintsArgs> = {
  id: "phase-constraints",
  priority: 20,
  template: ({ phase }) => {
    const constraints = getPhaseConstraints(phase);
    if (constraints.length === 0) return "";

    return `## Phase Constraints
${constraints.map((c) => `- ${c}`).join("\n")}`;
  },
};

function getPhaseConstraints(phase: string): string[] {
  const phaseDefinition = PHASE_DEFINITIONS[phase as Phase];
  return phaseDefinition?.constraints || [];
}

// Register fragments
fragmentRegistry.register(phaseConstraintsFragment);
