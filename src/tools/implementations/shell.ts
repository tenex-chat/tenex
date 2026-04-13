import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import {
    expandPathWithEnvironment,
    formatUnresolvedPathVariablesError,
    resolveToolEnvironment,
} from "@/tools/utils/path-expansion";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import { tool } from "ai";
import { z } from "zod";

/**
 * Commands known to use non-zero exit codes for non-error conditions.
 * These commands return exit code 1 for "no matches" or similar expected outcomes.
 */
const COMMANDS_WITH_EXPECTED_NON_ZERO_EXIT: Record<string, { exitCodes: number[]; description: string }> = {
    grep: { exitCodes: [1], description: "No matches found" },
    rg: { exitCodes: [1], description: "No matches found" },
    ripgrep: { exitCodes: [1], description: "No matches found" },
    diff: { exitCodes: [1], description: "Files differ" },
    cmp: { exitCodes: [1], description: "Files differ" },
    test: { exitCodes: [1], description: "Condition is false" },
    "[": { exitCodes: [1], description: "Condition is false" },
    "[[": { exitCodes: [1], description: "Condition is false" },
};

/**
 * Structure returned when a shell command completes with non-zero exit
 * but it's an expected condition (not an error)
 */
interface ShellExpectedNonZeroResult {
    type: "expected-non-zero-exit";
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    explanation: string;
}

/**
 * Structure returned when a shell command fails unexpectedly
 */
interface ShellErrorResult {
    type: "shell-error";
    command: string;
    exitCode: number | null;
    error: string;
    stdout: string;
    stderr: string;
    signal: string | null;
}

/**
 * Structure returned when a shell command is started in the background
 */
interface ShellBackgroundResult {
    type: "background-task";
    taskId: string;
    command: string;
    description: string | null;
    outputFile: string;
    message: string;
}

type BackgroundTaskInfo = {
    pid: number;
    command: string;
    description: string | null;
    outputFile: string;
    startTime: Date;
    projectId: string;
};

// Track background tasks
const backgroundTasks = new Map<string, BackgroundTaskInfo>();

/**
 * Generate a unique task ID for background processes
 */
function generateTaskId(): string {
    return Math.random().toString(36).substring(2, 9);
}

/**
 * Extracts the base command from a shell command string.
 * Handles pipes, redirects, and command chaining.
 */
function extractBaseCommand(command: string): string {
    // Remove leading whitespace and common prefixes
    const trimmed = command.trim();

    // Handle common patterns like "command args | ..." or "command args && ..."
    // Get just the first word (the command itself)
    const firstWord = trimmed.split(/\s+/)[0];

    // Remove any path prefix (e.g., /usr/bin/grep -> grep)
    const baseName = firstWord.split("/").pop() || firstWord;

    return baseName;
}

/**
 * Checks if a command's non-zero exit code is expected behavior
 */
function isExpectedNonZeroExit(command: string, exitCode: number): { expected: boolean; explanation?: string } {
    const baseCommand = extractBaseCommand(command);
    const config = COMMANDS_WITH_EXPECTED_NON_ZERO_EXIT[baseCommand];

    if (config?.exitCodes.includes(exitCode)) {
        return { expected: true, explanation: config.description };
    }

    return { expected: false };
}

const shellSchema = z.object({
    command: z.string().describe("The shell command to execute"),
    description: z
        .string()
        .trim()
        .min(1, "Description is required and cannot be empty")
        .describe("What this command does"),
    cwd: z
        .string()
        .nullable()
        .optional()
        .describe("Working directory for the command (defaults to project root)"),
    timeout: z
        .preprocess(
            // Coerce numeric strings to numbers while preserving undefined/null
            // Reject empty/whitespace strings (treat as undefined) to avoid Number("") === 0
            (val) => {
                if (val === undefined || val === null) return val;
                if (typeof val === "number") return val;
                if (typeof val === "string") {
                    const trimmed = val.trim();
                    if (trimmed === "") return undefined; // Treat empty/whitespace as "not provided"
                    const parsed = Number(trimmed);
                    return Number.isNaN(parsed) ? val : parsed;
                }
                return val;
            },
            z.number().nullable().optional()
        )
        .describe(
            "Command timeout in seconds (default: 30, max: 600). Optional for background processes."
        ),
    run_in_background: z
        .boolean()
        .nullable()
        .optional()
        .describe(
            "Set to true to run the command in the background. Returns immediately with a task ID that can be used to check status later."
        ),
});

