/**
 * Verification Before Merge Heuristic
 *
 * Ensures tests/builds are run before merging branches.
 * Prevents broken code from entering main branches.
 */

import type { Heuristic, HeuristicContext, HeuristicResult } from "../types";

const HEURISTIC_ID = "verification-before-merge";


/**
 * Commands that indicate merge/rebase operations
 */
const MERGE_COMMANDS = [
  "git merge",
  "git rebase",
  "git pull", // Can trigger merge
];



/**
 * Check if verification was performed before merge
 */
export const verificationBeforeMergeHeuristic: Heuristic = {
  id: HEURISTIC_ID,
  name: "Verification Before Merge",
  description: "Run tests and builds before merging branches",

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

    const isMergeCommand = MERGE_COMMANDS.some((cmd) => command.includes(cmd));

    if (!isMergeCommand) {
      return null; // Not a merge operation
    }

    // Check if verification was performed in this RAL
    if (context.state.hasVerification) {
      return null; // Verification already done
    }

    // BLOCKER 5 FIX: Remove stubbed logic - verification check is now in O(1) summary
    // The hasVerification flag is maintained by updateHeuristicSummary in RALRegistry

    // Don't warn for trivial merges (e.g., fast-forward)
    if (command.includes("--ff-only") || command.includes("--no-commit")) {
      return null; // Safe merge flags
    }

    // Violation: Merge without verification
    // BLOCKER 3 FIX: Use deterministic ID from context timestamp, not Date.now()
    return {
      id: `${HEURISTIC_ID}-${context.tool.callId}-${context.ralNumber}`,
      heuristicId: HEURISTIC_ID,
      title: "Missing Verification Before Merge",
      severity: "warning",
      timestamp: context.evaluationTimestamp,
      message: [
        `You are about to run: \`${command}\``,
        "",
        "No test or build verification was detected in recent history.",
        "",
        "**Why this matters:**",
        "- Merging without verification can introduce broken code",
        "- Tests catch regressions before they reach main branches",
        "- Builds verify compilation and dependencies",
        "",
        "**Recommended action:**",
        "Run tests and builds before merging:",
        "```bash",
        "npm test && npm run build",
        "# Then proceed with merge if passing",
        "```",
        "",
        "Or if you're confident the code is safe, proceed with the merge.",
      ].join("\n"),
    };
  },
};
