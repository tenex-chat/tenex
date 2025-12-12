import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ExecutionConfig } from "@/agents/execution/constants";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
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

    const workingDir = cwd || context.workingDirectory;

    logger.info("Executing shell command", {
        command,
        cwd: workingDir,
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
  command -m "\$(cat <<'EOF'
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
- Restricted to project-manager agent only

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
