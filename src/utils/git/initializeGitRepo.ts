import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { logger } from "@/utils/logger";

const execAsync = promisify(exec);

/**
 * Get the default branch name for a git repository
 * Tries to detect from remote HEAD, falls back to common defaults
 */
export async function getDefaultBranchName(repoPath: string): Promise<string> {
    try {
        // Try to get the default branch from the remote
        const { stdout } = await execAsync("git symbolic-ref refs/remotes/origin/HEAD", {
            cwd: repoPath,
        });
        const match = stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
        if (match) {
            return match[1];
        }
    } catch {
        // If that fails, try to get it from the local default branch
        try {
            const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
                cwd: repoPath,
            });
            return stdout.trim();
        } catch {
            // Fall back to checking git config
            try {
                const { stdout } = await execAsync("git config --get init.defaultBranch");
                if (stdout.trim()) {
                    return stdout.trim();
                }
            } catch {
                // Final fallback to 'main'
            }
        }
    }

    // Default to 'main' as it's the modern standard
    return "main";
}

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
 * @param projectBaseDir - The base project directory (will create repo in {projectBaseDir}/{branchName})
 * @returns The path to the initialized repository
 */
export async function initializeGitRepository(projectBaseDir?: string): Promise<string> {
    const baseDir = projectBaseDir || process.cwd();

    // Get the configured default branch name
    let branchName = "main";
    try {
        const { stdout } = await execAsync("git config --get init.defaultBranch");
        if (stdout.trim()) {
            branchName = stdout.trim();
        }
    } catch {
        // Use 'main' as default
    }

    const targetDir = path.join(baseDir, branchName);

    // Ensure directory exists
    await fs.mkdir(targetDir, { recursive: true });

    const isRepo = await isGitRepository(targetDir);
    if (!isRepo) {
        await execAsync("git init", { cwd: targetDir });
        logger.info("Initialized new git repository", { targetDir, branchName });
    }

    return targetDir;
}

/**
 * Clone a git repository into a directory
 * @param repoUrl - The git repository URL to clone
 * @param projectBaseDir - The base project directory (will clone into {projectBaseDir}/{branchName})
 * @returns The path to the cloned repository, or null if failed
 */
export async function cloneGitRepository(
    repoUrl: string,
    projectBaseDir: string
): Promise<string | null> {
    try {
        // Ensure project base directory exists
        await fs.mkdir(projectBaseDir, { recursive: true });

        // First check if we can detect an existing repo in common branch names
        const commonBranches = ["main", "master", "develop"];
        for (const branchName of commonBranches) {
            const possibleDir = path.join(projectBaseDir, branchName);
            if (await isGitRepository(possibleDir)) {
                logger.info("Found existing git repository", { targetDir: possibleDir });
                return possibleDir;
            }
        }

        // No existing repo found, proceed with cloning
        // Clone into a temporary directory to detect the default branch
        const tempDir = path.join(projectBaseDir, ".git-clone-temp");

        logger.info("Cloning git repository to detect default branch", { repoUrl, tempDir });

        await execAsync(`git clone "${repoUrl}" "${tempDir}"`, {
            cwd: projectBaseDir,
            maxBuffer: 1024 * 1024 * 10, // 10MB buffer for large repos
        });

        // Detect the default branch name
        const branchName = await getDefaultBranchName(tempDir);
        logger.info("Detected default branch", { branchName });

        // The final target directory with branch name
        const targetDir = path.join(projectBaseDir, branchName);

        // Check if target already exists (in case it's not one of the common branches we checked)
        try {
            await fs.access(targetDir);
            logger.warn("Target directory already exists, removing temp clone", { targetDir });
            await fs.rm(tempDir, { recursive: true, force: true });
            return targetDir;
        } catch {
            // Target doesn't exist, proceed with move
        }

        // Move the cloned repo to the branch-named directory
        await fs.rename(tempDir, targetDir);

        logger.info("Git repository cloned successfully", { repoUrl, targetDir, branchName });
        return targetDir;
    } catch (error) {
        logger.error("Failed to clone git repository", {
            error: error instanceof Error ? error.message : String(error),
            repoUrl,
            projectBaseDir,
        });

        // Clean up temp directory if it exists
        try {
            const tempDir = path.join(projectBaseDir, ".git-clone-temp");
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }

        return null;
    }
}
