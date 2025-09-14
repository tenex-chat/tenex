import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Check if the current directory is a Git repository
 */
export async function isGitRepository(): Promise<boolean> {
  try {
    await execAsync("git rev-parse --git-dir");
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize a new Git repository if not already initialized
 */
export async function initializeGitRepository(): Promise<void> {
  const isRepo = await isGitRepository();
  if (!isRepo) {
    await execAsync("git init");
  }
}