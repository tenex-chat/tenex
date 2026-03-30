import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import * as path from "node:path";
import { promisify } from "node:util";
import { logger } from "@/utils/logger";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";

const execAsync = promisify(exec);
const tracer = trace.getTracer("tenex.git");
const SLOW_GIT_COMMAND_THRESHOLD_MS = 500;

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function truncateOutput(output: string, maxLength = 160): string {
    const trimmed = output.trim();
    if (!trimmed) {
        return "";
    }

    if (trimmed.length <= maxLength) {
        return trimmed;
    }

    return `${trimmed.slice(0, maxLength)}...`;
}

async function resolveGitDir(repoPath: string): Promise<string> {
    const dotGitPath = path.join(repoPath, ".git");
    const dotGitStat = await fs.stat(dotGitPath);

    if (dotGitStat.isDirectory()) {
        return dotGitPath;
    }

    const dotGitContents = (await fs.readFile(dotGitPath, "utf-8")).trim();
    const gitDirMatch = dotGitContents.match(/^gitdir:\s*(.+)$/i);

    if (!gitDirMatch?.[1]) {
        throw new Error(`Unsupported .git file format at ${dotGitPath}`);
    }

    return path.resolve(repoPath, gitDirMatch[1]);
}

async function readCurrentBranchFromHead(repoPath: string): Promise<string | null> {
    try {
        const gitDir = await resolveGitDir(repoPath);
        const headContents = (await fs.readFile(path.join(gitDir, "HEAD"), "utf-8")).trim();

        if (!headContents.startsWith("ref: ")) {
            return null;
        }

        const ref = headContents.slice("ref: ".length).trim();
        if (!ref.startsWith("refs/heads/")) {
            return null;
        }

        return ref.slice("refs/heads/".length);
    } catch {
        return null;
    }
}

async function runGitCommandWithTelemetry(params: {
    command: string;
    cwd: string;
    span: Span;
}): Promise<{ stdout: string; stderr: string; durationMs: number }> {
    const startedAt = performance.now();

    params.span.addEvent("git.command_started", {
        "git.command": params.command,
        "git.cwd": params.cwd,
    });

    try {
        const { stdout, stderr } = await execAsync(params.command, { cwd: params.cwd });
        const durationMs = Math.round(performance.now() - startedAt);
        const stdoutPreview = truncateOutput(stdout);
        const stderrPreview = truncateOutput(stderr);

        params.span.addEvent("git.command_completed", {
            "git.command": params.command,
            "git.cwd": params.cwd,
            "duration_ms": durationMs,
            "stdout.preview": stdoutPreview,
            "stderr.present": Boolean(stderrPreview),
            ...(stderrPreview ? { "stderr.preview": stderrPreview } : {}),
        });

        if (durationMs >= SLOW_GIT_COMMAND_THRESHOLD_MS) {
            logger.warn("Slow git command detected", {
                command: params.command,
                cwd: params.cwd,
                durationMs,
                stdout: stdoutPreview || undefined,
                stderr: stderrPreview || undefined,
            });
        }

        return { stdout, stderr, durationMs };
    } catch (error) {
        const durationMs = Math.round(performance.now() - startedAt);
        const errorMessage = describeError(error);

        params.span.addEvent("git.command_failed", {
            "git.command": params.command,
            "git.cwd": params.cwd,
            "duration_ms": durationMs,
            "error.message": errorMessage,
        });

        logger.warn("Git command failed", {
            command: params.command,
            cwd: params.cwd,
            durationMs,
            error: errorMessage,
        });

        throw error;
    }
}

async function branchRefExists(params: {
    projectPath: string;
    branch: string;
    span: Span;
}): Promise<boolean> {
    const gitDir = await resolveGitDir(params.projectPath);
    const refPath = path.join(gitDir, "refs", "heads", params.branch);
    const startedAt = performance.now();

    params.span.addEvent("git.current_branch_fallback_check_started", {
        "git.branch": params.branch,
        "git.ref_path": refPath,
    });

    try {
        await fs.access(refPath);
        params.span.addEvent("git.current_branch_fallback_check_completed", {
            "git.branch": params.branch,
            "git.ref_path": refPath,
            "duration_ms": Math.round(performance.now() - startedAt),
            "exists": true,
        });
        return true;
    } catch {
        params.span.addEvent("git.current_branch_fallback_check_completed", {
            "git.branch": params.branch,
            "git.ref_path": refPath,
            "duration_ms": Math.round(performance.now() - startedAt),
            "exists": false,
        });
        return false;
    }
}

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
 * Read the current branch directly from .git/HEAD without spawning a subprocess.
 * Returns null if the HEAD is detached or the file cannot be read.
 */
export async function readCurrentBranchFromGitDir(repoPath: string): Promise<string | null> {
    try {
        const headPath = path.join(repoPath, ".git", "HEAD");
        const content = await fs.readFile(headPath, "utf-8");
        const trimmed = content.trim();
        const refPrefix = "ref: refs/heads/";
        if (trimmed.startsWith(refPrefix)) {
            return trimmed.slice(refPrefix.length);
        }
        // Detached HEAD (raw commit hash) — cannot determine branch name
        return null;
    } catch {
        return null;
    }
}

