import { exec, type ExecException } from "node:child_process";
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
    cwd: z
        .string()
        .nullable()
        .describe("Working directory for the command (defaults to project root)"),
    timeout: z.coerce
        .number()
        .nullable()
        .describe(
            `Command timeout in milliseconds (default: ${ExecutionConfig.DEFAULT_COMMAND_TIMEOUT_MS})`
        ),
});

type ShellInput = z.infer<typeof shellSchema>;
type ShellOutput = string | ShellExpectedNonZeroResult | ShellErrorResult;

/**
 * Core implementation of shell command execution
 * Shared between AI SDK and legacy Tool interfaces
 *
 * Handles three cases:
 * 1. Success (exit code 0): Returns stdout + stderr as string
 * 2. Expected non-zero exit (e.g., grep with no matches): Returns structured result, NOT an error
 * 3. Genuine failure: Returns structured error result for LLM recovery
 */
async function executeShell(input: ShellInput, context: ToolExecutionContext): Promise<ShellOutput> {
    const { command, cwd, timeout = ExecutionConfig.DEFAULT_COMMAND_TIMEOUT_MS } = input;

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
        "shell.cwd_param_raw": cwd || "(not provided)",
        "shell.cwd_resolved": workingDir || "(empty)",
        "shell.context.working_directory": context.workingDirectory || "(empty)",
        "shell.context.project_base_path": context.projectBasePath || "(empty)",
        "shell.context.current_branch": context.currentBranch || "(empty)",
        "shell.agent": context.agent.name,
        "shell.timeout": timeout ?? ExecutionConfig.DEFAULT_COMMAND_TIMEOUT_MS,
    });
    span?.addEvent("shell.execute_start", {
        command: command.substring(0, 200),
        cwd: workingDir || "(empty)",
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
        cwd: workingDir,
        contextWorkingDir: context.workingDirectory,
        contextProjectBasePath: context.projectBasePath,
        agent: context.agent.name,
        timeout,
    });

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
- File operations: Use read_path/write_path (NOT cat/echo/sed/awk)
- Code modifications: Use edit tools directly (NOT sed/awk)
- File search: Use glob patterns (NOT find/ls)
- Content search: Use grep tools (NOT grep/rg commands)

OTHER RESTRICTIONS:
- NEVER use interactive flags like -i (git rebase -i, git add -i, etc.)
- Commands run with timeout (default 2 minutes, max 10 minutes)

Use for: git operations, npm/build tools, docker, system commands where specialized tools don't exist.`,

        inputSchema: shellSchema,

        execute: async (input: ShellInput) => {
            // executeShell now handles all error cases internally
            // and returns structured results instead of throwing
            return await executeShell(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ command }: ShellInput) => {
            return `Executing: ${command}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
