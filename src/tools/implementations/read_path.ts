import { readFile, readdir, stat } from "node:fs/promises";
import type { AISdkTool, ToolContext } from "@/tools/types";
import { formatAnyError } from "@/lib/error-formatter";
import { tool } from "ai";
import { z } from "zod";
import { resolveAndValidatePath } from "../utils";

const readPathSchema = z.object({
    path: z
        .string()
        .describe("The file or directory path to read (absolute or relative to project root)"),
    offset: z
        .number()
        .min(0)
        .optional()
        .describe("Line number to start reading from (0-indexed). If omitted, starts from beginning."),
    limit: z
        .number()
        .optional()
        .describe("Maximum number of lines to read. If omitted, reads entire file."),
});

/**
 * Core implementation of the read_path functionality
 * Shared between AI SDK and legacy Tool interfaces
 */
async function executeReadPath(
    path: string,
    context: ToolContext,
    offset?: number,
    limit?: number,
): Promise<string> {
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
        const rawContent = await readFile(fullPath, "utf-8");

        // If offset or limit are provided, process the file line by line
        if (offset !== undefined || limit !== undefined) {
            const lines = rawContent.split("\n");
            const totalLines = lines.length;

            // Validate offset
            const startIndex = offset ?? 0;
            if (startIndex >= totalLines) {
                return `File has only ${totalLines} line(s), but offset ${offset} was requested.`;
            }

            // Apply offset and limit
            const endIndex =
                limit !== undefined ? startIndex + limit : totalLines;
            const selectedLines = lines.slice(startIndex, endIndex);

            // Format with line numbers like "cat -n"
            const numberedLines = selectedLines
                .map((line, idx) => {
                    const lineNum = startIndex + idx + 1;
                    return `${lineNum.toString().padStart(6)}\t${line}`;
                })
                .join("\n");

            content = numberedLines;
        } else {
            // No offset/limit - return as-is for backwards compatibility
            content = rawContent;
        }
    }

    return content;
}

/**
 * Create an AI SDK tool for reading paths
 * This is the primary implementation
 */
export function createReadPathTool(context: ToolContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Read a file or directory from the filesystem. Returns file contents for files, or directory listing for directories. By default, reads the entire file. You can optionally specify offset and limit for large files. Results include line numbers when using offset/limit. Paths are relative to project root unless absolute. Use this instead of shell commands like cat, ls, find. Safe and sandboxed to project directory.",

        inputSchema: readPathSchema,

        execute: async ({ path, offset, limit }: { path: string; offset?: number; limit?: number }) => {
            try {
                return await executeReadPath(path, context, offset, limit);
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