type ShellInput = z.infer<typeof shellSchema>;
type ShellOutput = string | ShellExpectedNonZeroResult | ShellErrorResult | ShellBackgroundResult;

function buildShellErrorResult(command: string, error: string): ShellErrorResult {
    return {
        type: "shell-error",
        command: command.substring(0, 200),
        exitCode: null,
        error,
        stdout: "",
        stderr: "",
        signal: null,
    };
}

/**
 * Core implementation of shell command execution
 * Shared between AI SDK and legacy Tool interfaces
 *
 * Handles four cases:
 * 1. Success (exit code 0): Returns stdout + stderr as string
 * 2. Expected non-zero exit (e.g., grep with no matches): Returns structured result, NOT an error
 * 3. Genuine failure: Returns structured error result for LLM recovery
 * 4. Background execution: Returns task info immediately, output written to file
 */
async function executeShell(input: ShellInput, context: ToolExecutionContext): Promise<ShellOutput> {
    const { command, description, cwd, timeout = 30, run_in_background } = input;
    const conversation = context.getConversation?.();
    const projectId = typeof conversation?.getProjectId === "function"
        ? conversation.getProjectId()
        : null;

    // Add trace span with all context for debugging
    const span = trace.getActiveSpan();
    span?.setAttributes({
        "shell.command": command.substring(0, 200),
        "shell.description": description || "(not provided)",
        "shell.cwd_param_raw": cwd || "(not provided)",
        "shell.context.working_directory": context.workingDirectory || "(empty)",
        "shell.context.project_base_path": context.projectBasePath || "(empty)",
        "shell.context.current_branch": context.currentBranch || "(empty)",
        "shell.agent": context.agent.name,
        "shell.timeout": (timeout ?? 30) * 1000,
        "shell.run_in_background": run_in_background ?? false,
    });
    span?.addEvent("shell.execute_start", {
        command: command.substring(0, 200),
        description: description || "(not provided)",
        cwd: cwd || "(not provided)",
        run_in_background: run_in_background ?? false,
    });

    let resolvedEnv: NodeJS.ProcessEnv;
    try {
        resolvedEnv = await resolveToolEnvironment(context);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        span?.addEvent("shell.env_resolution_error", {
            error: message.substring(0, 200),
        });

        logger.error("Failed to resolve shell environment", {
            command,
            agent: context.agent.name,
            error: message,
        });

        return buildShellErrorResult(command, message);
    }

    const rawWorkingDir = cwd || context.workingDirectory;
    if (!rawWorkingDir) {
        const errorMsg = `Shell command cannot run: workingDirectory is empty. Context projectBasePath: "${context.projectBasePath}", Context workingDirectory: "${context.workingDirectory}"`;
        span?.addEvent("shell.error", { error: errorMsg });
        return buildShellErrorResult(command, errorMsg);
    }

    const { expandedPath: expandedCwd, unresolvedVars } = expandPathWithEnvironment(
        rawWorkingDir,
        resolvedEnv
    );
    if (unresolvedVars.length > 0) {
        const errorMsg = `Shell command cannot run: ${
            formatUnresolvedPathVariablesError(rawWorkingDir, unresolvedVars, "cwd")
        }`;
        span?.addEvent("shell.error", { error: errorMsg });
        logger.error("Invalid shell cwd", {
            command,
            agent: context.agent.name,
            rawCwd: rawWorkingDir,
            unresolvedVars,
        });
        return buildShellErrorResult(command, errorMsg);
    }

    const workingDir = isAbsolute(expandedCwd)
        ? expandedCwd
        : resolve(context.workingDirectory, expandedCwd);

    span?.setAttributes({
        "shell.cwd_resolved": workingDir || "(empty)",
        "shell.cwd_expanded": expandedCwd || "(empty)",
    });

    logger.info("Executing shell command", {
        command,
        description: description || undefined,
        cwd: workingDir,
        cwdRaw: rawWorkingDir,
        cwdExpanded: expandedCwd,
        contextWorkingDir: context.workingDirectory,
        contextProjectBasePath: context.projectBasePath,
        agent: context.agent.name,
        timeout,
        runInBackground: run_in_background ?? false,
    });

    // Handle background execution
    if (run_in_background) {
        const taskId = generateTaskId();
        const outputDir = join(tmpdir(), "tenex-shell-tasks");
        await mkdir(outputDir, { recursive: true });
        const outputFile = join(outputDir, `${taskId}.output`);
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(command, [], {
                cwd: workingDir,
                shell: true,
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
                env: resolvedEnv,
            });
        } catch (error) {
            return buildShellErrorResult(
                command,
                `Failed to start shell command: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        // Write output to file
        const outputStream = createWriteStream(outputFile);
        child.stdout?.pipe(outputStream);
        child.stderr?.pipe(outputStream);

        // Track the background task with project isolation
        if (child.pid === undefined) {
            throw new Error("Failed to start background task: process ID unavailable");
        }

        // Get project ID for isolation enforcement
        if (!projectId) {
            throw new Error("Cannot create background task: no project context available");
        }

        backgroundTasks.set(taskId, {
            pid: child.pid,
            command: command.substring(0, 200),
            description: description || null,
            outputFile,
            startTime: new Date(),
            projectId,
        });

        // Unref so parent can exit independently
        child.unref();

        // Clean up task tracking when process exits
        child.on("exit", () => {
            // Keep task info for a while so status can be checked
            // It will be cleaned up eventually by a cleanup routine
        });

        span?.addEvent("shell.background_started", {
            task_id: taskId,
            output_file: outputFile,
            pid: child.pid,
        });

        logger.info("Shell command started in background", {
            taskId,
            command: command.substring(0, 200),
            description: description || undefined,
            outputFile,
            pid: child.pid,
        });

        const result: ShellBackgroundResult = {
            type: "background-task",
            taskId,
            command: command.substring(0, 200),
            description: description || null,
            outputFile,
            message: `Command started in background. Task ID: ${taskId}. Output is being written to: ${outputFile}`,
        };

        return result;
    }

    const timeoutMs = timeout != null ? timeout * 1000 : undefined;

    // Use spawn with stdin disconnected to prevent commands from blocking on stdin.
    // Without this, commands like `cat`, `grep` (no file args), `wc -l`, `read`, etc.
    // block indefinitely waiting for input, get killed by timeout, and crash with
    // "Missing exit code" because signal-killed processes have no exit code.
    const result = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
        signal: string | null;
        spawnError: string | null;
    }>((resolve) => {
        let child: ReturnType<typeof spawn>;
        let stdout = "";
        let stderr = "";
        let killed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
            child = spawn(command, [], {
                cwd: workingDir,
                shell: true,
                stdio: ["ignore", "pipe", "pipe"],
                env: resolvedEnv,
            });
        } catch (error) {
            resolve({
                stdout: "",
                stderr: "",
                exitCode: null,
                signal: null,
                spawnError: error instanceof Error ? error.message : String(error),
            });
            return;
        }

        const stdoutStream = child.stdout;
        const stderrStream = child.stderr;

        if (!stdoutStream || !stderrStream) {
            resolve({
                stdout: "",
                stderr: "",
                exitCode: null,
                signal: null,
                spawnError: "Shell process started without stdout/stderr pipes",
            });
            return;
        }

        child.on("error", (error: NodeJS.ErrnoException) => {
            if (timer) clearTimeout(timer);
            resolve({
                stdout,
                stderr,
                exitCode: null,
                signal: null,
                spawnError: error.message,
            });
        });

        stdoutStream.on("data", (data: Buffer) => { stdout += data.toString(); });
        stderrStream.on("data", (data: Buffer) => { stderr += data.toString(); });

        if (timeoutMs) {
            timer = setTimeout(() => {
                killed = true;
                child.kill("SIGTERM");
            }, timeoutMs);
        }

        child.on("close", (code, signal) => {
            if (timer) clearTimeout(timer);
            resolve({
                stdout,
                stderr,
                exitCode: code,
                signal: killed ? "SIGTERM" : (signal || null),
                spawnError: null,
            });
        });
    });

    const { stdout, stderr, exitCode, signal, spawnError } = result;

    if (spawnError) {
        const errorResult: ShellErrorResult = {
            type: "shell-error",
            command: command.substring(0, 200),
            exitCode: null,
            error: `Failed to start shell command: ${spawnError}`,
            stdout,
            stderr,
            signal,
        };

        span?.addEvent("shell.execute_error", {
            exit_code: -1,
            signal: "none",
            error_message: errorResult.error.substring(0, 200),
            has_stdout: !!stdout,
            has_stderr: !!stderr,
        });

        logger.error("Shell command failed to start", {
            command,
            workingDir,
            error: errorResult.error,
        });

        return errorResult;
    }

    if (exitCode === 0) {
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");

        span?.addEvent("shell.execute_complete", {
            has_stdout: !!stdout,
            has_stderr: !!stderr,
            output_length: output.length,
            exit_code: 0,
        });

        logger.info("Shell command completed", {
            command,
            hasStdout: !!stdout,
            hasStderr: !!stderr,
            exitCode: 0,
        });

        return output;
    }

    // Check if this is an expected non-zero exit code
    if (exitCode !== null) {
        const { expected, explanation } = isExpectedNonZeroExit(command, exitCode);

        if (expected) {
            const expectedResult: ShellExpectedNonZeroResult = {
                type: "expected-non-zero-exit",
                command: command.substring(0, 200),
                exitCode,
                stdout,
                stderr,
                explanation: explanation || `Command exited with code ${exitCode}`,
            };

            span?.addEvent("shell.execute_complete", {
                has_stdout: !!stdout,
                has_stderr: !!stderr,
                exit_code: exitCode,
                expected_non_zero: true,
                explanation: explanation,
            });

            logger.info("Shell command completed with expected non-zero exit", {
                command,
                exitCode,
                explanation,
                hasStdout: !!stdout,
                hasStderr: !!stderr,
            });

            return expectedResult;
        }
    }

    // Genuine error — return structured error for LLM recovery
    const errorResult: ShellErrorResult = {
        type: "shell-error",
        command: command.substring(0, 200),
        exitCode,
        error: signal ? `Process killed by ${signal}` : `Command exited with code ${exitCode}`,
        stdout,
        stderr,
        signal,
    };

    span?.addEvent("shell.execute_error", {
        exit_code: exitCode ?? -1,
        signal: signal ?? "none",
        error_message: errorResult.error.substring(0, 200),
        has_stdout: !!stdout,
        has_stderr: !!stderr,
    });

    logger.error("Shell command failed", {
        command,
        exitCode,
        signal,
        error: errorResult.error,
        hasStdout: !!stdout,
        hasStderr: !!stderr,
    });

    return errorResult;
}

/**
 * Create an AI SDK tool for executing shell commands
 */
export function createShellTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description: `Execute shell commands in the project directory.

IMPORTANT ESCAPING & STRING HANDLING:
- For complex/multi-line strings (git commits, PR bodies, JSON, etc.), ALWAYS use HEREDOC pattern:
  command -m "$(cat <<'EOF'
  Your multi-line content here
  With "quotes" and $variables that don't need escaping!
  EOF
  )"
- Always quote file paths with spaces: cd "/path with spaces/file.txt"
- NEVER use nested quotes without HEREDOC - they will fail
- DO NOT use newlines to separate commands (newlines OK in quoted strings)

COMMAND CHAINING:
- For independent commands: Use multiple shell() calls in parallel
- For dependent sequential commands: Use && to chain (e.g., "cmd1 && cmd2 && cmd3")
- Use ; only when you don't care if earlier commands fail
- Prefer absolute paths over cd: "pytest /foo/bar/tests" NOT "cd /foo/bar && pytest tests"

WHEN NOT TO USE SHELL:
- Reading files: Use fs_read (NOT cat/head/tail)
- Writing/creating files: Use fs_write or home_fs_write (NOT cat/echo/heredoc). If you don't have fs_write, you cannot write to the project directory — do NOT use shell as a workaround.
- Editing files: Use fs_edit (NOT sed/awk)
- File search: Use fs_glob (NOT find/ls)
- Content search: Use fs_grep (NOT grep/rg commands)

OTHER RESTRICTIONS:
- NEVER use interactive flags like -i (git rebase -i, git add -i, etc.)
- Commands run with timeout in seconds (default: 30s, max: 600s / 10 minutes)
- Shell sessions auto-load env vars from TENEX .env files with precedence agent > project > global.
- \`~\` resolves to the user's real home directory (via $HOME). To access your agent home, use \`$AGENT_HOME\`.

Use for: git operations, npm/build tools, docker, system commands where specialized tools don't exist.
- Time-based delays: Use shell(sleep N) to wait N seconds (e.g., shell(sleep 5) for 5 seconds).`,

        inputSchema: shellSchema,

        execute: async (input: ShellInput) => {
            // executeShell now handles all error cases internally
            // and returns structured results instead of throwing
            return await executeShell(input, context);
        },
    });

    return aiTool as AISdkTool;
}

