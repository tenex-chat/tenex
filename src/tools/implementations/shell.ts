import { tool } from 'ai';
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ExecutionConfig } from "@/agents/execution/constants";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/registry";

const execAsync = promisify(exec);

const shellSchema = z.object({
  command: z.string().describe("The shell command to execute"),
  cwd: z
    .string()
    .nullable()
    .optional()
    .describe("Working directory for the command (defaults to project root)"),
  timeout: z.coerce
    .number()
    .nullable()
    .optional()
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
async function executeShell(
  input: ShellInput,
  context: ExecutionContext
): Promise<ShellOutput> {
  const { command, cwd, timeout = ExecutionConfig.DEFAULT_COMMAND_TIMEOUT_MS } = input;

  const workingDir = cwd || context.projectPath;

  logger.info("Executing shell command", {
    command,
    cwd: workingDir,
    agent: context.agent.name,
    timeout,
  });

  // Publish status message about what command we're running
  try {
    const agentPublisher = context.agentPublisher;
    const conversation = context.getConversation();

    if (conversation?.history?.[0]) {
      await agentPublisher.conversation(
        { content: `⚡ Executing: ${command}` },
        {
          triggeringEvent: context.triggeringEvent,
          rootEvent: conversation.history[0],
          conversationId: context.conversationId,
        }
      );
    }
  } catch (error) {
    console.warn("Failed to publish shell status:", error);
  }

  const { stdout, stderr } = await execAsync(command, {
    cwd: workingDir,
    timeout,
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
    description:
      "Execute shell commands in the project directory. Use for system operations like git, npm, build tools, etc. NEVER use for file operations - use read_path/write_path instead. NEVER use for code modifications - edit files directly. Restricted to project-manager agent only. Commands run with timeout (default 2 minutes). Always prefer specialized tools over shell commands when available.",

    inputSchema: shellSchema,

    execute: async (input: ShellInput) => {
      try {
        return await executeShell(input, context);
      } catch (error) {
        throw new Error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  Object.defineProperty(aiTool, 'getHumanReadableContent', {
    value: ({ command }: ShellInput) => {
      return `Executing: ${command}`;
    },
    enumerable: false,
    configurable: true
  });

  return aiTool;
}

