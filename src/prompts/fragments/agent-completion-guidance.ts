import type { PromptFragment } from "../core/types";
import type { Phase } from "@/conversations/phases";

interface CompletionGuidanceArgs {
    phase: Phase;
    isOrchestrator: boolean;
}

/**
 * Provides clear guidance on when and how to use the complete() tool vs normal responses
 */
export const agentCompletionGuidanceFragment: PromptFragment<CompletionGuidanceArgs> = {
    id: "agent-completion-guidance",
    priority: 2,
    template: ({ phase, isOrchestrator }) => {
        // Orchestrator doesn't need completion guidance
        if (isOrchestrator) {
            return "";
        }

        const phaseGuidance: Record<Phase, string> = {
            chat: `During CHAT phase:
- Respond conversationally to gather information and clarify requirements
- DO NOT use complete() for back-and-forth conversation
- USE complete() when:
  * Requirements are clear and ready for implementation
  * User has provided all necessary details
  * You need to escalate to the next phase
- Example: After clarifying that user wants OAuth, use: complete("User wants to implement OAuth authentication with Google and GitHub providers")`,
            
            brainstorm: `During BRAINSTORM phase:
- Engage in creative exploration without using complete()
- USE complete() only when brainstorming session concludes with clear direction`,
            
            plan: `During PLAN phase:
- USE complete() after providing the full architectural plan or design`,
            
            execute: `During EXECUTE phase:
- USE complete() after implementing the requested functionality
- Include what was built and any important decisions made`,
            
            verification: `During VERIFICATION phase:
- USE complete() after testing the implementation
- Report whether it works correctly or needs fixes`,
            
            chores: `During CHORES phase:
- USE complete() after finishing documentation or cleanup tasks`,
            
            reflection: `During REFLECTION phase:
- USE complete() after recording lessons learned`
        };

        return `## Response Guidelines

### When to use complete() tool:
${phaseGuidance[phase] || "USE complete() when your assigned task is finished"}

### When NOT to use complete():
- For conversational exchanges (just respond normally)
- When providing intermediate updates
- When asking clarifying questions

Remember: The complete() tool ALWAYS routes to the orchestrator for phase control and next steps.`;
    }
};

// Register the fragment
import { fragmentRegistry } from "../core/FragmentRegistry";
fragmentRegistry.register(agentCompletionGuidanceFragment);