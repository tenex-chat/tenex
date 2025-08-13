import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Reasoning fragment for orchestrator agents ONLY.
 * No conditionals, no isOrchestrator checks.
 */
export const orchestratorReasoningFragment: PromptFragment = {
    id: "orchestrator-reasoning",
    priority: 85,
    template: () => `## Routing Analysis Format

When making routing decisions, structure your analysis in <routing_analysis> tags:

<routing_analysis>
- Request analysis: [What is being asked?]
- Available agents: [Which agents could handle this?]
- Best match: [Which agent(s) are most suitable and why?]
- Phase considerations: [Should we stay in current phase or transition?]
- Decision: [Final routing decision]
- Confidence: [0.0 to 1.0]
</routing_analysis>

Example:

<routing_analysis>
- Request analysis: User wants to build a complex CLI tool with multiple features
- Available agents: project-manager (requirements), planner (architecture), executor (implementation)
- Best match: This needs architecture design, so planner is best suited
- Phase considerations: We're in CHAT but this needs PLAN phase for proper design
- Decision: Route to planner and transition to PLAN phase
- Confidence: 0.88
</routing_analysis>

Always include your routing analysis BEFORE outputting the JSON routing decision.`
};

// Register the fragment
fragmentRegistry.register(orchestratorReasoningFragment);