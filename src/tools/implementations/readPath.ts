import { readFile, readdir, stat } from "node:fs/promises";
import { formatAnyError } from "@/utils/error-formatter";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema, success, failure } from "../types";
import { resolveAndValidatePath } from "../utils";

const readPathSchema = z.object({
  path: z
    .string()
    .describe("The file or directory path to read (absolute or relative to project root)"),
});

type ReadPathInput = z.infer<typeof readPathSchema>;
type ReadPathOutput = string;

/**
 * Read path tool - effect tool that reads files or directories from filesystem
 * Performs I/O side effects
 */
export const readPathTool: Tool<ReadPathInput, ReadPathOutput> = {
  name: "read_path",
  description:
    "Read a file or directory from the filesystem. Returns file contents for files, or directory listing for directories.",

  parameters: createZodSchema(readPathSchema),

  execute: async (input, context) => {
    const { path } = input.value;

    // Publish status message about what we're doing
    try {
      // Use shared AgentPublisher instance from context (guaranteed to be present)
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

    try {
      // Resolve path and ensure it's within project
      const fullPath = resolveAndValidatePath(path, context.projectPath);

      // Check if path is a directory first
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        // Get directory contents
        const files = await readdir(fullPath);
        const fileList = files.map((file) => `  - ${file}`).join("\n");

        return success(`Directory listing for ${path}:\n${fileList}\n\nTo read a specific file, please specify the full path to the file.`);
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

      return success(content);
    } catch (error: unknown) {
      // If it's an EISDIR error that we somehow missed, provide helpful guidance
      if (error instanceof Error && "code" in error && error.code === "EISDIR") {
        try {
          const fullPath = resolveAndValidatePath(path, context.projectPath);
          const files = await readdir(fullPath);
          const fileList = files.map((file) => `  - ${file}`).join("\n");

          return success(`Directory listing for ${path}:\n${fileList}\n\nTo read a specific file, please specify the full path to the file.`);
        } catch {
          // If we can't read the directory, fall back to the original error
          return failure({
            kind: "execution" as const,
            tool: "read_path",
            message: `Failed to read ${path}: ${error.message}`,
            cause: error,
          });
        }
      }

      return failure({
        kind: "execution" as const,
        tool: "read_path",
        message: `Failed to read ${path}: ${formatAnyError(error)}`,
        cause: error,
      });
    }
  },
};
