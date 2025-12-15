import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { logger } from "@/utils/logger";

const execAsync = promisify(exec);

/**
 * Result from git repository initialization or cloning.
 */
export interface GitRepoResult {
    /**
     * Project directory (the git repository root).
     * Example: ~/tenex/{dTag}
     */
    projectPath: string;
    /**
     * Name of the default/current branch.
     * Example: "main" or "master"
     */
    branch: string;
}

/**
 * Get the default branch name for a git repository.
 * Tries to detect from remote HEAD, falls back to common defaults.
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
            const branch = stdout.trim();
            if (branch && branch !== "HEAD") {
                return branch;
            }
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
 * Initialize a new Git repository.
 * Creates a standard git repository at the specified directory.
 *
 * @param projectDir - The project directory to initialize
 * @returns GitRepoResult with projectPath and branch
 */
export async function initializeGitRepository(projectDir?: string): Promise<GitRepoResult> {
    const targetDir = projectDir || process.cwd();

    // Check if already a git repository
    if (await isGitRepository(targetDir)) {
        logger.info("Git repository already exists", { projectDir: targetDir });
        const branch = await getDefaultBranchName(targetDir);
        return { projectPath: targetDir, branch };
    }

    // Ensure directory exists
    await fs.mkdir(targetDir, { recursive: true });

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

    // Initialize git repository
    await execAsync("git init", { cwd: targetDir });
    logger.info("Initialized git repository", { projectDir: targetDir, branch: branchName });

    return { projectPath: targetDir, branch: branchName };
}

/**
 * Clone a git repository.
 * Clones the repository to the specified directory.
 *
 * @param repoUrl - The git repository URL to clone
 * @param projectDir - The directory to clone into
 * @returns GitRepoResult with projectPath and branch, or null if failed
 */
export async function cloneGitRepository(
    repoUrl: string,
    projectDir: string
): Promise<GitRepoResult | null> {
    try {
        // Check if already a git repository
        if (await isGitRepository(projectDir)) {
            logger.info("Git repository already exists", { projectDir });
            const branch = await getDefaultBranchName(projectDir);
            return { projectPath: projectDir, branch };
        }

        // Ensure parent directory exists
        await fs.mkdir(path.dirname(projectDir), { recursive: true });

        // Clone the repository
        logger.info("Cloning git repository", { repoUrl, projectDir });
        await execAsync(`git clone ${JSON.stringify(repoUrl)} ${JSON.stringify(projectDir)}`, {
            maxBuffer: 1024 * 1024 * 10, // 10MB buffer for large repos
        });

        // Detect the default branch name
        const branchName = await getDefaultBranchName(projectDir);

        logger.info("Git repository cloned successfully", {
            repoUrl,
            projectDir,
            branch: branchName
        });

        return { projectPath: projectDir, branch: branchName };
    } catch (error) {
        logger.error("Failed to clone git repository", {
            error: error instanceof Error ? error.message : String(error),
            repoUrl,
            projectDir,
        });

        // Clean up directory if clone failed partially
        try {
            await fs.rm(projectDir, { recursive: true, force: true });
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
        logger.warn("Failed to get current branch, trying fallbacks", { projectPath, error });

        // Try fallback branch names
        try {
            await fs.access(path.join(projectPath, ".git/refs/heads/main"));
            return "main";
        } catch {
            return "master";
        }
    }
}
