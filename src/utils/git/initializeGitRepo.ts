import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@/utils/logger";

const execAsync = promisify(exec);

/**
 * Check if a directory is a Git repository
 */
export async function isGitRepository(dir?: string): Promise<boolean> {
  try {
    const cwd = dir || process.cwd();
    await execAsync("git rev-parse --git-dir", { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize a new Git repository if not already initialized
 */
export async function initializeGitRepository(dir?: string): Promise<void> {
  const cwd = dir || process.cwd();

  // Ensure directory exists
  await fs.mkdir(cwd, { recursive: true });

  const isRepo = await isGitRepository(cwd);
  if (!isRepo) {
    await execAsync("git init", { cwd });
  }
}

/**
 * Check if a directory is empty (no files/folders except .tenex)
 */
async function isDirectoryEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    // Filter out .tenex directory
    const nonTenexEntries = entries.filter(entry => entry !== ".tenex");
    return nonTenexEntries.length === 0;
  } catch {
    return true;
  }
}

/**
 * Clone a git repository into a directory
 * @param repoUrl - The git repository URL to clone
 * @param targetDir - The directory to clone into
 * @returns true if cloned, false if skipped (already exists or directory not empty)
 */
export async function cloneGitRepository(repoUrl: string, targetDir: string): Promise<boolean> {
  try {
    // Ensure target directory exists
    await fs.mkdir(targetDir, { recursive: true });

    // Check if directory already has a git repo
    const gitDir = path.join(targetDir, ".git");
    try {
      await fs.access(gitDir);
      logger.debug("Git repository already exists, skipping clone", { targetDir });
      return false;
    } catch {
      // .git doesn't exist, continue with clone check
    }

    // Check if directory is empty (except for .tenex)
    const isEmpty = await isDirectoryEmpty(targetDir);
    if (!isEmpty) {
      logger.warn("Directory not empty, skipping git clone", { targetDir });
      return false;
    }

    // Clone the repository
    logger.info("Cloning git repository", { repoUrl, targetDir });

    // Clone into a temporary directory first, then move contents
    const tempDir = path.join(targetDir, ".git-clone-temp");
    await execAsync(`git clone "${repoUrl}" "${tempDir}"`, {
      cwd: targetDir,
      maxBuffer: 1024 * 1024 * 10 // 10MB buffer for large repos
    });

    // Move all files from temp dir to target dir
    const entries = await fs.readdir(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(tempDir, entry.name);
      const destPath = path.join(targetDir, entry.name);
      await fs.rename(sourcePath, destPath);
    }

    // Remove temp directory
    await fs.rmdir(tempDir);

    logger.info("Git repository cloned successfully", { repoUrl, targetDir });
    return true;
  } catch (error) {
    logger.error("Failed to clone git repository", {
      error: error instanceof Error ? error.message : String(error),
      repoUrl,
      targetDir
    });
    return false;
  }
}