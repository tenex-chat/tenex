import type { ExecutionContext } from "@/agents/execution/types";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import { listWorktrees, loadWorktreeMetadata } from "@/utils/git/worktree";

/**
 * Worktree context fragment for agents.
 * Shows current working directory and available worktrees.
 */
interface WorktreeContextArgs {
  context: ExecutionContext;
}

export const worktreeContextFragment: PromptFragment<WorktreeContextArgs> = {
  id: "worktree-context",
  priority: 30,
  template: async ({ context }) => {
    const parts: string[] = [];

    // Get worktree information
    const workingDirectory = context.workingDirectory;
    const currentBranch = context.currentBranch;

    parts.push("## Git Worktree Context\n");
    parts.push("This project uses git worktrees with a bare repository structure.");
    parts.push("Each branch has its own working directory, allowing parallel work on different branches.");
    parts.push("All standard git commands (status, commit, push, etc.) work normally in your worktree.");
    parts.push("");
    parts.push(`**Current Working Directory:** ${workingDirectory}`);
    parts.push(`**Current Branch:** ${currentBranch}`);
    parts.push(`**Project Base:** ${context.projectPath}`);
    parts.push("");

    try {
      // List all worktrees
      const worktrees = await listWorktrees(context.projectPath);
      const metadata = await loadWorktreeMetadata(context.projectPath);

      if (worktrees.length > 0) {
        parts.push("### Available Worktrees:");
        for (const wt of worktrees) {
          const meta = metadata[wt.branch];
          const isCurrent = wt.branch === currentBranch;

          parts.push(`- **${wt.branch}**${isCurrent ? " [YOU ARE HERE]" : ""}`);
          parts.push(`  - Path: ${wt.path}`);

          if (meta) {
            parts.push(`  - Created by: ${meta.createdBy.substring(0, 8)}...`);
            parts.push(`  - Conversation: ${meta.conversationId.substring(0, 8)}...`);
            parts.push(`  - Parent branch: ${meta.parentBranch}`);
          }
        }
        parts.push("");
      }
    } catch (error) {
      // If we can't list worktrees (e.g., not a git repo yet), just skip
      console.warn("Failed to list worktrees", { error });
    }

    // Add worktree commands guidance for agents with shell access or phases
    if (context.agent.tools?.includes("shell") || context.agent.phases) {
      parts.push("### Worktree Commands:");
      parts.push("- Create: `git worktree add -b <branch-name> ../<branch-name>`");
      parts.push("- List: `git worktree list`");
      parts.push("- Remove: `git worktree remove ../<branch-name>`");
      parts.push("- Switch to: `cd ../<branch-name>`");
      parts.push("");

      if (context.agent.phases) {
        parts.push("### Delegation with Worktrees:");
        parts.push("When using `delegate`, you can specify `branch: \"<name>\"` to create and work in an isolated worktree.");
        parts.push("The worktree will be created from your current branch, and the delegated agent will work in that isolation.");
        parts.push("You are responsible for merging or cleaning up worktrees you create.");
        parts.push("");
      }

      parts.push("### Merge and Cleanup:");
      parts.push("When your work in a worktree is complete:");
      parts.push("1. Ensure all changes are committed");
      parts.push("2. Switch to the parent branch: `cd ../<parent-branch>`");
      parts.push("3. Merge your work: `git merge <your-branch>`");
      parts.push("4. Remove the worktree: `git worktree remove ../<your-branch>`");
    }

    return parts.join("\n");
  },
};

// Register the fragment
fragmentRegistry.register(worktreeContextFragment);