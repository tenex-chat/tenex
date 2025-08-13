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

- **${PHASES.CHAT}**: ${PHASE_DEFINITIONS[PHASES.CHAT].description}
  - Goal: ${PHASE_DEFINITIONS[PHASES.CHAT].goal}
  
- **${PHASES.BRAINSTORM}**: ${PHASE_DEFINITIONS[PHASES.BRAINSTORM].description}
  - Goal: ${PHASE_DEFINITIONS[PHASES.BRAINSTORM].goal}
  
- **${PHASES.PLAN}**: ${PHASE_DEFINITIONS[PHASES.PLAN].description}
  - Goal: ${PHASE_DEFINITIONS[PHASES.PLAN].goal}
  
- **${PHASES.EXECUTE}**: ${PHASE_DEFINITIONS[PHASES.EXECUTE].description}
  - Goal: ${PHASE_DEFINITIONS[PHASES.EXECUTE].goal}
  
- **${PHASES.VERIFICATION}**: ${PHASE_DEFINITIONS[PHASES.VERIFICATION].description}
  - Goal: ${PHASE_DEFINITIONS[PHASES.VERIFICATION].goal}
  
- **${PHASES.CHORES}**: ${PHASE_DEFINITIONS[PHASES.CHORES].description}
  - Goal: ${PHASE_DEFINITIONS[PHASES.CHORES].goal}
  
- **${PHASES.REFLECTION}**: ${PHASE_DEFINITIONS[PHASES.REFLECTION].description}
  - Goal: ${PHASE_DEFINITIONS[PHASES.REFLECTION].goal}`;
    },
};

// Register the fragment
fragmentRegistry.register(phaseDefinitionsFragment);
