import type { CorrectionAction, Heuristic, HeuristicDetection, PreToolContext, VerificationResult } from "../types";

export class PhaseAgentTodoHeuristic implements Heuristic<PreToolContext> {
  id = "phase-agent-todo";
  name = "Phase Agent Missing Todo List";
  timing = "pre-tool-execution" as const;
  toolFilter = ["delegate", "mcp__tenex__delegate"];

  async detect(context: PreToolContext): Promise<HeuristicDetection> {
    // Only applies to agents with phases
    if (!context.hasPhases) {
      return { triggered: false };
    }

    // Check if agent has set up todo list
    if (context.hasTodoList) {
      return { triggered: false };
    }

    return {
      triggered: true,
      reason: "Phase agent is delegating without setting up a todo list first",
      evidence: {
        agentSlug: context.agentSlug,
        toolName: context.toolName,
        toolArgs: context.toolArgs,
        hasPhases: context.hasPhases,
        hasTodoList: context.hasTodoList,
      },
    };
  }

  buildVerificationPrompt(context: PreToolContext, _detection: HeuristicDetection): string {
    return `The agent "${context.agentSlug}" is a phase manager with defined phases but is calling delegate without first setting up a todo list.

Tool being called: ${context.toolName}
Tool arguments: ${JSON.stringify(context.toolArgs)}

Phase agents should typically organize their work with a todo list before delegating to other agents.

Is this an acceptable exception, or should the agent set up a todo list first?`;
  }

  buildCorrectionMessage(_context: PreToolContext, verification: VerificationResult): string {
    return verification.correctionMessage ||
      `Before delegating, please set up a todo list to organize your work. As a phase manager, you should track your tasks and progress before assigning work to other agents.`;
  }

  getCorrectionAction(_verification: VerificationResult): CorrectionAction {
    return {
      type: "block-tool",
      reEngage: true,
    };
  }
}
