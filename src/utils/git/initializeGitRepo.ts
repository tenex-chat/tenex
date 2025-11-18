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

/**
 * Get current git branch name
 */
export async function getCurrentBranch(repoPath: string): Promise<string> {
    try {
        const { stdout } = await execAsync("git branch --show-current", { cwd: repoPath });
        return stdout.trim();
    } catch (error) {
        logger.error("Failed to get current branch", { repoPath, error });
        throw error;
    }
}

/**
 * List all git worktrees
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
 * Create a new git worktree
 * @param projectPath - Base project path (main worktree)
 * @param branchName - Name for the new branch
 * @param baseBranch - Branch to create from (typically current branch)
 * @returns Path to the new worktree
 */
export async function createWorktree(
    projectPath: string,
    branchName: string,
    baseBranch: string
): Promise<string> {
    try {
        // Worktree path is sibling to main worktree
        const parentDir = path.dirname(projectPath);
        const worktreePath = path.join(parentDir, branchName);

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

        // Create worktree
        await execAsync(
            `git worktree add -b ${JSON.stringify(branchName)} ${JSON.stringify(worktreePath)} ${JSON.stringify(baseBranch)}`,
            { cwd: projectPath }
        );

        logger.info("Created worktree", { branchName, path: worktreePath, baseBranch });
        return worktreePath;
    } catch (error) {
        logger.error("Failed to create worktree", { projectPath, branchName, baseBranch, error });
        throw error;
    }
}
