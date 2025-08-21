import { exec } from "node:child_process";
import { promisify } from "node:util";
import { PROJECT_MANAGER_AGENT } from "@/agents/constants";
import { ExecutionConfig } from "@/agents/execution/constants";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema, failure, success } from "../types";

const execAsync = promisify(exec);

const shellSchema = z.object({
  command: z.string().describe("The shell command to execute"),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the command (defaults to project root)"),
  timeout: z.coerce
    .number()
    .optional()
    .describe(
      `Command timeout in milliseconds (default: ${ExecutionConfig.DEFAULT_COMMAND_TIMEOUT_MS})`
    ),
});

/**
 * Shell tool - allows agents to execute shell commands
 * Restricted to project-manager agent for safety
 */
export const shellTool: Tool<
  {
    command: string;
    cwd?: string;
    timeout?: number;
  },
  string
> = {
  name: "shell",
  description:
    "Execute shell commands in the project directory (restricted to project-manager agent only)",

  parameters: createZodSchema(shellSchema),

  execute: async (input, context) => {
    const { command, cwd, timeout = ExecutionConfig.DEFAULT_COMMAND_TIMEOUT_MS } = input.value;

    // Safety check - only project-manager can use this tool
    if (context.agent.slug !== PROJECT_MANAGER_AGENT) {
      return failure({
        kind: "validation",
        field: "agent",
        message: "Shell tool is restricted to project-manager agent only",
      });
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
      const agentPublisher = new AgentPublisher(context.agent, context.conversationCoordinator);
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
      // Don't fail the tool if we can't publish the status
      console.warn("Failed to publish shell status:", error);
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workingDir,
        timeout,
        env: {
          ...process.env,
          // Ensure safe environment
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

      return success(output);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      logger.error("Shell command failed", {
        command,
        error: errorMessage,
      });

      return failure({
        kind: "execution",
        tool: "shell",
        message: `Command failed: ${errorMessage}`,
      });
    }
  },
};
