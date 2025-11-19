import { readFile, readdir, stat } from "node:fs/promises";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { formatAnyError } from "@/lib/error-formatter";
import { tool } from "ai";
import { z } from "zod";
import { resolveAndValidatePath } from "../utils";

const readPathSchema = z.object({
    path: z
        .string()
        .describe("The file or directory path to read (absolute or relative to project root)"),
});

/**
 * Core implementation of the read_path functionality
 * Shared between AI SDK and legacy Tool interfaces
 */
async function executeReadPath(path: string, context: ExecutionContext): Promise<string> {
    // Resolve path and ensure it's within project
    const fullPath = resolveAndValidatePath(path, context.workingDirectory);

    // Check if path is a directory first
    const stats = await stat(fullPath);
    let content: string;

    if (stats.isDirectory()) {
        // Get directory contents
        const files = await readdir(fullPath);
        const fileList = files.map((file) => `  - ${file}`).join("\n");

        content = `Directory listing for ${path}:\n${fileList}\n\nTo read a specific file, please specify the full path to the file.`;
    } else {
        content = await readFile(fullPath, "utf-8");

        // Track file read in conversation metadata if path starts with context/
        if (path.startsWith("context/") && context.conversationCoordinator) {
            const conversation = context.getConversation();
            const currentMetadata = conversation?.metadata || {};
            const readFiles = currentMetadata.readFiles || [];

            // Only add if not already tracked
            if (!readFiles.includes(path)) {
                await context.conversationCoordinator.updateMetadata(context.conversationId, {
                    readFiles: [...readFiles, path],
                });
            }
        }
    }

    return content;
}

/**
 * Create an AI SDK tool for reading paths
 * This is the primary implementation
 */
export function createReadPathTool(context: ExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Read a file or directory from the filesystem. Returns file contents for files, or directory listing for directories. Paths are relative to project root unless absolute. Use this instead of shell commands like cat, ls, find. Automatically tracks context file reads for conversation metadata. Safe and sandboxed to project directory.",

        inputSchema: readPathSchema,

        execute: async ({ path }: { path: string }) => {
            try {
                return await executeReadPath(path, context);
            } catch (error: unknown) {
                // If it's an EISDIR error that we somehow missed, provide helpful guidance
                if (error instanceof Error && "code" in error && error.code === "EISDIR") {
                    try {
                        const fullPath = resolveAndValidatePath(path, context.workingDirectory);
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

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ path }: { path: string }) => {
            return `Reading ${path}`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
