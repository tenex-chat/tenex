import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@/utils/logger";
import { config } from "@/services/ConfigService";

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

/**
 * Get the path to the worktree metadata file for a project
 * @param projectPath - The base project directory
 * @returns Path to the worktree metadata JSON file
 */
export async function getWorktreeMetadataPath(projectPath: string): Promise<string> {
  // Extract dTag from project path (last segment of path)
  const dTag = path.basename(projectPath);
  const metadataDir = path.join(config.getProjectsBase(), dTag);

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