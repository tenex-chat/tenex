import type { AgentInstance } from "@/agents/types";
import { config } from "@/services/ConfigService";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import { listWorktrees, loadWorktreeMetadata, type WorktreeMetadata } from "@/utils/git/worktree";
import { logger } from "@/utils/logger";

/**
 * Worktree context for the fragment.
 */
interface WorktreeContext {
  workingDirectory: string;
  currentBranch: string;
  /**
   * Project directory (normal git repository root).
   * Worktrees are in .worktrees/ subdirectory.
   */
  projectBasePath: string;
  agent: AgentInstance;
}

/**
 * Worktree context fragment for agents.
 * Shows current working directory and available worktrees.
 */
interface WorktreeContextArgs {
  context: WorktreeContext;
}

export const worktreeContextFragment: PromptFragment<WorktreeContextArgs> = {
  id: "worktree-context",
  priority: 30,
  template: async ({ context }) => {
    const parts: string[] = [];

    // Get worktree information
    const workingDirectory = context.workingDirectory;
    const currentBranch = context.currentBranch;

    // List worktrees first to determine what to show
    let worktrees: Array<{ branch: string; path: string }> = [];
    let metadata: Record<string, WorktreeMetadata> = {};
    let hasFeatureWorktrees = false;

    try {
      worktrees = await listWorktrees(context.projectBasePath);
      metadata = await loadWorktreeMetadata(context.projectBasePath, config.getConfigPath("projects"));
      // Check if there are worktrees in .worktrees/ directory (beyond the main repo)
      hasFeatureWorktrees = worktrees.some(wt => wt.path.includes("/.worktrees/"));
    } catch (error) {
      // If we can't list worktrees (e.g., not a git repo yet), just skip
      logger.warn("Failed to list worktrees", { error });
    }

    parts.push("## Git Worktree Context\n");
    parts.push("This project uses git worktrees for parallel work on different branches.");
    parts.push("The default branch is checked out at the project root.");
    if (hasFeatureWorktrees) {
      parts.push(`Feature branches are in \`${context.projectBasePath}/.worktrees/\` (branch slashes become underscores).`);
    }
    parts.push("All standard git commands (status, commit, push, etc.) work normally.");
    parts.push("");
    parts.push(`**Current Working Directory:** ${workingDirectory}`);
    parts.push(`**Current Branch:** ${currentBranch}`);
    parts.push(`**Project Root:** ${context.projectBasePath}`);
    parts.push("");

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

    // Add worktree commands guidance
    parts.push("### Delegation with Worktrees:");
    parts.push("When using `delegate`, you can specify `branch: \"<name>\"` to create and work in an isolated worktree.");
    parts.push("The worktree will be created from your current branch in `.worktrees/`, and the delegated agent will work in that isolation.");
    parts.push("You are responsible for merging or cleaning up worktrees you create.");
    parts.push("");

    return parts.join("\n");
  },
};

// Register the fragment
fragmentRegistry.register(worktreeContextFragment);