import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ExecutionConfig } from "@/agents/execution/constants";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";
import { tool } from "ai";
import { z } from "zod";

const execAsync = promisify(exec);

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
type ShellOutput = string;

/**
 * Core implementation of shell command execution
 * Shared between AI SDK and legacy Tool interfaces
 */
async function executeShell(input: ShellInput, context: ExecutionContext): Promise<ShellOutput> {
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
        const errorMsg = `Shell command cannot run: workingDirectory is empty. ` +
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
    });

    logger.info("Shell command completed", {
        command,
        hasStdout: !!stdout,
        hasStderr: !!stderr,
    });

    return output;
}

/**
 * Create an AI SDK tool for executing shell commands
 */
export function createShellTool(context: ExecutionContext): AISdkTool {
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
            try {
                return await executeShell(input, context);
            } catch (error) {
                throw new Error(
                    `Command failed: ${error instanceof Error ? error.message : String(error)}`
                );
            }
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
