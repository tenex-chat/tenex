import { tool } from 'ai';
import { readFile, readdir, stat } from "node:fs/promises";
import { formatAnyError } from "@/utils/error-formatter";
import { z } from "zod";
import { resolveAndValidatePath } from "../utils";
import type { ExecutionContext } from "@/agents/execution/types";

const readPathSchema = z.object({
  path: z
    .string()
    .describe("The file or directory path to read (absolute or relative to project root)"),
});


/**
 * Core implementation of the read_path functionality
 * Shared between AI SDK and legacy Tool interfaces
 */
async function executeReadPath(
  path: string,
  context: ExecutionContext
): Promise<string> {
  // Publish status message about what we're doing
  try {
    const conversation = context.conversationCoordinator.getConversation(context.conversationId);
    
    if (conversation?.history?.[0]) {
      await context.agentPublisher.conversation(
        { type: "conversation", content: `📖 Reading ${path}` },
        {
          triggeringEvent: context.triggeringEvent,
          rootEvent: conversation.history[0],
          conversationId: context.conversationId,
        }
      );
    }
  } catch (error) {
    // Don't fail the tool if we can't publish the status
    console.warn("Failed to publish read_path status:", error);
  }

  // Resolve path and ensure it's within project
  const fullPath = resolveAndValidatePath(path, context.projectPath);

  // Check if path is a directory first
  const stats = await stat(fullPath);
  if (stats.isDirectory()) {
    // Get directory contents
    const files = await readdir(fullPath);
    const fileList = files.map((file) => `  - ${file}`).join("\n");

    return `Directory listing for ${path}:\n${fileList}\n\nTo read a specific file, please specify the full path to the file.`;
  }

  const content = await readFile(fullPath, "utf-8");

  // Track file read in conversation metadata if path starts with context/
  if (path.startsWith("context/") && context.conversationCoordinator) {
    const conversation = context.conversationCoordinator.getConversation(context.conversationId);
    const currentMetadata = conversation?.metadata || {};
    const readFiles = currentMetadata.readFiles || [];

    // Only add if not already tracked
    if (!readFiles.includes(path)) {
      await context.conversationCoordinator.updateMetadata(context.conversationId, {
        readFiles: [...readFiles, path],
      });
    }
  }

  return content;
}

/**
 * Create an AI SDK tool for reading paths
 * This is the primary implementation
 */
export function createReadPathTool(context: ExecutionContext): ReturnType<typeof tool> {
  return tool({
    description:
      "Read a file or directory from the filesystem. Returns file contents for files, or directory listing for directories. Paths are relative to project root unless absolute. Use this instead of shell commands like cat, ls, find. Automatically tracks context file reads for conversation metadata. Safe and sandboxed to project directory.",
    
    inputSchema: readPathSchema,
    
    execute: async ({ path }: z.infer<typeof readPathSchema>) => {
      try {
        return await executeReadPath(path, context);
      } catch (error: unknown) {
        // If it's an EISDIR error that we somehow missed, provide helpful guidance
        if (error instanceof Error && "code" in error && error.code === "EISDIR") {
          try {
            const fullPath = resolveAndValidatePath(path, context.projectPath);
            const files = await readdir(fullPath);
            const fileList = files.map((file) => `  - ${file}`).join("\n");

            return `Directory listing for ${path}:\n${fileList}\n\nTo read a specific file, please specify the full path to the file.`;
          } catch {
            // If we can't read the directory, throw the original error
            throw new Error(`Failed to read ${path}: ${error.message}`);
          }
        }

        throw new Error(`Failed to read ${path}: ${formatAnyError(error)}`);
      }
    },
  });
}

