/**
 * TodoWrite Before Delegation Heuristic
 *
 * Ensures agents create a TODO list before delegating complex tasks.
 * This helps track progress and provides clear task breakdown.
 */

import type { Heuristic, HeuristicContext, HeuristicResult } from "../types";

const HEURISTIC_ID = "todo-before-delegation";

/**
 * Tools that trigger delegation
 */
const DELEGATION_TOOLS = new Set([
  "mcp__tenex__delegate",
  "mcp__tenex__delegate_crossproject",
]);

/**
 * Check if TodoWrite was called before delegation in this RAL
 */
export const todoBeforeDelegationHeuristic: Heuristic = {
  id: HEURISTIC_ID,
  name: "TodoWrite Before Delegation",
  description: "Agents should create a TODO list before delegating complex tasks",

  evaluate(context: HeuristicContext): HeuristicResult {
    // Only check if this is a delegation tool
    if (!DELEGATION_TOOLS.has(context.tool.name)) {
      return null;
    }

    // Check if TodoWrite was called in this RAL
    if (context.state.hasTodoWrite) {
      return null; // Rule satisfied
    }

    // Check recent tool history for TodoWrite
    const hasTodoInRecent = context.recentTools.some(
      (tool) => tool.name === "TodoWrite"
    );

    if (hasTodoInRecent) {
      return null; // Rule satisfied
    }

    // Violation: Delegation without TODO
    // BLOCKER 3 FIX: Use deterministic ID from context timestamp, not Date.now()
    return {
      id: `${HEURISTIC_ID}-${context.tool.callId}-${context.ralNumber}`,
      heuristicId: HEURISTIC_ID,
      title: "Missing TODO List Before Delegation",
      severity: "warning",
      timestamp: context.evaluationTimestamp,
      message: [
        "You are delegating a task without creating a TODO list first.",
        "",
        "**Why this matters:**",
        "- TODO lists help track progress across multiple delegations",
        "- They provide clear task breakdown for complex work",
        "- They ensure nothing is forgotten after delegation completes",
        "",
        "**Recommended action:**",
        "Use the `TodoWrite` tool to create a task list before delegating, unless this is a simple, single-step delegation.",
      ].join("\n"),
    };
  },
};
