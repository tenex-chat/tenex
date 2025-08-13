import { PHASE_DEFINITIONS, PHASES } from "@/conversations/phases";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Phase definitions fragment - provides all agents with clear understanding of what each phase means
 * This fragment is accessible to all agents so they understand the phase structure and expectations
 */
export const phaseDefinitionsFragment: PromptFragment = {
    id: "phase-definitions",
    priority: 15, // Higher priority to ensure it appears early in the prompt
    template: () => {
        return `## Phase Definitions

- **${PHASES.CHAT.toUpperCase()}**: ${PHASE_DEFINITIONS.chat.description}
  - Goal: ${PHASE_DEFINITIONS.chat.goal}
  
- **${PHASES.BRAINSTORM.toUpperCase()}**: ${PHASE_DEFINITIONS.brainstorm.description}
  - Goal: ${PHASE_DEFINITIONS.brainstorm.goal}
  
- **${PHASES.PLAN.toUpperCase()}**: ${PHASE_DEFINITIONS.plan.description}
  - Goal: ${PHASE_DEFINITIONS.plan.goal}
  
- **${PHASES.EXECUTE.toUpperCase()}**: ${PHASE_DEFINITIONS.execute.description}
  - Goal: ${PHASE_DEFINITIONS.execute.goal}
  
- **${PHASES.VERIFICATION.toUpperCase()}**: ${PHASE_DEFINITIONS.verification.description}
  - Goal: ${PHASE_DEFINITIONS.verification.goal}
  
- **${PHASES.CHORES.toUpperCase()}**: ${PHASE_DEFINITIONS.chores.description}
  - Goal: ${PHASE_DEFINITIONS.chores.goal}
  
- **${PHASES.REFLECTION.toUpperCase()}**: ${PHASE_DEFINITIONS.reflection.description}
  - Goal: ${PHASE_DEFINITIONS.reflection.goal}`;
    },
};

// Register the fragment
fragmentRegistry.register(phaseDefinitionsFragment);
