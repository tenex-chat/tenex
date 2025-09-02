import { tool } from 'ai';
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getProjectContext } from "@/services";
import { ExecutionConfig } from "@/agents/execution/constants";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";

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
async function executeShell(
  input: ShellInput,
  context: ExecutionContext
): Promise<ShellOutput> {
  const { command, cwd, timeout = ExecutionConfig.DEFAULT_COMMAND_TIMEOUT_MS } = input;

  // Safety check - only the current PM can use this tool
  try {
    const projectContext = getProjectContext();
    const pmAgent = projectContext.getProjectManager();
    if (context.agent.pubkey !== pmAgent.pubkey) {
      throw new Error("Shell tool is restricted to the project manager agent only");
    }
  } catch (error) {
    throw new Error("Unable to verify project manager status");
  }

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
    const conversation = context.conversationCoordinator.getConversation(context.conversationId);
    
    if (conversation?.history?.[0]) {
      await agentPublisher.conversation(
        { type: "conversation", content: `⚡ Executing: ${command}` },
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
export function createShellTool(context: ExecutionContext) {
  return tool({
    description:
      "Execute shell commands in the project directory (restricted to project-manager agent only)",
    
    inputSchema: shellSchema,
    
    execute: async (input: ShellInput) => {
      try {
        return await executeShell(input, context);
      } catch (error) {
        throw new Error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

