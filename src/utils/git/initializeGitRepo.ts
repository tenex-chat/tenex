import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { logger } from "@/utils/logger";
import { BARE_REPO_DIR } from "./worktree";

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
 * Initialize a new Git repository using bare repo pattern
 * Creates a bare repository at {projectBaseDir}/.bare/ and a worktree at {projectBaseDir}/{branchName}/
 * @param projectBaseDir - The base project directory
 * @returns The path to the first worktree
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

    const bareRepoDir = path.join(baseDir, BARE_REPO_DIR);
    const worktreeDir = path.join(baseDir, branchName);

    // Check if bare repo already exists
    const isBareRepo = await isGitRepository(bareRepoDir);
    if (isBareRepo) {
        logger.info("Bare repository already exists", { bareRepoDir });
        // Check if worktree exists
        try {
            await fs.access(worktreeDir);
            return worktreeDir;
        } catch {
            // Worktree doesn't exist, create it
            await execAsync(
                `git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(branchName)}`,
                { cwd: bareRepoDir }
            );
            logger.info("Created worktree for existing bare repo", { worktreeDir, branchName });
            return worktreeDir;
        }
    }

    // Ensure base directory exists
    await fs.mkdir(baseDir, { recursive: true });

    // Create bare repository
    await fs.mkdir(bareRepoDir, { recursive: true });
    await execAsync("git init --bare", { cwd: bareRepoDir });
    logger.info("Initialized bare git repository", { bareRepoDir });

    // Create first worktree
    await execAsync(
        `git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(branchName)}`,
        { cwd: bareRepoDir }
    );
    logger.info("Created initial worktree", { worktreeDir, branchName });

    return worktreeDir;
}

/**
 * Clone a git repository using bare repo pattern
 * Creates a bare repository at {projectBaseDir}/.bare/ and a worktree at {projectBaseDir}/{branchName}/
 * @param repoUrl - The git repository URL to clone
 * @param projectBaseDir - The base project directory
 * @returns The path to the cloned repository worktree, or null if failed
 */
export async function cloneGitRepository(
    repoUrl: string,
    projectBaseDir: string
): Promise<string | null> {
    try {
        // Ensure project base directory exists
        await fs.mkdir(projectBaseDir, { recursive: true });

        const bareRepoDir = path.join(projectBaseDir, ".bare");

        // Check if bare repo already exists
        if (await isGitRepository(bareRepoDir)) {
            logger.info("Bare repository already exists", { bareRepoDir });

            // Find existing worktree
            const commonBranches = ["main", "master", "develop"];
            for (const branchName of commonBranches) {
                const possibleDir = path.join(projectBaseDir, branchName);
                if (await isGitRepository(possibleDir)) {
                    logger.info("Found existing worktree", { targetDir: possibleDir });
                    return possibleDir;
                }
            }

            // No worktree found, create one for the default branch
            const branchName = await getDefaultBranchName(bareRepoDir);
            const worktreeDir = path.join(projectBaseDir, branchName);
            await execAsync(
                `git worktree add ${JSON.stringify(worktreeDir)} ${JSON.stringify(branchName)}`,
                { cwd: bareRepoDir }
            );
            logger.info("Created worktree for existing bare repo", { worktreeDir, branchName });
            return worktreeDir;
        }

        // Clone as bare repository
        logger.info("Cloning git repository as bare", { repoUrl, bareRepoDir });
        await execAsync(`git clone --bare "${repoUrl}" "${bareRepoDir}"`, {
            cwd: projectBaseDir,
            maxBuffer: 1024 * 1024 * 10, // 10MB buffer for large repos
        });

        // Detect the default branch name from the bare repo
        const branchName = await getDefaultBranchName(bareRepoDir);
        logger.info("Detected default branch", { branchName });

        // Create first worktree for the default branch
        const worktreeDir = path.join(projectBaseDir, branchName);
        await execAsync(
            `git worktree add ${JSON.stringify(worktreeDir)} ${JSON.stringify(branchName)}`,
            { cwd: bareRepoDir }
        );

        logger.info("Git repository cloned successfully as bare repo with worktree", {
            repoUrl,
            bareRepoDir,
            worktreeDir,
            branchName
        });
        return worktreeDir;
    } catch (error) {
        logger.error("Failed to clone git repository", {
            error: error instanceof Error ? error.message : String(error),
            repoUrl,
            projectBaseDir,
        });

        // Clean up bare repo directory if it exists
        try {
            const bareRepoDir = path.join(projectBaseDir, BARE_REPO_DIR);
            await fs.rm(bareRepoDir, { recursive: true, force: true });
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
 * Get current branch with fallback to main/master if detection fails
 */
export async function getCurrentBranchWithFallback(projectPath: string): Promise<string> {
    try {
        return await getCurrentBranch(projectPath);
    } catch (error) {
        logger.error("Failed to get current branch, trying fallbacks", { projectPath, error });

        // Try fallback branch names
        try {
            await fs.access(path.join(projectPath, ".git/refs/heads/main"));
            return "main";
        } catch {
            return "master";
        }
    }
}

