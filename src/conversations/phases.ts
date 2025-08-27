export type Phase =
  | "CHAT"
  | "BRAINSTORM"
  | "PLAN"
  | "EXECUTE"
  | "VERIFICATION"
  | "CHORES"
  | "REFLECTION";

export const PHASES = {
  CHAT: "CHAT" as const,
  BRAINSTORM: "BRAINSTORM" as const,
  PLAN: "PLAN" as const,
  EXECUTE: "EXECUTE" as const,
  VERIFICATION: "VERIFICATION" as const,
  CHORES: "CHORES" as const,
  REFLECTION: "REFLECTION" as const,
} as const;

export const ALL_PHASES: readonly Phase[] = [
  PHASES.CHAT,
  PHASES.BRAINSTORM,
  PHASES.PLAN,
  PHASES.EXECUTE,
  PHASES.VERIFICATION,
  PHASES.CHORES,
  PHASES.REFLECTION,
] as const;

export const PHASE_DESCRIPTIONS = {
  [PHASES.CHAT]: "Requirements gathering and discussion",
  [PHASES.BRAINSTORM]: "Creative exploration and ideation",
  [PHASES.PLAN]: "Planning approach for complex tasks",
  [PHASES.EXECUTE]: "Implementation and execution",
  [PHASES.VERIFICATION]: "Functional verification and testing",
  [PHASES.CHORES]: "Cleanup and documentation tasks",
  [PHASES.REFLECTION]: "Learn from experience and gather insights",
} as const;

export interface PhaseDefinition {
  description: string;
  goal: string;
  whenToUse: string[];
  doNot?: string[];
  constraints: string[];
}

export const PHASE_DEFINITIONS: Record<Phase, PhaseDefinition> = {
  [PHASES.CHAT]: {
    description: "Requirements gathering and discussion",
    goal: "Clarify intent.",
    whenToUse: [
      "The user's request is unclear or ambiguous",
      "You need to confirm what the user wants to happen",
      "The request is missing necessary inputs or context",
    ],
    doNot: [
      "Analyze the codebase",
      "Attempt to implement",
      "Delay action if the user's demand is clear",
      "If the user's command contains an imperative verb + concrete target (e.g. 'add', 'remove', 'replace') and no explicit question, switch to execute without further checks",
    ],
    constraints: [],
  },
  [PHASES.BRAINSTORM]: {
    description: "Creative exploration and ideation",
    goal: "Help the user explore and narrow down ideas.",
    whenToUse: [
      "The user is exploring possibilities or asking open-ended questions",
      "The request is abstract, conceptual, or speculative",
      "No specific goal or output is defined yet",
    ],
    constraints: [
      "Focus on exploration and ideation rather than concrete requirements",
      "Encourage creative thinking and alternative perspectives",
      "Don't rush to converge on solutions - embrace open-ended discussion",
      "Only transition out when user explicitly requests it",
      "Ask probing questions to deepen understanding",
    ],
  },
  [PHASES.PLAN]: {
    description: "Planning implementation for complex tasks",
    goal: "Produce architectural diagrams, technical specs, or design steps.",
    whenToUse: [
      "The user is asking for a system or architectural design",
      "The request involves multiple components, tradeoffs, or integrations",
      "The 'how' requires structured design before implementation",
    ],
    constraints: [
      "Reserved for genuinely complex architectural decisions",
      "Only plan when multiple competing technical approaches exist",
      "Focus on system design, not implementation details",
    ],
  },
  [PHASES.EXECUTE]: {
    description:
      "Moment of truth: the phase where all of the work is to be implemented AND reviewed.",
    goal: "Execute the task. Produce AND review the requested output.",
    whenToUse: [
      "The user gives a clear instruction to create or modify something",
      "The request involves producing tangible output",
      "You know what needs to be done",
    ],
    doNot: [
      "Analyze or try to understand the entire system - execution agents handle their domain",
    ],
    constraints: [
      "Use appropriate tools for the task at hand",
      "Focus on delivering what was requested",
      "Provide relevant examples when helpful",
      "Explain key decisions made during execution",
    ],
  },
  [PHASES.VERIFICATION]: {
    description: "Functional verification of the implemented work from an end-user perspective.",
    goal: "Functionally test the implemented changes to ensure they work as expected and meet requirements. This is NOT a code review of implementation details.",
    whenToUse: [
      "After the 'execute' phase is complete.",
      "When you need to confirm that the changes work correctly from a user's point of view.",
      "Before moving on to documentation (chores) or learning (reflection).",
    ],
    constraints: [
      "Focus on the functional aspects, not the implementation details.",
      "Try out the feature that was built to confirm it works as expected.",
      "If the changes work correctly, proceed to the 'chores' phase.",
      "If issues are found, provide clear, reproducible steps and route back to the 'execute' phase for fixes.",
    ],
  },
  [PHASES.CHORES]: {
    description: "Cleanup and documentation tasks",
    goal: "Allow agents that can perform routine cleanup functions to tidy up.",
    whenToUse: [
      "Work is complete and needs documentation",
      "Artifacts have been created or modified and need organizing",
      "Need to clean up temporary work products",
    ],
    constraints: [
      "Focus on updating documentation for recent work",
      "Use appropriate tools to maintain project organization",
      "Clean up any temporary artifacts",
      "Ensure all changes are properly documented",
      "Consider creating guides for complex work",
    ],
  },
  [PHASES.REFLECTION]: {
    description:
      "Provide an opportunity to all agents that were part of this conversation to reflect on the work they did.",
    goal: "Reflect on the work done, learn from mistakes, and record valuable insights.",
    whenToUse: [
      "After completing significant work or fixing complex issues",
      "When mistakes were made and corrected during execution",
      "When discovering important patterns or best practices",
      "At the end of a project iteration or milestone",
    ],
    constraints: [
      "Use the learn tool to record important lessons and insights",
      "Focus on actionable learnings that prevent future mistakes",
      "Record project-specific knowledge for PM's understanding",
      "Be concise and specific in lessons learned",
      "Include relevant keywords for future retrieval",
      "Apply metacognition before recording - ask 'Will this genuinely improve future behavior?'",
      "Avoid trivial lessons like 'always test code' or 'read documentation'",
      "Only record lessons that are specific to THIS project's unique challenges",
    ],
  },
} as const;

export function isValidPhase(phase: string): phase is Phase {
  return ALL_PHASES.includes(phase as Phase);
}
