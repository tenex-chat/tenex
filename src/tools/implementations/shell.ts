import { exec, spawn, type ExecException } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ExecutionConfig } from "@/agents/execution/constants";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import { tool } from "ai";
import { z } from "zod";

const execAsync = promisify(exec);

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

    if (config && config.exitCodes.includes(exitCode)) {
        return { expected: true, explanation: config.description };
    }

    return { expected: false };
}

const shellSchema = z.object({
    command: z.string().describe("The shell command to execute"),
    description: z
        .string()
        .nullable()
        .optional()
        .describe(
            "A clear, concise description of what this command does. For simple commands (5-10 words), for complex commands add more context."
        ),
    cwd: z
        .string()
        .nullable()
        .optional()
        .describe("Working directory for the command (defaults to project root)"),
    timeout: z
        .preprocess(
            // Coerce numeric strings to numbers while preserving undefined/null
            (val) => {
                if (val === undefined || val === null) return val;
                if (typeof val === "number") return val;
                if (typeof val === "string") {
                    const parsed = Number(val);
                    return Number.isNaN(parsed) ? val : parsed;
                }
                return val;
            },
            z.number().nullable().optional()
        )
        .describe(
            `Command timeout in milliseconds (default: ${ExecutionConfig.DEFAULT_COMMAND_TIMEOUT_MS}). Optional for background processes.`
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
    const { command, description, cwd, timeout = ExecutionConfig.DEFAULT_COMMAND_TIMEOUT_MS, run_in_background } = input;

    // Resolve cwd: if provided and relative, resolve against context.workingDirectory
    // If not provided, use context.workingDirectory directly
    let workingDir: string;
    if (cwd) {
        // If cwd is relative (like "."), resolve it against the project working directory
        const { isAbsolute, resolve } = await import("node:path");
        workingDir = isAbsolute(cwd) ? cwd : resolve(context.workingDirectory, cwd);
    } else {
        workingDir = context.workingDirectory;
    }

    // Add trace span with all context for debugging
    const span = trace.getActiveSpan();
    span?.setAttributes({
        "shell.command": command.substring(0, 200),
        "shell.description": description || "(not provided)",
        "shell.cwd_param_raw": cwd || "(not provided)",
        "shell.cwd_resolved": workingDir || "(empty)",
        "shell.context.working_directory": context.workingDirectory || "(empty)",
        "shell.context.project_base_path": context.projectBasePath || "(empty)",
        "shell.context.current_branch": context.currentBranch || "(empty)",
        "shell.agent": context.agent.name,
        "shell.timeout": timeout ?? ExecutionConfig.DEFAULT_COMMAND_TIMEOUT_MS,
        "shell.run_in_background": run_in_background ?? false,
    });
    span?.addEvent("shell.execute_start", {
        command: command.substring(0, 200),
        description: description || "(not provided)",
        cwd: workingDir || "(empty)",
        run_in_background: run_in_background ?? false,
    });

    // Validate working directory - fail fast if it's empty
    if (!workingDir) {
        const errorMsg = "Shell command cannot run: workingDirectory is empty. " +
            `Context projectBasePath: "${context.projectBasePath}", ` +
            `Context workingDirectory: "${context.workingDirectory}"`;
        span?.addEvent("shell.error", { error: errorMsg });
        throw new Error(errorMsg);
    }

    logger.info("Executing shell command", {
        command,
        description: description || undefined,
        cwd: workingDir,
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

        const child = spawn(command, [], {
            cwd: workingDir,
            shell: true,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                PATH: process.env.PATH,
                HOME: process.env.HOME,
            },
        });

        // Write output to file
        const outputStream = createWriteStream(outputFile);
        child.stdout?.pipe(outputStream);
        child.stderr?.pipe(outputStream);

        // Track the background task with project isolation
        if (child.pid === undefined) {
            throw new Error("Failed to start background task: process ID unavailable");
        }

        // Get project ID for isolation enforcement
        const conversation = context.getConversation?.();
        const projectId = conversation?.getProjectId();
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

    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: workingDir,
            timeout: timeout ?? undefined,
            env: {
                ...process.env,
                PATH: process.env.PATH,
                HOME: process.env.HOME,
            },
        });

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
    } catch (error) {
        // Handle exec errors - which include non-zero exit codes
        const execError = error as ExecException & { stdout?: string; stderr?: string };
        const exitCode = execError.code ?? null;
        const stdout = execError.stdout || "";
        const stderr = execError.stderr || "";
        const signal = execError.signal || null;

        // Check if this is an expected non-zero exit code
        if (exitCode !== null) {
            const { expected, explanation } = isExpectedNonZeroExit(command, exitCode);

            if (expected) {
                // This is NOT an error - it's expected behavior (e.g., grep found no matches)
                const result: ShellExpectedNonZeroResult = {
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

                // Return structured result - NOT throwing an error
                return result;
            }
        }

        // This is a genuine error - return structured error for LLM recovery
        const errorResult: ShellErrorResult = {
            type: "shell-error",
            command: command.substring(0, 200),
            exitCode,
            error: execError.message,
            stdout,
            stderr,
            signal,
        };

        span?.addEvent("shell.execute_error", {
            exit_code: exitCode ?? "unknown",
            signal: signal ?? "none",
            error_message: execError.message.substring(0, 200),
            has_stdout: !!stdout,
            has_stderr: !!stderr,
        });

        logger.error("Shell command failed", {
            command,
            exitCode,
            signal,
            error: execError.message,
            hasStdout: !!stdout,
            hasStderr: !!stderr,
        });

        // Return structured error instead of throwing
        // This allows the LLM to see the full context and make recovery decisions
        return errorResult;
    }
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
- File operations: Use fs_read/write_path (NOT cat/echo/sed/awk)
- Code modifications: Use edit tools directly (NOT sed/awk)
- File search: Use glob patterns (NOT find/ls)
- Content search: Use grep tools (NOT grep/rg commands)

OTHER RESTRICTIONS:
- NEVER use interactive flags like -i (git rebase -i, git add -i, etc.)
- Commands run with timeout (default 2 minutes, max 10 minutes)

Use for: git operations, npm/build tools, docker, system commands where specialized tools don't exist.
- Time-based delays: Use shell(sleep N) to wait N seconds (e.g., shell(sleep 5) for 5 seconds).`,

        inputSchema: shellSchema,

        execute: async (input: ShellInput) => {
            // executeShell now handles all error cases internally
            // and returns structured results instead of throwing
            return await executeShell(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ command, description, run_in_background }: ShellInput) => {
            const prefix = run_in_background ? "Running in background: " : "Executing: ";
            if (description) {
                return `${prefix}${description} (${command})`;
            }
            return `${prefix}${command}`;
        },
        enumerable: false,
        configurable: true,
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