/**
 * Get information about a background task by its ID
 */
export function getBackgroundTaskInfo(taskId: string): BackgroundTaskInfo | undefined {
    return backgroundTasks.get(taskId);
}

/**
 * Get all background tasks
 */
export function getAllBackgroundTasks(): Array<{ taskId: string } & BackgroundTaskInfo> {
    return Array.from(backgroundTasks.entries()).map(([id, info]) => ({
        taskId: id,
        ...info,
    }));
}

/**
 * Kill a background task by its ID
 * @returns Object with success status and message
 */
export function killBackgroundTask(taskId: string): { success: boolean; message: string; pid?: number } {
    const taskInfo = backgroundTasks.get(taskId);

    if (!taskInfo) {
        return {
            success: false,
            message: `No background task found with ID: ${taskId}`,
        };
    }

    try {
        // Send SIGTERM to gracefully terminate the process
        process.kill(taskInfo.pid, "SIGTERM");

        // Remove from tracking
        backgroundTasks.delete(taskId);

        logger.info("Background task killed", {
            taskId,
            pid: taskInfo.pid,
            command: taskInfo.command,
        });

        return {
            success: true,
            message: `Successfully terminated background task ${taskId} (PID: ${taskInfo.pid})`,
            pid: taskInfo.pid,
        };
    } catch (error) {
        // Process might already be dead
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            // Process doesn't exist anymore, clean up tracking
            backgroundTasks.delete(taskId);
            return {
                success: true,
                message: `Task ${taskId} was already terminated (PID: ${taskInfo.pid})`,
                pid: taskInfo.pid,
            };
        }

        logger.error("Failed to kill background task", {
            taskId,
            pid: taskInfo.pid,
            error: error instanceof Error ? error.message : String(error),
        });

        return {
            success: false,
            message: `Failed to terminate task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
            pid: taskInfo.pid,
        };
    }
}

// Export types for use in other modules
export type { ShellBackgroundResult, ShellErrorResult, ShellExpectedNonZeroResult };
