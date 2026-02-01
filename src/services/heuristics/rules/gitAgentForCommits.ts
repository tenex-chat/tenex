/**
 * Git Agent for Commits Heuristic
 *
 * Encourages delegation to git-agent for commit operations.
 * The git-agent has specialized knowledge of git workflows.
 */

import type { Heuristic, HeuristicContext, HeuristicResult } from "../types";

const HEURISTIC_ID = "git-agent-for-commits";

/**
 * Git commit commands that should use git-agent
 */
const COMMIT_COMMANDS = [
  "git commit",
  "git add",
];

/**
 * Safe git commands that don't need git-agent
 */
const SAFE_GIT_COMMANDS = [
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git fetch",
];

/**
 * Check if git operations should use git-agent
 */
export const gitAgentForCommitsHeuristic: Heuristic = {
  id: HEURISTIC_ID,
  name: "Use Git Agent for Commits",
  description: "Delegate git commit operations to git-agent for proper workflow",

  evaluate(context: HeuristicContext): HeuristicResult {
    // Only check Bash tool (where git commands run)
    if (context.tool.name !== "Bash") {
      return null;
    }

    // Type guard for Bash args (BLOCKER 4 FIX: replace unchecked cast)
    const isBashArgs = (args: unknown): args is { command?: string } => {
      if (!args || typeof args !== "object") return false;
      const obj = args as Record<string, unknown>;
      return !("command" in obj) || typeof obj.command === "string";
    };

    if (!isBashArgs(context.tool.args)) {
      return null; // Invalid args structure
    }

    const args = context.tool.args;
    const command = args?.command?.toLowerCase() || "";

    // Skip if not a git command
    if (!command.includes("git")) {
      return null;
    }

    // Skip safe read-only commands
    const isSafeCommand = SAFE_GIT_COMMANDS.some((cmd) => command.includes(cmd));
    if (isSafeCommand) {
      return null;
    }

    // Check if this is a commit operation
    const isCommitCommand = COMMIT_COMMANDS.some((cmd) => command.includes(cmd));

    if (!isCommitCommand) {
      return null; // Not a commit operation
    }

    // Check if git-agent was used in this RAL
    if (context.state.hasGitAgentCommit) {
      return null; // git-agent already used
    }

    // BLOCKER 5 FIX: Remove unused variable - git-agent check is in O(1) summary
    // The hasGitAgentCommit flag is maintained by updateHeuristicSummary in RALRegistry

    // Violation: Direct git commit without git-agent
    // BLOCKER 3 FIX: Use deterministic ID from context timestamp, not Date.now()
    return {
      id: `${HEURISTIC_ID}-${context.tool.callId}-${context.ralNumber}`,
      heuristicId: HEURISTIC_ID,
      title: "Consider Using Git Agent for Commits",
      severity: "warning",
      timestamp: context.evaluationTimestamp,
      message: [
        `You are running: \`${command}\``,
        "",
        "Direct git commits bypass the specialized git-agent workflow.",
        "",
        "**Why this matters:**",
        "- git-agent has specialized knowledge of commit message formats",
        "- It ensures proper co-authoring attribution",
        "- It handles pre-commit hooks and verification correctly",
        "- It provides consistent commit workflow across the project",
        "",
        "**Recommended action:**",
        "Delegate to git-agent for commit operations:",
        "```typescript",
        "delegate({",
        "  delegations: [{",
        '    recipient: "git-agent",',
        '    prompt: "Create a commit with the staged changes"',
        "  }]",
        "})",
        "```",
        "",
        "Or if you're making a quick fix and understand the git workflow, proceed with the direct commit.",
      ].join("\n"),
    };
  },
};
