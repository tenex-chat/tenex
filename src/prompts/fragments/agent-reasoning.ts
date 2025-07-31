import type { PromptFragment } from "../core/types";
import { fragmentRegistry } from "../core/FragmentRegistry";

/**
 * Fragment that instructs agents to output their reasoning in structured tags
 * This enables the ExecutionLogger to extract and display agent thinking
 */
export const agentReasoningFragment: PromptFragment<Record<string, never>> = {
    id: "agent-reasoning",
    priority: 90, // High priority to ensure it's included early
    applicablePhases: ["chat", "plan", "execute", "verification"],
    template: () => `
## Reasoning Output Format

Before taking any action or making any decision, you MUST explain your reasoning in <thinking> tags. This helps the system understand your decision-making process.

Format your reasoning as follows:

<thinking>
- Current situation: [Analyze what you're being asked to do]
- Options considered: [List the different approaches or tools you could use]
- Decision: [What you've decided to do and why]
- Confidence: [Your confidence level from 0.0 to 1.0]
</thinking>

Examples:

<thinking>
- Current situation: User is asking me to create a CLI tool with multiple commands
- Options considered: 
  1. Start implementing immediately (too hasty)
  2. Ask clarifying questions (might be needed)
  3. Move to PLAN phase for architecture design (best for complex request)
- Decision: Move to PLAN phase because this requires careful architecture planning
- Confidence: 0.85
</thinking>

<thinking>
- Current situation: Need to route this technical question to appropriate agent
- Options considered:
  1. Route to executor (they handle implementation)
  2. Route to planner (they handle architecture)
  3. Handle myself (I'm orchestrator, should delegate)
- Decision: Route to planner for architecture design
- Confidence: 0.90
</thinking>

Always include your thinking BEFORE using any tools or generating responses. Be honest about your uncertainty when confidence is low.
`,
};

/**
 * Fragment for orchestrator agents to include routing reasoning
 */
export const orchestratorReasoningFragment: PromptFragment<Record<string, never>> = {
    id: "orchestrator-reasoning",
    priority: 85,
    applicablePhases: ["chat", "plan", "execute", "verification"],
    applicableAgents: ["isOrchestrator"],
    template: () => `
## Orchestrator Routing Reasoning

As an orchestrator, when making routing decisions, structure your thinking specifically around routing:

<thinking>
- Message analysis: [What is the user/agent asking for?]
- Available agents: [Which agents could handle this?]
- Best match: [Which agent(s) are most suitable and why?]
- Phase considerations: [Should we stay in current phase or transition?]
- Routing decision: [Final decision on agents and phase]
- Confidence: [0.0 to 1.0]
</thinking>

Example:

<thinking>
- Message analysis: User wants to build a complex CLI tool with multiple features
- Available agents: project-manager (requirements), planner (architecture), executor (implementation)
- Best match: This needs architecture design, so planner is best suited
- Phase considerations: We're in CHAT but this needs PLAN phase for proper design
- Routing decision: Route to planner and transition to PLAN phase
- Confidence: 0.88
</thinking>
`,
};

/**
 * Fragment for domain experts to include expertise reasoning
 */
export const expertReasoningFragment: PromptFragment<Record<string, never>> = {
    id: "expert-reasoning",
    priority: 85,
    applicablePhases: ["plan", "execute", "verification"],
    template: () => `
## Expert Domain Reasoning

When applying your domain expertise, structure your thinking around your specific knowledge:

<thinking>
- Domain analysis: [What domain knowledge applies to this task?]
- Technical considerations: [What technical constraints or best practices apply?]
- Approach: [How will you apply your expertise?]
- Tools needed: [Which tools will help accomplish this?]
- Expected outcome: [What will be the result?]
- Confidence: [0.0 to 1.0]
</thinking>

Example for a frontend expert:

<thinking>
- Domain analysis: Need to create a responsive React component with TypeScript
- Technical considerations: Must follow React best practices, use proper TypeScript types
- Approach: Create functional component with hooks, define clear prop interfaces
- Tools needed: read_file (check existing patterns), write_file (create component)
- Expected outcome: Clean, type-safe React component following project conventions
- Confidence: 0.92
</thinking>
`,
};

// Register fragments
fragmentRegistry.register(agentReasoningFragment);
fragmentRegistry.register(orchestratorReasoningFragment);
fragmentRegistry.register(expertReasoningFragment);