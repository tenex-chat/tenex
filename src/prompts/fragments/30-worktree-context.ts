import type { AgentInstance } from "@/agents/types";
import { config } from "@/services/ConfigService";
import { SHORT_EVENT_ID_LENGTH } from "@/types/event-ids";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import { listWorktrees, loadWorktreeMetadata, type WorktreeMetadata } from "@/utils/git/worktree";
import { logger } from "@/utils/logger";

const WORKTREE_CONTEXT_CACHE_TTL_MS = 30_000;

interface WorktreeSnapshot {
  hasFeatureWorktrees: boolean;
  metadata: Record<string, WorktreeMetadata>;
  worktrees: Array<{ branch: string; path: string }>;
}

interface WorktreeSnapshotCacheEntry {
  expiresAt: number;
  snapshot: WorktreeSnapshot;
}

const worktreeSnapshotCache = new Map<string, WorktreeSnapshotCacheEntry>();

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

async function getCachedWorktreeSnapshot(projectBasePath: string): Promise<WorktreeSnapshot> {
  const cached = worktreeSnapshotCache.get(projectBasePath);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      hasFeatureWorktrees: cached.snapshot.hasFeatureWorktrees,
      metadata: { ...cached.snapshot.metadata },
      worktrees: cached.snapshot.worktrees.map((worktree) => ({ ...worktree })),
    };
  }

  let worktrees: Array<{ branch: string; path: string }> = [];
  let metadata: Record<string, WorktreeMetadata> = {};
  let hasFeatureWorktrees = false;

  try {
    worktrees = await listWorktrees(projectBasePath);
    metadata = await loadWorktreeMetadata(projectBasePath, config.getConfigPath("projects"));
    hasFeatureWorktrees = worktrees.some(wt => wt.path.includes("/.worktrees/"));
  } catch (error) {
    logger.warn("Failed to list worktrees", { error });
  }

  const snapshot: WorktreeSnapshot = {
    hasFeatureWorktrees,
    metadata,
    worktrees,
  };
  worktreeSnapshotCache.set(projectBasePath, {
    expiresAt: Date.now() + WORKTREE_CONTEXT_CACHE_TTL_MS,
    snapshot: {
      hasFeatureWorktrees,
      metadata: { ...metadata },
      worktrees: worktrees.map((worktree) => ({ ...worktree })),
    },
  });

  return snapshot;
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
    const { worktrees, metadata, hasFeatureWorktrees } = await getCachedWorktreeSnapshot(
      context.projectBasePath
    );

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
          parts.push(`  - Created by: ${meta.createdBy.substring(0, SHORT_EVENT_ID_LENGTH)}`);
          parts.push(`  - Conversation ID: ${meta.conversationId}`);
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
