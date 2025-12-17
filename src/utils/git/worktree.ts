import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { logger } from "@/utils/logger";
import { config } from "@/services/ConfigService";
import { ensureWorktreesGitignore } from "./gitignore";

const execAsync = promisify(exec);

/** Directory name for worktrees (relative to project root) */
export const WORKTREES_DIR = ".worktrees";

/**
 * Sanitize a branch name for use as a directory name.
 * Replaces forward slashes with underscores to avoid nested directories.
 * @example sanitizeBranchName("feature/whatever") => "feature_whatever"
 */
export function sanitizeBranchName(branch: string): string {
    return branch.replace(/\//g, "_");
}

/**
 * Metadata for a git worktree
 */
export interface WorktreeMetadata {
  path: string;
  branch: string;
  createdBy: string; // Agent pubkey
  conversationId: string;
  parentBranch: string;
  createdAt: number;
  mergedAt?: number;
  deletedAt?: number;
}

// ============================================================================
// Core Worktree Operations
// ============================================================================

/**
 * List all git worktrees for a project.
 * The main repository is always included as the first entry.
 * Additional worktrees are located in .worktrees/ subdirectory.
 *
 * @param projectPath - Root project directory (normal git repo)
 * @returns Array of worktrees with branch name and path
 */
export async function listWorktrees(projectPath: string): Promise<Array<{ branch: string; path: string }>> {
    try {
        const { stdout } = await execAsync("git worktree list --porcelain", { cwd: projectPath });

        const worktrees: Array<{ branch: string; path: string }> = [];
        const lines = stdout.trim().split("\n");

        let currentWorktree: { path?: string; branch?: string } = {};

        for (const line of lines) {
            if (line.startsWith("worktree ")) {
                currentWorktree.path = line.substring(9);
            } else if (line.startsWith("branch ")) {
                currentWorktree.branch = line.substring(7).replace("refs/heads/", "");
            } else if (line === "") {
                // Empty line marks end of worktree entry
                if (currentWorktree.path && currentWorktree.branch) {
                    worktrees.push({
                        path: currentWorktree.path,
                        branch: currentWorktree.branch,
                    });
                }
                currentWorktree = {};
            }
        }

        // Handle last entry if no trailing newline
        if (currentWorktree.path && currentWorktree.branch) {
            worktrees.push({
                path: currentWorktree.path,
                branch: currentWorktree.branch,
            });
        }

        return worktrees;
    } catch (error) {
        logger.error("Failed to list worktrees", { projectPath, error });
        return [];
    }
}

/**
 * Create a new git worktree in the .worktrees/ directory.
 * Branch names are sanitized (slashes replaced with underscores) for directory names.
 * Also ensures .worktrees is added to .gitignore.
 *
 * @param projectPath - Root project directory (normal git repo)
 * @param branchName - Name for the new branch (can contain slashes)
 * @param baseBranch - Branch to create from (typically current branch)
 * @returns Path to the new worktree
 *
 * @example
 * // Creates worktree at ~/tenex/project/.worktrees/feature_auth/
 * await createWorktree("~/tenex/project", "feature/auth", "main");
 */
export async function createWorktree(
    projectPath: string,
    branchName: string,
    baseBranch: string
): Promise<string> {
    try {
        // Ensure .worktrees is in .gitignore before creating any worktrees
        await ensureWorktreesGitignore(projectPath);

        // Create .worktrees directory if it doesn't exist
        const worktreesDir = path.join(projectPath, WORKTREES_DIR);
        await fs.mkdir(worktreesDir, { recursive: true });

        // Sanitize branch name for directory (feature/whatever -> feature_whatever)
        const sanitizedName = sanitizeBranchName(branchName);
        const worktreePath = path.join(worktreesDir, sanitizedName);

        // Check if worktree already exists
        const existingWorktrees = await listWorktrees(projectPath);
        if (existingWorktrees.some((wt) => wt.branch === branchName)) {
            logger.info("Worktree already exists", { branchName, path: worktreePath });
            return worktreePath;
        }

        // Check if path exists on filesystem
        try {
            await fs.access(worktreePath);
            // Path exists but not in worktree list - this is an error state
            throw new Error(
                `Directory "${worktreePath}" exists but is not a registered git worktree. ` +
                "Remove it manually or use a different branch name."
            );
        } catch (err: unknown) {
            if (err instanceof Error && "code" in err && err.code !== "ENOENT") throw err;
            // Path doesn't exist - safe to create
        }

        // Create worktree from repository
        // Wrap in try-catch to handle race conditions where another process creates the worktree
        try {
            await execAsync(
                `git worktree add -b ${JSON.stringify(branchName)} ${JSON.stringify(worktreePath)} ${JSON.stringify(baseBranch)}`,
                { cwd: projectPath }
            );
        } catch (createError: unknown) {
            // Check if worktree was created by another process (race condition)
            const refreshedWorktrees = await listWorktrees(projectPath);
            if (refreshedWorktrees.some((wt) => wt.branch === branchName)) {
                logger.info("Worktree was created by another process", { branchName, path: worktreePath });
                return worktreePath;
            }
            // Re-throw if it's a different error
            throw createError;
        }

        logger.info("Created worktree", {
            branchName,
            sanitizedName,
            path: worktreePath,
            baseBranch
        });
        return worktreePath;
    } catch (error) {
        logger.error("Failed to create worktree", { projectPath, branchName, baseBranch, error });
        throw error;
    }
}

// ============================================================================
// Worktree Metadata Management
// ============================================================================

/**
 * Get the path to the worktree metadata file for a project
 * @param projectPath - The base project directory
 * @returns Path to the worktree metadata JSON file
 */
export async function getWorktreeMetadataPath(projectPath: string): Promise<string> {
  // Extract dTag from project path (last segment of path)
  const dTag = path.basename(projectPath);
  const metadataDir = path.join(config.getConfigPath("projects"), dTag);

  // Ensure the metadata directory exists
  await fs.mkdir(metadataDir, { recursive: true });

  return path.join(metadataDir, "worktrees.json");
}

/**
 * Load worktree metadata for a project
 * @param projectPath - The base project directory
 * @returns Map of branch names to metadata
 */
export async function loadWorktreeMetadata(
  projectPath: string
): Promise<Record<string, WorktreeMetadata>> {
  try {
    const metadataPath = await getWorktreeMetadataPath(projectPath);
    const content = await fs.readFile(metadataPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    // File doesn't exist or invalid JSON - return empty object
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
      logger.warn("Failed to load worktree metadata", {
        projectPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return {};
  }
}

/**
 * Save worktree metadata for a project
 * @param projectPath - The base project directory
 * @param metadata - Map of branch names to metadata
 */
async function saveWorktreeMetadata(
  projectPath: string,
  metadata: Record<string, WorktreeMetadata>
): Promise<void> {
  const metadataPath = await getWorktreeMetadataPath(projectPath);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

/**
 * Track the creation of a new worktree
 * @param projectPath - The base project directory
 * @param metadata - The worktree metadata
 */
export async function trackWorktreeCreation(
  projectPath: string,
  metadata: Omit<WorktreeMetadata, "createdAt">
): Promise<void> {
  const allMetadata = await loadWorktreeMetadata(projectPath);

  // Add timestamp and save
  allMetadata[metadata.branch] = {
    ...metadata,
    createdAt: Date.now()
  };

  await saveWorktreeMetadata(projectPath, allMetadata);

  logger.info("Tracked worktree creation", {
    branch: metadata.branch,
    createdBy: metadata.createdBy.substring(0, 8),
    conversationId: metadata.conversationId.substring(0, 8)
  });
}

/**
 * Mark a worktree as merged
 * @param projectPath - The base project directory
 * @param branch - The branch name
 */
export async function markWorktreeMerged(
  projectPath: string,
  branch: string
): Promise<void> {
  const allMetadata = await loadWorktreeMetadata(projectPath);

  if (allMetadata[branch]) {
    allMetadata[branch].mergedAt = Date.now();
    await saveWorktreeMetadata(projectPath, allMetadata);

    logger.info("Marked worktree as merged", { branch });
  }
}

/**
 * Mark a worktree as deleted
 * @param projectPath - The base project directory
 * @param branch - The branch name
 */
export async function markWorktreeDeleted(
  projectPath: string,
  branch: string
): Promise<void> {
  const allMetadata = await loadWorktreeMetadata(projectPath);

  if (allMetadata[branch]) {
    allMetadata[branch].deletedAt = Date.now();
    await saveWorktreeMetadata(projectPath, allMetadata);

    logger.info("Marked worktree as deleted", { branch });
  }
}

/**
 * Get worktrees created by a specific agent in a conversation
 * @param projectPath - The base project directory
 * @param agentPubkey - The agent's pubkey
 * @param conversationId - The conversation ID
 * @returns Array of worktree metadata
 */
export async function getAgentWorktrees(
  projectPath: string,
  agentPubkey: string,
  conversationId: string
): Promise<WorktreeMetadata[]> {
  const allMetadata = await loadWorktreeMetadata(projectPath);

  return Object.values(allMetadata).filter(
    wt =>
      wt.createdBy === agentPubkey &&
      wt.conversationId === conversationId &&
      !wt.mergedAt &&
      !wt.deletedAt
  );
}

/**
 * Clean up old worktree metadata
 * Removes metadata for worktrees that have been deleted or merged more than 30 days ago
 * @param projectPath - The base project directory
 */
export async function cleanupOldMetadata(projectPath: string): Promise<void> {
  const allMetadata = await loadWorktreeMetadata(projectPath);
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const cleanedMetadata: Record<string, WorktreeMetadata> = {};

  for (const [branch, metadata] of Object.entries(allMetadata)) {
    const shouldKeep =
      (!metadata.deletedAt || metadata.deletedAt > thirtyDaysAgo) &&
      (!metadata.mergedAt || metadata.mergedAt > thirtyDaysAgo);

    if (shouldKeep) {
      cleanedMetadata[branch] = metadata;
    }
  }

  if (Object.keys(cleanedMetadata).length !== Object.keys(allMetadata).length) {
    await saveWorktreeMetadata(projectPath, cleanedMetadata);

    const removedCount = Object.keys(allMetadata).length - Object.keys(cleanedMetadata).length;
    logger.info("Cleaned up old worktree metadata", {
      projectPath,
      removedCount
    });
  }
}