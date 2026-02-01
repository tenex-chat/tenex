/**
 * Branch Isolation Heuristic
 *
 * Warns when delegations occur without branch isolation.
 * Encourages use of worktree branches for parallel work.
 */

import type { Heuristic, HeuristicContext, HeuristicResult } from "../types";

const HEURISTIC_ID = "branch-isolation";

/**
 * Tools that support branch parameter
 */
const DELEGATION_TOOLS_WITH_BRANCH = new Set([
  "mcp__tenex__delegate",
]);

/**
 * Check if delegation uses branch isolation
 */
export const branchIsolationHeuristic: Heuristic = {
  id: HEURISTIC_ID,
  name: "Branch Isolation for Delegations",
  description: "Delegations should use branch parameter for isolation when appropriate",

  evaluate(context: HeuristicContext): HeuristicResult {
    // Only check tools that support branch parameter
    if (!DELEGATION_TOOLS_WITH_BRANCH.has(context.tool.name)) {
      return null;
    }

    // Type guard for delegation args (BLOCKER 4 FIX: replace unchecked cast)
    const isDelegationArgs = (
      args: unknown
    ): args is { delegations?: Array<{ branch?: string }> } => {
      if (!args || typeof args !== "object") return false;
      const obj = args as Record<string, unknown>;
      if (!("delegations" in obj)) return true; // No delegations is valid
      return Array.isArray(obj.delegations);
    };

    if (!isDelegationArgs(context.tool.args)) {
      return null; // Invalid args structure
    }

    const args = context.tool.args;
    const delegations = args?.delegations;

    if (!delegations || delegations.length === 0) {
      return null; // No delegations in args
    }

    // Check if any delegation has branch parameter
    const hasBranchParam = delegations.some((d) => d.branch !== undefined && d.branch !== "");

    if (hasBranchParam) {
      return null; // Using branch isolation
    }

    // Check if we're already on a worktree branch
    if (context.state.isWorktreeBranch) {
      return null; // Already isolated
    }

    // Check message count - only warn for complex conversations
    if (context.state.messageCount < 10) {
      return null; // Simple conversation, isolation not critical
    }

    // Violation: Delegation without branch isolation
    // BLOCKER 3 FIX: Use deterministic ID from context timestamp, not Date.now()
    return {
      id: `${HEURISTIC_ID}-${context.tool.callId}-${context.ralNumber}`,
      heuristicId: HEURISTIC_ID,
      title: "Consider Branch Isolation for Delegation",
      severity: "warning",
      timestamp: context.evaluationTimestamp,
      message: [
        "You are delegating work without branch isolation.",
        "",
        "**Why this matters:**",
        "- Branch isolation prevents conflicts when multiple agents work in parallel",
        "- Worktrees allow independent git operations per delegation",
        "- Failures in one branch don't affect other work",
        "",
        "**Recommended action:**",
        "Consider adding `branch: \"feature/task-name\"` to your delegation calls for complex or risky tasks.",
        "",
        "**Example:**",
        "```typescript",
        "delegate({",
        "  delegations: [{",
        '    recipient: "worker-agent",',
        '    prompt: "Implement feature X",',
        '    branch: "feature/implement-x"  // Creates isolated worktree',
        "  }]",
        "})",
        "```",
      ].join("\n"),
    };
  },
};