/**
 * Get current git branch name
 */
export async function getCurrentBranch(repoPath: string): Promise<string> {
    return tracer.startActiveSpan("tenex.git.get_current_branch", async (span) => {
        span.setAttribute("git.repo_path", repoPath);

        try {
            const headStartedAt = performance.now();
            const branchFromHead = await readCurrentBranchFromHead(repoPath);
            if (branchFromHead) {
                const durationMs = Math.round(performance.now() - headStartedAt);

                span.setAttributes({
                    "git.branch": branchFromHead,
                    "git.command.duration_ms": 0,
                    "git.lookup.method": "head",
                    "git.lookup.duration_ms": durationMs,
                });
                span.addEvent("git.current_branch_resolved", {
                    "git.branch": branchFromHead,
                    "duration_ms": durationMs,
                    "branch.empty": false,
                    "git.lookup.method": "head",
                });
                span.setStatus({ code: SpanStatusCode.OK });
                return branchFromHead;
            }

            const { stdout, durationMs } = await runGitCommandWithTelemetry({
                command: "git branch --show-current",
                cwd: repoPath,
                span,
            });
            const branch = stdout.trim();
            span.setAttributes({
                "git.branch": branch,
                "git.command.duration_ms": durationMs,
                "git.lookup.method": "command",
                "git.lookup.duration_ms": durationMs,
            });
            span.addEvent("git.current_branch_resolved", {
                "git.branch": branch,
                "duration_ms": durationMs,
                "branch.empty": branch.length === 0,
                "git.lookup.method": "command",
            });

            if (!branch) {
                logger.warn("Git current branch lookup returned empty output", {
                    repoPath,
                    durationMs,
                });
            }

            span.setStatus({ code: SpanStatusCode.OK });
            return branch;
        } catch (error) {
            const errorMessage = describeError(error);
            span.recordException(error as Error);
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: errorMessage,
            });
            logger.error("Failed to get current branch", { repoPath, error: errorMessage });
            throw error;
        } finally {
            span.end();
        }
    });
}

/**
 * Get current branch with fallback to main/master if detection fails
 */
export async function getCurrentBranchWithFallback(projectPath: string): Promise<string> {
    return tracer.startActiveSpan("tenex.git.get_current_branch_with_fallback", async (span) => {
        span.setAttribute("git.project_path", projectPath);
        const startedAt = performance.now();

        span.addEvent("git.current_branch_lookup_started", {
            "git.project_path": projectPath,
        });

        try {
            const branch = await getCurrentBranch(projectPath);
            if (!branch) {
                const errorMessage = "git branch --show-current returned empty output";
                span.addEvent("git.current_branch_lookup_empty_result", {
                    "error.message": errorMessage,
                });
                logger.warn("Git current branch lookup returned empty output, trying fallbacks", {
                    projectPath,
                });
                throw new Error(errorMessage);
            }
            const totalDurationMs = Math.round(performance.now() - startedAt);

            span.setAttributes({
                "git.branch": branch,
                "git.branch.fallback_used": false,
                "git.lookup.duration_ms": totalDurationMs,
            });
            span.addEvent("git.current_branch_lookup_completed", {
                "git.branch": branch,
                "git.branch.fallback_used": false,
                "duration_ms": totalDurationMs,
            });

            if (totalDurationMs >= SLOW_GIT_COMMAND_THRESHOLD_MS) {
                logger.warn("Slow git branch lookup detected", {
                    projectPath,
                    branch,
                    durationMs: totalDurationMs,
                    fallbackUsed: false,
                });
            }

            span.setStatus({ code: SpanStatusCode.OK });
            return branch;
        } catch (error) {
            const errorMessage = describeError(error);

            logger.warn("Failed to get current branch, trying fallbacks", {
                projectPath,
                error: errorMessage,
            });

            span.addEvent("git.current_branch_lookup_failed", {
                "error.message": errorMessage,
            });

            const fallbackBranch = (await branchRefExists({
                projectPath,
                branch: "main",
                span,
            }))
                ? "main"
                : "master";
            const totalDurationMs = Math.round(performance.now() - startedAt);

            span.setAttributes({
                "git.branch": fallbackBranch,
                "git.branch.fallback_used": true,
                "git.lookup.duration_ms": totalDurationMs,
            });
            span.addEvent("git.current_branch_fallback_selected", {
                "git.branch": fallbackBranch,
                "duration_ms": totalDurationMs,
            });

            if (totalDurationMs >= SLOW_GIT_COMMAND_THRESHOLD_MS) {
                logger.warn("Slow git branch lookup detected", {
                    projectPath,
                    branch: fallbackBranch,
                    durationMs: totalDurationMs,
                    fallbackUsed: true,
                });
            }

            span.setStatus({ code: SpanStatusCode.OK });
            return fallbackBranch;
        } finally {
            span.end();
        }
    });
}
