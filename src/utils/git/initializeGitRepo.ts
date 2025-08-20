import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { logger } from "@/utils/logger";

const execAsync = promisify(exec);

/**
 * Check if a directory is a git repository (has its own .git directory)
 */
export async function isGitRepository(projectPath: string): Promise<boolean> {
  try {
    const gitPath = path.join(projectPath, ".git");
    await fs.access(gitPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize a git repository in the given directory
 */
export async function initializeGitRepository(projectPath: string): Promise<void> {
  try {
    const { stdout, stderr } = await execAsync("git init", {
      cwd: projectPath,
    });

    if (stderr) {
      logger.warn("Git init warning", { stderr });
    }

    logger.info("Initialized git repository", { projectPath, stdout });
  } catch (error) {
    logger.error("Failed to initialize git repository", { error, projectPath });
    throw error;
  }
}
